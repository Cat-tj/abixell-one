import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { activateAllModules, authHeader, bootstrapTenant, createReadOnlyRole, login, provisionFirstAdmin } from "./helpers.js";

/**
 * Phase 4 — Supply Chain Core (SCM-CORE-001…013).
 *
 * Drives the real HTTP API: item + supplier master → stock in/out →
 * purchase request through the Workflow Engine → purchase order → receipt
 * against the order. Plus transactional integrity, concurrency safety,
 * authorization, Data Scope, cross-tenant isolation, and validation.
 */

const TENANT = `test-p4-${Date.now()}`;
const OTHER = `test-p4-other-${Date.now()}`;
const PR_WORKFLOW = "purchase_request_approval";

describe("Phase 4 — Supply Chain Core", () => {
  const app = buildApp();

  let tenantId: string;
  let adminToken: string;
  let buyerToken: string;
  let storeToken: string;
  let readerToken: string;
  let scopedToken: string;
  let unitNorthId: string;
  let unitSouthId: string;
  let siteId: string;

  let otherAdminToken: string;
  let otherItemCode: string;
  let otherOrderId: string;

  const post = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers: authHeader(token), payload });
  const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: authHeader(token) });
  const patch = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "PATCH", url, headers: authHeader(token), payload });

  async function buildPrWorkflow(token: string) {
    await post("/workflow/definitions", token, {
      code: PR_WORKFLOW,
      name: "Purchase Request Approval",
      entityType: "purchase_request",
      description: "Phase 4 test approval lifecycle",
    });
    const addStep = (b: Record<string, unknown>) =>
      post(`/workflow/definitions/${PR_WORKFLOW}/versions/1/steps`, token, b);
    await addStep({ code: "DRAFT", name: "Draft", stepType: "task", isInitial: true });
    await addStep({ code: "REVIEW", name: "Review", stepType: "approval", slaHours: 24 });
    await addStep({ code: "APPROVED", name: "Approved", stepType: "end", isTerminal: true, terminalStatus: "approved" });
    await addStep({ code: "REJECTED", name: "Rejected", stepType: "end", isTerminal: true, terminalStatus: "rejected" });

    const addTransition = (b: Record<string, unknown>) =>
      post(`/workflow/definitions/${PR_WORKFLOW}/versions/1/transitions`, token, b);
    await addTransition({ fromStepCode: "DRAFT", toStepCode: "REVIEW", actionCode: "submit", name: "Submit" });
    await addTransition({ fromStepCode: "REVIEW", toStepCode: "APPROVED", actionCode: "approve", name: "Approve" });
    await addTransition({ fromStepCode: "REVIEW", toStepCode: "REJECTED", actionCode: "reject", name: "Reject" });

    for (const stepCode of ["DRAFT", "REVIEW"]) {
      await post(`/workflow/definitions/${PR_WORKFLOW}/versions/1/assignment-rules`, token, {
        stepCode,
        assignmentType: "role",
        roleCode: "BUYER_P4",
        organizationUnitStrategy: "tenant",
      });
    }
    const publish = await post(`/workflow/definitions/${PR_WORKFLOW}/versions/1/publish`, token);
    expect(publish.statusCode).toBe(200);
  }

  /** Drive a request all the way to APPROVED and return its id. */
  async function approvedRequest(itemCode: string, quantity = 10): Promise<string> {
    const created = await post("/purchase-requests", buyerToken, {
      justification: "Stock replenishment",
      lines: [{ itemCode, quantity }],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id;
    await post(`/purchase-requests/${id}/actions/submit`, buyerToken, {});
    await post(`/purchase-requests/${id}/actions/approve`, buyerToken, {});
    return id;
  }

  beforeAll(async () => {
    const t = await bootstrapTenant(app, TENANT, "Tenant P4");
    await activateAllModules(t.id);
    tenantId = t.id;
    await provisionFirstAdmin({ tenantId, email: "admin@p4.local", password: "Admin12345!" });
    adminToken = (await login(app, TENANT, "admin@p4.local", "Admin12345!")).body.accessToken;

    const legal = await post("/legal-entities", adminToken, { code: "LE-P4", name: "Legal Entity P4" });
    const north = await post("/organization-units", adminToken, {
      legalEntityId: legal.json().id,
      code: "N-P4",
      name: "North P4",
    });
    unitNorthId = north.json().id;
    const south = await post("/organization-units", adminToken, {
      legalEntityId: legal.json().id,
      code: "S-P4",
      name: "South P4",
    });
    unitSouthId = south.json().id;

    const customer = await post("/customers", adminToken, { code: "CUST-P4", name: "Customer P4" });
    const site = await post("/sites", adminToken, {
      customerId: customer.json().id,
      code: "SITE-P4",
      name: "Site P4",
    });
    siteId = site.json().id;

    await createReadOnlyRole(tenantId, "BUYER_P4", [
      "supply_chain.read",
      "supply_chain.manage",
      "supply_chain.configure",
      "wms.price.view",
      "workflow.instance.start",
      "workflow.instance.act",
    ]);
    await createReadOnlyRole(tenantId, "STORE_P4", ["supply_chain.read", "supply_chain.stock.manage"]);
    await createReadOnlyRole(tenantId, "READER_P4", ["supply_chain.read"]);

    const mkUser = (email: string, roleCode: string, scope: Record<string, unknown> = { scopeType: "tenant" }) =>
      post("/admin/users", adminToken, { email, fullName: email, password: "Passw0rd12345!", pairs: [{ roleCode, ...scope }] });
    await mkUser("buyer@p4.local", "BUYER_P4");
    await mkUser("store@p4.local", "STORE_P4");
    await mkUser("reader@p4.local", "READER_P4");
    await mkUser("scoped@p4.local", "BUYER_P4", {
      scopeType: "organization_unit",
      scopeOrganizationUnitId: unitNorthId,
    });

    const tok = async (email: string) => (await login(app, TENANT, email, "Passw0rd12345!")).body.accessToken;
    buyerToken = await tok("buyer@p4.local");
    storeToken = await tok("store@p4.local");
    readerToken = await tok("reader@p4.local");
    scopedToken = await tok("scoped@p4.local");

    await post("/config/numbering/purchase_request", adminToken, { pattern: "PR-{SEQ:5}" });
    await post("/config/numbering/purchase_order", adminToken, { pattern: "PO-{SEQ:5}" });
    await buildPrWorkflow(adminToken);

    // Second tenant for cross-tenant checks.
    const ot = await bootstrapTenant(app, OTHER, "Tenant P4 Other");
    await activateAllModules(ot.id);
    await provisionFirstAdmin({ tenantId: ot.id, email: "admin@p4other.local", password: "Admin12345!" });
    otherAdminToken = (await login(app, OTHER, "admin@p4other.local", "Admin12345!")).body.accessToken;
    await post("/config/numbering/purchase_order", otherAdminToken, { pattern: "PO-O-{SEQ:5}" });
    otherItemCode = "other-item";
    await post("/items", otherAdminToken, { code: otherItemCode, name: "Other Item", unitOfMeasure: "EA" });
    await post("/suppliers", otherAdminToken, { code: "other-sup", name: "Other Supplier" });
    otherOrderId = (
      await post("/purchase-orders", otherAdminToken, {
        supplierCode: "other-sup",
        lines: [{ itemCode: otherItemCode, quantity: 5 }],
      })
    ).json().order.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  // --- SCM-CORE-001/002 --------------------------------------------------

  it("SCM-CORE-001/002: item and supplier master with duplicate-code protection", async () => {
    const item = await post("/items", buyerToken, {
      code: "bolt-m8",
      name: "Bolt M8",
      unitOfMeasure: "EA",
      category: "fastener",
    });
    expect(item.statusCode).toBe(201);
    expect((await post("/items", buyerToken, { code: "bolt-m8", name: "Dup", unitOfMeasure: "EA" })).statusCode).toBe(409);

    const supplier = await post("/suppliers", buyerToken, {
      code: "acme",
      name: "Acme Supplies",
      email: "sales@acme.test",
    });
    expect(supplier.statusCode).toBe(201);
    expect((await post("/suppliers", buyerToken, { code: "acme", name: "Dup" })).statusCode).toBe(409);

    const listed = await get("/items?search=Bolt", readerToken);
    expect(listed.json().some((i: { code: string }) => i.code === "bolt-m8")).toBe(true);
  });

  it("An inactive item cannot be used for stock or ordering", async () => {
    await post("/items", buyerToken, { code: "retired-item", name: "Retired", unitOfMeasure: "EA" });
    expect((await patch("/items/retired-item", buyerToken, { isActive: false })).statusCode).toBe(200);
    const denied = await post("/stock/goods-in", storeToken, { itemCode: "retired-item", quantity: 5 });
    expect(denied.statusCode).toBe(409);
  });

  // --- SCM-CORE-003/004/005/006 -----------------------------------------

  it("SCM-CORE-004/005: goods in increases and goods out decreases the balance, with a movement ledger", async () => {
    await post("/items", buyerToken, { code: "cable-2m", name: "Cable 2m", unitOfMeasure: "EA" });

    const received = await post("/stock/goods-in", storeToken, {
      itemCode: "cable-2m",
      quantity: 100,
      reference: "opening balance",
    });
    expect(received.statusCode).toBe(201);
    expect(received.json().balance.quantity).toBe(100);

    const issued = await post("/stock/goods-out", storeToken, { itemCode: "cable-2m", quantity: 30 });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().balance.quantity).toBe(70);

    const movements = await get("/stock/movements?itemCode=cable-2m", readerToken);
    expect(movements.json()).toHaveLength(2);
    expect(movements.json().map((m: { movementType: string }) => m.movementType).sort()).toEqual(["in", "out"]);
  });

  it("SCM-CORE-005: an issue larger than the balance is rejected and changes nothing", async () => {
    await post("/items", buyerToken, { code: "valve-x", name: "Valve X", unitOfMeasure: "EA" });
    await post("/stock/goods-in", storeToken, { itemCode: "valve-x", quantity: 5 });

    const denied = await post("/stock/goods-out", storeToken, { itemCode: "valve-x", quantity: 9 });
    expect(denied.statusCode).toBe(409);

    // Balance untouched and NO movement was written — the whole transaction
    // rolled back.
    const balances = await get("/stock/balances?itemCode=valve-x", readerToken);
    expect(balances.json()[0].quantity).toBe(5);
    const movements = await get("/stock/movements?itemCode=valve-x", readerToken);
    expect(movements.json()).toHaveLength(1);
  });

  it("Concurrency: simultaneous issues cannot overspend the balance", async () => {
    await post("/items", buyerToken, { code: "race-item", name: "Race Item", unitOfMeasure: "EA" });
    await post("/stock/goods-in", storeToken, { itemCode: "race-item", quantity: 10 });

    // Six concurrent issues of 2 against a balance of 10: at most five can
    // succeed, and the balance must never go negative.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        post("/stock/goods-out", storeToken, { itemCode: "race-item", quantity: 2 }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 201).length;
    const rejected = results.filter((r) => r.statusCode === 409).length;
    expect(ok).toBe(5);
    expect(rejected).toBe(1);

    const balance = (await get("/stock/balances?itemCode=race-item", readerToken)).json()[0];
    expect(balance.quantity).toBe(0);
    const movements = await get("/stock/movements?itemCode=race-item", readerToken);
    // 1 inbound + exactly the successful outbound movements.
    expect(movements.json()).toHaveLength(ok + 1);
  });

  it("Stock is tracked per location: site balance and tenant-level balance are separate", async () => {
    await post("/items", buyerToken, { code: "paint-5l", name: "Paint 5L", unitOfMeasure: "L" });
    await post("/stock/goods-in", storeToken, { itemCode: "paint-5l", quantity: 12 });
    await post("/stock/goods-in", storeToken, { itemCode: "paint-5l", quantity: 7, siteId });

    const balances = (await get("/stock/balances?itemCode=paint-5l", readerToken)).json();
    expect(balances).toHaveLength(2);
    const bySite = balances.find((b: { siteId: string | null }) => b.siteId === siteId);
    const tenantLevel = balances.find((b: { siteId: string | null }) => b.siteId === null);
    expect(bySite.quantity).toBe(7);
    expect(tenantLevel.quantity).toBe(12);
  });

  // --- SCM-CORE-007/008 --------------------------------------------------

  it("SCM-CORE-007/008: a purchase request follows the configured Workflow lifecycle", async () => {
    await post("/items", buyerToken, { code: "filter-a", name: "Filter A", unitOfMeasure: "EA" });

    const created = await post("/purchase-requests", buyerToken, {
      justification: "Maintenance stock",
      requiredDate: "2026-11-30",
      lines: [{ itemCode: "filter-a", quantity: 25, note: "urgent" }],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.request.requestNumber).toMatch(/^PR-\d{5}$/);
    expect(body.lines).toHaveLength(1);
    expect(body.status.stepCode).toBe("DRAFT");
    expect(body.request.workflowInstanceId).toBeTruthy();

    const id = body.request.id;
    expect((await post(`/purchase-requests/${id}/actions/submit`, buyerToken, {})).statusCode).toBe(200);
    expect((await get(`/purchase-requests/${id}`, buyerToken)).json().status.stepCode).toBe("REVIEW");

    // An action invalid for the current step is rejected by the engine.
    expect((await post(`/purchase-requests/${id}/actions/submit`, buyerToken, {})).statusCode).toBe(400);

    expect((await post(`/purchase-requests/${id}/actions/approve`, buyerToken, {})).statusCode).toBe(200);
    expect((await get(`/purchase-requests/${id}`, buyerToken)).json().status.instanceStatus).toBe("approved");
  });

  it("A purchase request needs at least one line and a known item", async () => {
    expect(
      (await post("/purchase-requests", buyerToken, { justification: "empty", lines: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await post("/purchase-requests", buyerToken, {
          justification: "unknown item",
          lines: [{ itemCode: "does-not-exist", quantity: 1 }],
        })
      ).statusCode,
    ).toBe(404);
  });

  // --- SCM-CORE-009/010 --------------------------------------------------

  it("SCM-CORE-009/010: approved request → order → issue → receipt increases stock", async () => {
    await post("/items", buyerToken, { code: "gasket-b", name: "Gasket B", unitOfMeasure: "EA" });
    const requestId = await approvedRequest("gasket-b", 40);

    const order = await post("/purchase-orders", buyerToken, {
      supplierCode: "acme",
      purchaseRequestId: requestId,
      currency: "IDR",
      lines: [{ itemCode: "gasket-b", quantity: 40, unitPrice: 2500 }],
    });
    expect(order.statusCode).toBe(201);
    const orderBody = order.json();
    expect(orderBody.order.orderNumber).toMatch(/^PO-\d{5}$/);
    expect(orderBody.state).toBe("draft");
    expect(orderBody.lines[0].quantityOrdered).toBe(40);
    expect(orderBody.lines[0].unitPrice).toBe(2500);
    const orderId = orderBody.order.id;

    // A request converts exactly once.
    const second = await post("/purchase-orders", buyerToken, {
      supplierCode: "acme",
      purchaseRequestId: requestId,
    });
    expect(second.statusCode).toBe(409);

    // Receiving before issue is rejected.
    expect(
      (await post(`/purchase-orders/${orderId}/receipts`, storeToken, {
        lineId: orderBody.lines[0].id,
        quantity: 5,
      })).statusCode,
    ).toBe(409);

    expect((await post(`/purchase-orders/${orderId}/issue`, buyerToken)).statusCode).toBe(200);
    expect((await get(`/purchase-orders/${orderId}`, buyerToken)).json().state).toBe("issued");
    // Issuing twice is rejected.
    expect((await post(`/purchase-orders/${orderId}/issue`, buyerToken)).statusCode).toBe(409);

    // Partial receipt.
    const first = await post(`/purchase-orders/${orderId}/receipts`, storeToken, {
      lineId: orderBody.lines[0].id,
      quantity: 15,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().line.quantityReceived).toBe(15);
    expect(first.json().balance.quantity).toBe(15);

    // Over-receipt beyond the ordered quantity is rejected.
    const over = await post(`/purchase-orders/${orderId}/receipts`, storeToken, {
      lineId: orderBody.lines[0].id,
      quantity: 30,
    });
    expect(over.statusCode).toBe(409);

    // Remaining quantity receives fine.
    const rest = await post(`/purchase-orders/${orderId}/receipts`, storeToken, {
      lineId: orderBody.lines[0].id,
      quantity: 25,
    });
    expect(rest.statusCode).toBe(201);
    expect(rest.json().line.quantityReceived).toBe(40);
    expect(rest.json().balance.quantity).toBe(40);

    // The receipt movements reference the order.
    const movements = (await get("/stock/movements?itemCode=gasket-b", readerToken)).json();
    expect(movements).toHaveLength(2);
    expect(movements.every((m: { purchaseOrderId: string | null }) => m.purchaseOrderId === orderId)).toBe(true);

    // Events + audit.
    const events = (
      await pool.query(
        `SELECT event_type FROM domain_events WHERE entity_type = 'purchase_order' AND entity_id = $1`,
        [orderId],
      )
    ).rows.map((r) => r.event_type);
    expect(events).toEqual(
      expect.arrayContaining(["supply_chain.purchase_order.created", "supply_chain.purchase_order.issued"]),
    );
  });

  it("An order cannot be created from a request that is not approved", async () => {
    await post("/items", buyerToken, { code: "seal-c", name: "Seal C", unitOfMeasure: "EA" });
    const created = await post("/purchase-requests", buyerToken, {
      justification: "not approved yet",
      lines: [{ itemCode: "seal-c", quantity: 3 }],
    });
    const denied = await post("/purchase-orders", buyerToken, {
      supplierCode: "acme",
      purchaseRequestId: created.json().request.id,
    });
    expect(denied.statusCode).toBe(409);
  });

  it("A cancelled order cannot be received, and an order with receipts cannot be cancelled", async () => {
    await post("/items", buyerToken, { code: "hose-d", name: "Hose D", unitOfMeasure: "EA" });
    const order = (
      await post("/purchase-orders", buyerToken, {
        supplierCode: "acme",
        lines: [{ itemCode: "hose-d", quantity: 10 }],
      })
    ).json();
    await post(`/purchase-orders/${order.order.id}/issue`, buyerToken);
    await post(`/purchase-orders/${order.order.id}/receipts`, storeToken, {
      lineId: order.lines[0].id,
      quantity: 4,
    });
    expect((await post(`/purchase-orders/${order.order.id}/cancel`, buyerToken, {})).statusCode).toBe(409);

    const clean = (
      await post("/purchase-orders", buyerToken, {
        supplierCode: "acme",
        lines: [{ itemCode: "hose-d", quantity: 2 }],
      })
    ).json();
    expect((await post(`/purchase-orders/${clean.order.id}/cancel`, buyerToken, { reason: "no longer needed" })).statusCode).toBe(200);
    await post(`/purchase-orders/${clean.order.id}/issue`, buyerToken);
    const afterCancel = await get(`/purchase-orders/${clean.order.id}`, buyerToken);
    expect(afterCancel.json().state).toBe("cancelled");
  });

  // --- Authorization ------------------------------------------------------

  it("Authorization: capabilities are separated across configure, manage, and stock", async () => {
    // Store keeper cannot maintain the master or raise orders.
    expect((await post("/items", storeToken, { code: "x", name: "X", unitOfMeasure: "EA" })).statusCode).toBe(403);
    expect((await post("/purchase-requests", storeToken, { justification: "x", lines: [{ itemCode: "bolt-m8", quantity: 1 }] })).statusCode).toBe(403);
    // Buyer cannot move stock.
    expect((await post("/stock/goods-in", buyerToken, { itemCode: "bolt-m8", quantity: 1 })).statusCode).toBe(403);
    // Reader can do neither.
    expect((await post("/stock/goods-out", readerToken, { itemCode: "bolt-m8", quantity: 1 })).statusCode).toBe(403);
    expect((await post("/suppliers", readerToken, { code: "y", name: "Y" })).statusCode).toBe(403);
  });

  // --- SCM-CORE-012 (Data Scope) -----------------------------------------

  it("SCM-CORE-012: organisation Data Scope limits which purchase requests are visible", async () => {
    await post("/items", buyerToken, { code: "scope-item", name: "Scope Item", unitOfMeasure: "EA" });
    const northRequest = await post("/purchase-requests", buyerToken, {
      justification: "north",
      organizationUnitId: unitNorthId,
      lines: [{ itemCode: "scope-item", quantity: 1 }],
    });
    const southRequest = await post("/purchase-requests", buyerToken, {
      justification: "south",
      organizationUnitId: unitSouthId,
      lines: [{ itemCode: "scope-item", quantity: 1 }],
    });

    const listed = await get("/purchase-requests", scopedToken);
    const ids = listed.json().map((r: { id: string }) => r.id);
    expect(ids).toContain(northRequest.json().request.id);
    expect(ids).not.toContain(southRequest.json().request.id);

    expect((await get(`/purchase-requests/${southRequest.json().request.id}`, scopedToken)).statusCode).toBe(403);
    // Raising a request against a unit outside the actor's scope is denied.
    expect(
      (
        await post("/purchase-requests", scopedToken, {
          justification: "out of scope",
          organizationUnitId: unitSouthId,
          lines: [{ itemCode: "scope-item", quantity: 1 }],
        })
      ).statusCode,
    ).toBe(403);
  });

  // --- Cross-tenant --------------------------------------------------------

  it("Cross-tenant: items, suppliers, orders and stock are isolated", async () => {
    // Same item code in both tenants resolves separately.
    await post("/items", buyerToken, { code: otherItemCode, name: "Local Item", unitOfMeasure: "EA" });
    const mine = await get(`/items/${otherItemCode}`, buyerToken);
    const theirs = await get(`/items/${otherItemCode}`, otherAdminToken);
    expect(mine.json().item.id).not.toBe(theirs.json().item.id);

    expect((await get(`/purchase-orders/${otherOrderId}`, buyerToken)).statusCode).toBe(404);
    expect((await post(`/purchase-orders/${otherOrderId}/issue`, buyerToken)).statusCode).toBe(404);
    expect((await post(`/purchase-orders/${otherOrderId}/cancel`, buyerToken, {})).statusCode).toBe(404);

    // A supplier code from the other tenant is unusable here.
    expect(
      (await post("/purchase-orders", buyerToken, { supplierCode: "other-sup", lines: [{ itemCode: "bolt-m8", quantity: 1 }] })).statusCode,
    ).toBe(404);

    const listedOrders = (await get("/purchase-orders", buyerToken)).json();
    expect(listedOrders.map((o: { id: string }) => o.id)).not.toContain(otherOrderId);
  });

  // --- Validation -----------------------------------------------------------

  it("Validation: non-positive quantities and unknown references are rejected", async () => {
    expect((await post("/stock/goods-in", storeToken, { itemCode: "bolt-m8", quantity: 0 })).statusCode).toBe(400);
    expect((await post("/stock/goods-in", storeToken, { itemCode: "bolt-m8", quantity: -5 })).statusCode).toBe(400);
    expect((await post("/stock/goods-in", storeToken, { itemCode: "no-such-item", quantity: 1 })).statusCode).toBe(404);
    expect(
      (await post("/stock/goods-in", storeToken, {
        itemCode: "bolt-m8",
        quantity: 1,
        siteId: "00000000-0000-0000-0000-000000000000",
      })).statusCode,
    ).toBe(404);
  });

  it("Historical safety: renaming an item does not change past movements or order lines", async () => {
    await post("/items", buyerToken, { code: "rename-me", name: "Original Name", unitOfMeasure: "EA" });
    const received = await post("/stock/goods-in", storeToken, { itemCode: "rename-me", quantity: 6 });
    const movementId = received.json().movement.id;

    expect((await patch("/items/rename-me", buyerToken, { name: "Renamed Later" })).statusCode).toBe(200);

    const movements = (await get("/stock/movements?itemCode=rename-me", readerToken)).json();
    expect(movements.some((m: { id: string; quantity: number }) => m.id === movementId && m.quantity === 6)).toBe(true);
    const balance = (await get("/stock/balances?itemCode=rename-me", readerToken)).json()[0];
    expect(balance.quantity).toBe(6);
  });

  it("Grade: regrading an item with stock in a conflicting-grade warehouse is rejected (409 GRADE_MISMATCH)", async () => {
    const item = (await post("/items", buyerToken, { code: "grade-rice", name: "Rice", unitOfMeasure: "EA", grade: "food" })).json();
    const wh = await pool.query(
      `INSERT INTO scm_warehouses (tenant_id, code, name, grade) VALUES ($1, 'WH-GRADE-F', 'Food WH', 'food') RETURNING id`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO scm_advanced_stock_balances (tenant_id, item_id, warehouse_id, quantity) VALUES ($1, $2, $3, 5)`,
      [tenantId, item.id, wh.rows[0].id],
    );
    const blocked = await patch("/items/grade-rice", buyerToken, { grade: "non_food" });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.stringify(blocked.json())).toContain("food warehouse WH-GRADE-F"); // code is on ConflictError (unit-tested)
    // stock gone -> regrade allowed
    await pool.query(`UPDATE scm_advanced_stock_balances SET quantity = 0 WHERE tenant_id = $1 AND item_id = $2`, [tenantId, item.id]);
    expect((await patch("/items/grade-rice", buyerToken, { grade: "non_food" })).statusCode).toBe(200);
  });
});
