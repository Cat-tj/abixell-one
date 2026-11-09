/**
 * Demo-history harness: drives the real API in-process (app.inject) as the
 * demo tenant admin so every record goes through domain rules, then lets a
 * sector module backdate business timestamps with plain SQL so the tenant
 * looks like it has been operating for a year.
 *
 * Synthetic data only. Every module must be idempotent: look records up by
 * their code/number first and skip what already exists, so the runner can be
 * re-run safely after a partial failure.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export type Json = Record<string, unknown> | unknown[] | null;

export class ApiCallError extends Error {
  constructor(
    public readonly method: string,
    public readonly url: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${method} ${url} -> ${status}: ${body.slice(0, 500)}`);
  }
}

export interface DemoCtx {
  app: FastifyInstance;
  pool: Pool;
  tenantId: string;
  tenantCode: string;
  adminUserId: string;
  /** Call the API as the tenant admin. Throws ApiCallError on non-2xx. */
  call<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T>;
  /** Like call, but returns null instead of throwing on 404. */
  tryGet<T = any>(url: string): Promise<T | null>;
  /** Call the API as another seeded user (email/password), e.g. to act in a role. */
  callAs<T = any>(
    email: string,
    password: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<T>;
  /** Run SQL directly (backdating, or data with no API). Always scope by tenant_id. */
  sql<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  /** Deterministic random helpers so re-runs produce the same story. */
  rand: Rand;
  /** Calendar of the year of history. */
  cal: Calendar;
  log(sector: string, msg: string): void;
}

export interface Rand {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** Money-ish decimal string with 2 places in [min, max]. */
  money(min: number, max: number): string;
}

export interface Calendar {
  /** Today (YYYY-MM-DD). */
  today: string;
  /** First day of history = same day 12 months ago (YYYY-MM-DD). */
  start: string;
  /** The 13 month keys from 12 months ago through this month, e.g. "2025-11". */
  months: string[];
  /** YYYY-MM-DD for a day inside a month key (clamped to month length and to today). */
  day(month: string, dayOfMonth: number): string;
  /** Random working day (Mon–Sat) inside the month, never after today. */
  workday(month: string): string;
  addDays(date: string, days: number): string;
  /** ISO timestamp at a local hour on a date (UTC+7 business hours). */
  at(date: string, hour: number, minute?: number): string;
}

export function makeRand(seed: number): Rand {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    money: (min, max) => (min + next() * (max - min)).toFixed(2),
  };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function makeCalendar(today = new Date()): Calendar {
  const t = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const todayStr = iso(t);
  const startD = new Date(Date.UTC(t.getUTCFullYear() - 1, t.getUTCMonth(), t.getUTCDate()));
  const months: string[] = [];
  for (let i = 12; i >= 0; i--) {
    const m = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1));
    months.push(iso(m).slice(0, 7));
  }
  const rand = makeRand(7);
  const day = (month: string, dom: number) => {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = iso(new Date(Date.UTC(y, m - 1, Math.min(Math.max(dom, 1), last))));
    return d > todayStr ? todayStr : d;
  };
  return {
    today: todayStr,
    start: iso(startD),
    months,
    day,
    workday: (month) => {
      for (let i = 0; i < 20; i++) {
        const d = day(month, rand.int(1, 28));
        if (new Date(d + "T00:00:00Z").getUTCDay() !== 0) return d;
      }
      return day(month, 2);
    },
    addDays: (date, days) => iso(new Date(new Date(date + "T00:00:00Z").getTime() + days * 86400000)),
    at: (date, hour, minute = 0) =>
      new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`).toISOString(),
  };
}

export async function makeCtx(
  app: FastifyInstance,
  pool: Pool,
  opts: { tenantCode: string; email: string; password: string },
): Promise<DemoCtx> {
  const tokens = new Map<string, string>();
  const passwords = new Map<string, string>([[opts.email, opts.password]]);

  // Access tokens live 15 minutes and a full run takes longer, so every call
  // goes through `authed`, which logs in again once on a 401.
  async function login(email: string, password: string, fresh = false): Promise<string> {
    passwords.set(email, password);
    const cached = tokens.get(email);
    if (cached && !fresh) return cached;
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { tenantCode: opts.tenantCode, email, password },
    });
    if (r.statusCode !== 200) throw new ApiCallError("POST", "/auth/login", r.statusCode, r.body);
    const token = (r.json() as { accessToken: string }).accessToken;
    tokens.set(email, token);
    return token;
  }

  async function authed(email: string, method: string, url: string, body?: unknown) {
    const send = (token: string) =>
      app.inject({
        method: method as any,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as any } : {}),
      });
    const password = passwords.get(email)!;
    let r = await send(await login(email, password));
    if (r.statusCode === 401) r = await send(await login(email, password, true));
    return r;
  }

  await login(opts.email, opts.password);
  const me = (await authed(opts.email, "GET", "/me")).json() as { id?: string; userId?: string; tenantId: string };

  const call = async (method: any, url: string, body?: unknown) => {
    const r = await authed(opts.email, method, url, body);
    if (r.statusCode < 200 || r.statusCode >= 300) throw new ApiCallError(method, url, r.statusCode, r.body);
    return r.body ? r.json() : null;
  };

  return {
    app,
    pool,
    tenantId: me.tenantId,
    tenantCode: opts.tenantCode,
    adminUserId: (me.id ?? me.userId) as string,
    call,
    tryGet: async (url) => {
      const r = await authed(opts.email, "GET", url);
      if (r.statusCode === 404) return null;
      if (r.statusCode < 200 || r.statusCode >= 300) throw new ApiCallError("GET", url, r.statusCode, r.body);
      return r.json();
    },
    callAs: async (email, password, method, url, body) => {
      await login(email, password);
      const r = await authed(email, method, url, body);
      if (r.statusCode < 200 || r.statusCode >= 300) throw new ApiCallError(method, url, r.statusCode, r.body);
      return r.body ? r.json() : null;
    },
    sql: async (text, params) => (await pool.query(text, params as any[])).rows,
    rand: makeRand(20261109),
    cal: makeCalendar(),
    log: (sector, msg) => console.log(`[demo:${sector}] ${msg}`),
  };
}
