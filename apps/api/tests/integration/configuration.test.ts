import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { authHeader, bootstrapTenant, createReadOnlyRole, login, provisionFirstAdmin } from "./helpers.js";

/**
 * Checkpoint 0C integration test — proves the Configuration & Metadata
 * Foundation end-to-end:
 *
 *   Schema Registry (Ajv validation) -> Module Activation -> Feature Flags
 *   with Configuration Scope precedence -> Terminology -> Reference Data
 *   -> Numbering -> Configuration Audit -> PostgreSQL
 *
 * Runs against the real PostgreSQL database, same pattern as the 0B
 * vertical-slice suite: no mocking, direct `pool` assertions at the end
 * confirm data actually landed, not just that the API responded 2xx.
 */

const TENANT_CODE = `test-0c-${Date.now()}`;

describe("Checkpoint 0C — Configuration & Metadata Foundation", () => {
  const app = buildApp();
  let tenantId: string;
  let adminToken: string;
  let legalEntityId: string;
  let headOfficeId: string;
  let siteId: string;

  beforeAll(async () => {
    const tenant = await bootstrapTenant(app, TENANT_CODE, "Test Tenant 0C");
    tenantId = tenant.id;
    await provisionFirstAdmin({
      tenantId,
      email: "admin@test-0c.local",
      password: "AdminPass123!",
    });

    const loginResult = await login(app, TENANT_CODE, "admin@test-0c.local", "AdminPass123!");
    adminToken = loginResult.body.accessToken;

    const legalEntityResponse = await app.inject({
      method: "POST",
      url: "/legal-entities",
      headers: authHeader(adminToken),
      payload: { name: "Test Legal Entity 0C" },
    });
    legalEntityId = legalEntityResponse.json().id;

    const headOfficeResponse = await app.inject({
      method: "POST",
      url: "/organization-units",
      headers: authHeader(adminToken),
      payload: { legalEntityId, name: "Head Office" },
    });
    headOfficeId = headOfficeResponse.json().id;

    const siteResponse = await app.inject({
      method: "POST",
      url: "/organization-units",
      headers: authHeader(adminToken),
      payload: { legalEntityId, parentId: headOfficeId, name: "Site A", unitType: "Site" },
    });
    siteId = siteResponse.json().id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await app.close();
  });

  it("lists the Product Core Module catalog with none activated for a fresh Tenant", async () => {
    // Tenant creation now activates every module by default (the
    // fresh-deployment fix). This test verifies the module CATALOG and the
    // read-only refusal path, so it starts from the all-inactive state it
    // has always assumed.
    for (const m of (await app.inject({ method: "GET", url: "/config/modules", headers: authHeader(adminToken) })).json()) {
      if (m.isActive) {
        const off = await app.inject({ method: "PUT", url: `/config/modules/${m.moduleCode}`, headers: authHeader(adminToken), payload: { isActive: false } });
        if (off.statusCode !== 200) throw new Error(`deactivate ${m.moduleCode} failed`);
      }
    }
    const response = await app.inject({
      method: "GET",
      url: "/config/modules",
      headers: authHeader(adminToken),
    });
    expect(response.statusCode).toBe(200);
    const modules = response.json();
    const moduleCodes = modules.map((m: { moduleCode: string }) => m.moduleCode);
    expect(moduleCodes).toContain("customer_complaint");
    expect(moduleCodes).toContain("warehouse_management");
    expect(moduleCodes).toContain("procurement_management");
    expect(modules.every((m: { isActive: boolean }) => m.isActive === false)).toBe(true);

    const me = await app.inject({ method: "GET", url: "/me", headers: authHeader(adminToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json().activeModuleCodes).toEqual([]);
  });

  it("activates a Module for this Tenant only and persists it in tenant_module_activations", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/config/modules/customer_complaint",
      headers: authHeader(adminToken),
      payload: { isActive: true },
    });
    expect(response.statusCode).toBe(200);

    const row = await pool.query(
      `SELECT tma.is_active FROM tenant_module_activations tma
       JOIN modules m ON m.id = tma.module_id
       WHERE tma.tenant_id = $1 AND m.code = 'customer_complaint'`,
      [tenantId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].is_active).toBe(true);

    // GET /me exposes activeModuleCodes safely for client-side navigation capability gating
    const meRes = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(adminToken),
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().activeModuleCodes).toContain("customer_complaint");
  });

  it("resolves Feature Flags with Configuration Scope precedence: Organization Unit overrides Tenant overrides catalog default", async () => {
    // catalog default for offline_field_mode is false
    let effective = await app.inject({
      method: "GET",
      url: `/config/feature-flags/effective?organizationUnitId=${siteId}`,
      headers: authHeader(adminToken),
    });
    expect(effective.json().find((f: { code: string }) => f.code === "offline_field_mode")).toMatchObject(
      { isEnabled: false, source: "catalog_default" },
    );

    // set tenant-level override -> true
    const tenantSet = await app.inject({
      method: "PUT",
      url: "/config/feature-flags/offline_field_mode",
      headers: authHeader(adminToken),
      payload: { isEnabled: true, scopeType: "tenant" },
    });
    expect(tenantSet.statusCode).toBe(200);

    effective = await app.inject({
      method: "GET",
      url: `/config/feature-flags/effective?organizationUnitId=${siteId}`,
      headers: authHeader(adminToken),
    });
    expect(effective.json().find((f: { code: string }) => f.code === "offline_field_mode")).toMatchObject(
      { isEnabled: true, source: "tenant" },
    );

    // set organization_unit-level override at Site A -> false (opposite of tenant)
    const orgUnitSet = await app.inject({
      method: "PUT",
      url: "/config/feature-flags/offline_field_mode",
      headers: authHeader(adminToken),
      payload: {
        isEnabled: false,
        scopeType: "organization_unit",
        scopeOrganizationUnitId: siteId,
      },
    });
    expect(orgUnitSet.statusCode).toBe(200);

    // Site A now resolves to the org-unit override, not the tenant value
    effective = await app.inject({
      method: "GET",
      url: `/config/feature-flags/effective?organizationUnitId=${siteId}`,
      headers: authHeader(adminToken),
    });
    expect(effective.json().find((f: { code: string }) => f.code === "offline_field_mode")).toMatchObject(
      { isEnabled: false, source: "organization_unit" },
    );

    // Head Office (no org-unit override) still resolves to the tenant value
    const headOfficeEffective = await app.inject({
      method: "GET",
      url: `/config/feature-flags/effective?organizationUnitId=${headOfficeId}`,
      headers: authHeader(adminToken),
    });
    expect(
      headOfficeEffective.json().find((f: { code: string }) => f.code === "offline_field_mode"),
    ).toMatchObject({ isEnabled: true, source: "tenant" });
  });

  it("enforces the Schema Registry via Ajv: rejects an out-of-schema Terminology value", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/config/terminology/legal_entity.label",
      headers: authHeader(adminToken),
      payload: { value: "" }, // schema requires minLength 1
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Schema Registry validation");
  });

  it("accepts a valid Terminology override and it is reflected in the catalog", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/config/terminology/organization_unit.label",
      headers: authHeader(adminToken),
      payload: { value: "Site" },
    });
    expect(response.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/config/terminology",
      headers: authHeader(adminToken),
    });
    const entry = list
      .json()
      .find((t: { code: string }) => t.code === "organization_unit.label");
    expect(entry).toMatchObject({ value: "Site", isOverridden: true });
  });

  it("creates a Reference Data item and rejects a duplicate code with 409 (not a 500)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/config/reference-data/priority_level",
      headers: authHeader(adminToken),
      payload: { code: "urgent", label: "Urgent", sortOrder: 1 },
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/config/reference-data/priority_level",
      headers: authHeader(adminToken),
      payload: { code: "urgent", label: "Urgent Again" },
    });
    expect(duplicate.statusCode).toBe(409);

    const rows = await pool.query(
      `SELECT * FROM tenant_reference_data_items WHERE tenant_id = $1 AND code = 'urgent'`,
      [tenantId],
    );
    expect(rows.rows).toHaveLength(1); // duplicate was rejected, not double-inserted
  });

  it("generates atomically-incrementing Numbers from a Tenant-specific pattern", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/config/numbering/complaint_ticket",
      headers: authHeader(adminToken),
      payload: { pattern: "CMP-{YYYY}-{SEQ:4}" },
    });
    expect(created.statusCode).toBe(201);

    const first = await app.inject({
      method: "POST",
      url: "/config/numbering/complaint_ticket/generate",
      headers: authHeader(adminToken),
    });
    const second = await app.inject({
      method: "POST",
      url: "/config/numbering/complaint_ticket/generate",
      headers: authHeader(adminToken),
    });
    expect(first.json().sequence).toBe(1);
    expect(second.json().sequence).toBe(2);
    expect(second.json().number).toMatch(/^CMP-\d{4}-0002$/);

    const row = await pool.query(
      `SELECT current_sequence FROM numbering_sequences WHERE tenant_id = $1 AND code = 'complaint_ticket'`,
      [tenantId],
    );
    expect(Number(row.rows[0].current_sequence)).toBe(2);
  });

  it("REJECTS a read-only Role's attempt to mutate Configuration (403, backend-enforced)", async () => {
    await createReadOnlyRole(tenantId, "AUDITOR", ["config.read"]);
    const auditorPasswordResponse = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(adminToken),
      payload: {email: "auditor@test-0c.local", fullName: "Test Auditor", password: "AuditorPass123!", pairs: [{ roleCode: "AUDITOR", scopeType: "tenant" as const }]},
    });
    expect(auditorPasswordResponse.statusCode).toBe(201);

    const auditorLogin = await login(app, TENANT_CODE, "auditor@test-0c.local", "AuditorPass123!");
    expect(auditorLogin.statusCode).toBe(200);

    const readResponse = await app.inject({
      method: "GET",
      url: "/config/modules",
      headers: authHeader(auditorLogin.body.accessToken),
    });
    expect(readResponse.statusCode).toBe(200);

    const writeResponse = await app.inject({
      method: "PUT",
      url: "/config/modules/survey_assessment",
      // An auditor holding only `config.read` is refused on the RBAC check.
      headers: authHeader(auditorLogin.body.accessToken),
      payload: { isActive: true },
    });
    expect(writeResponse.statusCode).toBe(403);

    const row = await pool.query(
      `SELECT tma.* FROM tenant_module_activations tma
       JOIN modules m ON m.id = tma.module_id
       WHERE tma.tenant_id = $1 AND m.code = 'survey_assessment'`,
      [tenantId],
    );
    // The refused write must leave the module in its prior state. With
    // activate-on-create the row always exists; this test deactivated the
    // catalog earlier, so the prior state is 'false' — the assertion is
    // that the 403 did not flip it.
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].is_active).toBe(false);
  });

  it("allows the granular config.module.manage alone to toggle a Module (Epic 15 Decision #7)", async () => {
    await createReadOnlyRole(tenantId, "MODULE_OPERATOR", ["config.read", "config.module.manage"]);
    const created = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(adminToken),
      payload: {email: "operator@test-0c.local", fullName: "Module Operator", password: "OperatorPass123!", pairs: [{ roleCode: "MODULE_OPERATOR", scopeType: "tenant" as const }]},
    });
    expect(created.statusCode).toBe(201);

    const operator = await login(app, TENANT_CODE, "operator@test-0c.local", "OperatorPass123!");
    expect(operator.statusCode).toBe(200);

    const response = await app.inject({
      method: "PUT",
      url: "/config/modules/warehouse_management",
      headers: authHeader(operator.body.accessToken),
      payload: { isActive: true },
    });
    expect(response.statusCode).toBe(200);

    const row = await pool.query(
      `SELECT tma.is_active FROM tenant_module_activations tma
       JOIN modules m ON m.id = tma.module_id
       WHERE tma.tenant_id = $1 AND m.code = 'warehouse_management'`,
      [tenantId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].is_active).toBe(true);

    // Restore: later tests assert the tenant's exact active-module set.
    const reset = await app.inject({
      method: "PUT",
      url: "/config/modules/warehouse_management",
      headers: authHeader(adminToken),
      payload: { isActive: false },
    });
    expect(reset.statusCode).toBe(200);
  });

  it("exposes only this tenant's active module codes without granting config.read", async () => {
    await createReadOnlyRole(tenantId, "NAVIGATION_USER", ["tenant.read"]);
    const created = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: authHeader(adminToken),
      payload: {email: "navigation@test-0c.local", fullName: "Navigation User", password: "NavigationPass123!", pairs: [{ roleCode: "NAVIGATION_USER", scopeType: "tenant" as const }]},
    });
    expect(created.statusCode).toBe(201);
    const user = await login(app, TENANT_CODE, "navigation@test-0c.local", "NavigationPass123!");
    expect(user.statusCode).toBe(200);
    const headers = authHeader(user.body.accessToken);
    const me = await app.inject({ method: "GET", url: "/me", headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().activeModuleCodes).toEqual(["customer_complaint"]);
    expect(me.json().permissions).not.toContain("config.read");
    expect((await app.inject({ method: "GET", url: "/config/modules", headers })).statusCode).toBe(403);

    const otherTenant = await bootstrapTenant(app, `${TENANT_CODE}-other`, "Other Navigation Tenant");

    try {
      await provisionFirstAdmin({
        tenantId: otherTenant.id,
        email: "other@test-0c.local",
        password: "OtherAdminPass123!",
      });
      const otherAdmin = await login(app, `${TENANT_CODE}-other`, "other@test-0c.local", "OtherAdminPass123!");
      expect(otherAdmin.statusCode).toBe(200);
      const otherHeaders = authHeader(otherAdmin.body.accessToken);
      // All modules are active on a fresh tenant now; reduce to exactly
      // survey_assessment for this assertion.
      for (const m of (await app.inject({ method: "GET", url: "/config/modules", headers: otherHeaders })).json()) {
        if (m.isActive && m.moduleCode !== "survey_assessment") {
          await app.inject({ method: "PUT", url: `/config/modules/${m.moduleCode}`, headers: otherHeaders, payload: { isActive: false } });
        }
      }
      const activated = await app.inject({
        method: "PUT", url: "/config/modules/survey_assessment",
        headers: otherHeaders,
        payload: { isActive: true },
      });
      expect(activated.statusCode).toBe(200);
      const otherMe = await app.inject({ method: "GET", url: "/me", headers: otherHeaders });
      expect(otherMe.statusCode).toBe(200);
      expect(otherMe.json().activeModuleCodes).toEqual(["survey_assessment"]);
      expect((await app.inject({ method: "GET", url: "/me", headers })).json().activeModuleCodes)
        .toEqual(["customer_complaint"]);

      const disabled = await app.inject({
        method: "PUT", url: "/config/modules/customer_complaint",
        headers: authHeader(adminToken),
        payload: { isActive: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/me", headers })).json().activeModuleCodes).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    } finally {
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [otherTenant.id]);
      await app.inject({
        method: "PUT", url: "/config/modules/customer_complaint",
        headers: authHeader(adminToken),
        payload: { isActive: true },
      });
    }
  });

  it("records a Configuration Audit entry for every mutating action performed above", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/audit-log/recent",
      headers: authHeader(adminToken),
    });
    const actions = response.json().map((e: { action: string }) => e.action);

    expect(actions).toContain("config.module_activation.changed");
    expect(actions).toContain("config.feature_flag.changed");
    expect(actions).toContain("config.terminology.changed");
    expect(actions).toContain("config.reference_data_item.created");
    expect(actions).toContain("config.numbering_sequence.created");
    expect(actions).toContain("config.numbering.generated");
  });
});
