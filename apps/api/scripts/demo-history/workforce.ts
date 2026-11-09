/**
 * Sector "workforce": one year of HR history for PT Sentra Layanan Terpadu.
 *
 *  - workflow definitions for leave / overtime / payroll / recruitment / review
 *  - shifts, rosters (last 5 weeks + next week), attendance (last 90 days in
 *    full, one sample week per earlier month)
 *  - leave types, balances, requests (approved / rejected / cancelled / pending)
 *  - overtime requests with actual hours
 *  - statutory policies, salary profiles (annual raise on 2026-01-01),
 *    one payroll run per month (closed in the past, in review for November)
 *  - recruitment: job postings, applications through the stages, hires that
 *    match the employee join dates in catalog.ts
 *  - competencies, assessments, training courses + enrollments, performance
 *    review cycles, career paths, manpower plans
 *
 * Everything goes through the real API as HR / manager logins; SQL is used
 * only to backdate timestamps, to fill attendance minutes (the API leaves them
 * empty) and to stamp locked payroll facts (replication-role transaction).
 * Idempotent: every block looks the record up by its natural key first.
 */
import type { DemoCtx } from "./harness.js";
import { makeRand } from "./harness.js";
import { EMPLOYEES, POSITIONS, USERS, activityFactor, type EmployeeSpec } from "./catalog.js";

const S = "workforce";
const rnd = makeRand(20251109);

type Id = string;
const counts: Record<string, number> = {};
const made = (k: string, n = 1) => {
  if (n > 0) counts[k] = (counts[k] ?? 0) + n;
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay(); // 0 = Sunday
const monthOf = (d: string) => d.slice(0, 7);
const pad = (n: number) => String(n).padStart(2, "0");
const max = (a: string, b: string) => (a > b ? a : b);
const min = (a: string, b: string) => (a < b ? a : b);

function pickW<T>(items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rnd.next() * total;
  for (const [it, w] of items) {
    r -= w;
    if (r <= 0) return it;
  }
  return items[items.length - 1][0];
}

/** Indonesian public holidays + cuti bersama inside the history window. */
const HOLIDAYS = new Set([
  "2025-12-25", "2025-12-26", "2026-01-01", "2026-01-16", "2026-02-17", "2026-03-19", "2026-03-20", "2026-03-23",
  "2026-03-24", "2026-04-03", "2026-05-01", "2026-05-14", "2026-05-27", "2026-06-01", "2026-06-16", "2026-08-17",
  "2026-08-25",
]);

const OFFICE_ORGS = new Set(["HEAD_OFFICE", "FINANCE", "HR", "HSE", "PROJECTS", "PROCUREMENT", "SALES"]);

function activeOn(e: EmployeeSpec, d: string): boolean {
  return e.joinedAt <= d && (!e.endedAt || d <= e.endedAt);
}

/** Shift code a person works on a date, or null for a day off. */
function shiftFor(e: EmployeeSpec, idx: number, d: string): string | null {
  const w = dow(d);
  if (w === 0) return null;
  if (OFFICE_ORGS.has(e.org)) return w === 6 ? null : "KANTOR";
  if (e.org === "CATERING") return "DAPUR";
  if (e.org === "WAREHOUSE") return "PAGI";
  // FACILITY
  if (e.positionCode === "ASSET-OFF") return w === 6 ? null : "KANTOR";
  if (e.positionCode === "CLEANER") {
    const week = Math.floor((new Date(d + "T00:00:00Z").getTime() / 86400000 + 3) / 7);
    return (week + idx) % 2 === 0 ? "PAGI" : "SIANG";
  }
  return "PAGI";
}

const SHIFTS = [
  { shiftCode: "KANTOR", name: "Shift Kantor", startTime: "08:00", endTime: "17:00", breakMinutes: 60, isOvernight: false },
  { shiftCode: "PAGI", name: "Shift Pagi", startTime: "07:00", endTime: "15:00", breakMinutes: 60, isOvernight: false },
  { shiftCode: "SIANG", name: "Shift Siang", startTime: "15:00", endTime: "23:00", breakMinutes: 45, isOvernight: false },
  { shiftCode: "MALAM", name: "Shift Malam", startTime: "23:00", endTime: "07:00", breakMinutes: 45, isOvernight: true },
  { shiftCode: "DAPUR", name: "Shift Dapur (Produksi Katering)", startTime: "05:00", endTime: "13:00", breakMinutes: 45, isOvernight: false },
] as const;

/** Run backdating of workflow rows + domain events + audit for a set of business entities. */
export async function backdateEntities(
  ctx: DemoCtx,
  items: { id: Id; start: string; end?: string | null }[],
): Promise<void> {
  if (items.length === 0) return;
  const ids = items.map((i) => i.id);
  const starts = items.map((i) => i.start);
  const ends = items.map((i) => i.end ?? i.start);
  const t = ctx.tenantId;
  const m = `WITH m AS (SELECT * FROM unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[]) AS x(entity_id, s, e))`;
  await ctx.sql(
    `${m} UPDATE workflow_instances wi
        SET started_at = m.s, completed_at = CASE WHEN wi.completed_at IS NOT NULL THEN GREATEST(m.e, m.s) END
       FROM m WHERE wi.tenant_id = $1 AND wi.entity_id = m.entity_id`,
    [t, ids, starts, ends],
  );
  await ctx.sql(
    `${m}, a AS (
       SELECT asg.id, m.s, GREATEST(m.e, m.s + interval '4 hours') AS e,
              row_number() OVER (PARTITION BY asg.workflow_instance_id ORDER BY asg.assigned_at, asg.id) rn,
              count(*) OVER (PARTITION BY asg.workflow_instance_id) cnt
         FROM workflow_instance_assignments asg
         JOIN workflow_instances wi ON wi.id = asg.workflow_instance_id
         JOIN m ON m.entity_id = wi.entity_id
        WHERE wi.tenant_id = $1)
     UPDATE workflow_instance_assignments x
        SET assigned_at = a.s + (a.rn - 1) * ((a.e - a.s) / a.cnt),
            decided_at = CASE WHEN x.decided_at IS NOT NULL THEN a.s + a.rn * ((a.e - a.s) / a.cnt) END,
            due_at = CASE WHEN x.due_at IS NOT NULL THEN a.s + (a.rn - 1) * ((a.e - a.s) / a.cnt) + interval '3 days' END,
            claimed_at = NULL, claimed_by_user_id = NULL
       FROM a WHERE x.id = a.id`,
    [t, ids, starts, ends],
  );
  await ctx.sql(
    `${m}, h AS (
       SELECT w.id, m.s, GREATEST(m.e, m.s + interval '4 hours') AS e,
              row_number() OVER (PARTITION BY w.workflow_instance_id ORDER BY w.occurred_at, w.id) rn,
              count(*) OVER (PARTITION BY w.workflow_instance_id) cnt
         FROM workflow_history w
         JOIN workflow_instances wi ON wi.id = w.workflow_instance_id
         JOIN m ON m.entity_id = wi.entity_id
        WHERE wi.tenant_id = $1)
     UPDATE workflow_history x SET occurred_at = h.s + (h.rn - 1) * ((h.e - h.s) / h.cnt)
       FROM h WHERE x.id = h.id`,
    [t, ids, starts, ends],
  );
  await ctx.sql(
    `${m} UPDATE domain_events d SET occurred_at = m.s + (random() * interval '2 hours')
       FROM m WHERE d.tenant_id = $1 AND d.entity_id = m.entity_id`,
    [t, ids, starts, ends],
  );
  await ctx.sql(
    `${m} UPDATE audit_log d SET created_at = m.s + (random() * interval '2 hours')
       FROM m WHERE d.tenant_id = $1 AND d.entity_id = m.entity_id`,
    [t, ids, starts, ends],
  );
}

/** Replace the year segment of a business number when the business date is in 2025. */
export async function renumberYear(
  ctx: DemoCtx,
  table: string,
  numberCol: string,
  dateCol: string,
  entityIds?: Id[],
): Promise<void> {
  const filter = entityIds ? `AND id = ANY($2::uuid[])` : "";
  const params: unknown[] = entityIds ? [ctx.tenantId, entityIds] : [ctx.tenantId];
  const rows = await ctx.sql(
    `SELECT id, ${numberCol} AS num FROM ${table}
      WHERE tenant_id = $1 ${filter} AND EXTRACT(YEAR FROM ${dateCol}) = 2025 AND ${numberCol} ~ '-2026-'`,
    params,
  );
  for (const r of rows) {
    const next = String(r.num).replace("-2026-", "-2025-");
    // locked tables (approved payroll) reject updates: bypass triggers for this one-column fix
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`UPDATE ${table} SET ${numberCol} = $2 WHERE id = $1`, [r.id, next]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    await ctx.sql(
      `UPDATE workflow_instances SET context_data = replace(context_data::text, $3, $4)::jsonb
        WHERE tenant_id = $1 AND entity_id = $2`,
      [ctx.tenantId, r.id, r.num, next],
    );
  }
}

// ---------------------------------------------------------------------------
// workflow definitions
// ---------------------------------------------------------------------------
export interface WfStep { code: string; name: string; type: "task" | "approval" | "end"; initial?: boolean; terminal?: "approved" | "rejected" | "cancelled"; role?: string }
export async function ensureWorkflow(
  ctx: DemoCtx,
  code: string,
  name: string,
  steps: WfStep[],
  transitions: [string, string, string, string][],
  entityType: string = code,
): Promise<void> {
  const defs: any[] = (await ctx.call("GET", "/workflow/definitions")) ?? [];
  if (defs.some((d) => d.code === code)) return;
  await ctx.call("POST", "/workflow/definitions", {
    code,
    name,
    entityType,
    description: `${name} — alur persetujuan PT Sentra Layanan Terpadu`,
  });
  let order = 1;
  for (const s of steps) {
    await ctx.call("POST", `/workflow/definitions/${code}/versions/1/steps`, {
      code: s.code,
      name: s.name,
      stepType: s.type,
      isInitial: !!s.initial,
      isTerminal: !!s.terminal,
      terminalStatus: s.terminal ?? null,
      sequenceOrder: order++,
    });
  }
  let so = 1;
  for (const [from, to, action, label] of transitions) {
    await ctx.call("POST", `/workflow/definitions/${code}/versions/1/transitions`, {
      fromStepCode: from,
      toStepCode: to,
      actionCode: action,
      name: label,
      sortOrder: so++,
    });
  }
  for (const s of steps.filter((x) => x.role)) {
    await ctx.call("POST", `/workflow/definitions/${code}/versions/1/assignment-rules`, {
      stepCode: s.code,
      assignmentType: "role",
      roleCode: s.role,
      organizationUnitStrategy: "tenant",
    });
  }
  await ctx.call("POST", `/workflow/definitions/${code}/versions/1/publish`);
  made("workflowDefinition");
}

async function setupWorkflows(ctx: DemoCtx): Promise<void> {
  const END_A = (c: string, n: string): WfStep => ({ code: c, name: n, type: "end", terminal: "approved" });
  const END_R = (c: string, n: string): WfStep => ({ code: c, name: n, type: "end", terminal: "rejected" });
  const END_C = (c: string, n: string): WfStep => ({ code: c, name: n, type: "end", terminal: "cancelled" });

  for (const [code, name] of [
    ["workforce_leave_request", "Persetujuan Cuti"],
    ["workforce_overtime_request", "Persetujuan Lembur"],
  ] as const) {
    await ensureWorkflow(
      ctx,
      code,
      name,
      [
        { code: "SUBMITTED", name: "Menunggu Persetujuan Atasan", type: "approval", initial: true, role: "OPS_MANAGER" },
        END_A("APPROVED", "Disetujui"),
        END_R("REJECTED", "Ditolak"),
        END_C("CANCELLED", "Dibatalkan"),
      ],
      [
        ["SUBMITTED", "APPROVED", "approve", "Setujui"],
        ["SUBMITTED", "REJECTED", "reject", "Tolak"],
        ["SUBMITTED", "CANCELLED", "cancel", "Batalkan"],
      ],
    );
  }
  await ensureWorkflow(
    ctx,
    "workforce_payroll_run",
    "Penggajian Bulanan",
    [
      { code: "DRAFT", name: "Draf Perhitungan", type: "task", initial: true, role: "HR_OPS" },
      { code: "REVIEWED", name: "Menunggu Persetujuan Manajemen", type: "approval", role: "OPS_MANAGER" },
      { code: "APPROVED", name: "Disetujui", type: "task", role: "OPS_MANAGER" },
      END_A("CLOSED", "Ditutup & Dibayar"),
      END_R("REJECTED", "Ditolak"),
    ],
    [
      ["DRAFT", "REVIEWED", "review", "Kirim untuk Persetujuan"],
      ["DRAFT", "REJECTED", "reject", "Batalkan Draf"],
      ["REVIEWED", "APPROVED", "approve", "Setujui"],
      ["REVIEWED", "CLOSED", "close", "Setujui & Tutup"],
      ["REVIEWED", "DRAFT", "return", "Kembalikan untuk Revisi"],
      ["REVIEWED", "REJECTED", "reject", "Tolak"],
      ["APPROVED", "CLOSED", "close", "Tutup Periode"],
    ],
  );
  await ensureWorkflow(
    ctx,
    "workforce_job_posting",
    "Siklus Lowongan Kerja",
    [
      { code: "SUBMITTED", name: "Draf Lowongan", type: "task", initial: true, role: "HR_OPS" },
      { code: "PUBLISHED", name: "Dipublikasikan", type: "task", role: "HR_OPS" },
      END_A("CLOSED", "Ditutup"),
      END_C("CANCELLED", "Dibatalkan"),
    ],
    [
      ["SUBMITTED", "PUBLISHED", "publish", "Publikasikan"],
      ["SUBMITTED", "CANCELLED", "cancel", "Batalkan"],
      ["PUBLISHED", "CLOSED", "close", "Tutup Lowongan"],
      ["PUBLISHED", "CANCELLED", "cancel", "Batalkan"],
    ],
  );
  await ensureWorkflow(
    ctx,
    "workforce_performance_review",
    "Penilaian Kinerja",
    [
      { code: "DRAFT", name: "Penilaian Disusun", type: "task", initial: true, role: "HR_OPS" },
      { code: "SUBMITTED", name: "Menunggu Finalisasi", type: "approval", role: "HR_OPS" },
      END_A("FINALIZED", "Final"),
    ],
    [
      ["DRAFT", "SUBMITTED", "submit", "Ajukan"],
      ["SUBMITTED", "FINALIZED", "finalize", "Finalisasi"],
    ],
  );
}

// ---------------------------------------------------------------------------
// leave plan (deterministic) — shared by leave creation and attendance
// ---------------------------------------------------------------------------
interface LeavePlan {
  empCode: string;
  type: "ANNUAL" | "SICK" | "MARRIAGE" | "BEREAVEMENT" | "MATERNITY" | "UNPAID";
  start: string;
  end: string;
  days: number;
  createdOn: string;
  outcome: "approved" | "rejected" | "cancelled" | "pending";
  reason: string;
  decidedOn: string | null;
  comment: string | null;
}

function weekdaysBetween(a: string, b: string, saturdayCounts = false): number {
  let n = 0;
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const w = dow(d);
    if (w === 0 || HOLIDAYS.has(d)) continue;
    if (w === 6 && !saturdayCounts) continue;
    n++;
  }
  return n;
}
function addDays(d: string, n: number): string {
  return new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
}

