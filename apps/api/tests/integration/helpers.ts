import { config } from "dotenv";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { createSession } from "../../src/application/identity/session.service.js";
import { signAccessToken } from "../../src/infrastructure/security/jwt.js";
import { hashPassword } from "../../src/infrastructure/security/password.js";

config({ path: resolve(__dirname, "../../.env") });

/**
 * Test helpers mirror the REAL bootstrap flow for a brand-new dedicated
 * deployment: (1) Tenant is created via the platform-bootstrap endpoint
 * (shared secret, no user exists yet), then (2) the very first
 * Administrator is provisioned directly against the database — exactly
 * what a provisioning script would do, because there is no authenticated
 * user yet to call an API with. Every step after that goes through the
 * real HTTP API + RBAC, no shortcuts.
 */

export async function bootstrapTenant(app: FastifyInstance, code: string, name: string) {
  const bootstrapKey = process.env.PLATFORM_BOOTSTRAP_KEY || "dev-only-change-me-bootstrap";
  const response = await app.inject({
    method: "POST",
    url: "/tenants",
    headers: { "x-bootstrap-key": bootstrapKey },
    payload: { code, name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`bootstrapTenant failed: ${response.statusCode} ${response.body}`);
  }
  const tenant = response.json() as { id: string; code: string };
  // Tenant creation now activates every module by default (the fresh-deploy
  // fix). Tests that need the old all-inactive default de-activate explicitly
  // via withModule, so the helper restores the zero state here.
  await pool.query(
    `UPDATE tenant_module_activations SET is_active = false WHERE tenant_id = $1`,
    [tenant.id],
  );
  return tenant;
}

export async function provisionFirstAdmin(params: {
  tenantId: string;
  email: string;
  password: string;
}) {
  const roleResult = await pool.query(
    `INSERT INTO roles (tenant_id, code, name, is_full_access) VALUES ($1, 'ADMIN', 'Administrator', true) RETURNING id`,
    [params.tenantId],
  );
  const roleId = roleResult.rows[0].id;

  const permissionRows = (await pool.query(`SELECT id FROM permissions`)).rows;
  for (const p of permissionRows) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
      [roleId, p.id],
    );
  }

  const passwordHash = await hashPassword(params.password);
  const userResult = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, 'Test Admin') RETURNING id`,
    [params.tenantId, params.email, passwordHash],
  );
  const userId = userResult.rows[0].id;

  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type) VALUES ($1, $2, 'tenant')`,
    [userId, roleId],
  );

  return { userId, roleId };
}

