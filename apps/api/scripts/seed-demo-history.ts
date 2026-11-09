/**
 * Demo history seed: makes the demo tenant (demo-gs, created by seed.ts) look
 * like a company that has been operating for a year — every sector gets
 * twelve months of realistic, linked records.
 *
 * Runs the real API in-process (no network, no rate limits) as the tenant
 * admin, then backdates business timestamps with SQL. Synthetic data only.
 * Idempotent: every sector module skips records that already exist, so a
 * failed run can simply be re-run.
 *
 * Usage:
 *   npm run seed:demo-history -w apps/api                 # all sectors
 *   npm run seed:demo-history -w apps/api -- finance hse  # only these
 *
 * Env: DATABASE_URL (required), DEMO_TENANT_CODE (default demo-gs),
 *      DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD (default: the seed.ts admin).
 */
import "dotenv/config";

// The in-process app must not throttle or schedule while seeding.
process.env.RATE_LIMIT_GLOBAL_MAX = "100000000"; // dotenv already loaded .env, so ??= would keep the throttled dev values
process.env.AUTH_RATE_LIMIT_MAX = "100000"; // dotenv already loaded .env, so ??= would keep the throttled dev values
process.env.SWITCH_ROLE_RATE_LIMIT_MAX = "100000"; // dotenv already loaded .env, so ??= would keep the throttled dev values
process.env.SCHEDULER_DISABLED = "true";
process.env.LOG_LEVEL ??= "warn";

import type { DemoCtx } from "./demo-history/harness.js";
import { SECTORS } from "./demo-history/sectors.js";

async function main() {
  const { buildApp } = await import("../src/app.js");
  const { pool } = await import("../src/infrastructure/persistence/db.js");
  const { makeCtx } = await import("./demo-history/harness.js");

  const app = buildApp();
  await app.ready();
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  let failed = 0;
  try {
    const ctx: DemoCtx = await makeCtx(app, pool, {
      tenantCode: process.env.DEMO_TENANT_CODE ?? "demo-gs",
      email: process.env.DEMO_ADMIN_EMAIL ?? "admin@demo.local",
      password: process.env.DEMO_ADMIN_PASSWORD ?? "admin123!",
    });
    ctx.log("runner", `tenant ${ctx.tenantCode}, history ${ctx.cal.start} → ${ctx.cal.today}`);
    for (const sector of SECTORS) {
      if (only.length > 0 && !only.includes(sector.key)) continue;
      const t0 = Date.now();
      try {
        await sector.run(ctx);
        ctx.log(sector.key, `done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        failed++;
        console.error(`[demo:${sector.key}] FAILED:`, err instanceof Error ? err.message : err);
        if (process.env.DEMO_STOP_ON_ERROR === "1") throw err;
      }
    }
  } finally {
    await app.close();
    await pool.end();
  }
  if (failed > 0) {
    console.error(`[demo] ${failed} sector(s) failed — fix and re-run (idempotent).`);
    process.exit(1);
  }
}

void main();
