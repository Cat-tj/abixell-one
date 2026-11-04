#!/usr/bin/env node
/**
 * One-off maintenance: delete leftover integration-test tenants (codes
 * starting with test-, ep, dbg-, or containing test-<timestamp> patterns).
 * Test tenants are deleted by their own afterAll hooks, but crashes/timeouts
 * (like the PC crash earlier today) leave thousands of rows behind, which
 * slows every subsequent test run via index bloat and seq scans.
 *
 * Safe guards: only deletes tenants matching the test-code patterns, never
 * the demo tenant, never reports success on partial failure.
 */
import "dotenv/config";
import pg from "pg";

const PATTERNS = ["test-%", "ep2w23-%", "dbg-%"];

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT code, count(*) OVER () AS total FROM tenants
      WHERE code LIKE ANY($1) AND code <> 'demo-gs' LIMIT 5`,
    [PATTERNS],
  );
  if (rows.length === 0) {
    console.log("No leftover test tenants found.");
    await pool.end();
    return;
  }
  const total = rows[0].total;
  console.log(`Deleting ${total} leftover test tenants...`);
  const result = await pool.query(
    `DELETE FROM tenants WHERE code LIKE ANY($1) AND code <> 'demo-gs'`,
    [PATTERNS],
  );
  console.log(`Deleted: ${result.rowCount}`);
  await pool.query(`VACUUM ANALYZE tenants`);
  console.log("VACUUM done.");
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exitCode = 1;
});
