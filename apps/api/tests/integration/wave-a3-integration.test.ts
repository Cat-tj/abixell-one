import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { activateAllModules, authHeader, bootstrapTenant, createReadOnlyRole, login, provisionExternalCustomerUser, provisionFirstAdmin } from "./helpers.js";

const TENANT_CODE = `wave-a3-main-${Date.now()}`;
const OTHER_TENANT_CODE = `wave-a3-other-${Date.now()}`;
const ADMIN_EMAIL = "admin@wave-a3.local";
const ADMIN_PASSWORD = "Admin12345!";
const OPERATOR_EMAIL = "operator@wave-a3.local";
const OPERATOR_PASSWORD = "Operator12345!";
const OTHER_ADMIN_EMAIL = "otheradmin@wave-a3.local";
const OTHER_ADMIN_PASSWORD = "OtherAdmin12345!";

describe("Wave A3 — Service Operations & Asset Advanced Integration Suite", () => {
  const app = buildApp();

  let tenantId: string;
  let otherTenantId: string;
  let adminUserId: string;
  let adminToken: string;
  let otherAdminUserId: string;
  let otherAdminToken: string;
  let operatorUserId: string;
  let operatorToken: string;
  let customerScopeToken: string;

  let legalEntityId: string;
  let orgUnitId: string;
  let customerId: string;
  let otherCustomerId: string;
  let assetId: string;
  let otherAssetId: string;
  let itemId: string;
  let otherItemId: string;

  let scheduleId: string;
  let meterScheduleId: string;
  let maintenanceWorkOrderId: string;
  let correctiveWorkOrderId: string;
  let optimizationRunId: string;
  let openDowntimeId: string;

  const post = (url: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url,
      headers: authHeader(token),
      ...(payload === undefined ? {} : { payload }),
    });

  const get = (url: string, token: string) =>
    app.inject({
      method: "GET",
      url,
      headers: authHeader(token),
    });

  beforeAll(async () => {
    // 1. Bootstrap Primary Tenant & Admin
    const primaryTenant = await bootstrapTenant(app, TENANT_CODE, "Wave A3 Primary Tenant");
    await activateAllModules(primaryTenant.id);
    tenantId = primaryTenant.id;
    const adminUser = await provisionFirstAdmin({
      tenantId,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    adminUserId = adminUser.userId;
    const adminLogin = await login(app, TENANT_CODE, ADMIN_EMAIL, ADMIN_PASSWORD);
    adminToken = adminLogin.body.accessToken;

    // 2. Bootstrap Other Tenant & Admin (for multi-tenant isolation verification)
    const otherTenant = await bootstrapTenant(app, OTHER_TENANT_CODE, "Wave A3 Other Tenant");
    await activateAllModules(otherTenant.id);
    otherTenantId = otherTenant.id;
    const otherAdmin = await provisionFirstAdmin({
      tenantId: otherTenantId,
      email: OTHER_ADMIN_EMAIL,
      password: OTHER_ADMIN_PASSWORD,
    });
    otherAdminUserId = otherAdmin.userId;
    const otherAdminLogin = await login(app, OTHER_TENANT_CODE, OTHER_ADMIN_EMAIL, OTHER_ADMIN_PASSWORD);
    otherAdminToken = otherAdminLogin.body.accessToken;

    // 3. Create operator user with constrained read/meter permissions
    await createReadOnlyRole(tenantId, "OPERATOR_ROLE", [
      "service_operations.optimization.read",
      "asset.read",
      "asset.maintenance.read",
      "asset.meter.manage",
      "asset.analytics.read",
    ]);

    const createOpRes = await post("/admin/users", adminToken, {
      email: OPERATOR_EMAIL,
      fullName: "Field Operator Technician",
      password: OPERATOR_PASSWORD,
      pairs: [{ roleCode: "OPERATOR_ROLE", scopeType: "tenant" }],
    });
    expect(createOpRes.statusCode).toBe(201);
    operatorUserId = createOpRes.json().user.id;

    const operatorLogin = await login(app, TENANT_CODE, OPERATOR_EMAIL, OPERATOR_PASSWORD);
    operatorToken = operatorLogin.body.accessToken;

    // Customer-scoped reader holding the optimization read permission — the
    // permission ceiling (§4.4 decision 2) allows exactly this pair.
    const customerEmail = `custscope-a3-${Date.now()}@wave-a3.local`;
    await provisionExternalCustomerUser({
      tenantId,
      email: customerEmail,
      password: OPERATOR_PASSWORD,
      permissionCodes: ["service_operations.optimization.read"],
    });
    customerScopeToken = (await login(app, TENANT_CODE, customerEmail, OPERATOR_PASSWORD)).body.accessToken;

    // 4. Seed numbering sequences for both tenants
    for (const [tToken, tId] of [[adminToken, tenantId], [otherAdminToken, otherTenantId]] as const) {
      await post("/config/numbering/asset", tToken, { pattern: "AST-{SEQ:5}" });
      await post("/config/numbering/asset_maintenance_work_order", tToken, { pattern: "PM-{SEQ:5}" });
      await post("/config/numbering/service_optimization_run", tToken, { pattern: "OPT-{YYYY}-{SEQ:4}" });
      await post("/config/numbering/work_order", tToken, { pattern: "WO-{SEQ:5}" });
      await post("/config/numbering/service_request", tToken, { pattern: "SR-{SEQ:5}" });

      // Seed workflow definition for service operations work orders
      await post("/workflow/definitions", tToken, {
        code: "service_operations_work_order",
        name: "Service Operations Work Order",
        entityType: "work_order",
        description: "Authoritative workflow for generic service operations work orders",
      });
      await post("/workflow/definitions/service_operations_work_order/versions/1/steps", tToken, {
        code: "CREATED",
        name: "Created",
        stepType: "task",
        isInitial: true,
      });
      await post("/workflow/definitions/service_operations_work_order/versions/1/steps", tToken, {
        code: "COMPLETED",
        name: "Completed",
        stepType: "end",
        isTerminal: true,
        terminalStatus: "approved",
      });
      await post("/workflow/definitions/service_operations_work_order/versions/1/transitions", tToken, {
        fromStepCode: "CREATED",
        toStepCode: "COMPLETED",
        actionCode: "complete",
        name: "Complete Work",
      });
      await post("/workflow/definitions/service_operations_work_order/versions/1/assignment-rules", tToken, {
        stepCode: "CREATED",
        assignmentType: "specific_user",
        specificUserSource: "submitter",
      });
      await post("/workflow/definitions/service_operations_work_order/versions/1/publish", tToken);

      // Seed workflow definition for asset maintenance work orders
      await post("/workflow/definitions", tToken, {
        code: "asset_maintenance_work_order",
        name: "Asset Maintenance Lifecycle",
        entityType: "asset_maintenance_work_order",
        description: "Authoritative workflow for asset maintenance orders",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/steps", tToken, {
        code: "CREATED",
        name: "Created",
        stepType: "task",
        isInitial: true,
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/steps", tToken, {
        code: "IN_PROGRESS",
        name: "In Progress",
        stepType: "task",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/steps", tToken, {
        code: "COMPLETED",
        name: "Completed",
        stepType: "task",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/steps", tToken, {
        code: "VERIFIED",
        name: "Verified",
        stepType: "end",
        isTerminal: true,
        terminalStatus: "approved",
      });

      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/transitions", tToken, {
        fromStepCode: "CREATED",
        toStepCode: "IN_PROGRESS",
        actionCode: "start",
        name: "Start Work",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/transitions", tToken, {
        fromStepCode: "IN_PROGRESS",
        toStepCode: "COMPLETED",
        actionCode: "complete",
        name: "Complete Work",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/transitions", tToken, {
        fromStepCode: "COMPLETED",
        toStepCode: "VERIFIED",
        actionCode: "verify",
        name: "Verify Work",
      });

      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/assignment-rules", tToken, {
        stepCode: "CREATED",
        assignmentType: "specific_user",
        specificUserSource: "submitter",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/assignment-rules", tToken, {
        stepCode: "IN_PROGRESS",
        assignmentType: "specific_user",
        specificUserSource: "submitter",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/assignment-rules", tToken, {
        stepCode: "COMPLETED",
        assignmentType: "specific_user",
        specificUserSource: "submitter",
      });
      await post("/workflow/definitions/asset_maintenance_work_order/versions/1/publish", tToken);
    }

    // 5. Seed organizational and master data in Primary Tenant
    const leRes = await post("/legal-entities", adminToken, {
      code: "LE-A3-MAIN",
      name: "Wave A3 Primary Legal Entity",
    });
    legalEntityId = leRes.json().id;

    const ouRes = await post("/organization-units", adminToken, {
      legalEntityId,
      code: "OU-OPS-NORTH",
      name: "North Operations District",
    });
    orgUnitId = ouRes.json().id;

    // Create employee record linked to the field operator
    await pool.query(
      `INSERT INTO employees (tenant_id, user_id, organization_unit_id, employee_number, full_name, employment_status, joined_at)
       VALUES ($1, $2, $3, 'EMP-A3-001', 'Field Operator Technician', 'active', '2026-01-01')`,
      [tenantId, operatorUserId, orgUnitId],
    );

    const custRes = await post("/customers", adminToken, {
      code: "CUST-A3-01",
      name: "Industrial Client Alpha",
      ownerOrganizationUnitId: orgUnitId,
    });
    customerId = custRes.json().id;

    const itemRes = await post("/items", adminToken, {
      code: "PART-SYNTH-OIL-10W40",
      name: "High Performance Engine Oil 10W-40",
      itemType: "consumable",
      unitOfMeasure: "L",
    });
    itemId = itemRes.json().id;

    const assetRes = await post("/assets", adminToken, {
      name: "Main Diesel Generator Unit 01",
      assetTag: "GEN-001",
      category: "machinery",
      organizationUnitId: orgUnitId,
    });
    expect(assetRes.statusCode).toBe(201);
    assetId = assetRes.json().asset.id;

    // 6. Seed master data in Other Tenant
    const otherCustRes = await post("/customers", otherAdminToken, {
      code: "CUST-OTHER-01",
      name: "Other Tenant Client",
    });
    otherCustomerId = otherCustRes.json().id;

    const otherItemRes = await post("/items", otherAdminToken, {
      code: "PART-OTHER-01",
      name: "Other Tenant Spare Part",
      itemType: "consumable",
      unitOfMeasure: "pcs",
    });
    otherItemId = otherItemRes.json().id;

    const otherAssetRes = await post("/assets", otherAdminToken, {
      name: "Other Tenant Generator",
      assetTag: "OTHER-GEN-01",
      category: "machinery",
    });
    expect(otherAssetRes.statusCode).toBe(201);
    otherAssetId = otherAssetRes.json().asset.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // =========================================================================
  // Unit 1: PACK-001…004 — Vertical Service Pack Configuration & Presets
  // =========================================================================

  describe("PACK-001…004: Vertical Service Pack Configuration & Presets", () => {
    it("lists all vertical service packs with default inactive status", async () => {
      const res = await get("/service-operations/packs", adminToken);
      expect(res.statusCode).toBe(200);
      const packs = res.json();
      expect(Array.isArray(packs)).toBe(true);
      expect(packs.length).toBe(4);
      const codes = packs.map((p: any) => p.packCode);
      expect(codes).toEqual(expect.arrayContaining(["catering", "housekeeping", "camp", "facility"]));
      for (const pack of packs) {
        expect(pack.isActive).toBe(false);
        expect(pack.presetServiceCount).toBeGreaterThan(0);
      }
    });

    it("gets individual service pack details by pack code", async () => {
      const res = await get("/service-operations/packs/catering", adminToken);
      expect(res.statusCode).toBe(200);
      const pack = res.json();
      expect(pack.packCode).toBe("catering");
      expect(pack.preset.name).toContain("Catering");
      expect(pack.preset.serviceDefinitions[0].checklistItems.length).toBeGreaterThan(0);
    });

    it("activates catering pack and seeds presets into generic Service Operations definitions", async () => {
      const res = await post("/service-operations/packs/catering/activate", adminToken, {
        seedPresets: true,
      });
      expect(res.statusCode).toBe(200);
      const activation = res.json();
      expect(activation.packCode).toBe("catering");
      expect(activation.isActive).toBe(true);

      // Verify that generic service definitions and checklists now exist in Service Operations Core
      const defsRes = await get("/service-definitions", adminToken);
      expect(defsRes.statusCode).toBe(200);
      const defs = defsRes.json();
      const cateringDef = defs.find((d: any) => d.category === "catering");
      expect(cateringDef).toBeDefined();

      const singleDefRes = await get(`/service-definitions/${cateringDef.code}`, adminToken);
      expect(singleDefRes.statusCode).toBe(200);
      const singleDef = singleDefRes.json();
      expect(singleDef.checklist.length).toBeGreaterThan(0);
    });

    it("activates housekeeping, camp, and facility packs with presets", async () => {
      for (const packCode of ["housekeeping", "camp", "facility"] as const) {
        const res = await post(`/service-operations/packs/${packCode}/activate`, adminToken, {
          seedPresets: true,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().isActive).toBe(true);
      }

      const listRes = await get("/service-operations/packs", adminToken);
      expect(listRes.statusCode).toBe(200);
      const activeCount = listRes.json().filter((p: any) => p.isActive).length;
      expect(activeCount).toBe(4);
    });

    it("deactivates a service pack without deleting service definitions", async () => {
      const res = await post("/service-operations/packs/catering/deactivate", adminToken);
      expect(res.statusCode).toBe(200);
      expect(res.json().isActive).toBe(false);

      const listRes = await get("/service-operations/packs", adminToken);
      const catering = listRes.json().find((p: any) => p.packCode === "catering");
      expect(catering.isActive).toBe(false);

      // Verify service definitions remain intact in generic service registry
      const defsRes = await get("/service-definitions", adminToken);
      const cateringDefs = defsRes.json().filter((d: any) => d.category === "catering");
      expect(cateringDefs.length).toBeGreaterThanOrEqual(1);
    });

    it("enforces RBAC permission check on service pack management", async () => {
      const res = await post("/service-operations/packs/facility/deactivate", operatorToken);
      expect(res.statusCode).toBe(403);
    });

    it("enforces tenant isolation for service pack activations", async () => {
      const otherListRes = await get("/service-operations/packs", otherAdminToken);
      expect(otherListRes.statusCode).toBe(200);
      // Other tenant has not activated any packs yet
      for (const pack of otherListRes.json()) {
        expect(pack.isActive).toBe(false);
      }
    });
  });

  // =========================================================================
  // Unit 2: SO-ADV-002…005 — Route, Roster, Capacity & Workload Optimization
  // =========================================================================

  describe("SO-ADV-002…005: Advisory Operations Optimization & Atomic Apply", () => {
    let unassignedWo1Id: string;
    let unassignedWo2Id: string;

    beforeAll(async () => {
      // Create generic work orders for optimization testing
      const wo1Res = await post("/work-orders", adminToken, {
        customerId,
        serviceDefinitionCode: "catering_meal_service",
        title: "Morning Shift Catering Service",
        priority: "high",
        plannedStartAt: "2026-09-01T07:00:00.000Z",
        plannedEndAt: "2026-09-01T10:00:00.000Z",
        dueAt: "2026-09-01T12:00:00.000Z",
      });
      expect(wo1Res.statusCode).toBe(201);
      unassignedWo1Id = wo1Res.json().id;

      const wo2Res = await post("/work-orders", adminToken, {
        customerId,
        serviceDefinitionCode: "catering_event_banquet",
        title: "Executive Lunch Banquet Service",
        priority: "medium",
        plannedStartAt: "2026-09-01T11:00:00.000Z",
        plannedEndAt: "2026-09-01T14:00:00.000Z",
        dueAt: "2026-09-01T15:00:00.000Z",
      });
      expect(wo2Res.statusCode).toBe(201);
      unassignedWo2Id = wo2Res.json().id;
    });

    it("generates advisory optimization run with deterministic proposals and rationales", async () => {
      const res = await post("/service-operations/optimization/runs", adminToken, {
        targetDate: "2026-09-01",
        organizationUnitId: orgUnitId,
        parameters: {
          maxWorkOrdersPerWorker: 5,
          maxMinutesPerWorker: 480,
          prioritizeSla: true,
        },
      });
      expect(res.statusCode).toBe(201);
      const run = res.json();
      optimizationRunId = run.id;
      expect(run.runNumber).toMatch(/^OPT-\d{4}-\d+$/);
      expect(run.status).toBe("proposed");
      expect(run.targetDate).toBe("2026-09-01");
      expect(Array.isArray(run.proposals)).toBe(true);
      expect(run.proposals.length).toBeGreaterThanOrEqual(2);

      // Verify explainable rationales and recommended worker
      for (const proposal of run.proposals) {
        expect(proposal.recommendedUserId).toBe(operatorUserId);
        expect(proposal.rationale).toBeTruthy();
      }
    });

    it("lists optimization runs and fetches detail by id", async () => {
      const listRes = await get("/service-operations/optimization/runs", operatorToken);
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().length).toBeGreaterThanOrEqual(1);

      const detailRes = await get(`/service-operations/optimization/runs/${optimizationRunId}`, operatorToken);
      expect(detailRes.statusCode).toBe(200);
      expect(detailRes.json().id).toBe(optimizationRunId);
    });

    it("atomically applies optimization run assignments to work orders", async () => {
      const applyRes = await post(`/service-operations/optimization/runs/${optimizationRunId}/apply`, adminToken);
      expect(applyRes.statusCode).toBe(200);
      const result = applyRes.json();
      expect(result.run.status).toBe("applied");
      expect(result.appliedCount).toBeGreaterThanOrEqual(2);
      expect(result.skippedCount).toBe(0);

      // Verify work orders in Core are now assigned to the recommended operator
      const wo1 = (await get(`/work-orders/${unassignedWo1Id}`, adminToken)).json();
      expect(wo1.workOrder.assignedToUserId).toBe(operatorUserId);
      expect(wo1.workOrder.assignedAt).toBeTruthy();

      const wo2 = (await get(`/work-orders/${unassignedWo2Id}`, adminToken)).json();
      expect(wo2.workOrder.assignedToUserId).toBe(operatorUserId);
      expect(wo2.workOrder.assignedAt).toBeTruthy();
    });

    it("rejects re-applying an already applied optimization run (idempotent guard)", async () => {
      const reapplyRes = await post(`/service-operations/optimization/runs/${optimizationRunId}/apply`, adminToken);
      expect(reapplyRes.statusCode).toBe(409);
    });

    it("supports dismissing an unapplied optimization proposal run", async () => {
      // Create a fresh unassigned work order and generate a new run
      await post("/work-orders", adminToken, {
        customerId,
        serviceDefinitionCode: "housekeeping_room_cleaning",
        title: "Guest Suite Turnover",
        plannedStartAt: "2026-09-02T08:00:00.000Z",
        dueAt: "2026-09-02T12:00:00.000Z",
      });

      const newRunRes = await post("/service-operations/optimization/runs", adminToken, {
        targetDate: "2026-09-02",
      });
      expect(newRunRes.statusCode).toBe(201);
      const newRunId = newRunRes.json().id;

      const dismissRes = await post(`/service-operations/optimization/runs/${newRunId}/dismiss`, adminToken);
      expect(dismissRes.statusCode).toBe(200);
      expect(dismissRes.json().status).toBe("dismissed");

      // Dismissed run cannot be applied
      const applyDismissedRes = await post(`/service-operations/optimization/runs/${newRunId}/apply`, adminToken);
      expect(applyDismissedRes.statusCode).toBe(409);
    });

    it("enforces RBAC permission on optimization apply", async () => {
      const res = await post(`/service-operations/optimization/runs/${optimizationRunId}/apply`, operatorToken);
      expect(res.statusCode).toBe(403);
    });

    it("refuses optimization runs to a customer-scoped actor (§4.4 line 3)", async () => {
      // A run spans every customer and names internal staff — there is no
      // customer axis to filter on, so the surface is internal-only.
      expect((await get("/service-operations/optimization/runs", customerScopeToken)).statusCode).toBe(403);
      expect(
        (await get(`/service-operations/optimization/runs/${optimizationRunId}`, customerScopeToken)).statusCode,
      ).toBe(403);
      expect(
        (await post("/service-operations/optimization/runs", customerScopeToken, { targetDate: "2026-09-02" }))
          .statusCode,
      ).toBe(403);
    });

    it("enforces multi-tenant isolation on optimization runs", async () => {
      const otherRes = await get(`/service-operations/optimization/runs/${optimizationRunId}`, otherAdminToken);
      expect(otherRes.statusCode).toBe(404);

      const otherApply = await post(
        `/service-operations/optimization/runs/${optimizationRunId}/apply`,
        otherAdminToken,
      );
      expect(otherApply.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // Unit 3: AST-ADV-001/002 — Maintenance Schedules & Workflow-Delegated Work Orders
  // =========================================================================

  describe("AST-ADV-001/002: Maintenance Schedules & Authoritative Workflow Work Orders", () => {
    it("creates calendar and meter-based maintenance schedules", async () => {
      // 1. Calendar schedule
      const calRes = await post("/assets/schedules", adminToken, {
        assetId,
        scheduleCode: "SCHED-CAL-MONTHLY",
        title: "Monthly Generator Fluid & Filter Inspection",
        frequencyType: "calendar",
        intervalDays: 30,
        nextDueDate: "2026-09-15",
      });
      expect(calRes.statusCode).toBe(201);
      const calSched = calRes.json();
      scheduleId = calSched.id;
      expect(calSched.scheduleCode).toBe("SCHED-CAL-MONTHLY");
      expect(calSched.frequencyType).toBe("calendar");
      expect(calSched.intervalDays).toBe(30);

      // 2. Meter schedule
      const meterRes = await post("/assets/schedules", adminToken, {
        assetId,
        scheduleCode: "SCHED-MTR-250H",
        title: "250-Hour Engine Overhaul Service",
        frequencyType: "meter",
        meterType: "hours",
        meterInterval: 250.0,
        nextDueMeter: 250.0,
      });
      expect(meterRes.statusCode).toBe(201);
      meterScheduleId = meterRes.json().id;
      expect(meterRes.json().frequencyType).toBe("meter");
      expect(meterRes.json().meterInterval).toBe(250.0);
    });

    it("lists maintenance schedules and discovers due schedules by target date", async () => {
      const listRes = await get(`/assets/schedules?assetId=${assetId}`, adminToken);
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().length).toBe(2);

      const dueRes = await get("/assets/schedules/due?asOfDate=2026-09-20", adminToken);
      expect(dueRes.statusCode).toBe(200);
      const dueSchedules = dueRes.json();
      expect(dueSchedules.some((s: any) => s.id === scheduleId)).toBe(true);
    });

    it("creates maintenance work order and verifies delegation to Workflow Engine (no local status)", async () => {
      const res = await post("/assets/work-orders", adminToken, {
        assetId,
        scheduleId,
        maintenanceType: "preventive",
        priority: "medium",
        title: "Execute Monthly Generator Routine Service",
        description: "Inspect oil levels, check coolant, and replace air filters",
        costEstimate: 350.0,
      });
      expect(res.statusCode).toBe(201);
      const wo = res.json();
      maintenanceWorkOrderId = wo.id;
      expect(wo.orderNumber).toMatch(/^PM-\d+$/);
      expect(wo.assetId).toBe(assetId);
      expect(wo.workflowInstanceId).toBeTruthy();
      expect(wo.startedAt).toBeNull();
      expect(wo.completedAt).toBeNull();
      expect(wo.verifiedAt).toBeNull();

      // Site-scoping (ADR-0007 amendment 2026-11-08): the Instance carries the
      // asset's owning Organization Unit so unit-scoped managers keep seeing it.
      const stamped = await pool.query(
        `SELECT wi.context_data, a.organization_unit_id
           FROM workflow_instances wi, assets a
          WHERE wi.id = $1 AND a.id = $2`,
        [wo.workflowInstanceId, assetId],
      );
      expect(stamped.rows[0].context_data).toHaveProperty("organizationUnitId");
      expect(stamped.rows[0].context_data.organizationUnitId).toBe(stamped.rows[0].organization_unit_id ?? null);

      // Detail view proves status is computed dynamically from Workflow Service
      const detailRes = await get(`/assets/work-orders/${maintenanceWorkOrderId}`, adminToken);
      expect(detailRes.statusCode).toBe(200);
      const detail = detailRes.json();
      expect(detail.workOrder.id).toBe(maintenanceWorkOrderId);
      expect(detail.status).toBeDefined();
      expect(detail.status.stepCode).toBe("CREATED");
      expect(Array.isArray(detail.availableActions)).toBe(true);
      expect(detail.availableActions.some((a: any) => a.actionCode === "start")).toBe(true);
    });

    it("assigns maintenance work order to technician", async () => {
      const res = await post(`/assets/work-orders/${maintenanceWorkOrderId}/assign`, adminToken, {
        assignedToUserId: operatorUserId,
      });
      expect(res.statusCode).toBe(200);
      const wo = res.json();
      expect(wo.assignedToUserId).toBe(operatorUserId);
      expect(wo.assignedAt).toBeTruthy();
    });

    it("transitions work order through authoritative workflow steps: start -> complete -> verify", async () => {
      // 1. Start work order
      const startRes = await post(`/assets/work-orders/${maintenanceWorkOrderId}/start`, adminToken);
      expect(startRes.statusCode).toBe(200);
      const startedWo = startRes.json();
      expect(startedWo.startedAt).toBeTruthy();

      // 2. Complete work order with completion facts (cost, downtime, and meter reading)
      const completeRes = await post(`/assets/work-orders/${maintenanceWorkOrderId}/complete`, adminToken, {
        completionNotes: "All filters replaced, oil changed, and generator tested under load.",
        actualCost: 320.0,
        downtimeHours: 1.5,
        currentMeterReading: 120.0,
      });
      expect(completeRes.statusCode).toBe(200);
      const completedWo = completeRes.json();
      expect(completedWo.completedAt).toBeTruthy();
      expect(completedWo.actualCost).toBe(320.0);
      expect(completedWo.downtimeHours).toBe(1.5);
      expect(completedWo.completionNotes).toContain("All filters replaced");

      // Verify schedule advancement after completion
      const scheduleAfterRes = await get(`/assets/schedules/${scheduleId}`, adminToken);
      expect(scheduleAfterRes.statusCode).toBe(200);
      const scheduleAfter = scheduleAfterRes.json();
      expect(scheduleAfter.lastPerformedAt).toBeTruthy();
      expect(scheduleAfter.nextDueDate).toBeTruthy();

      // 3. Verify work order
      const verifyRes = await post(`/assets/work-orders/${maintenanceWorkOrderId}/verify`, adminToken, {
        verificationNotes: "Supervisor confirmed operational standards and test run logs.",
      });
      expect(verifyRes.statusCode).toBe(200);
      const verifiedWo = verifyRes.json();
      expect(verifiedWo.verifiedAt).toBeTruthy();
      expect(verifiedWo.verificationNotes).toContain("Supervisor confirmed");

      // Detail view confirms workflow is in terminal approved state
      const finalDetailRes = await get(`/assets/work-orders/${maintenanceWorkOrderId}`, adminToken);
      expect(finalDetailRes.statusCode).toBe(200);
      const detail = finalDetailRes.json();
      expect(detail.status.instanceStatus).toBe("approved");
      expect(detail.status.stepCode).toBe("VERIFIED");
    });

    it("creates and completes a corrective maintenance work order for failure history", async () => {
      const createRes = await post("/assets/work-orders", adminToken, {
        assetId,
        maintenanceType: "corrective",
        priority: "high",
        title: "Emergency Alternator Replacement",
        description: "Alternator winding short circuit replacement",
        costEstimate: 1200.0,
      });
      expect(createRes.statusCode).toBe(201);
      correctiveWorkOrderId = createRes.json().id;

      await post(`/assets/work-orders/${correctiveWorkOrderId}/start`, adminToken);
      const completeRes = await post(`/assets/work-orders/${correctiveWorkOrderId}/complete`, adminToken, {
        completionNotes: "Alternator replaced and calibrated",
        actualCost: 1150.0,
        downtimeHours: 4.0,
      });
      expect(completeRes.statusCode).toBe(200);
      expect(completeRes.json().completedAt).toBeTruthy();
    });

    it("enforces tenant isolation on maintenance work orders and schedules", async () => {
      const otherSchedRes = await get(`/assets/schedules/${scheduleId}`, otherAdminToken);
      expect(otherSchedRes.statusCode).toBe(404);

      const otherWoRes = await get(`/assets/work-orders/${maintenanceWorkOrderId}`, otherAdminToken);
      expect(otherWoRes.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // Unit 4: AST-ADV-003…005 — Spare Parts, Monotonic Meter Readings & Downtime
  // =========================================================================

  describe("AST-ADV-003…005: Spare Parts, Meter Readings & Downtime Tracking", () => {
    it("records spare parts consumption linked to Supply Chain items on a work order", async () => {
      // Create a fresh open work order for parts recording
      const openWoRes = await post("/assets/work-orders", adminToken, {
        assetId,
        maintenanceType: "preventive",
        title: "Spare Parts Consumption Inspection",
      });
      expect(openWoRes.statusCode).toBe(201);
      const openWoId = openWoRes.json().id;

      const partRes = await post(`/assets/work-orders/${openWoId}/parts`, adminToken, {
        itemId,
        quantity: 5.0,
        unitCost: 18.5,
        notes: "5 Litres of engine oil consumed",
      });
      expect(partRes.statusCode).toBe(201);
      const part = partRes.json();
      expect(part.itemId).toBe(itemId);
      expect(part.quantity).toBe(5.0);
      expect(part.unitCost).toBe(18.5);

      const listPartsRes = await get(`/assets/work-orders/${openWoId}/parts`, adminToken);
      expect(listPartsRes.statusCode).toBe(200);
      expect(listPartsRes.json().length).toBe(1);

      // Rejects using an item from another tenant
      const crossPartRes = await post(`/assets/work-orders/${openWoId}/parts`, adminToken, {
        itemId: otherItemId,
        quantity: 1.0,
      });
      expect(crossPartRes.statusCode).toBe(404);
    });

    it("records monotonic meter readings and enforces non-decreasing validation", async () => {
      // 1. Initial reading
      const r1 = await post(`/assets/${assetId}/meter-readings`, operatorToken, {
        readingType: "hours",
        readingValue: 500.0,
        readingDate: "2026-08-01T00:00:00.000Z",
        notes: "Initial commissioning baseline",
      });
      expect(r1.statusCode).toBe(201);
      expect(r1.json().readingValue).toBe(500.0);

      // 2. Valid monotonic increment
      const r2 = await post(`/assets/${assetId}/meter-readings`, operatorToken, {
        readingType: "hours",
        readingValue: 580.0,
        readingDate: "2026-08-15T00:00:00.000Z",
        notes: "Mid-month check",
      });
      expect(r2.statusCode).toBe(201);
      expect(r2.json().readingValue).toBe(580.0);

      // 3. Rejects non-monotonic regression (lower value)
      const rLower = await post(`/assets/${assetId}/meter-readings`, operatorToken, {
        readingType: "hours",
        readingValue: 540.0,
        readingDate: "2026-08-20T00:00:00.000Z",
        notes: "Invalid regression reading",
      });
      expect(rLower.statusCode).toBe(400);

      // 4. Rejects past chronological timestamp
      const rPast = await post(`/assets/${assetId}/meter-readings`, operatorToken, {
        readingType: "hours",
        readingValue: 600.0,
        readingDate: "2026-08-10T00:00:00.000Z",
        notes: "Invalid past timestamp reading",
      });
      expect(rPast.statusCode).toBe(400);

      // 5. Query meter readings
      const readingsList = await get(`/assets/${assetId}/meter-readings?readingType=hours`, operatorToken);
      expect(readingsList.statusCode).toBe(200);
      expect(readingsList.json().length).toBe(2);
    });

    it("records downtime periods, calculates duration, and closes active downtime", async () => {
      // 1. Create closed downtime record
      const dt1 = await post(`/assets/${assetId}/downtime`, adminToken, {
        maintenanceWorkOrderId: correctiveWorkOrderId,
        startTime: "2026-08-10T08:00:00.000Z",
        endTime: "2026-08-10T12:00:00.000Z",
        reasonCategory: "breakdown",
        notes: "Alternator sudden trip",
      });
      expect(dt1.statusCode).toBe(201);
      expect(dt1.json().durationMinutes).toBe(240);
      expect(dt1.json().reasonCategory).toBe("breakdown");

      // 2. Create open downtime record and close it via endpoint
      const dt2 = await post(`/assets/${assetId}/downtime`, adminToken, {
        startTime: "2026-08-20T10:00:00.000Z",
        reasonCategory: "scheduled_maintenance",
        notes: "Scheduled overhaul downtime",
      });
      expect(dt2.statusCode).toBe(201);
      openDowntimeId = dt2.json().id;
      expect(dt2.json().endTime).toBeNull();

      const closeDtRes = await post(`/assets/downtime/${openDowntimeId}/close`, adminToken, {
        endTime: "2026-08-20T12:30:00.000Z",
      });
      expect(closeDtRes.statusCode).toBe(200);
      const closedDt = closeDtRes.json();
      expect(closedDt.endTime).toBeTruthy();
      expect(closedDt.durationMinutes).toBe(150);

      // 3. List downtime records for asset
      const listDt = await get(`/assets/${assetId}/downtime`, operatorToken);
      expect(listDt.statusCode).toBe(200);
      expect(listDt.json().length).toBeGreaterThanOrEqual(2);
    });

    it("enforces tenant isolation on meter readings and downtime records", async () => {
      const otherMtrRes = await get(`/assets/${assetId}/meter-readings`, otherAdminToken);
      expect(otherMtrRes.statusCode).toBe(404);

      const otherDtRes = await get(`/assets/${assetId}/downtime`, otherAdminToken);
      expect(otherDtRes.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // Unit 5: AST-ADV-006/007 — Reliability Analytics & Predictive Snapshots
  // =========================================================================

  describe("AST-ADV-006/007: Deterministic Reliability Analytics & Predictive Snapshots", () => {
    // The corrective work order below is completed via the API without an explicit
    // completedAt override, so the server stamps completed_at = NOW() at test-run time
    // (see completeMaintenanceWorkOrder in asset-advanced.repository.pg.ts). periodEnd
    // must therefore stay anchored to "tomorrow" (relative to whenever this suite runs)
    // rather than a hardcoded historical date, or the corrective failure would fall
    // outside the query window on any run date after that hardcoded cutoff. periodStart
    // stays fixed at 2026-08-01, safely before the fixture's hardcoded downtime records
    // (2026-08-10 / 2026-08-20).
    const reliabilityPeriodStart = "2026-08-01";
    const reliabilityPeriodEnd = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

    it("computes mathematical reliability metrics (MTBF, MTTR, Availability %)", async () => {
      const res = await get(
        `/assets/${assetId}/reliability?periodStart=${reliabilityPeriodStart}&periodEnd=${reliabilityPeriodEnd}`,
        operatorToken,
      );
      expect(res.statusCode).toBe(200);
      const metrics = res.json();
      expect(metrics.periodStart).toBe(reliabilityPeriodStart);
      expect(metrics.periodEnd).toBe(reliabilityPeriodEnd);
      expect(metrics.elapsedHours).toBeGreaterThan(0);
      expect(metrics.downtimeHours).toBeGreaterThan(0);
      expect(metrics.operationalHours).toBeGreaterThan(0);
      expect(metrics.correctiveFailureCount).toBeGreaterThanOrEqual(1);
      expect(metrics.mtbfHours).toBeGreaterThan(0);
      expect(metrics.mttrHours).toBeGreaterThan(0);
      expect(metrics.availabilityPct).toBeGreaterThan(0);
      expect(metrics.availabilityPct).toBeLessThanOrEqual(100);

      // Verify mathematical identity: operationalHours + downtimeHours ≈ elapsedHours
      const sum = metrics.operationalHours + metrics.downtimeHours;
      expect(Math.abs(sum - metrics.elapsedHours)).toBeLessThan(0.05);
    });

    it("generates deterministic predictive snapshot and inspects latest snapshot", async () => {
      const res = await post(`/assets/${assetId}/predictive-snapshots`, adminToken);
      expect(res.statusCode).toBe(201);
      const snapshot = res.json();
      expect(snapshot.assetId).toBe(assetId);
      expect(snapshot.healthScore).toBeGreaterThanOrEqual(10);
      expect(snapshot.healthScore).toBeLessThanOrEqual(100);
      expect(snapshot.confidencePct).toBeGreaterThan(0);
      expect(snapshot.recommendation).toBeTruthy();
      expect(snapshot.algorithmVersion).toBe("v1.0-deterministic");

      // Verify list and latest queries
      const listRes = await get(`/assets/${assetId}/predictive-snapshots`, operatorToken);
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().length).toBeGreaterThanOrEqual(1);

      const latestRes = await get(`/assets/${assetId}/predictive-snapshots/latest`, operatorToken);
      expect(latestRes.statusCode).toBe(200);
      expect(latestRes.json().id).toBe(snapshot.id);
      expect(latestRes.json().healthScore).toBe(snapshot.healthScore);
    });

    it("enforces RBAC permissions on reliability analytics and snapshot generation", async () => {
      // User without analytics permission cannot generate snapshots
      await createReadOnlyRole(tenantId, "NO_ANALYTICS_ROLE", ["asset.maintenance.read"]);
      const noPermUser = await post("/admin/users", adminToken, {
      email: "noanalytics@wave-a3.local",
      fullName: "No Analytics User",
      password: "User12345!",
      pairs: [{ roleCode: "NO_ANALYTICS_ROLE", scopeType: "tenant" }],
    });
      const noPermToken = (await login(app, TENANT_CODE, "noanalytics@wave-a3.local", "User12345!")).body.accessToken;

      const noPermRes = await post(`/assets/${assetId}/predictive-snapshots`, noPermToken);
      expect(noPermRes.statusCode).toBe(403);
    });

    it("enforces cross-tenant isolation on reliability analytics and predictive snapshots", async () => {
      const otherRelRes = await get(
        `/assets/${assetId}/reliability?periodStart=${reliabilityPeriodStart}&periodEnd=${reliabilityPeriodEnd}`,
        otherAdminToken,
      );
      expect(otherRelRes.statusCode).toBe(404);

      const otherSnapRes = await post(`/assets/${assetId}/predictive-snapshots`, otherAdminToken);
      expect(otherSnapRes.statusCode).toBe(404);
    });
  });
});