export async function createReadOnlyRole(tenantId: string, code: string, permissionCodes: string[]) {
  const roleResult = await pool.query(
    `INSERT INTO roles (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
    [tenantId, code],
  );
  const roleId = roleResult.rows[0].id;
  const permissionRows = (
    await pool.query(`SELECT id FROM permissions WHERE code = ANY($1)`, [permissionCodes])
  ).rows;
  for (const p of permissionRows) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
      [roleId, p.id],
    );
  }
  return roleId as string;
}

/**
 * Activates every module in the catalogue for a tenant, directly against the
 * database — the same `is_active` state `PUT /config/modules/:code` writes.
 * Tests use this when the thing they check needs the FULL navigation (e.g. the
 * seed parity test); the Wave 2 filter tests deliberately do NOT call it,
 * because partial activation is exactly what they must reproduce.
 */
export async function activateAllModules(tenantId: string) {
  await pool.query(
    `INSERT INTO tenant_module_activations (tenant_id, module_id, is_active)
     SELECT $1, m.id, true FROM modules m
     ON CONFLICT (tenant_id, module_id) DO UPDATE SET is_active = true`,
    [tenantId],
  );
}

/**
 * A minimal internal user: one role with the given permissions and a
 * `tenant` Data Scope, which makes the caller internal (§4.3 step 7's
 * classification). No user row is returned — the caller logs in through the
 * normal endpoint with the returned credentials.
 */
export async function provisionInternalUser(params: {
  tenantId: string;
  email: string;
  password: string;
  roleCode: string;
  permissionCodes: string[];
}) {
  const roleId = await createReadOnlyRole(params.tenantId, params.roleCode, params.permissionCodes);
  const passwordHash = await hashPassword(params.password);
  const userResult = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, 'Test User') RETURNING id`,
    [params.tenantId, params.email, passwordHash],
  );
  const userId = userResult.rows[0].id;
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type) VALUES ($1, $2, 'tenant')`,
    [userId, roleId],
  );
  return { userId, roleId };
}

/**
 * An external Customer User: only a `customer` scope, nothing internal. The
 * §4.3 filter classifies every caller without a `tenant` or
 * `organization_unit` scope as external, so this is the payload the external
 * whitelist is proven against.
 *
 * A `customer` assignment is only valid with a real `scope_customer_id`
 * (`user_role_assignments_scope_org_unit_required_check`), so a Customer row
 * is created too — the same row a real customer sign-in would point at.
 */
export async function provisionExternalCustomerUser(params: {
  tenantId: string;
  email: string;
  password: string;
  permissionCodes?: string[];
}) {
  const customerResult = await pool.query(
    `INSERT INTO customers (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [params.tenantId, `CUST-${Date.now()}`, "Test Customer"],
  );
  const customerId = customerResult.rows[0].id as string;

  const passwordHash = await hashPassword(params.password);
  const userResult = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, 'External Customer User') RETURNING id`,
    [params.tenantId, params.email, passwordHash],
  );
  const userId = userResult.rows[0].id;
  const roleResult = await pool.query(
    `INSERT INTO roles (tenant_id, code, name) VALUES ($1, 'CUSTOMER', 'Customer') RETURNING id`,
    [params.tenantId],
  );
  const roleId = roleResult.rows[0].id;
  for (const code of params.permissionCodes ?? []) {
    const permissionRows = (
      await pool.query(`SELECT id FROM permissions WHERE code = $1`, [code])
    ).rows;
    for (const p of permissionRows) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [roleId, p.id],
      );
    }
  }
  await pool.query(
    `INSERT INTO user_role_assignments (user_id, role_id, scope_type, scope_customer_id)
     VALUES ($1, $2, 'customer', $3)`,
    [userId, roleId, customerId],
  );
  return { userId, roleId, customerId };
}

export async function login(app: FastifyInstance, tenantCode: string, email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { tenantCode, email, password },
  });
  return { statusCode: response.statusCode, body: response.json() };
}

export async function createScheduledJobFixture(params: {
  jobCode: string;
  handlerKey: string;
  name: string;
}) {
  const result = await pool.query(
    `INSERT INTO scheduled_jobs
       (job_code, name, description, interval_seconds, handler_key, is_enabled)
     VALUES ($1, $2, 'Integration-test Scheduler fixture', 60, $3, true)
     RETURNING id`,
    [params.jobCode, params.name, params.handlerKey],
  );
  return result.rows[0].id as string;
}

export async function deleteScheduledJobFixture(jobCode: string) {
  await pool.query(`DELETE FROM scheduled_jobs WHERE job_code = $1`, [jobCode]);
}

export function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * Epic 1 (§4.1 F) — mint a bearer token the way the login endpoint does.
 *
 * Before Epic 1 a test could sign `{ sub, tenantId }` and be authenticated;
 * now the auth plugin refuses a token with no `sessionId` claim, because the
 * active Role is server-side session state and there is no transition window
 * for pre-session tokens. Fixtures that need a token without going through
 * `/auth/login` (usually because they want a specific assignment active)
 * create the session row here and sign the id into the token — the same two
 * steps `AuthService.login` performs.
 *
 * `activeAssignmentId` optional: omit it to let `createSession` pin the
 * first effective assignment (which is what a real login does), or pass one
 * to land on a specific Role.
 */
export async function sessionTokenFor(params: {
  userId: string;
  tenantId: string;
  /** Writes the session's active assignment. Defaults to createSession's
   * own default (the first effective assignment by role name). */
  activeAssignmentId?: string;
}): Promise<string> {
  const sessionId = await createSession(pool, {
    userId: params.userId,
    tenantId: params.tenantId,
  });
  if (params.activeAssignmentId !== undefined) {
    await pool.query(
      `UPDATE sessions SET active_assignment_id = $2 WHERE id = $1`,
      [sessionId, params.activeAssignmentId],
    );
  }
  return signAccessToken({ sub: params.userId, tenantId: params.tenantId, sessionId });
}

/**
 * Epic 4 §4.4 D — create an INTERNAL User through the governed surface
 * (`POST /admin/users`), which is the single door for tenant and
 * organization-unit assignments since B1b narrowed `POST /users` to
 * external Customer Users (ADR-0011). `adminToken` must hold the console
 * ticket plus `user.role.manage` visibility — the `provisionFirstAdmin`
 * fixture always does.
 *
 * `pairs` follows the governed body: one pair per assignment, built from
 * the same flat `scopeType` / `scopeOrganizationUnitId` fields the legacy
 * `POST /users` body used, so existing call sites move by changing one line.
 */
export async function createInternalUser(
  app: FastifyInstance,
  adminToken: string,
  payload: {
    email: string;
    fullName: string;
    password: string;
    roleCode: string;
    scopeType?: "tenant" | "organization_unit";
    scopeOrganizationUnitId?: string | null;
  },
) {
  const { email, fullName, password, roleCode } = payload;
  const pair =
    payload.scopeType === "organization_unit"
      ? { roleCode, scopeType: "organization_unit" as const, scopeOrganizationUnitId: payload.scopeOrganizationUnitId }
      : { roleCode, scopeType: "tenant" as const };
  const response = await app.inject({
    method: "POST",
    url: "/admin/users",
    headers: authHeader(adminToken),
    payload: { email, fullName, password, pairs: [pair] },
  });
  if (response.statusCode !== 201) {
    throw new Error(`createInternalUser failed: ${response.statusCode} ${response.body}`);
  }
  return response.json() as { user: { id: string; email: string }; assignments: unknown[] };
}