const ANNUAL_REASONS = [
  "Pulang kampung menghadiri acara keluarga", "Liburan akhir tahun bersama keluarga", "Mengurus keperluan pribadi",
  "Menemani orang tua berobat", "Acara pernikahan saudara di luar kota", "Istirahat dan keperluan keluarga",
  "Mudik libur sekolah anak", "Mengurus dokumen kependudukan",
];
const SICK_REASONS = ["Demam dan flu, surat dokter terlampir", "Gejala tifus, istirahat sesuai anjuran dokter", "Sakit punggung, rawat jalan", "Gastritis, istirahat 2 hari", "Infeksi saluran pernapasan (ISPA)"];
const REJECT_COMMENTS = [
  "Bertepatan dengan puncak order katering, mohon geser jadwal", "Kuota cuti tim pada periode tersebut sudah penuh",
  "Mohon diajukan ulang setelah serah terima pekerjaan selesai", "Bertepatan dengan audit pelanggan",
];

let _leavePlan: LeavePlan[] | null = null;
function leavePlan(ctx: DemoCtx): LeavePlan[] {
  if (_leavePlan) return _leavePlan;
  const today = ctx.cal.today;
  const start = ctx.cal.start;
  const plan: LeavePlan[] = [];
  const busy = new Map<string, Array<[string, string]>>(); // empCode -> ranges
  const annualUsed = new Map<string, number>(); // `${emp}:${year}`
  const sickUsed = new Map<string, number>();
  const overlaps = (c: string, a: string, b: string) => (busy.get(c) ?? []).some(([x, y]) => a <= y && b >= x);
  const push = (p: LeavePlan) => {
    plan.push(p);
    if (p.outcome === "approved" || p.outcome === "pending") busy.set(p.empCode, [...(busy.get(p.empCode) ?? []), [p.start, p.end]]);
  };

  const staff = EMPLOYEES.filter((e) => e.joinedAt <= "2026-09-30");
  // Favoured leave windows (year-end, Lebaran, school holiday, ordinary)
  const windows: Array<[string, string, number]> = [
    ["2025-12-15", "2026-01-04", 4],
    ["2026-01-12", "2026-02-27", 2],
    ["2026-03-23", "2026-04-08", 3],
    ["2026-04-20", "2026-06-12", 2],
    ["2026-06-22", "2026-07-17", 3],
    ["2026-07-27", "2026-10-30", 2],
  ];

  for (const e of staff) {
    const eligibleFrom = max(e.joinedAt, start);
    const tenureMonths = (new Date(today).getTime() - new Date(e.joinedAt).getTime()) / (30 * 86400000);
    if (tenureMonths < 3) continue;
    const n = e.employmentType === "permanent" ? rnd.int(1, 3) : rnd.int(0, 1);
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const w = pickW(windows.map((x) => [x, x[2]] as const));
        const lo = max(w[0], addDays(eligibleFrom, 60));
        if (lo > w[1] || lo > addDays(today, -4)) continue;
        const span = Math.floor((new Date(min(w[1], addDays(today, -4))).getTime() - new Date(lo).getTime()) / 86400000);
        if (span < 0) continue;
        let s = addDays(lo, rnd.int(0, span));
        while (dow(s) === 0 || dow(s) === 6 || HOLIDAYS.has(s)) s = addDays(s, 1);
        const len = rnd.int(1, 4);
        let eDate = addDays(s, len - 1);
        const days = weekdaysBetween(s, eDate);
        if (days < 1) continue;
        const yr = s.slice(0, 4);
        const key = `${e.code}:${yr}`;
        if ((annualUsed.get(key) ?? 0) + days > (yr === "2025" ? 6 : 12)) continue;
        if (overlaps(e.code, s, eDate)) continue;
        annualUsed.set(key, (annualUsed.get(key) ?? 0) + days);
        const roll = rnd.next();
        const outcome: LeavePlan["outcome"] = roll < 0.07 ? "rejected" : roll < 0.1 ? "cancelled" : "approved";
        const createdOn = max(start, addDays(s, -rnd.int(5, 18)));
        const decidedOn = min(addDays(createdOn, rnd.int(1, 3)), today);
        push({
          empCode: e.code, type: "ANNUAL", start: s, end: eDate, days, createdOn, outcome,
          reason: rnd.pick(ANNUAL_REASONS), decidedOn,
          comment: outcome === "rejected" ? rnd.pick(REJECT_COMMENTS) : outcome === "cancelled" ? "Dibatalkan, karyawan tidak jadi mengambil cuti" : "Disetujui",
        });
        break;
      }
    }
    // sick leave
    if (rnd.chance(0.38) && tenureMonths >= 2) {
      for (let attempt = 0; attempt < 8; attempt++) {
        let s = addDays(max(eligibleFrom, start), rnd.int(10, 330));
        if (s > addDays(today, -2)) continue;
        while (dow(s) === 0 || dow(s) === 6 || HOLIDAYS.has(s)) s = addDays(s, 1);
        const len = rnd.int(1, 3);
        const eDate = addDays(s, len - 1);
        const days = weekdaysBetween(s, eDate);
        if (days < 1 || overlaps(e.code, s, eDate)) continue;
        const key = `${e.code}:${s.slice(0, 4)}`;
        if ((sickUsed.get(key) ?? 0) + days > 12) continue;
        sickUsed.set(key, (sickUsed.get(key) ?? 0) + days);
        push({
          empCode: e.code, type: "SICK", start: s, end: eDate, days, createdOn: min(addDays(s, 1), today), outcome: "approved",
          reason: rnd.pick(SICK_REASONS), decidedOn: min(addDays(s, 2), today), comment: "Surat dokter diterima HR",
        });
        break;
      }
    }
  }

  const spec = (code: string, type: LeavePlan["type"], s: string, e2: string, reason: string, createdOn: string, outcome: LeavePlan["outcome"] = "approved", countSat = false) => {
    if (e2 < ctx.cal.start) return;
    const days = weekdaysBetween(s, e2, countSat);
    push({ empCode: code, type, start: s, end: e2, days, createdOn, outcome, reason, decidedOn: outcome === "pending" ? null : min(addDays(createdOn, 2), today), comment: outcome === "approved" ? "Disetujui" : null });
  };
  // Life events
  spec("EMP-0008", "MATERNITY", "2026-04-13", "2026-07-10", "Cuti melahirkan (3 bulan)", "2026-03-02");
  spec("EMP-0013", "MARRIAGE", "2026-05-18", "2026-05-20", "Pernikahan karyawan", "2026-04-20");
  spec("EMP-0014", "BEREAVEMENT", "2026-02-10", "2026-02-11", "Anggota keluarga inti meninggal dunia", "2026-02-10");
  spec("EMP-0026", "BEREAVEMENT", "2026-08-04", "2026-08-05", "Orang tua meninggal dunia", "2026-08-04");
  spec("EMP-0011", "UNPAID", "2026-09-07", "2026-09-18", "Keperluan keluarga di kampung halaman (cuti di luar tanggungan)", "2026-08-24");

  // Pending in the HR/manager queue right now
  const pendings: Array<[string, string, string]> = [
    ["EMP-0007", "2026-11-16", "2026-11-18"], ["EMP-0010", "2026-12-21", "2026-12-24"], ["EMP-0022", "2026-12-28", "2026-12-31"],
    ["EMP-0032", "2026-11-23", "2026-11-25"], ["EMP-0020", "2026-12-14", "2026-12-16"], ["EMP-0035", "2026-12-24", "2026-12-31"],
    ["EMP-0029", "2026-11-12", "2026-11-13"],
  ];
  pendings.forEach(([c, s, e2], i) => {
    if (overlaps(c, s, e2)) return;
    spec(c, "ANNUAL", s, e2, rnd.pick(ANNUAL_REASONS), addDays(today, -(i % 5)), "pending");
  });
  // Someone is on approved leave today
  spec("EMP-0025", "ANNUAL", addDays(today, -1), addDays(today, 1), "Menghadiri acara keluarga", addDays(today, -9));

  plan.sort((a, b) => (a.createdOn === b.createdOn ? a.empCode.localeCompare(b.empCode) : a.createdOn.localeCompare(b.createdOn)));
  _leavePlan = plan;
  return plan;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export async function run(ctx: DemoCtx): Promise<void> {
  const t0 = Date.now();
  const tid = ctx.tenantId;
  const HR = USERS.hr;
  const MGR = USERS.manager;
  const hr = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(HR.email, HR.password, method, url, body);
  const mgr = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(MGR.email, MGR.password, method, url, body);
  const iso = (d: string, h: number, m = 0) => ctx.cal.at(d, h, m);
  const today = ctx.cal.today;
  const start = ctx.cal.start;

  // -- lookups -------------------------------------------------------------
  const empRows: any[] = await ctx.call("GET", "/employees");
  const empId = new Map<string, Id>(empRows.map((e) => [e.employeeNumber, e.id]));
  const spec = new Map<string, EmployeeSpec>(EMPLOYEES.map((e) => [e.code, e]));
  const specIdx = new Map<string, number>(EMPLOYEES.map((e, i) => [e.code, i]));
  const orgRows = await ctx.sql(`SELECT id, name FROM organization_units WHERE tenant_id = $1`, [tid]);
  const orgId = (name: string): Id => orgRows.find((o) => o.name === name)?.id;
  const HEAD = orgId("Head Office");
  const orgByKey: Record<string, Id> = {
    HEAD_OFFICE: HEAD, CATERING: orgId("Catering Operations"), FACILITY: orgId("Facility Services"), WAREHOUSE: orgId("Warehouse & Logistics"),
    FINANCE: orgId("Finance & Accounting"), HR: orgId("Human Capital"), HSE: orgId("HSE & Quality"), PROJECTS: orgId("Project Management"),
    PROCUREMENT: orgId("Procurement"), SALES: orgId("Business Development"),
  };
  const posRows: any[] = await ctx.call("GET", "/positions");
  const posId = new Map<string, Id>(posRows.map((p) => [p.code, p.id]));
  const hrUserId: Id = (await ctx.sql(`SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [tid, HR.email]))[0]?.id;
  const mgrUserId: Id = (await ctx.sql(`SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [tid, MGR.email]))[0]?.id;

  await setupWorkflows(ctx);

  // =========================================================================
  // 1. Shifts
  // =========================================================================
  const shiftRows: any[] = await hr("GET", "/workforce/advanced/shifts?includeInactive=true");
  const shiftId = new Map<string, Id>(shiftRows.map((s) => [s.shiftCode, s.id]));
  for (const s of SHIFTS) {
    if (shiftId.has(s.shiftCode)) continue;
    const r = await hr("POST", "/workforce/advanced/shifts", s);
    shiftId.set(s.shiftCode, r.id);
    made("shift");
  }
  await ctx.sql(`UPDATE workforce_shifts SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '2 days'`, [tid, iso(start, 9)]);

  // =========================================================================
  // 2. Leave types + allocations
  // =========================================================================
  const LEAVE_TYPES = [
    { code: "ANNUAL", name: "Cuti Tahunan", annualAllowanceDays: 12, isPaid: true, requiresAttachment: false },
    { code: "SICK", name: "Cuti Sakit (Surat Dokter)", annualAllowanceDays: 12, isPaid: true, requiresAttachment: true },
    { code: "MARRIAGE", name: "Cuti Menikah", annualAllowanceDays: 3, isPaid: true, requiresAttachment: false },
    { code: "BEREAVEMENT", name: "Izin Keluarga Meninggal", annualAllowanceDays: 2, isPaid: true, requiresAttachment: false },
    { code: "MATERNITY", name: "Cuti Melahirkan", annualAllowanceDays: 90, isPaid: true, requiresAttachment: true },
    { code: "UNPAID", name: "Cuti di Luar Tanggungan", annualAllowanceDays: 30, isPaid: false, requiresAttachment: false },
  ];
  const ltRows: any[] = await hr("GET", "/workforce/advanced/leave-types?includeInactive=true");
  const leaveTypeId = new Map<string, Id>(ltRows.map((l) => [l.code, l.id]));
  for (const lt of LEAVE_TYPES) {
    if (leaveTypeId.has(lt.code)) continue;
    const r = await hr("POST", "/workforce/advanced/leave-types", lt);
    leaveTypeId.set(lt.code, r.id);
    made("leaveType");
  }
  await ctx.sql(`UPDATE workforce_leave_types SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '2 days'`, [tid, iso(start, 9)]);

  // allocations: only create when no balance row exists yet
  const existingBal = new Set<string>(
    (await ctx.sql(`SELECT employee_id, leave_type_id, balance_year FROM workforce_leave_balances WHERE tenant_id = $1`, [tid])).map(
      (r) => `${r.employee_id}:${r.leave_type_id}:${r.balance_year}`,
    ),
  );
  const plan = leavePlan(ctx);
  const needs = new Map<string, number>(); // key -> days needed at least
  for (const p of plan) needs.set(`${p.empCode}:${p.type}:${p.start.slice(0, 4)}`, (needs.get(`${p.empCode}:${p.type}:${p.start.slice(0, 4)}`) ?? 0) + p.days);
  let allocCount = 0;
  for (const e of EMPLOYEES) {
    for (const yr of [2025, 2026]) {
      const from = yr === 2025 ? start : `${yr}-01-01`;
      const to = yr === 2025 ? "2025-12-31" : `${yr}-12-31`;
      if (e.joinedAt > to || (e.endedAt && e.endedAt < from)) continue;
      const wantTypes: Array<[string, number]> = [];
      // Annual: pro-rated for newcomers; 2025 only covers Nov-Dec of the history
      const tenureStart = max(e.joinedAt, from);
      const monthsLeft = Math.max(1, 12 - Number(tenureStart.slice(5, 7)) + 1);
      const annual = yr === 2025 ? 6 : e.joinedAt >= "2026-01-01" ? Math.min(12, Math.max(4, monthsLeft)) : 12;
      wantTypes.push(["ANNUAL", annual], ["SICK", yr === 2025 ? 6 : 12]);
      for (const k of ["MARRIAGE", "BEREAVEMENT", "MATERNITY", "UNPAID"]) {
        if (needs.has(`${e.code}:${k}:${yr}`)) wantTypes.push([k, LEAVE_TYPES.find((l) => l.code === k)!.annualAllowanceDays]);
      }
      for (const [code, days] of wantTypes) {
        const need = needs.get(`${e.code}:${code}:${yr}`) ?? 0;
        const lid = leaveTypeId.get(code)!;
        if (existingBal.has(`${empId.get(e.code)}:${lid}:${yr}`)) continue;
        await hr("PUT", "/workforce/advanced/leave-balances", { employeeId: empId.get(e.code), leaveTypeId: lid, balanceYear: yr, allocatedDays: Math.max(days, need) });
        allocCount++;
      }
    }
  }
  made("leaveBalance", allocCount);
  await ctx.sql(`UPDATE workforce_leave_balances SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '2 days'`, [tid, iso(start, 9, 30)]);

  // =========================================================================
  // 3. Leave requests (chronological so numbers run in time order)
  // =========================================================================
  {
    const have = new Set<string>(
      (await ctx.sql(`SELECT employee_id, leave_type_id, start_date::text AS sd FROM workforce_leave_requests WHERE tenant_id = $1`, [tid])).map(
        (r) => `${r.employee_id}:${r.leave_type_id}:${r.sd}`,
      ),
    );
    const stamps: Array<{ id: Id; p: LeavePlan }> = [];
    for (const p of plan) {
      const eid = empId.get(p.empCode)!;
      const lid = leaveTypeId.get(p.type)!;
      if (have.has(`${eid}:${lid}:${p.start}`)) continue;
      const created = await hr("POST", "/workforce/advanced/leave-requests", {
        employeeId: eid, leaveTypeId: lid, startDate: p.start, endDate: p.end, totalDays: p.days, reason: p.reason,
      });
      if (p.outcome === "approved") await mgr("POST", `/workforce/advanced/leave-requests/${created.id}/act`, { actionCode: "approve", comment: p.comment });
      else if (p.outcome === "rejected") await mgr("POST", `/workforce/advanced/leave-requests/${created.id}/act`, { actionCode: "reject", comment: p.comment });
      else if (p.outcome === "cancelled") await mgr("POST", `/workforce/advanced/leave-requests/${created.id}/act`, { actionCode: "cancel", comment: p.comment });
      stamps.push({ id: created.id, p });
      made("leaveRequest");
    }
    // backdate (also covers rows created in an earlier, interrupted run: only fix those still at "now")
    for (const { id, p } of stamps) {
      const created = iso(p.createdOn, rnd.int(8, 16), rnd.int(0, 59));
      const decided = p.decidedOn ? iso(p.decidedOn, rnd.int(9, 17), rnd.int(0, 59)) : null;
      await ctx.sql(
        `UPDATE workforce_leave_requests SET created_at = $2, submitted_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz),
                approved_at = CASE WHEN approved_at IS NOT NULL THEN $3::timestamptz END,
                rejected_at = CASE WHEN rejected_at IS NOT NULL THEN $3::timestamptz END,
                cancelled_at = CASE WHEN cancelled_at IS NOT NULL THEN $3::timestamptz END
          WHERE id = $1`,
        [id, created, decided],
      );
      await backdateEntities(ctx, [{ id, start: created, end: decided }]);
    }
    await renumberYear(ctx, "workforce_leave_requests", "request_number", "start_date");
    await ctx.sql(`UPDATE workforce_leave_balances SET updated_at = $2 WHERE tenant_id = $1 AND updated_at > $2::timestamptz - interval '1 day'`, [tid, iso(addDays(today, -1), 10)]);
  }

  // =========================================================================
  // 4. Rosters (last 5 weeks + next week)
  // =========================================================================
  {
    const from = addDays(today, -34);
    const to = addDays(today, 6);
    const have = new Set<string>(
      (await ctx.sql(`SELECT employee_id, roster_date::text AS d FROM workforce_rosters WHERE tenant_id = $1`, [tid])).map((r) => `${r.employee_id}:${r.d}`),
    );
    let n = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (HOLIDAYS.has(d)) continue;
      for (const e of EMPLOYEES) {
        if (!activeOn(e, d) && !(d > today && !e.endedAt && e.joinedAt <= today)) continue;
        const sc = shiftFor(e, specIdx.get(e.code)!, d);
        if (!sc) continue;
        const eid = empId.get(e.code)!;
        if (have.has(`${eid}:${d}`)) continue;
        await hr("PUT", "/workforce/advanced/rosters", { employeeId: eid, shiftId: shiftId.get(sc), rosterDate: d, organizationUnitId: orgByKey[e.org], notes: null });
        n++;
      }
    }
    made("roster", n);
    // rosters are published the Friday before the week they cover
    await ctx.sql(
      `UPDATE workforce_rosters SET
          created_at = (roster_date - (((EXTRACT(DOW FROM roster_date)::int + 1) % 7) + 1))::timestamp + interval '15 hours' - interval '7 hours',
          updated_at = (roster_date - (((EXTRACT(DOW FROM roster_date)::int + 1) % 7) + 1))::timestamp + interval '15 hours' - interval '7 hours'
        WHERE tenant_id = $1 AND created_at > now() - interval '3 hours' AND roster_date <= $2::date`,
      [tid, today],
    );
    await ctx.sql(
      `UPDATE workforce_rosters SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > now() - interval '3 hours'`,
      [tid, iso(addDays(today, -2), 15)],
    );
  }

  // =========================================================================
  // 5. Attendance
  // =========================================================================
  {
    const approvedLeave = new Map<string, Set<string>>();
    for (const p of plan) {
      if (p.outcome !== "approved") continue;
      const set = approvedLeave.get(p.empCode) ?? new Set<string>();
      for (let d = p.start; d <= p.end; d = addDays(d, 1)) set.add(d);
      approvedLeave.set(p.empCode, set);
    }
    const dates: string[] = [];
    const fullFrom = addDays(today, -89);
    for (let d = fullFrom; d <= today; d = addDays(d, 1)) dates.push(d);
    // one sample week (Mon-Fri) in each earlier month
    for (const m of ctx.cal.months) {
      if (m + "-28" >= fullFrom && m >= monthOf(fullFrom)) continue;
      let d = ctx.cal.day(m, 8);
      while (dow(d) !== 1) d = addDays(d, 1);
      if (m === ctx.cal.months[0]) {
        d = addDays(start, 1);
        while (dow(d) !== 1) d = addDays(d, 1);
      }
      for (let i = 0; i < 5; i++) {
        const x = addDays(d, i);
        if (x < fullFrom && x >= start) dates.push(x);
      }
    }
    dates.sort();
    const have = new Set<string>(
      (await ctx.sql(`SELECT employee_id, attendance_date::text AS d FROM workforce_attendance_records WHERE tenant_id = $1`, [tid])).map((r) => `${r.employee_id}:${r.d}`),
    );
    const shiftDef = new Map<string, (typeof SHIFTS)[number]>(SHIFTS.map((s) => [s.shiftCode, s]));
    let n = 0;
    for (const d of dates) {
      for (const e of EMPLOYEES) {
        if (!activeOn(e, d)) continue;
        const sc = shiftFor(e, specIdx.get(e.code)!, d);
        if (!sc) continue;
        const eid = empId.get(e.code)!;
        if (have.has(`${eid}:${d}`)) continue;
        const sd = shiftDef.get(sc)!;
        const [sh, sm] = sd.startTime.split(":").map(Number);
        const [eh, em] = sd.endTime.split(":").map(Number);
        let body: any = { employeeId: eid, attendanceDate: d, shiftId: shiftId.get(sc), source: "device" };
        const onLeave = approvedLeave.get(e.code)?.has(d);
        if (HOLIDAYS.has(d)) {
          body.status = "holiday";
          body.notes = "Hari libur nasional / cuti bersama";
          body.source = "import";
        } else if (onLeave) {
          body.status = "leave";
          body.notes = "Cuti disetujui";
          body.source = "import";
        } else if (rnd.chance(0.012)) {
          body.status = "absent";
          body.notes = rnd.pick(["Tidak hadir tanpa keterangan", "Izin mendadak, belum ada surat", "Tidak hadir, tidak dapat dihubungi"]);
          body.source = "manual";
        } else {
          const lateP = dow(d) === 1 ? 0.1 : 0.06;
          const isLate = rnd.chance(lateP);
          const inOffset = isLate ? rnd.int(6, 48) : -rnd.int(0, 22);
          const outOffset = rnd.chance(0.12) ? rnd.int(30, 150) : rnd.int(0, 18);
          const inMin = sh * 60 + sm + inOffset;
          const outMin = Math.min(23 * 60 + 50, eh * 60 + em + outOffset);
          body.status = isLate ? "late" : "present";
          body.clockIn = iso(d, Math.floor(inMin / 60), inMin % 60);
          body.clockOut = iso(d, Math.floor(outMin / 60), outMin % 60);
          body.source = rnd.chance(0.82) ? "device" : rnd.chance(0.7) ? "self_service" : "manual";
          if (isLate) body.notes = rnd.pick(["Macet di jalan tol", "Kendaraan mogok", "Hujan deras", null as any]) ?? undefined;
        }
        const nowIso = new Date().toISOString();
        if (body.clockIn && body.clockIn > nowIso) continue; // shift has not started yet today
        if (body.clockOut && body.clockOut > nowIso) delete body.clockOut; // still on shift
        await hr("POST", "/workforce/advanced/attendance", body);
        n++;
      }
    }
    made("attendance", n);
    // The API leaves minutes empty: derive them from clock times and the shift
    await ctx.sql(
      `UPDATE workforce_attendance_records a SET
          worked_minutes = GREATEST(0, (EXTRACT(EPOCH FROM (a.clock_out - a.clock_in)) / 60)::int - COALESCE(s.break_minutes, 0)),
          late_minutes = CASE WHEN s.start_time IS NULL THEN 0 ELSE GREATEST(0, (EXTRACT(EPOCH FROM ((a.clock_in AT TIME ZONE 'Asia/Jakarta')::time - s.start_time)) / 60)::int) END,
          early_out_minutes = CASE WHEN s.end_time IS NULL THEN 0 ELSE GREATEST(0, (EXTRACT(EPOCH FROM (s.end_time - (a.clock_out AT TIME ZONE 'Asia/Jakarta')::time)) / 60)::int) END
         FROM workforce_shifts s
        WHERE a.tenant_id = $1 AND s.id = a.shift_id AND a.clock_in IS NOT NULL AND a.clock_out IS NOT NULL AND a.worked_minutes IS NULL`,
      [tid],
    );
    await ctx.sql(
      `UPDATE workforce_attendance_records SET
          created_at = COALESCE(clock_out, attendance_date::timestamptz + interval '10 hours'),
          updated_at = COALESCE(clock_out, attendance_date::timestamptz + interval '10 hours')
        WHERE tenant_id = $1 AND created_at > now() - interval '6 hours'`,
      [tid],
    );
  }

  // =========================================================================
  // 6. Overtime requests
  // =========================================================================
  const otPlanned: Array<{ code: string; date: string; startT: string; endT: string; hours: number; reason: string; outcome: "approved" | "rejected" | "cancelled" | "pending"; actual: number }> = [];
  {
    const OT_ROLES = new Set(["COOK", "KITCHEN-HELP", "PACKER", "DRIVER", "CHEF-HEAD", "WH-STAFF", "WH-HEAD", "CLEANER", "TECH-MEP", "TECH-AC", "SPV-CLEAN"]);
    const OFFICE_OT = new Set(["BILLING-OFF", "ACCOUNTANT", "AR-AP", "HR-STAFF", "PURCH-OFF"]);
    const reasonsBy: Record<string, string[]> = {
      CATERING: ["Produksi tambahan untuk pesanan event pelanggan", "Persiapan menu katering pesanan mendadak", "Packing tambahan untuk pengiriman malam", "Persiapan paket iftar & sahur"],
      WAREHOUSE: ["Bongkar muat bahan baku datang terlambat", "Stock opname bulanan", "Penataan ulang lokasi rak gudang"],
      FACILITY: ["Pembersihan menyeluruh setelah acara pelanggan", "Perbaikan darurat AC ruang server", "Pembersihan pasca renovasi lantai 3", "General cleaning akhir pekan"],
      OFFICE: ["Penutupan buku akhir bulan", "Penyiapan tagihan pelanggan", "Rekonsiliasi pembayaran vendor", "Penyiapan data penggajian"],
    };
    const eligible = EMPLOYEES.filter((e) => OT_ROLES.has(e.positionCode) || OFFICE_OT.has(e.positionCode));
    for (const m of ctx.cal.months) {
      const base = m === "2026-03" ? 22 : 11;
      let n = Math.round(base * activityFactor(m) * (0.85 + rnd.next() * 0.35));
      const lastDay = ctx.cal.day(m, 31);
      if (m === ctx.cal.months[0]) n = Math.round(n * 0.7);
      if (m === ctx.cal.months[ctx.cal.months.length - 1]) n = 6;
      for (let i = 0; i < n; i++) {
        let d = ctx.cal.day(m, rnd.int(1, 31));
        if (m === ctx.cal.months[0]) d = max(d, addDays(start, 1));
        if (d > today) d = addDays(today, -rnd.int(0, 6));
        const w = dow(d);
        let e: EmployeeSpec | undefined;
        for (let k = 0; k < 10; k++) {
          const c = rnd.pick(eligible);
          if (activeOn(c, d) && addDays(c.joinedAt, 30) <= d) { e = c; break; }
        }
        if (!e) continue;
        if (HOLIDAYS.has(d) && !["CATERING", "FACILITY"].includes(e.org)) continue;
        const hours = rnd.pick([1.5, 2, 2, 2.5, 3, 3, 4]);
        const sc = shiftFor(e, specIdx.get(e.code)!, d) ?? "PAGI";
        const sdef = SHIFTS.find((s) => s.shiftCode === sc)!;
        const [eh] = sdef.endTime.split(":").map(Number);
        const startH = w === 0 ? 8 : eh % 24;
        const endMin = startH * 60 + hours * 60;
        const fmt = (min2: number) => `${pad(Math.floor(min2 / 60) % 24)}:${pad(min2 % 60)}`;
        const reasonPool = OFFICE_OT.has(e.positionCode) ? reasonsBy.OFFICE : reasonsBy[e.org] ?? reasonsBy.CATERING;
        const roll = rnd.next();
        let outcome: "approved" | "rejected" | "cancelled" | "pending" = roll < 0.07 ? "rejected" : roll < 0.09 ? "cancelled" : "approved";
        if (d >= addDays(today, -2) && i % 2 === 0) outcome = "pending";
        const actual = Math.max(0.5, hours + rnd.pick([-0.5, 0, 0, 0, 0.5]));
        otPlanned.push({ code: e.code, date: d, startT: fmt(startH * 60), endT: fmt(endMin), hours, reason: rnd.pick(reasonPool), outcome, actual });
      }
      void lastDay;
    }
    otPlanned.sort((a, b) => (a.date === b.date ? a.code.localeCompare(b.code) : a.date.localeCompare(b.date)));
    const have = new Set<string>(
      (await ctx.sql(`SELECT employee_id, overtime_date::text AS d FROM workforce_overtime_requests WHERE tenant_id = $1`, [tid])).map((r) => `${r.employee_id}:${r.d}`),
    );
    const stamps: Array<{ id: Id; o: (typeof otPlanned)[number]; created: string; decided: string | null }> = [];
    const seen = new Set<string>();
    // the plan depends on the shared random stream, which earlier blocks consume conditionally (e.g. today's
    // attendance rows appear as the day goes on): once a month has overtime requests, never add more to it
    const otMonths = new Set<string>(
      (await ctx.sql(`SELECT DISTINCT to_char(overtime_date, 'YYYY-MM') AS m FROM workforce_overtime_requests WHERE tenant_id = $1`, [tid])).map((r) => r.m),
    );
    for (const o of otPlanned) {
      if (otMonths.has(o.date.slice(0, 7))) continue;
      const eid = empId.get(o.code)!;
      const key = `${eid}:${o.date}`;
      if (have.has(key) || seen.has(key)) continue;
      seen.add(key);
      const r = await hr("POST", "/workforce/advanced/overtime-requests", {
        employeeId: eid, overtimeDate: o.date, startTime: o.startT, endTime: o.endT, estimatedHours: o.hours, reason: o.reason,
      });
      if (o.outcome === "approved") {
        await hr("POST", `/workforce/advanced/overtime-requests/${r.id}/actual`, { actualHours: o.actual });
        await mgr("POST", `/workforce/advanced/overtime-requests/${r.id}/act`, { actionCode: "approve", comment: "Disetujui, sesuai kebutuhan produksi" });
      } else if (o.outcome === "rejected") {
        await mgr("POST", `/workforce/advanced/overtime-requests/${r.id}/act`, { actionCode: "reject", comment: "Pekerjaan dapat diselesaikan dalam jam kerja normal" });
      } else if (o.outcome === "cancelled") {
        await mgr("POST", `/workforce/advanced/overtime-requests/${r.id}/act`, { actionCode: "cancel", comment: "Dibatalkan, lembur tidak jadi dilaksanakan" });
      }
      const created = iso(addDays(o.date, o.date === start ? 0 : -rnd.int(0, 1)) < iso(start, 8) ? start : addDays(o.date, -rnd.int(0, 1)), rnd.int(9, 16), rnd.int(0, 59));
      const decided = o.outcome === "pending" ? null : iso(min(addDays(created.slice(0, 10), 1), today), 9, rnd.int(0, 59));
      stamps.push({ id: r.id, o, created, decided });
      made("overtimeRequest");
    }
    for (const s of stamps) {
      await ctx.sql(
        `UPDATE workforce_overtime_requests SET created_at = $2, submitted_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz),
                approved_at = CASE WHEN approved_at IS NOT NULL THEN $3::timestamptz END,
                rejected_at = CASE WHEN rejected_at IS NOT NULL THEN $3::timestamptz END,
                cancelled_at = CASE WHEN cancelled_at IS NOT NULL THEN $3::timestamptz END
          WHERE id = $1`,
        [s.id, s.created, s.decided],
      );
      await backdateEntities(ctx, [{ id: s.id, start: s.created, end: s.decided }]);
    }
    await renumberYear(ctx, "workforce_overtime_requests", "request_number", "overtime_date");
  }

  // =========================================================================
  // 7. Statutory policy, salary profiles
  // =========================================================================
  {
    const ptkp = { "TK/0": 54000000, "TK/1": 58500000, "TK/2": 63000000, "TK/3": 67500000, "K/0": 58500000, "K/1": 63000000, "K/2": 67500000, "K/3": 72000000 };
    const brackets = [
      { upTo: 60000000, rate: 0.05 }, { upTo: 250000000, rate: 0.15 }, { upTo: 500000000, rate: 0.25 },
      { upTo: 5000000000, rate: 0.3 }, { upTo: null, rate: 0.35 },
    ];
    const common = {
      countryCode: "ID", bpjsKesehatanRateEmployer: 0.04, bpjsKesehatanRateEmployee: 0.01, bpjsKesehatanCap: 12000000,
      bpjsTkJhtRateEmployer: 0.037, bpjsTkJhtRateEmployee: 0.02, bpjsTkJkkRate: 0.0024, bpjsTkJkmRate: 0.003,
      bpjsTkJpRateEmployer: 0.02, bpjsTkJpRateEmployee: 0.01, occupationalCostRate: 0.05, occupationalCostMonthlyCap: 500000,
      ptkpAnnualAmounts: ptkp, pph21Brackets: brackets, pph21Method: "annualized", nonNpwpSurchargeRate: 0.2, roundingMode: "half_up",
    };
    const pols: any[] = await hr("GET", "/workforce/advanced/statutory-policies");
    const polCodes = new Set(pols.map((p) => p.policyCode));
    if (!polCodes.has("ID-STAT-2025")) {
      await hr("POST", "/workforce/advanced/statutory-policies", { ...common, policyCode: "ID-STAT-2025", name: "Ketentuan Statutori Indonesia 2025 (BPJS & PPh 21)", effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", bpjsTkJpCap: 10547400 });
      made("statutoryPolicy");
    }
    if (!polCodes.has("ID-STAT-2026")) {
      await hr("POST", "/workforce/advanced/statutory-policies", { ...common, policyCode: "ID-STAT-2026", name: "Ketentuan Statutori Indonesia 2026 (BPJS & PPh 21)", effectiveFrom: "2026-01-01", effectiveTo: null, bpjsTkJpCap: 11086300 });
      made("statutoryPolicy");
    }
    await ctx.sql(`UPDATE workforce_statutory_policies SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '2 days'`, [tid, iso(start, 10)]);

    const haveProf = new Set<string>((await ctx.sql(`SELECT employee_id FROM workforce_employee_salary_profiles WHERE tenant_id = $1`, [tid])).map((r) => r.employee_id));
    const banks = ["Bank Mandiri", "Bank Central Asia", "Bank Rakyat Indonesia", "Bank Negara Indonesia"];
    const ptkpFor = (i: number, e: EmployeeSpec): string => {
      const r = (i * 7 + e.salary / 1000) % 10;
      return e.salary > 15000000 ? (r < 7 ? "K/2" : "K/1") : r < 3 ? "TK/0" : r < 5 ? "K/0" : r < 7 ? "K/1" : r < 9 ? "K/2" : "TK/1";
    };
    let n = 0;
    for (let i = 0; i < EMPLOYEES.length; i++) {
      const e = EMPLOYEES[i];
      const eid = empId.get(e.code)!;
      if (haveProf.has(eid)) continue;
      const allowance = e.salary >= 20000000 ? 2500000 : e.salary >= 9000000 ? 1200000 : e.salary >= 6500000 ? 800000 : 500000;
      const hasNpwp = e.salary > 6500000 || i % 3 !== 0;
      const common2 = {
        employeeId: eid, ptkpStatus: ptkpFor(i, e), hasNpwp,
        bpjsKesehatanNumber: `000${(1234500000 + i * 7919).toString().slice(0, 10)}`, bpjsTkNumber: `26${(10000000 + i * 104729).toString().slice(0, 9)}`,
        bankName: banks[i % banks.length], bankAccountNumber: `${(1100000000 + i * 3571293).toString().slice(0, 10)}`,
      };
      const firstOfMonth = `${e.joinedAt.slice(0, 7)}-01`;
      const raised = e.joinedAt < "2025-12-01" && e.employmentType === "permanent";
      if (raised) {
        const old = Math.round(e.salary / 1.06 / 1000) * 1000;
        await hr("PUT", "/workforce/advanced/salary-profiles", { ...common2, baseSalary: old, fixedAllowance: Math.max(300000, allowance - 100000), overtimeHourlyRate: Math.round((old / 173) * 1.5 / 100) * 100, effectiveFrom: max(firstOfMonth, "2025-01-01") });
        await hr("PUT", "/workforce/advanced/salary-profiles", { ...common2, baseSalary: e.salary, fixedAllowance: allowance, overtimeHourlyRate: Math.round((e.salary / 173) * 1.5 / 100) * 100, effectiveFrom: "2026-01-01" });
        n += 2;
      } else {
        await hr("PUT", "/workforce/advanced/salary-profiles", { ...common2, baseSalary: e.salary, fixedAllowance: allowance, overtimeHourlyRate: Math.round((e.salary / 173) * 1.5 / 100) * 100, effectiveFrom: firstOfMonth });
        n++;
      }
    }
    made("salaryProfile", n);
    await ctx.sql(
      `UPDATE workforce_employee_salary_profiles p SET created_at = (p.effective_from + interval '8 hours') - interval '7 hours' - interval '3 days',
              updated_at = (p.effective_from + interval '8 hours') - interval '7 hours' - interval '3 days'
        WHERE p.tenant_id = $1 AND p.created_at > now() - interval '12 hours'`,
      [tid],
    );
    await ctx.sql(`UPDATE workforce_employee_salary_profiles SET created_at = GREATEST(created_at, $2::timestamptz), updated_at = GREATEST(updated_at, $2::timestamptz) WHERE tenant_id = $1 AND created_at < $2::timestamptz`, [tid, iso(start, 11)]);
  }

  // =========================================================================
  // 8. Payroll runs
  // =========================================================================
  {
    const runs = await ctx.sql(`SELECT period_year, period_month FROM workforce_payroll_runs WHERE tenant_id = $1`, [tid]);
    const haveRun = new Set(runs.map((r) => `${r.period_year}-${pad(r.period_month)}`));
    const ended = EMPLOYEES.filter((e) => e.endedAt);
    for (const m of ctx.cal.months) {
      if (haveRun.has(m)) continue;
      const [yy, mm] = m.split("-").map(Number);
      const isCurrent = m === ctx.cal.months[ctx.cal.months.length - 1];
      const first = `${m}-01`;
      // people who left later in/after this month were on the payroll then
      const flip = ended.filter((e) => e.endedAt! >= first).map((e) => empId.get(e.code)!);
      try {
        if (flip.length) await ctx.sql(`UPDATE employees SET employment_status = 'active' WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tid, flip]);
        const run = await hr("POST", "/workforce/advanced/payroll-runs", { periodMonth: mm, periodYear: yy, organizationUnitId: HEAD });
        await hr("POST", `/workforce/advanced/payroll-runs/${run.id}/calculate`);
        await hr("POST", `/workforce/advanced/payroll-runs/${run.id}/act`, { actionCode: "review", comment: "Perhitungan diperiksa, siap disetujui" });
        if (!isCurrent) await mgr("POST", `/workforce/advanced/payroll-runs/${run.id}/act`, { actionCode: "close", comment: "Disetujui dan dibayarkan via transfer bank" });
        made("payrollRun");
        // stamp dates (locked facts need replication role)
        const payDay = min(ctx.cal.day(m, 25), today);
        const calcDay = isCurrent ? addDays(today, -1) : ctx.cal.day(m, 20) < start ? start : ctx.cal.day(m, 20);
        const apprDay = isCurrent ? null : min(addDays(payDay, -1), today);
        const client = await ctx.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL session_replication_role = replica");
          await client.query(
            `UPDATE workforce_payroll_runs SET created_at = $2, calculated_at = $3, approved_at = $4, closed_at = $5, updated_at = COALESCE($5::timestamptz, $3::timestamptz) WHERE id = $1`,
            [run.id, iso(calcDay, 9), iso(calcDay, 11), apprDay ? iso(apprDay, 15) : null, isCurrent ? null : iso(payDay, 11)],
          );
          await client.query(`UPDATE workforce_payslips SET created_at = $2 WHERE payroll_run_id = $1`, [run.id, iso(calcDay, 11)]);
          if (!isCurrent) {
            await client.query(
              `UPDATE scm_accounting_ready_events SET effective_at = $3, created_at = $3 WHERE tenant_id = $1 AND source_document_id = $2 AND event_type = 'payroll.run_posted'`,
              [tid, run.id, iso(payDay, 11)],
            );
            await client.query(
              `UPDATE scm_accounting_ready_event_state_transitions SET occurred_at = $3 WHERE tenant_id = $1 AND accounting_event_id IN (SELECT id FROM scm_accounting_ready_events WHERE tenant_id = $1 AND source_document_id = $2)`,
              [tid, run.id, iso(payDay, 11)],
            );
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        await backdateEntities(ctx, [{ id: run.id, start: iso(calcDay, 9), end: isCurrent ? null : iso(payDay, 11) }]);
        await renumberYear(ctx, "workforce_payroll_runs", "run_number", "created_at", [run.id]);
      } finally {
        if (flip.length) await ctx.sql(`UPDATE employees SET employment_status = 'ended' WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tid, flip]);
      }
    }
  }

  await renumberYear(ctx, "workforce_payroll_runs", "run_number", "created_at");

  // =========================================================================
  // 9. Recruitment
  // =========================================================================
  await seedRecruitment(ctx, { hr, empId, orgByKey, posId });

  // =========================================================================
  // 10. Competencies, training, performance, career, manpower
  // =========================================================================
  await seedTalent(ctx, { hr, empId, orgByKey, posId, hrUserId, mgrUserId, specIdx });

  ctx.log(S, `created: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing new"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  void POSITIONS;
}

// ---------------------------------------------------------------------------
// Recruitment
// ---------------------------------------------------------------------------
const FIRST = ["Agus", "Budi", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hendra", "Indah", "Joko", "Kurniawan", "Lina", "Mega", "Nanda", "Oki", "Putri", "Rangga", "Sari", "Tiara", "Umar", "Vina", "Wahyu", "Yoga", "Zainal", "Adi", "Bayu", "Dian", "Erna", "Farhan", "Ghani", "Hesti", "Irfan", "Jamal", "Karina", "Lukman", "Maya", "Novi", "Prasetyo", "Rizal", "Siti"];
const LAST = ["Santoso", "Wijaya", "Pratama", "Lestari", "Hidayat", "Saputra", "Nugroho", "Rahayu", "Setiawan", "Kusuma", "Permana", "Wibowo", "Utami", "Hakim", "Maulana", "Fitriani", "Susanto", "Purnomo", "Ramadhan", "Anggraini"];
let nameSeq = 0;
function candidateName(): string {
  const f = FIRST[(nameSeq * 7 + 3) % FIRST.length];
  const l = LAST[(nameSeq * 11 + 5) % LAST.length];
  nameSeq++;
  return `${f} ${l}`;
}

interface PostingSpec {
  title: string;
  org: string;
  pos: string;
  headcount: number;
  employmentType: string;
  postedOn: string;
  closedOn?: string;
  cancelledOn?: string;
  hires: string[]; // employee codes
  applicants: number;
  jd: string;
  /** For open postings: share of candidates per stage. */
  open?: boolean;
}
const POSTINGS: PostingSpec[] = [
  { title: "Helper Dapur", org: "CATERING", pos: "KITCHEN-HELP", headcount: 1, employmentType: "contract", postedOn: "2025-11-10", closedOn: "2025-11-26", hires: ["EMP-0017"], applicants: 7, jd: "Membantu persiapan bahan, pemotongan, dan kebersihan area dapur produksi katering. Bersedia bekerja shift pagi mulai pukul 05.00." },
  { title: "QC Officer Keamanan Pangan", org: "HSE", pos: "QC-OFFICER", headcount: 1, employmentType: "contract", postedOn: "2025-11-12", closedOn: "2025-12-05", hires: ["EMP-0038"], applicants: 8, jd: "Melakukan inspeksi mutu bahan baku dan makanan jadi, audit higiene dapur, serta pelaporan temuan ke Manajer Katering. Min. D3 Teknologi Pangan/Gizi, paham HACCP." },
  { title: "Petugas Packing Katering", org: "CATERING", pos: "PACKER", headcount: 1, employmentType: "contract", postedOn: "2025-11-24", closedOn: "2025-12-19", hires: ["EMP-0018"], applicants: 6, jd: "Mengemas nasi kotak sesuai pesanan pelanggan, memberi label, dan menata ke kendaraan pengiriman." },
  { title: "Site Engineer", org: "PROJECTS", pos: "SITE-ENG", headcount: 1, employmentType: "contract", postedOn: "2025-12-08", closedOn: "2026-01-16", hires: ["EMP-0041"], applicants: 9, jd: "Mendampingi pelaksanaan proyek renovasi dan fit-out fasilitas pelanggan, membuat laporan harian dan opname volume pekerjaan. Min. S1 Teknik Sipil/Arsitektur." },
  { title: "Driver Pengiriman Katering", org: "CATERING", pos: "DRIVER", headcount: 1, employmentType: "contract", postedOn: "2026-02-23", closedOn: "2026-03-13", hires: ["EMP-0019"], applicants: 7, jd: "Mengantar pesanan katering tepat waktu ke lokasi pelanggan di Bekasi, Jakarta, dan sekitarnya. SIM A aktif, bersedia lembur saat Ramadan." },
  { title: "Sales Executive Korporat", org: "SALES", pos: "SALES-EXEC", headcount: 1, employmentType: "permanent", postedOn: "2026-04-13", closedOn: "2026-05-08", hires: ["EMP-0043"], applicants: 10, jd: "Mengembangkan pelanggan korporat baru untuk layanan katering dan facility services, menyusun penawaran, dan menjaga hubungan pelanggan." },
  { title: "Staf Gudang", org: "WAREHOUSE", pos: "WH-STAFF", headcount: 1, employmentType: "contract", postedOn: "2026-06-22", closedOn: "2026-07-17", hires: ["EMP-0045"], applicants: 6, jd: "Penerimaan barang, penataan FEFO, pencatatan keluar-masuk stok, dan stock opname." },
  { title: "Petugas Kebersihan (Pengganti & Penambahan)", org: "FACILITY", pos: "CLEANER", headcount: 2, employmentType: "contract", postedOn: "2026-07-27", closedOn: "2026-09-25", hires: ["EMP-0046", "EMP-0049"], applicants: 10, jd: "Membersihkan area kantor dan fasilitas pelanggan sesuai jadwal shift, menggunakan bahan kimia sesuai SOP." },
  { title: "Supervisor Kebersihan Area Cikarang", org: "FACILITY", pos: "SPV-CLEAN", headcount: 1, employmentType: "permanent", postedOn: "2026-05-18", closedOn: "2026-07-03", hires: [], applicants: 6, jd: "Mengawasi tim kebersihan di lokasi pelanggan, memeriksa kualitas pekerjaan, dan menyusun jadwal shift." },
  { title: "Akuntan Pajak", org: "FINANCE", pos: "ACCOUNTANT", headcount: 1, employmentType: "permanent", postedOn: "2026-03-02", cancelledOn: "2026-03-30", hires: [], applicants: 4, jd: "Mengelola pelaporan PPN dan PPh, rekonsiliasi pajak bulanan." },
  { title: "Helper Dapur (Pengganti)", org: "CATERING", pos: "KITCHEN-HELP", headcount: 1, employmentType: "contract", postedOn: "2026-10-05", hires: [], applicants: 7, open: true, jd: "Pengganti karyawan yang mengundurkan diri. Membantu persiapan dan kebersihan dapur produksi." },
  { title: "Juru Masak (Cook)", org: "CATERING", pos: "COOK", headcount: 2, employmentType: "permanent", postedOn: "2026-10-19", hires: [], applicants: 8, open: true, jd: "Memasak menu katering massal untuk 1.500+ porsi per hari, menjaga standar rasa dan higiene. Pengalaman min. 2 tahun di katering industri." },
  { title: "Teknisi AC & MEP", org: "FACILITY", pos: "TECH-AC", headcount: 1, employmentType: "contract", postedOn: "2026-10-26", hires: [], applicants: 5, open: true, jd: "Perawatan preventif dan perbaikan AC split/cassette di lokasi pelanggan. Sertifikat teknisi refrigerasi diutamakan." },
];

async function seedRecruitment(
  ctx: DemoCtx,
  h: { hr: (m: any, u: string, b?: unknown) => Promise<any>; empId: Map<string, Id>; orgByKey: Record<string, Id>; posId: Map<string, Id> },
): Promise<void> {
  const tid = ctx.tenantId;
  const today = ctx.cal.today;
  const iso = (d: string, hh: number, mm = 0) => ctx.cal.at(d, hh, mm);
  const have = new Map<string, Id>(
    (await ctx.sql(`SELECT title, id FROM workforce_job_postings WHERE tenant_id = $1`, [tid])).map((r) => [r.title, r.id]),
  );
  const specs = [...POSTINGS].sort((a, b) => a.postedOn.localeCompare(b.postedOn));
  for (const p of specs) {
    if (have.has(p.title)) continue;
    const post = await h.hr("POST", "/workforce/advanced/job-postings", {
      title: p.title, positionId: h.posId.get(p.pos), organizationUnitId: h.orgByKey[p.org], headcountTarget: p.headcount, employmentType: p.employmentType, jobDescription: p.jd,
    });
    await h.hr("POST", `/workforce/advanced/job-postings/${post.id}/act`, { actionCode: "publish", comment: "Dipublikasikan di situs karier dan portal lowongan" });
    if (p.closedOn) await h.hr("POST", `/workforce/advanced/job-postings/${post.id}/act`, { actionCode: "close", comment: p.hires.length ? "Posisi terisi" : "Ditutup, belum ada kandidat yang sesuai" });
    if (p.cancelledOn) await h.hr("POST", `/workforce/advanced/job-postings/${post.id}/act`, { actionCode: "cancel", comment: "Dibatalkan karena pembekuan anggaran perekrutan" });
    made("jobPosting");

    // applications ---------------------------------------------------------
    const hireNames = p.hires.map((c) => EMPLOYEES.find((e) => e.code === c)!);
    const span = p.closedOn ?? p.cancelledOn ?? today;
    const total = p.applicants;
    const decidedBy = (n: number) => min2(addDays(p.postedOn, 7 + n * 2 + 5), span);
    let hiredSoFar = 0;
    const stamps: Array<{ id: Id; applied: string; decided: string | null }> = [];
    for (let i = 0; i < total; i++) {
      const isHire = hiredSoFar < hireNames.length && i === Math.floor((i + 1) * 0 + (hiredSoFar === 0 ? 2 : 5));
      const hire = isHire ? hireNames[hiredSoFar] : null;
      const name = hire ? hire.fullName : candidateName();
      const slug = name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
      const appliedOn = min2(addDays(p.postedOn, Math.min(i * 2 + rnd.int(0, 2), Math.max(1, Math.floor((new Date(span).getTime() - new Date(p.postedOn).getTime()) / 86400000) - 3))), today);
      const app = await h.hr("POST", "/workforce/advanced/job-applications", {
        jobPostingId: post.id, candidateName: name, candidateEmail: `${slug}@mail.example.co.id`, candidatePhone: hire ? hire.phone : `0821${rnd.int(10000000, 99999999)}`,
      });
      let decided: string | null = null;
      const advance = (stage: string, rating: number | null, notes: string) =>
        h.hr("POST", `/workforce/advanced/job-applications/${app.id}/stage`, { stage, rating, interviewerNotes: notes, ...(stage === "hired" ? { hiredEmployeeId: h.empId.get(hire!.code) } : {}) });
      if (hire) {
        await advance("screening", 4, "CV sesuai kualifikasi, lolos penyaringan administrasi");
        await advance("interview", 4, "Wawancara HR & user baik, komunikasi jelas, siap bergabung sesuai jadwal");
        await advance("offer", 5, "Penawaran disampaikan, kandidat menerima");
        await advance("hired", 5, `Bergabung ${hire.joinedAt}`);
        decided = iso(addDays(hire.joinedAt, -rnd.int(3, 9)) > today ? today : addDays(hire.joinedAt, -rnd.int(3, 9)), 14);
        hiredSoFar++;
      } else if (p.open) {
        const stage = pickW([["applied", 3], ["screening", 3], ["interview", 3], ["offer", 1], ["rejected", 1]] as const);
        if (stage !== "applied") await advance("screening", rnd.int(2, 4), "Penyaringan CV oleh HR");
        if (stage === "interview" || stage === "offer") await advance("interview", rnd.int(3, 5), "Wawancara terjadwal / sudah dilakukan, menunggu hasil user");
        if (stage === "offer") await advance("offer", rnd.int(4, 5), "Penawaran sedang dinegosiasikan");
        if (stage === "rejected") { await advance("rejected", 2, "Tidak memenuhi kualifikasi minimum"); decided = iso(addDays(today, -rnd.int(1, 6)), 11); }
      } else {
        const outcome = pickW([["rejected_cv", 4], ["rejected_int", 3], ["withdrawn", 1], ["declined_offer", p.hires.length ? 0 : 1]] as const);
        if (outcome === "rejected_cv") { await advance("rejected", rnd.int(1, 2), "Pengalaman tidak sesuai kebutuhan posisi"); }
        else {
          await advance("screening", rnd.int(3, 4), "Lolos penyaringan administrasi");
          if (outcome === "rejected_int") { await advance("interview", rnd.int(2, 3), "Kompetensi teknis belum memadai"); await advance("rejected", 2, "Tidak lolos wawancara user"); }
          else if (outcome === "withdrawn") { await advance("withdrawn", null as any, "Kandidat mengundurkan diri, menerima tawaran lain"); }
          else { await advance("interview", 4, "Wawancara baik"); await advance("offer", 4, "Penawaran diberikan"); await advance("withdrawn", 4, "Kandidat menolak penawaran (ekspektasi gaji lebih tinggi)"); }
        }
        decided = iso(decidedBy(i), 13);
      }
      stamps.push({ id: app.id, applied: iso(appliedOn, rnd.int(8, 17), rnd.int(0, 59)), decided: decided ? decided : null });
      made("jobApplication");
    }
    for (const s of stamps) {
      await ctx.sql(
        `UPDATE workforce_job_applications SET applied_at = $2, created_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz), decided_at = CASE WHEN decided_at IS NOT NULL THEN COALESCE($3::timestamptz, $2::timestamptz + interval '5 days') END WHERE id = $1`,
        [s.id, s.applied, s.decided],
      );
    }
    // posting dates
    const created = iso(p.postedOn, 9, 15);
    const closed = p.closedOn ? iso(p.closedOn, 16) : p.cancelledOn ? iso(p.cancelledOn, 11) : null;
    await ctx.sql(
      `UPDATE workforce_job_postings SET created_at = $2, published_at = CASE WHEN published_at IS NOT NULL THEN $2::timestamptz + interval '3 hours' END,
              closed_at = CASE WHEN closed_at IS NOT NULL THEN $3::timestamptz END, updated_at = COALESCE($3::timestamptz, $2::timestamptz + interval '3 hours') WHERE id = $1`,
      [post.id, created, closed],
    );
    await backdateEntities(ctx, [{ id: post.id, start: created, end: closed }]);
    await renumberYear(ctx, "workforce_job_postings", "posting_code", "created_at", [post.id]);
  }
}
const min2 = (a: string, b: string) => (a < b ? a : b);

// ---------------------------------------------------------------------------
// Talent: competencies, training, reviews, career paths, manpower plans
// ---------------------------------------------------------------------------
const COMPETENCIES = [
  { code: "COM-HACCP", name: "Keamanan Pangan (HACCP)", category: "Teknis" },
  { code: "COM-SANI", name: "Sanitasi & Higiene", category: "Teknis" },
  { code: "COM-COOK", name: "Teknik Memasak Massal", category: "Teknis" },
  { code: "COM-DRV", name: "Mengemudi Defensif", category: "Teknis" },
  { code: "COM-MEP", name: "Perawatan MEP & AC", category: "Teknis" },
  { code: "COM-K3", name: "Keselamatan & Kesehatan Kerja", category: "Wajib" },
  { code: "COM-CS", name: "Pelayanan Pelanggan", category: "Perilaku" },
  { code: "COM-TEAM", name: "Kerja Sama Tim", category: "Perilaku" },
  { code: "COM-LEAD", name: "Kepemimpinan", category: "Manajerial" },
  { code: "COM-ANL", name: "Analisis & Pelaporan", category: "Manajerial" },
];

const COURSES = [
  { courseCode: "TRN-HACCP", title: "Keamanan Pangan & HACCP untuk Penjamah Makanan", provider: "LPK Boga Sehat Nusantara", durationHours: 16, comp: "COM-HACCP" },
  { courseCode: "TRN-SANI", title: "Sanitasi dan Higiene Penjamah Makanan", provider: "LPK Boga Sehat Nusantara", durationHours: 8, comp: "COM-SANI" },
  { courseCode: "TRN-K3", title: "K3 Dasar & Penanggulangan Kebakaran (APAR)", provider: "Pusat Pelatihan K3 Mandiri", durationHours: 8, comp: "COM-K3" },
  { courseCode: "TRN-P3K", title: "Pertolongan Pertama pada Kecelakaan (P3K)", provider: "Pusat Pelatihan K3 Mandiri", durationHours: 8, comp: "COM-K3" },
  { courseCode: "TRN-DDRV", title: "Defensive Driving untuk Pengemudi Niaga", provider: "Akademi Berkendara Aman", durationHours: 8, comp: "COM-DRV" },
  { courseCode: "TRN-MEP", title: "Perawatan Preventif Sistem MEP & AC", provider: "Balai Latihan Teknik Terpadu", durationHours: 24, comp: "COM-MEP" },
  { courseCode: "TRN-CS", title: "Service Excellence & Penanganan Komplain Pelanggan", provider: "Insight Training Center", durationHours: 8, comp: "COM-CS" },
  { courseCode: "TRN-LEAD", title: "Dasar Kepemimpinan Lini Pertama", provider: "Insight Training Center", durationHours: 16, comp: "COM-LEAD" },
  { courseCode: "TRN-CHEM", title: "Penanganan Bahan Kimia Pembersih (Chemical Handling)", provider: "Pusat Pelatihan K3 Mandiri", durationHours: 4, comp: "COM-SANI" },
  { courseCode: "TRN-PAJAK", title: "Pembaruan PPh 21 & BPJS untuk Tim Payroll", provider: "Konsultan Pajak Cakrawala", durationHours: 6, comp: "COM-ANL" },
];

async function seedTalent(
  ctx: DemoCtx,
  h: { hr: (m: any, u: string, b?: unknown) => Promise<any>; empId: Map<string, Id>; orgByKey: Record<string, Id>; posId: Map<string, Id>; hrUserId: Id; mgrUserId: Id; specIdx: Map<string, number> },
): Promise<void> {
  const tid = ctx.tenantId;
  const today = ctx.cal.today;
  const start = ctx.cal.start;
  const iso = (d: string, hh: number, mm = 0) => ctx.cal.at(d, hh, mm);
  const E = (c: string) => h.empId.get(c)!;

  // -- competencies ----------------------------------------------------------
  const compRows: any[] = await h.hr("GET", "/workforce/advanced/competencies?includeInactive=true");
  const compId = new Map<string, Id>(compRows.map((c) => [c.code, c.id]));
  for (const c of COMPETENCIES) {
    if (compId.has(c.code)) continue;
    const r = await h.hr("POST", "/workforce/advanced/competencies", { ...c, description: `Kompetensi ${c.name}`, scaleMin: 1, scaleMax: 5 });
    compId.set(c.code, r.id);
    made("competency");
  }
  await ctx.sql(`UPDATE workforce_competencies SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '2 days'`, [tid, iso(start, 10)]);

  // assessments: two cycles per person; levels follow tenure
  const compFor = (e: EmployeeSpec): string[] => {
    const p = e.positionCode;
    if (["COOK", "CHEF-HEAD"].includes(p)) return ["COM-HACCP", "COM-COOK", "COM-K3", "COM-TEAM"];
    if (["KITCHEN-HELP", "PACKER"].includes(p)) return ["COM-HACCP", "COM-SANI", "COM-TEAM"];
    if (p === "DRIVER") return ["COM-DRV", "COM-CS", "COM-K3"];
    if (["CLEANER", "SPV-CLEAN"].includes(p)) return ["COM-SANI", "COM-K3", "COM-TEAM"];
    if (["TECH-MEP", "TECH-AC"].includes(p)) return ["COM-MEP", "COM-K3"];
    if (["QC-OFFICER"].includes(p)) return ["COM-HACCP", "COM-ANL", "COM-K3"];
    if (["HSE-OFF"].includes(p)) return ["COM-K3", "COM-ANL"];
    if (e.positionCode.startsWith("MGR") || ["GM-OPS", "DIR", "COORD-OPS", "WH-HEAD", "PM"].includes(p)) return ["COM-LEAD", "COM-ANL", "COM-TEAM"];
    if (["SALES-EXEC", "CS-OFF"].includes(p)) return ["COM-CS", "COM-TEAM"];
    return ["COM-ANL", "COM-TEAM"];
  };
  const haveAss = new Set<string>((await ctx.sql(`SELECT employee_id, competency_id FROM workforce_employee_competencies WHERE tenant_id = $1`, [tid])).map((r) => `${r.employee_id}:${r.competency_id}`));
  let nAss = 0;
  const assessed: Array<{ emp: Id; comp: Id; on: string }> = [];
  for (const e of EMPLOYEES) {
    if (e.joinedAt > addDays(today, -60)) continue;
    const tenureYrs = (new Date(today).getTime() - new Date(e.joinedAt).getTime()) / (365 * 86400000);
    for (const cc of compFor(e)) {
      const key = `${E(e.code)}:${compId.get(cc)}`;
      if (haveAss.has(key)) continue;
      const level = Math.max(1, Math.min(5, Math.round(1.5 + Math.min(tenureYrs, 5) * 0.55 + rnd.pick([-1, 0, 0, 1]))));
      const on = rnd.chance(0.5) ? ctx.cal.day("2026-01", rnd.int(14, 28)) : ctx.cal.day("2026-07", rnd.int(10, 28));
      await h.hr("PUT", "/workforce/advanced/employee-competencies", { employeeId: E(e.code), competencyId: compId.get(cc), proficiencyLevel: level, notes: level >= 4 ? "Dapat menjadi mentor rekan kerja" : level <= 2 ? "Perlu pelatihan lanjutan" : null });
      assessed.push({ emp: E(e.code), comp: compId.get(cc)!, on });
      nAss++;
    }
  }
  made("competencyAssessment", nAss);
  for (const a of assessed) {
    await ctx.sql(`UPDATE workforce_employee_competencies SET last_assessed_date = $3::date, created_at = $4, updated_at = $4 WHERE employee_id = $1 AND competency_id = $2`, [a.emp, a.comp, a.on, iso(a.on, 14)]);
  }

  // -- training courses ------------------------------------------------------
  const courseRows: any[] = await h.hr("GET", "/workforce/advanced/training-courses?includeInactive=true");
  const courseId = new Map<string, Id>(courseRows.map((c) => [c.courseCode, c.id]));
  for (const c of COURSES) {
    if (courseId.has(c.courseCode)) continue;
    const r = await h.hr("POST", "/workforce/advanced/training-courses", { courseCode: c.courseCode, title: c.title, provider: c.provider, durationHours: c.durationHours, competencyId: compId.get(c.comp), description: `${c.title} — ${c.durationHours} jam, sertifikat kehadiran.` });
    courseId.set(c.courseCode, r.id);
    made("trainingCourse");
  }
  await ctx.sql(`UPDATE workforce_training_courses SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '2 days'`, [tid, iso(start, 10, 30)]);

  // batches: course, date, filter, count limit
  const byOrg = (...orgs: string[]) => EMPLOYEES.filter((e) => orgs.includes(e.org));
  const byPos = (...ps: string[]) => EMPLOYEES.filter((e) => ps.includes(e.positionCode));
  const batches: Array<{ course: string; on: string; people: EmployeeSpec[]; upcoming?: boolean }> = [
    { course: "TRN-SANI", on: "2025-11-25", people: byPos("KITCHEN-HELP", "PACKER", "COOK") },
    { course: "TRN-HACCP", on: "2025-12-10", people: byPos("COOK", "CHEF-HEAD", "KITCHEN-HELP", "QC-OFFICER") },
    { course: "TRN-K3", on: "2026-01-21", people: [...byOrg("CATERING"), ...byOrg("FACILITY"), ...byOrg("WAREHOUSE")] },
    { course: "TRN-CHEM", on: "2026-02-12", people: byPos("CLEANER", "SPV-CLEAN") },
    { course: "TRN-DDRV", on: "2026-03-05", people: byPos("DRIVER") },
    { course: "TRN-PAJAK", on: "2026-03-10", people: byPos("HR-STAFF", "ACCOUNTANT", "AR-AP", "BILLING-OFF", "MGR-HR") },
    { course: "TRN-CS", on: "2026-04-16", people: byPos("SALES-EXEC", "CS-OFF", "COORD-OPS", "DRIVER") },
    { course: "TRN-MEP", on: "2026-05-19", people: byPos("TECH-MEP", "TECH-AC", "ASSET-OFF") },
    { course: "TRN-LEAD", on: "2026-06-24", people: byPos("COORD-OPS", "SPV-CLEAN", "CHEF-HEAD", "WH-HEAD", "QC-OFFICER") },
    { course: "TRN-P3K", on: "2026-08-19", people: [...byPos("COOK", "CLEANER", "WH-STAFF", "HSE-OFF", "DRIVER")] },
    { course: "TRN-HACCP", on: "2026-09-23", people: EMPLOYEES.filter((e) => e.joinedAt >= "2026-01-01" && e.org === "CATERING") },
    { course: "TRN-K3", on: "2026-11-19", people: [...byOrg("CATERING", "FACILITY")].slice(0, 14), upcoming: true },
    { course: "TRN-DDRV", on: "2026-11-24", people: byPos("DRIVER"), upcoming: true },
  ];
  const haveEnr = new Set<string>((await ctx.sql(`SELECT training_course_id, employee_id FROM workforce_training_enrollments WHERE tenant_id = $1`, [tid])).map((r) => `${r.training_course_id}:${r.employee_id}`));
  const enrStamps: Array<{ id: Id; enrolled: string; completed: string | null }> = [];
  let failedLeft = 2;
  for (const b of batches) {
    for (const e of b.people) {
      if (!activeEmp(e, b.on) && !b.upcoming) continue;
      if (b.upcoming && (e.endedAt || e.joinedAt > today)) continue;
      const cid = courseId.get(b.course)!;
      const key = `${cid}:${E(e.code)}`;
      if (haveEnr.has(key)) continue;
      haveEnr.add(key);
      const enr = await h.hr("POST", "/workforce/advanced/training-enrollments", { trainingCourseId: cid, employeeId: E(e.code) });
      let completed: string | null = null;
      if (!b.upcoming) {
        const fail = failedLeft > 0 && rnd.chance(0.04);
        if (fail) failedLeft--;
        const score = fail ? rnd.int(45, 59) : rnd.int(72, 98);
        await h.hr("POST", `/workforce/advanced/training-enrollments/${enr.id}/complete`, { status: fail ? "failed" : "completed", completionDate: b.on, score });
        completed = b.on;
      }
      enrStamps.push({ id: enr.id, enrolled: iso(max2(start, addDays(b.on, -14)), 10), completed });
      made("trainingEnrollment");
    }
  }
  for (const s of enrStamps) {
    await ctx.sql(`UPDATE workforce_training_enrollments SET enrolled_at = $2, created_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz) WHERE id = $1`, [s.id, s.enrolled, s.completed ? iso(s.completed, 16) : null]);
  }

  // -- career paths -----------------------------------------------------------
  const cpHave = new Set<string>((await ctx.sql(`SELECT from_position_id, to_position_id FROM workforce_career_paths WHERE tenant_id = $1`, [tid])).map((r) => `${r.from_position_id}:${r.to_position_id}`));
  const paths: Array<[string, string, number, string[], string]> = [
    ["KITCHEN-HELP", "COOK", 18, ["COM-HACCP", "COM-COOK"], "Lulus pelatihan HACCP, penilaian juru masak senior min. 3."],
    ["COOK", "CHEF-HEAD", 36, ["COM-COOK", "COM-LEAD"], "Memimpin produksi min. 1.000 porsi/hari, lulus Dasar Kepemimpinan."],
    ["CLEANER", "SPV-CLEAN", 30, ["COM-SANI", "COM-LEAD"], "Rekam jejak kehadiran baik dan lulus Chemical Handling."],
    ["WH-STAFF", "WH-HEAD", 36, ["COM-ANL", "COM-LEAD"], "Menguasai FEFO dan stock opname, lulus Dasar Kepemimpinan."],
    ["SITE-ENG", "PM", 36, ["COM-ANL", "COM-LEAD"], "Menangani min. 2 proyek hingga serah terima."],
    ["SALES-EXEC", "MGR-FIN", 60, ["COM-ANL"], "Contoh jalur lintas fungsi — evaluasi kasus per kasus."],
    ["DRIVER", "COORD-OPS", 48, ["COM-DRV", "COM-CS", "COM-LEAD"], "Rekam jejak keselamatan berkendara bersih dan tanpa keterlambatan berulang."],
  ];
  for (const [f, tt, months, comps, guide] of paths) {
    const from = h.posId.get(f), to = h.posId.get(tt);
    if (!from || !to || cpHave.has(`${from}:${to}`)) continue;
    if (f === "SALES-EXEC") continue; // keep the registry plausible
    await h.hr("POST", "/workforce/advanced/career-paths", { fromPositionId: from, toPositionId: to, requiredTenureMonths: months, requiredCompetencyIds: comps.map((c) => compId.get(c)), guidelines: guide });
    made("careerPath");
  }
  await ctx.sql(`UPDATE workforce_career_paths SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '2 days'`, [tid, iso("2026-01-12", 10)]);

  // -- performance reviews ----------------------------------------------------
  const haveRev = new Set<string>((await ctx.sql(`SELECT employee_id, period_start::text AS ps FROM workforce_performance_reviews WHERE tenant_id = $1`, [tid])).map((r) => `${r.employee_id}:${r.ps}`));
  type RevPlan = { code: string; ps: string; pe: string; createdOn: string; finalize: boolean; submit: boolean; label: string };
  const revs: RevPlan[] = [];
  for (const e of EMPLOYEES) {
    if (e.joinedAt <= "2025-09-30" && (!e.endedAt || e.endedAt >= "2026-01-31")) revs.push({ code: e.code, ps: "2025-07-01", pe: "2025-12-31", createdOn: ctx.cal.day("2026-01", rnd.int(12, 28)), finalize: true, submit: true, label: "Semester II 2025" });
    if (e.joinedAt <= "2026-03-31" && (!e.endedAt || e.endedAt >= "2026-08-01")) revs.push({ code: e.code, ps: "2026-01-01", pe: "2026-06-30", createdOn: ctx.cal.day("2026-07", rnd.int(10, 30)), finalize: true, submit: true, label: "Semester I 2026" });
  }
  const probation: Array<[string, string, string, string]> = [
    ["EMP-0017", "2025-12-01", "2026-02-28", "2026-03-06"], ["EMP-0038", "2025-12-15", "2026-03-14", "2026-03-20"], ["EMP-0018", "2026-01-05", "2026-04-04", "2026-04-09"],
    ["EMP-0041", "2026-02-02", "2026-05-01", "2026-05-07"], ["EMP-0019", "2026-04-01", "2026-06-30", "2026-07-06"], ["EMP-0043", "2026-06-01", "2026-08-31", "2026-09-07"],
    ["EMP-0045", "2026-08-03", "2026-11-02", "2026-11-06"],
  ];
  for (const [c, ps, pe, on] of probation) revs.push({ code: c, ps, pe, createdOn: on, finalize: on < ctx.cal.day("2026-11", 1), submit: true, label: "Evaluasi masa percobaan" });
  // the last cohort of the mid-year cycle is still waiting for HR to finalise
  const pendingJul = revs.filter((r) => r.ps === "2026-01-01").slice(-5);
  for (const r of pendingJul) { r.finalize = false; r.createdOn = ctx.cal.day("2026-10", 26 + (revs.indexOf(r) % 3)); }
  const lastProb = revs.find((r) => r.code === "EMP-0045");
  if (lastProb) { lastProb.submit = false; lastProb.finalize = false; }
  revs.sort((a, b) => (a.createdOn === b.createdOn ? a.code.localeCompare(b.code) : a.createdOn.localeCompare(b.createdOn)));
  const NOTES_GOOD = ["Kinerja konsisten, target produksi tercapai, disiplin baik.", "Inisiatif tinggi dan kooperatif dengan rekan satu tim.", "Hasil kerja rapi dan tepat waktu; menjadi rujukan rekan baru.", "Kehadiran sangat baik, kualitas pekerjaan di atas ekspektasi."];
  const NOTES_MID = ["Kinerja memadai; perlu meningkatkan ketelitian pencatatan.", "Target tercapai sebagian, perlu pendampingan pada keterampilan teknis.", "Disiplin baik, perlu lebih proaktif melaporkan kendala."];
  const DEV = ["Mengikuti pelatihan sertifikasi sesuai bidang dalam 6 bulan ke depan.", "Pendampingan oleh senior selama 3 bulan.", "Rotasi tugas untuk memperluas pengalaman.", "Persiapan jalur promosi ke posisi lead."];
  const stampsRev: Array<{ id: Id; created: string; submitted: string | null; finalized: string | null }> = [];
  for (const r of revs) {
    if (haveRev.has(`${E(r.code)}:${r.ps}`)) continue;
    const goals = Number((3 + rnd.next() * 1.8).toFixed(1));
    const comp = Number((3 + rnd.next() * 1.8).toFixed(1));
    const overall = Number(((goals * 0.6 + comp * 0.4)).toFixed(1));
    const created = await h.hr("POST", "/workforce/advanced/performance-reviews", {
      employeeId: E(r.code), periodStart: r.ps, periodEnd: r.pe, reviewerUserId: h.mgrUserId, goalsScore: goals, competencyScore: comp, overallRating: overall,
      reviewNotes: `${r.label}: ${overall >= 4.2 ? rnd.pick(NOTES_GOOD) : rnd.pick(NOTES_MID)}`, developmentPlan: rnd.pick(DEV),
    });
    if (r.submit) await h.hr("POST", `/workforce/advanced/performance-reviews/${created.id}/act`, { actionCode: "submit", comment: "Penilaian atasan langsung telah diisi" });
    if (r.finalize) await h.hr("POST", `/workforce/advanced/performance-reviews/${created.id}/act`, { actionCode: "finalize", comment: "Dibahas bersama karyawan dan difinalisasi" });
    const c = iso(r.createdOn, 10);
    const sub = r.submit ? iso(min2(addDays(r.createdOn, 2), today), 11) : null;
    const fin = r.finalize ? iso(min2(addDays(r.createdOn, 6), today), 15) : null;
    stampsRev.push({ id: created.id, created: c, submitted: sub, finalized: fin });
    made("performanceReview");
  }
  for (const s of stampsRev) {
    await ctx.sql(
      `UPDATE workforce_performance_reviews SET created_at = $2, submitted_at = CASE WHEN submitted_at IS NOT NULL THEN $3::timestamptz END,
              finalized_at = CASE WHEN finalized_at IS NOT NULL THEN $4::timestamptz END, updated_at = COALESCE($4::timestamptz, $3::timestamptz, $2::timestamptz) WHERE id = $1`,
      [s.id, s.created, s.submitted, s.finalized],
    );
    await backdateEntities(ctx, [{ id: s.id, start: s.created, end: s.finalized ?? s.submitted }]);
  }
  if (stampsRev.length) await renumberYear(ctx, "workforce_performance_reviews", "review_code", "created_at", stampsRev.map((s) => s.id));

  // -- manpower plans ---------------------------------------------------------
  const havePlan = new Set<string>((await ctx.sql(`SELECT title FROM workforce_manpower_plans WHERE tenant_id = $1`, [tid])).map((r) => r.title));
  const headcount = (codes: string[]) => EMPLOYEES.filter((e) => !e.endedAt && codes.includes(e.positionCode)).length;
  const target = (extra: Record<string, number>) => {
    const t: Record<string, number> = {};
    for (const [code, add] of Object.entries(extra)) {
      const pid = h.posId.get(code);
      if (pid) t[pid] = headcount([code]) + add;
    }
    return t;
  };
  const plans: Array<{ title: string; year: number; org?: string; created: string; targets: Record<string, number>; action: "apply" | "dismiss" | "compute" | "none"; actedOn?: string }> = [
    { title: "Rencana Tenaga Kerja 2026 — Perusahaan", year: 2026, org: "HEAD_OFFICE", created: "2025-12-08", targets: target({ COOK: 1, DRIVER: 1, CLEANER: 2, "SALES-EXEC": 1, "SITE-ENG": 1 }), action: "apply", actedOn: "2026-01-13" },
    { title: "Penambahan Armada & Driver Katering 2026", year: 2026, org: "CATERING", created: "2026-05-20", targets: target({ DRIVER: 3 }), action: "dismiss", actedOn: "2026-06-05" },
    { title: "Kebutuhan SDM Katering — Lonjakan Order Q4 2026", year: 2026, org: "CATERING", created: "2026-10-12", targets: target({ COOK: 2, "KITCHEN-HELP": 3, PACKER: 2, DRIVER: 1 }), action: "compute" },
    { title: "Rencana Tenaga Kerja 2027 — Perusahaan", year: 2027, org: "HEAD_OFFICE", created: "2026-11-03", targets: target({ COOK: 3, "KITCHEN-HELP": 3, CLEANER: 4, "TECH-AC": 1, "WH-STAFF": 1, "SALES-EXEC": 1, PM: 1 }), action: "compute" },
    { title: "Skenario Ekspansi Facility Services 2027", year: 2027, org: "FACILITY", created: "2026-11-06", targets: {}, action: "none" },
  ];
  for (const p of plans) {
    if (havePlan.has(p.title)) continue;
    const plan = await h.hr("POST", "/workforce/advanced/manpower-plans", {
      planYear: p.year, organizationUnitId: p.org ? h.orgByKey[p.org] : null, title: p.title,
      parameters: { asumsiPertumbuhanOrder: p.year === 2027 ? "18%" : "12%", sumber: "Proyeksi Business Development & Operasional" },
    });
    if (p.action !== "none") await h.hr("POST", `/workforce/advanced/manpower-plans/${plan.id}/compute`, { targetHeadcountByPosition: p.targets });
    if (p.action === "apply") await h.hr("POST", `/workforce/advanced/manpower-plans/${plan.id}/apply`);
    if (p.action === "dismiss") await h.hr("POST", `/workforce/advanced/manpower-plans/${plan.id}/dismiss`);
    const created = iso(p.created, 10);
    const computed = p.action === "none" ? null : iso(addDays(p.created, 1), 11);
    const acted = p.actedOn ? iso(p.actedOn, 14) : null;
    await ctx.sql(
      `UPDATE workforce_manpower_plans SET created_at = $2, computed_at = CASE WHEN computed_at IS NOT NULL THEN $3::timestamptz END,
              applied_at = CASE WHEN applied_at IS NOT NULL THEN $4::timestamptz END, updated_at = COALESCE($4::timestamptz, $3::timestamptz, $2::timestamptz) WHERE id = $1`,
      [plan.id, created, computed, acted],
    );
    await renumberYear(ctx, "workforce_manpower_plans", "plan_number", "created_at", [plan.id]);
    made("manpowerPlan");
  }
}

function activeEmp(e: EmployeeSpec, d: string) {
  return e.joinedAt <= d && (!e.endedAt || d <= e.endedAt);
}
const max2 = (a: string, b: string) => (a > b ? a : b);
