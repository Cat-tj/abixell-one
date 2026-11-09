import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/infrastructure/persistence/db.js";
import {
  activateAllModules,
  authHeader,
  bootstrapTenant,
  login,
  provisionFirstAdmin,
  provisionInternalUser,
} from "./helpers.js";

/**
 * Wave A8 / ADR-0028 — partner credential lifecycle + partner surface.
 */
const FIXTURE_ID = `${Date.now()}-${process.pid}`;
const TENANT_A = `test-a8-a-${FIXTURE_ID}`;
const TENANT_B = `test-a8-b-${FIXTURE_ID}`;

function basic(clientId: string, secret: string) {
  return { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` };
}

describe("Wave A8 — partner API", () => {
  const app = buildApp();
  let tenantAId: string;
  let tenantBId: string;
  let adminA: string;
  let adminB: string;
  let limitedA: string;

  async function issue(token: string, permissions: string[], name = "partner") {
    return app.inject({
      method: "POST",
      url: "/integration/partner-credentials",
      headers: authHeader(token),
      payload: { name, permissions },
    });
  }

  beforeAll(async () => {
    const a = await bootstrapTenant(app, TENANT_A, "A8 A");
    const b = await bootstrapTenant(app, TENANT_B, "A8 B");
    tenantAId = a.id;
    tenantBId = b.id;
    await activateAllModules(a.id);
    await activateAllModules(b.id);
    await provisionFirstAdmin({ tenantId: a.id, email: "admin@a8-a.local", password: "Admin12345!" });
    await provisionFirstAdmin({ tenantId: b.id, email: "admin@a8-b.local", password: "Admin12345!" });
    adminA = (await login(app, TENANT_A, "admin@a8-a.local", "Admin12345!")).body.accessToken;
    adminB = (await login(app, TENANT_B, "admin@a8-b.local", "Admin12345!")).body.accessToken;
    await provisionInternalUser({
      tenantId: a.id,
      email: "limited@a8-a.local",
      password: "Limited12345!",
      roleCode: "A8_LIMITED",
      permissionCodes: ["integration.partner_credential.manage", "integration.partner_credential.read", "customer.read"],
    });
    limitedA = (await login(app, TENANT_A, "limited@a8-a.local", "Limited12345!")).body.accessToken;

    for (const [token, code] of [[adminA, "CUST-A"], [adminB, "CUST-B"]] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/customers",
        headers: authHeader(token),
        payload: { code, name: `Customer ${code}` },
      });
      expect(res.statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantAId, tenantBId]]);
    await app.close();
    await pool.end();
  });

  it("valid credential with customer.read gets 200 and only its own tenant's customers", async () => {
    const issued = await issue(adminA, ["customer.read"]);
    expect(issued.statusCode).toBe(201);
    const { clientId, secret } = issued.json();
    const res = await app.inject({ method: "GET", url: "/api/partner/v1/customers", headers: basic(clientId, secret) });
    expect(res.statusCode).toBe(200);
    const codes = res.json().map((c: { code: string }) => c.code);
    expect(codes).toEqual(["CUST-A"]);

    // Cross-tenant impossible: tenant B's customer id is 404 for tenant A's credential.
    const bCustomer = (await pool.query(`SELECT id FROM customers WHERE tenant_id = $1`, [tenantBId])).rows[0].id;
    const cross = await app.inject({
      method: "GET",
      url: `/api/partner/v1/customers/${bCustomer}`,
      headers: basic(clientId, secret),
    });
    expect(cross.statusCode).toBe(404);
    const own = (await pool.query(`SELECT id FROM customers WHERE tenant_id = $1`, [tenantAId])).rows[0].id;
    const ok = await app.inject({ method: "GET", url: `/api/partner/v1/customers/${own}`, headers: basic(clientId, secret) });
    expect(ok.statusCode).toBe(200);
    // A tenant-selecting parameter is ignored: tenant comes from the credential only.
    const spoof = await app.inject({
      method: "GET",
      url: `/api/partner/v1/customers?tenantId=${tenantBId}`,
      headers: { ...basic(clientId, secret), "x-tenant-id": tenantBId },
    });
    expect(spoof.json().map((c: { code: string }) => c.code)).toEqual(["CUST-A"]);
  });

  it("credential without the route permission gets 403; missing/unknown creds get 401", async () => {
    const issued = await issue(adminA, ["customer.manage"]);
    const { clientId, secret } = issued.json();
    const res = await app.inject({ method: "GET", url: "/api/partner/v1/customers", headers: basic(clientId, secret) });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/partner/v1/customers" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/partner/v1/customers", headers: basic("pc_nope", "x") })).statusCode,
    ).toBe(401);
  });

  it("rotated-old secret and revoked credential are 401; new secret works", async () => {
    const issued = (await issue(adminA, ["customer.read"])).json();
    const rotated = await app.inject({
      method: "POST",
      url: `/integration/partner-credentials/${issued.credential.id}/rotate`,
      headers: authHeader(adminA),
    });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json();
    expect(next.clientId).toBe(issued.clientId);
    const get = (secret: string) =>
      app.inject({ method: "GET", url: "/api/partner/v1/customers", headers: basic(issued.clientId, secret) });
    expect((await get(issued.secret)).statusCode).toBe(401);
    expect((await get(next.secret)).statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: `/integration/partner-credentials/${issued.credential.id}/revoke`,
      headers: authHeader(adminA),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await get(next.secret)).statusCode).toBe(401);
    // Revoked credentials cannot be rotated back to life.
    const again = await app.inject({
      method: "POST",
      url: `/integration/partner-credentials/${issued.credential.id}/rotate`,
      headers: authHeader(adminA),
    });
    expect(again.statusCode).toBe(404);
  });

  it("issue rejects permissions the issuer's active Role does not hold", async () => {
    const res = await issue(limitedA, ["customer.read", "customer.manage"]);
    expect(res.statusCode).toBe(403);
    const ok = await issue(limitedA, ["customer.read"]);
    expect(ok.statusCode).toBe(201);
  });

  it("issue / rotate / revoke / list require the governed permissions", async () => {
    const noPerm = (await provisionInternalUser({
      tenantId: tenantAId,
      email: "noperm@a8-a.local",
      password: "NoPerm12345!",
      roleCode: "A8_NOPERM",
      permissionCodes: ["customer.read"],
    }), (await login(app, TENANT_A, "noperm@a8-a.local", "NoPerm12345!")).body.accessToken);
    expect((await issue(noPerm, ["customer.read"])).statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: "/integration/partner-credentials", headers: authHeader(noPerm) });
    expect(list.statusCode).toBe(403);
  });

  it("another tenant's admin cannot rotate or revoke a credential", async () => {
    const issued = (await issue(adminA, ["customer.read"])).json();
    for (const action of ["rotate", "revoke"]) {
      const res = await app.inject({
        method: "POST",
        url: `/integration/partner-credentials/${issued.credential.id}/${action}`,
        headers: authHeader(adminB),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("list never exposes secrets or hashes and is tenant-scoped; lifecycle is audited", async () => {
    const issued = (await issue(adminA, ["customer.read"], "listed")).json();
    const res = await app.inject({ method: "GET", url: "/integration/partner-credentials", headers: authHeader(adminA) });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toContain(issued.secret);
    expect(text).not.toContain("secret_hash");
    expect(text).not.toContain("secretHash");
    expect(text).not.toMatch(/"secret"/);
    expect(res.json().every((c: { tenantId: string }) => c.tenantId === tenantAId)).toBe(true);
    const listB = await app.inject({ method: "GET", url: "/integration/partner-credentials", headers: authHeader(adminB) });
    expect(listB.json()).toEqual([]);

    const audits = await pool.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_type = 'partner_credential'`,
      [tenantAId],
    );
    const actions = new Set(audits.rows.map((r) => r.action));
    expect(actions).toContain("integration.partner_credential.issued");
    expect(actions).toContain("integration.partner_credential.rotated");
    expect(actions).toContain("integration.partner_credential.revoked");
  });
});
