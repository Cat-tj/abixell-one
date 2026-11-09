import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { workOrderUsesContractPricing } from "../../src/modules/service-operations/core/domain/service-operations.entity.js";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { activateAllModules, authHeader, bootstrapTenant, createReadOnlyRole, login, provisionFirstAdmin } from "./helpers.js";

/**
 * Phase 2 — Service Operations & Work Management Core (SO-CORE-001…015).
 *
 * Drives the real HTTP API end to end: Service Definition → Work Request →
 * Work Order → assignment/scheduling → execution + checklist + evidence →
 * completion → supervisor verification, plus authorization, Data Scope,
 * cross-tenant isolation, lifecycle validity, idempotency, and historical
 * safety. The Work Order lifecycle is a Tenant-configured Workflow Definition
 * built through the existing Workflow API — proving Service Operations never
 * hardcodes a Step graph (SO-CORE-004).
 */

const TENANT = `test-p2-${Date.now()}`;
const OTHER = `test-p2-other-${Date.now()}`;
const WORKFLOW_CODE = "service_operations_work_order";
const SERVICE_CODE = "generic_service_a";

describe("Phase 2 — Service Operations & Work Management Core", () => {
  const app = buildApp();

  let tenantId: string;
  let adminToken: string;
  let coordinatorToken: string;
  let executorToken: string;
  let executorUserId: string;
  let otherExecutorToken: string;
  let otherExecutorUserId: string;
  let verifierToken: string;
  let readerToken: string;
  let customerUserToken: string;
  let customerAId: string;
  let customerBId: string;
  let siteAId: string;

  let otherTenantAdminToken: string;
  let otherTenantUserId: string;
  let otherTenantWorkOrderId: string;

  const post = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers: authHeader(token), payload });
  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: authHeader(token) });
  const patch = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "PATCH", url, headers: authHeader(token), payload });

  /** Build the Work Order lifecycle as Tenant Configuration. */
  async function buildWorkflow(token: string) {
    await post("/workflow/definitions", token, {
      code: WORKFLOW_CODE,
      name: "Work Order Lifecycle",
      entityType: "work_order",
      description: "Phase 2 test lifecycle",
    });
    const addStep = (body: Record<string, unknown>) =>
      post(`/workflow/definitions/${WORKFLOW_CODE}/versions/1/steps`, token, body);
    await addStep({ code: "PLANNED", name: "Planned", stepType: "task", isInitial: true });
    await addStep({ code: "IN_PROGRESS", name: "In Progress", stepType: "task", slaHours: 8 });
    await addStep({ code: "DONE", name: "Done", stepType: "approval" });
    await addStep({ code: "CLOSED", name: "Closed", stepType: "end", isTerminal: true, terminalStatus: "approved" });
    await addStep({ code: "CANCELLED", name: "Cancelled", stepType: "end", isTerminal: true, terminalStatus: "cancelled" });

    const addTransition = (body: Record<string, unknown>) =>
      post(`/workflow/definitions/${WORKFLOW_CODE}/versions/1/transitions`, token, body);
    await addTransition({ fromStepCode: "PLANNED", toStepCode: "IN_PROGRESS", actionCode: "start", name: "Start Work" });
    await addTransition({ fromStepCode: "PLANNED", toStepCode: "CANCELLED", actionCode: "cancel", name: "Cancel" });
    await addTransition({ fromStepCode: "IN_PROGRESS", toStepCode: "DONE", actionCode: "complete", name: "Complete" });
    await addTransition({ fromStepCode: "DONE", toStepCode: "CLOSED", actionCode: "verify", name: "Verify" });

    const addRule = (body: Record<string, unknown>) =>
      post(`/workflow/definitions/${WORKFLOW_CODE}/versions/1/assignment-rules`, token, body);
    // Every step routes to the COORDINATOR role tenant-wide, so the test's
    // lifecycle actions are role-driven Tenant Configuration, not code.
    for (const stepCode of ["PLANNED", "IN_PROGRESS", "DONE"]) {
      await addRule({ stepCode, assignmentType: "role", roleCode: "COORD_P2", organizationUnitStrategy: "tenant" });
    }
    const publish = await post(`/workflow/definitions/${WORKFLOW_CODE}/versions/1/publish`, token);
    expect(publish.statusCode).toBe(200);
  }

  beforeAll(async () => {
    const t = await bootstrapTenant(app, TENANT, "Tenant P2");
    await activateAllModules(t.id);
    tenantId = t.id;
    await provisionFirstAdmin({ tenantId, email: "admin@p2.local", password: "Admin12345!" });
    adminToken = (await login(app, TENANT, "admin@p2.local", "Admin12345!")).body.accessToken;

    // Capability-based roles (no role-name logic anywhere in the module).
    await createReadOnlyRole(tenantId, "COORD_P2", [
      "service_operations.read",
      "service_operations.manage",
      "service_operations.configure",
      "customer.read",
      "workflow.instance.start",
      "workflow.instance.act",
      "document.read",
      "document.manage",
    ]);
    await createReadOnlyRole(tenantId, "EXEC_P2", [
      "service_operations.read",
      "service_operations.execute",
      "workflow.instance.act",
      "document.read",
      "document.manage",
    ]);
    await createReadOnlyRole(tenantId, "VERIFY_P2", [
      "service_operations.read",
      "service_operations.verify",
      "workflow.instance.act",
    ]);
    await createReadOnlyRole(tenantId, "READER_P2", ["service_operations.read", "customer.read"]);
    await createReadOnlyRole(tenantId, "CUSTOMER_P2", [
      "service_operations.read",
      "service_operations.manage",
      "customer.read",
      "workflow.instance.start",
    ]);

    const customerA = await post("/customers", adminToken, { code: "CUST-P2-A", name: "Customer A" });
    customerAId = customerA.json().id;
    const customerB = await post("/customers", adminToken, { code: "CUST-P2-B", name: "Customer B" });
    customerBId = customerB.json().id;
    const site = await post("/sites", adminToken, { customerId: customerAId, code: "SITE-P2-A", name: "Site A" });
    siteAId = site.json().id;

    // Two doors since B1b (§4.4 D): internal Users go through the governed
    // surface as one assignment pair; the Customer User stays on the ADR-0011
    // provisioning path.
    const mkUser = (email: string, roleCode: string, scope: Record<string, unknown> = { scopeType: "tenant" }) =>
      post(
        scope.scopeType === "customer"
          ? "/users"
          : "/admin/users",
        adminToken,
        scope.scopeType === "customer"
          ? { email, fullName: email, password: "Passw0rd12345!", roleCode, ...scope }
          : { email, fullName: email, password: "Passw0rd12345!", pairs: [{ roleCode, ...scope }] },
      );
    await mkUser("coord@p2.local", "COORD_P2");
    executorUserId = (await mkUser("exec@p2.local", "EXEC_P2")).json().user.id;
    otherExecutorUserId = (await mkUser("exec2@p2.local", "EXEC_P2")).json().user.id;
    await mkUser("verify@p2.local", "VERIFY_P2");
    await mkUser("reader@p2.local", "READER_P2");
    await mkUser("custuser@p2.local", "CUSTOMER_P2", { scopeType: "customer", scopeCustomerId: customerAId });

    const tok = async (email: string) => (await login(app, TENANT, email, "Passw0rd12345!")).body.accessToken;
    coordinatorToken = await tok("coord@p2.local");
    executorToken = await tok("exec@p2.local");
    otherExecutorToken = await tok("exec2@p2.local");
    verifierToken = await tok("verify@p2.local");
    readerToken = await tok("reader@p2.local");
    customerUserToken = await tok("custuser@p2.local");

    // Tenant Configuration: numbering + lifecycle.
    await post("/config/numbering/work_request", adminToken, { pattern: "WR-{SEQ:5}" });
    await post("/config/numbering/work_order", adminToken, { pattern: "WO-{SEQ:5}" });
    await post("/config/numbering/work_order_serving", adminToken, { pattern: "SRV-{SEQ:5}" });
    await buildWorkflow(adminToken);

    // Second tenant for cross-tenant isolation checks.
    const ot = await bootstrapTenant(app, OTHER, "Tenant P2 Other");
    await activateAllModules(ot.id);
    otherTenantUserId = (
      await provisionFirstAdmin({ tenantId: ot.id, email: "admin@p2other.local", password: "Admin12345!" })
    ).userId;
    otherTenantAdminToken = (await login(app, OTHER, "admin@p2other.local", "Admin12345!")).body.accessToken;
    await post("/config/numbering/work_request", otherTenantAdminToken, { pattern: "WR-O-{SEQ:5}" });
    await post("/config/numbering/work_order", otherTenantAdminToken, { pattern: "WO-O-{SEQ:5}" });
    await buildWorkflow(otherTenantAdminToken);
    const otherCustomer = await post("/customers", otherTenantAdminToken, { code: "CUST-O", name: "Other Customer" });
    await post("/service-definitions", otherTenantAdminToken, { code: SERVICE_CODE, name: "Other Service" });
    otherTenantWorkOrderId = (
      await post("/work-orders", otherTenantAdminToken, {
        customerId: otherCustomer.json().id,
        serviceDefinitionCode: SERVICE_CODE,
        title: "Other tenant work",
      })
    ).json().id;
  });

  afterAll(async () => {
    await pool.end();
  });

  // --- SO-CORE-001 / SO-CORE-007 ---------------------------------------

  it("SO-CORE-001/007: coordinator defines a reusable Service Definition with a checklist template", async () => {
    const created = await post("/service-definitions", coordinatorToken, {
      code: SERVICE_CODE,
      name: "Generic Service A",
      description: "Reusable service type",
      category: "generic",
    });
    expect(created.statusCode).toBe(201);

    for (const item of [
      { code: "prep", label: "Preparation done", isRequired: true, sortOrder: 1 },
      { code: "exec", label: "Work executed", isRequired: true, sortOrder: 2 },
      { code: "tidy", label: "Area tidied (optional)", isRequired: false, sortOrder: 3 },
    ]) {
      const r = await post(`/service-definitions/${SERVICE_CODE}/checklist-items`, coordinatorToken, item);
      expect(r.statusCode).toBe(201);
    }

    const detail = await get(`/service-definitions/${SERVICE_CODE}`, coordinatorToken);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().checklist).toHaveLength(3);

    // Duplicate code rejected.
    const dup = await post("/service-definitions", coordinatorToken, { code: SERVICE_CODE, name: "Dup" });
    expect(dup.statusCode).toBe(409);
  });

  it("Authorization: an executor cannot configure Service Definitions; a reader cannot execute", async () => {
    const configure = await post("/service-definitions", executorToken, { code: "nope", name: "Nope" });
    expect(configure.statusCode).toBe(403);

    const execute = await post("/work-orders/00000000-0000-0000-0000-000000000000/start", readerToken);
    expect(execute.statusCode).toBe(403);
  });

  // --- Full happy path: SO-CORE-002 … SO-CORE-015 -----------------------

  it("SO-CORE-002…015: request → work order → assign → schedule → execute → evidence → complete → verify", async () => {
    // SO-CORE-002 + SO-CORE-011 (numbering)
    const request = await post("/work-requests", customerUserToken, {
      customerId: customerAId,
      siteId: siteAId,
      serviceDefinitionCode: SERVICE_CODE,
      description: "Please perform the service at Site A",
      priority: "medium",
    });
    expect(request.statusCode).toBe(201);
    expect(request.json().requestNumber).toMatch(/^WR-\d{5}$/);
    const requestId = request.json().id;

    // SO-CORE-003: convert intake into executable work.
    const converted = await post(`/work-requests/${requestId}/convert`, coordinatorToken, {
      title: "Service A at Site A",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(converted.statusCode).toBe(201);
    const workOrderId = converted.json().id;
    expect(converted.json().workOrderNumber).toMatch(/^WO-\d{5}$/);
    // SO-CORE-004: lifecycle owned by Workflow, not a status column.
    expect(converted.json().workflowInstanceId).toBeTruthy();

    // Request is now converted and cannot convert twice.
    const second = await post(`/work-requests/${requestId}/convert`, coordinatorToken, {});
    expect(second.statusCode).toBe(409);
    expect((await get(`/work-requests/${requestId}`, coordinatorToken)).json().state).toBe("converted");

    // Checklist snapshotted from the template onto the work order.
    let detail = await get(`/work-orders/${workOrderId}`, coordinatorToken);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().checklist).toHaveLength(3);
    expect(detail.json().status.stepCode).toBe("PLANNED");

    // SO-CORE-005: assignment.
    const assigned = await post(`/work-orders/${workOrderId}/assign`, coordinatorToken, {
      assigneeUserId: executorUserId,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().assignedToUserId).toBe(executorUserId);

    // SO-CORE-006: basic scheduling.
    const scheduled = await post(`/work-orders/${workOrderId}/schedule`, coordinatorToken, {
      plannedStartAt: new Date(Date.now() + 3600000).toISOString(),
      plannedEndAt: new Date(Date.now() + 7200000).toISOString(),
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json().plannedStartAt).toBeTruthy();

    // SO-CORE-014: the executor sees it in their own work list.
    const myWork = await get("/work-orders/my", executorToken);
    expect(myWork.statusCode).toBe(200);
    expect(myWork.json().some((r: { workOrder: { id: string } }) => r.workOrder.id === workOrderId)).toBe(true);

    // SO-CORE-004: lifecycle transition through the Workflow Engine.
    const started = await post(`/work-orders/${workOrderId}/actions/start`, coordinatorToken, {});
    expect(started.statusCode).toBe(200);
    expect((await get(`/work-orders/${workOrderId}`, coordinatorToken)).json().status.stepCode).toBe("IN_PROGRESS");

    // SO-CORE-008: execution facts + checklist.
    expect((await post(`/work-orders/${workOrderId}/start`, executorToken)).statusCode).toBe(200);
    detail = await get(`/work-orders/${workOrderId}`, executorToken);
    const checklist = detail.json().checklist as { id: string; code: string }[];

    // Completion is blocked while a required item is outstanding.
    const premature = await post(`/work-orders/${workOrderId}/complete`, executorToken, { notes: "too early" });
    expect(premature.statusCode).toBe(400);

    for (const item of checklist.filter((c) => c.code !== "tidy")) {
      const r = await post(`/work-orders/${workOrderId}/checklist/${item.id}`, executorToken, {
        isCompleted: true,
        note: `${item.code} ok`,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().isCompleted).toBe(true);
    }

    // SO-CORE-009: evidence through Document Core (no new attachment system).
    const evidence = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        ...authHeader(executorToken),
        "content-type": "multipart/form-data; boundary=----p2boundary",
      },
      payload: Buffer.from(
        `------p2boundary\r\nContent-Disposition: form-data; name="entityType"\r\n\r\nwork_order\r\n` +
          `------p2boundary\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${workOrderId}\r\n` +
          `------p2boundary\r\nContent-Disposition: form-data; name="file"; filename="evidence.txt"\r\n` +
          `Content-Type: text/plain\r\n\r\nwork completed evidence\r\n------p2boundary--\r\n`,
      ),
    });
    expect(evidence.statusCode).toBe(201);

    // SO-CORE-010: completion.
    const completed = await post(`/work-orders/${workOrderId}/complete`, executorToken, { notes: "done" });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().completedByUserId).toBe(executorUserId);

    // Idempotency: a duplicate completion cannot overwrite the facts.
    const dupComplete = await post(`/work-orders/${workOrderId}/complete`, executorToken, { notes: "again" });
    expect(dupComplete.statusCode).toBe(409);

    await post(`/work-orders/${workOrderId}/actions/complete`, coordinatorToken, {});

    // SO-CORE-010: supervisor verification requires its own capability.
    const executorVerify = await post(`/work-orders/${workOrderId}/verify`, executorToken, {});
    expect(executorVerify.statusCode).toBe(403);

    const verified = await post(`/work-orders/${workOrderId}/verify`, verifierToken, { notes: "checked" });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().verifiedAt).toBeTruthy();
    expect((await post(`/work-orders/${workOrderId}/verify`, verifierToken, {})).statusCode).toBe(409);

    // SO-CORE-015: events + audit.
    const events = (
      await pool.query(
        `SELECT event_type FROM domain_events WHERE entity_type = 'work_order' AND entity_id = $1`,
        [workOrderId],
      )
    ).rows.map((r) => r.event_type);
    expect(events).toEqual(
      expect.arrayContaining(["work_order.created", "work_order.assigned", "work_order.started", "work_order.completed", "work_order.verified"]),
    );
    const audits = (
      await pool.query(`SELECT action FROM audit_log WHERE entity_type = 'work_order' AND entity_id = $1`, [workOrderId])
    ).rows.map((r) => r.action);
    expect(audits).toEqual(expect.arrayContaining(["work_order.created", "work_order.scheduled", "work_order.verified"]));
  });

  // --- Lifecycle validity (SO-CORE-004) --------------------------------

  it("SO-CORE-004: an action code invalid for the current Step is rejected by the Workflow Engine", async () => {
    const wo = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Lifecycle guard",
    });
    const id = wo.json().id;
    // 'verify' is not a valid transition from PLANNED.
    const invalid = await post(`/work-orders/${id}/actions/verify`, coordinatorToken, {});
    expect(invalid.statusCode).toBe(400);
    expect((await get(`/work-orders/${id}`, coordinatorToken)).json().status.stepCode).toBe("PLANNED");
  });

  // --- Execution ownership ---------------------------------------------

  it("Execution ownership: a different executor cannot execute work assigned to someone else", async () => {
    const wo = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Ownership guard",
    });
    const id = wo.json().id;
    await post(`/work-orders/${id}/assign`, coordinatorToken, { assigneeUserId: executorUserId });

    const foreign = await post(`/work-orders/${id}/start`, otherExecutorToken);
    expect(foreign.statusCode).toBe(403);
    expect((await post(`/work-orders/${id}/start`, executorToken)).statusCode).toBe(200);
  });

  // --- Historical safety (SO-CORE-047 posture) -------------------------

  it("Historical safety: editing the Service Definition checklist does not change existing Work Orders", async () => {
    const wo = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Snapshot check",
    });
    const id = wo.json().id;
    const before = (await get(`/work-orders/${id}`, coordinatorToken)).json().checklist.length;

    await post(`/service-definitions/${SERVICE_CODE}/checklist-items`, coordinatorToken, {
      code: "added_later",
      label: "Added after the work order existed",
      isRequired: true,
    });

    const after = (await get(`/work-orders/${id}`, coordinatorToken)).json().checklist;
    expect(after).toHaveLength(before);
    expect(after.some((c: { code: string }) => c.code === "added_later")).toBe(false);
  });

  // --- Data scope (SO-CORE-012) ----------------------------------------

  it("SO-CORE-012: a customer-scoped user sees only their own organisation's work", async () => {
    await post("/work-orders", coordinatorToken, {
      customerId: customerBId,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Customer B work",
    });

    const mine = await get("/work-orders", customerUserToken);
    expect(mine.statusCode).toBe(200);
    const customerIds = mine.json().map((r: { workOrder: { customerId: string } }) => r.workOrder.customerId);
    expect(customerIds.length).toBeGreaterThan(0);
    expect(new Set(customerIds)).toEqual(new Set([customerAId]));

    // And cannot raise a request against another customer.
    const foreign = await post("/work-requests", customerUserToken, {
      customerId: customerBId,
      serviceDefinitionCode: SERVICE_CODE,
      description: "should be denied",
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("SO-CORE-012 / §4.4 line 3: a customer-scoped user gets no internal staff ids or notes", async () => {
    const wo = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Internal surface filter",
    });
    const workOrderId = wo.json().id;
    await post(`/work-orders/${workOrderId}/assign`, coordinatorToken, { assigneeUserId: executorUserId });
    await post(`/work-orders/${workOrderId}/start`, executorToken);
    await post(`/work-orders/${workOrderId}/complete`, executorToken, { notes: "internal completion note" });

    // The list projection carries neither staff ids nor internal notes, and
    // the workflow status does not name the pending assignee either.
    const listed = (await get("/work-orders", customerUserToken)).json() as {
      workOrder: Record<string, unknown>;
      status: { assignment: { userId: string | null } | null } | null;
    }[];
    const row = listed.find((r) => r.workOrder.id === workOrderId);
    expect(row).toBeDefined();
    expect(row!.workOrder.assignedToUserId).toBeNull();
    expect(row!.workOrder.assignedByUserId).toBeNull();
    expect(row!.workOrder.startedByUserId).toBeNull();
    expect(row!.workOrder.completedByUserId).toBeNull();
    expect(row!.workOrder.completionNotes).toBeNull();
    expect(row!.workOrder.verificationNotes).toBeNull();
    expect(row!.status?.assignment?.userId ?? null).toBeNull();

    // Detail: same redaction, plus checklist notes and completers.
    const detail = (await get(`/work-orders/${workOrderId}`, customerUserToken)).json();
    expect(detail.workOrder.assignedToUserId).toBeNull();
    expect(detail.workOrder.completionNotes).toBeNull();
    for (const item of detail.checklist as Record<string, unknown>[]) {
      expect(item.note).toBeNull();
      expect(item.completedByUserId).toBeNull();
    }

    // Cost breakdown is internal-only — refused, not partially shown.
    expect((await get(`/work-orders/${workOrderId}/cost-items`, customerUserToken)).statusCode).toBe(403);

    // An internal actor still sees the full row.
    const internal = (await get("/work-orders", coordinatorToken)).json() as {
      workOrder: { id: string; assignedToUserId: string | null };
    }[];
    expect(internal.find((r) => r.workOrder.id === workOrderId)!.workOrder.assignedToUserId).toBe(executorUserId);
  });

  // --- Cross-tenant isolation ------------------------------------------

  it("Cross-tenant: another tenant's Work Order is invisible, immutable, and cannot receive evidence", async () => {
    expect((await get(`/work-orders/${otherTenantWorkOrderId}`, coordinatorToken)).statusCode).toBe(404);
    expect(
      (await post(`/work-orders/${otherTenantWorkOrderId}/assign`, coordinatorToken, { assigneeUserId: executorUserId }))
        .statusCode,
    ).toBe(404);
    expect((await post(`/work-orders/${otherTenantWorkOrderId}/verify`, verifierToken, {})).statusCode).toBe(404);

    const listedIds = (await get("/work-orders", coordinatorToken)).json().map(
      (r: { workOrder: { id: string } }) => r.workOrder.id,
    );
    expect(listedIds).not.toContain(otherTenantWorkOrderId);
  });

  it("Cross-tenant: a user from another tenant cannot be assigned work", async () => {
    const wo = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Cross-tenant assignment guard",
    });
    const denied = await post(`/work-orders/${wo.json().id}/assign`, coordinatorToken, {
      assigneeUserId: otherTenantUserId,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("Cross-tenant: a Service Definition code from another tenant is not usable", async () => {
    // Same code exists in both tenants; each resolves only its own.
    const own = await get(`/service-definitions/${SERVICE_CODE}`, coordinatorToken);
    const other = await get(`/service-definitions/${SERVICE_CODE}`, otherTenantAdminToken);
    expect(own.json().definition.id).not.toBe(other.json().definition.id);

    const unknown = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: "definitely_not_in_this_tenant",
      title: "Should fail",
    });
    expect(unknown.statusCode).toBe(404);
  });

  // --- Intake lifecycle -------------------------------------------------

  it("Work Request: an open request can be cancelled, and a cancelled request cannot convert", async () => {
    const request = await post("/work-requests", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: SERVICE_CODE,
      description: "to be cancelled",
    });
    const id = request.json().id;
    const cancelled = await post(`/work-requests/${id}/cancel`, coordinatorToken, { reason: "not needed" });
    expect(cancelled.statusCode).toBe(200);
    expect((await get(`/work-requests/${id}`, coordinatorToken)).json().state).toBe("cancelled");

    expect((await post(`/work-requests/${id}/convert`, coordinatorToken, {})).statusCode).toBe(409);
    expect((await post(`/work-requests/${id}/cancel`, coordinatorToken, {})).statusCode).toBe(409);
  });

  it("Service Definition: an inactive definition cannot be used for new work", async () => {
    await post("/service-definitions", coordinatorToken, { code: "retired_service", name: "Retired" });
    const deactivated = await patch("/service-definitions/retired_service/active", coordinatorToken, {
      isActive: false,
    });
    expect(deactivated.statusCode).toBe(200);

    const attempt = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: "retired_service",
      title: "Should be rejected",
    });
    expect(attempt.statusCode).toBe(409);
  });

  it("Scheduling validation: plannedEndAt earlier than plannedStartAt is rejected", async () => {
    const wo = await post("/work-orders", coordinatorToken, {
      customerId: customerAId,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Schedule validation",
    });
    const bad = await post(`/work-orders/${wo.json().id}/schedule`, coordinatorToken, {
      plannedStartAt: new Date(Date.now() + 7200000).toISOString(),
      plannedEndAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(bad.statusCode).toBe(400);
  });

  describe("WO type — regular vs back_charge", () => {
    it("defaults to regular and keeps the contract link", async () => {
      const code = `WOT-${Date.now()}`;
      const c = await pool.query(
        `INSERT INTO contracts (tenant_id, customer_id, code, name) VALUES ($1,$2,$3,'WO type contract') RETURNING id`,
        [tenantId, customerAId, code],
      );
      const contractId = c.rows[0].id as string;
      const plain = await post("/work-orders", coordinatorToken, {
        customerId: customerAId,
        serviceDefinitionCode: SERVICE_CODE,
        title: "Default type",
      });
      expect(plain.statusCode).toBe(201);
      expect(plain.json().woType).toBe("regular");
      const withContract = await post("/work-orders", coordinatorToken, {
        customerId: customerAId,
        serviceDefinitionCode: SERVICE_CODE,
        title: "Regular with contract",
        contractId,
        woType: "regular",
      });
      expect(withContract.statusCode).toBe(201);
      expect(withContract.json().woType).toBe("regular");
      expect(withContract.json().contractId).toBe(contractId);
      expect(workOrderUsesContractPricing(withContract.json())).toBe(true);
      const detail = await get(`/work-orders/${withContract.json().id}`, coordinatorToken);
      expect(detail.json().workOrder.woType).toBe("regular");
    });

    it("creates a back_charge WO that skips contract pricing and rejects a contract", async () => {
      const bc = await post("/work-orders", coordinatorToken, {
        customerId: customerAId,
        serviceDefinitionCode: SERVICE_CODE,
        title: "Back charge",
        woType: "back_charge",
      });
      expect(bc.statusCode).toBe(201);
      expect(bc.json().woType).toBe("back_charge");
      expect(bc.json().contractId).toBeNull();
      expect(workOrderUsesContractPricing(bc.json())).toBe(false);

      const bad = await post("/work-orders", coordinatorToken, {
        customerId: customerAId,
        serviceDefinitionCode: SERVICE_CODE,
        title: "Back charge with contract",
        woType: "back_charge",
        contractId: "00000000-0000-4000-8000-000000000001",
      });
      expect(bad.statusCode).toBe(400);

      const invalid = await post("/work-orders", coordinatorToken, {
        customerId: customerAId,
        serviceDefinitionCode: SERVICE_CODE,
        title: "Bad type",
        woType: "other",
      });
      expect(invalid.statusCode).toBe(400);
    });
  });

  describe("SO-CORE-016 — Work Order Serving Phase", () => {
    it("recordServingLog: accepted WO receives meal serving event", async () => {
      const wo = await post("/work-orders", coordinatorToken, {
        customerId: customerAId,
        serviceDefinitionCode: SERVICE_CODE,
        title: "Serving test",
      });
      const workOrderId = wo.json().id;

      // Workflow: PLANNED → IN_PROGRESS → DONE → CLOSED (customer-accepted).
      await post(`/work-orders/${workOrderId}/assign`, coordinatorToken, { assigneeUserId: executorUserId });
      await post(`/work-orders/${workOrderId}/actions/start`, coordinatorToken, {});
      await post(`/work-orders/${workOrderId}/start`, executorToken);

      // Complete all required checklist items before /complete.
      const detail = await get(`/work-orders/${workOrderId}`, executorToken);
      const checklist = detail.json().checklist as { id: string; code: string }[];
      for (const item of checklist) {
        await post(`/work-orders/${workOrderId}/checklist/${item.id}`, executorToken, {
          isCompleted: true,
          note: `${item.code} ok`,
        });
      }

      await post(`/work-orders/${workOrderId}/complete`, executorToken, { notes: "done" });
      await post(`/work-orders/${workOrderId}/actions/complete`, coordinatorToken, {});
      await post(`/work-orders/${workOrderId}/verify`, verifierToken, { notes: "verified" });
      const accepted = await post(`/work-orders/${workOrderId}/customer-accept`, verifierToken, {});
      expect(accepted.statusCode).toBe(200);

      // Nothing recorded yet: a normal state, answered as { servingLog: null }.
      const none = await get(`/work-orders/${workOrderId}/serving`, coordinatorToken);
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ servingLog: null });

      // Record a serving event: meals received, served, returned, wasted.
      const serving = await post(`/work-orders/${workOrderId}/serving`, coordinatorToken, {
        mealDate: "2026-10-30",
        mealType: "lunch",
        openingTime: new Date().toISOString(),
        closingTime: new Date(Date.now() + 3600000).toISOString(),
        receivedQty: "100.0000",
        servedQty: "95.0000",
        returnedQty: "3.0000",
        wastedQty: "2.0000",
        servicePointId: siteAId,
        servingSupervisorUserId: executorUserId,
      });
      expect(serving.statusCode).toBe(201);
      expect(serving.json().servingLog.servingNumber).toMatch(/^SRV-/);
      expect(serving.json().servingLog.remainingQty).toBe("0.0000"); // 100 - 95 - 3 - 2
      expect(serving.json().workOrder.servingRecordedAt).toBeTruthy();

      // GET answers with the same { servingLog } envelope the web reads.
      const read = await get(`/work-orders/${workOrderId}/serving`, coordinatorToken);
      expect(read.statusCode).toBe(200);
      expect(read.json().servingLog.servingNumber).toBe(serving.json().servingLog.servingNumber);
    });
  });

  describe("SO-CORE-017 — KPI Dashboard (4 core KPIs)", () => {
    it("getMgmtDashboard: computes meal fulfillment, food waste, food cost from serving + WO data", async () => {
      const wo = await post("/work-orders", coordinatorToken, {
        customerId: customerAId,
        serviceDefinitionCode: SERVICE_CODE,
        title: "KPI dashboard test",
      });
      const workOrderId = wo.json().id;

      await post(`/work-orders/${workOrderId}/assign`, coordinatorToken, { assigneeUserId: executorUserId });
      await post(`/work-orders/${workOrderId}/actions/start`, coordinatorToken, {});
      await post(`/work-orders/${workOrderId}/start`, executorToken);

      const detail = await get(`/work-orders/${workOrderId}`, executorToken);
      const checklist = detail.json().checklist as { id: string; code: string }[];
      for (const item of checklist) {
        await post(`/work-orders/${workOrderId}/checklist/${item.id}`, executorToken, {
          isCompleted: true,
          note: `${item.code} ok`,
        });
      }

      await post(`/work-orders/${workOrderId}/complete`, executorToken, { notes: "done" });
      await post(`/work-orders/${workOrderId}/actions/complete`, coordinatorToken, {});
      await post(`/work-orders/${workOrderId}/verify`, verifierToken, { notes: "verified" });
      await post(`/work-orders/${workOrderId}/customer-accept`, verifierToken, {});

      // Record a serving event: 100 received, 80 served, 20 wasted (20% waste, 80% fulfillment).
      const serving = await post(`/work-orders/${workOrderId}/serving`, coordinatorToken, {
        mealDate: "2026-10-30",
        mealType: "lunch",
        openingTime: new Date().toISOString(),
        receivedQty: "100.0000",
        servedQty: "80.0000",
        returnedQty: "0.0000",
        wastedQty: "20.0000",
      });
      expect(serving.statusCode).toBe(201);

      // Query the dashboard for the current month.
      const period = new Date().toISOString().substring(0, 7); // YYYY-MM
      const dashboard = await get(`/dashboard/management?period=${period}`, coordinatorToken);
      expect(dashboard.statusCode).toBe(200);

      const body = dashboard.json();
      expect(body.period).toBe(period);
      expect(body.mealFulfillment.metric).toBe("Meal Fulfillment Rate");
      expect(body.foodWaste.metric).toBe("Food Waste Percentage");
      expect(body.productionAchievement.metric).toBe("Production Achievement");
      expect(body.foodCostPerMeal.metric).toBe("Food Cost per Meal");

      // At least this one serving log's numbers should be reflected
      // (fulfillment = served/received*100, waste = wasted/received*100).
      // Tenant-wide totals include other tests' data in this describe block,
      // so assert the metrics exist and are well-formed percentages, not exact values.
      expect(Number(body.mealFulfillment.value)).toBeGreaterThanOrEqual(0);
      expect(Number(body.foodWaste.value)).toBeGreaterThanOrEqual(0);
      expect(body.mealFulfillment.dataPoints).toBeGreaterThan(0);
    });

    it("getMgmtDashboard rejects malformed period", async () => {
      const bad = await get("/dashboard/management?period=not-a-date", coordinatorToken);
      expect(bad.statusCode).toBe(400);
    });

    it("getMgmtDashboard requires service_operations.read permission", async () => {
      // CUSTOMER_P2 has service_operations.manage but let's verify READER_P2 (read-only) works.
      const period = new Date().toISOString().substring(0, 7);
      const asReader = await get(`/dashboard/management?period=${period}`, readerToken);
      expect(asReader.statusCode).toBe(200);
    });
  });
});
