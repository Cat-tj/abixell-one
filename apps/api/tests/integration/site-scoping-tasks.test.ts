import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { hashPassword } from "../../src/infrastructure/security/password.js";
import {
  activateAllModules,
  authHeader,
  bootstrapTenant,
  createReadOnlyRole,
  login,
  provisionFirstAdmin,
  sessionTokenFor,
} from "./helpers.js";

/**
 * Site-scoping of tasks between field officers ("petugas").
 *
 * A catering company runs many sites. A petugas whose ACTIVE assignment is
 * scoped to Site A must not see, open or claim Site B's tasks, and vice versa;
 * a manager whose scope is broader (Region above both sites, or the whole
 * Tenant) still sees across sites.
 *
 * No new authorization mechanism is under test: the site is an Organization
 * Unit (unit_type "Internal Site"), a task's site is its parent Customer's
 * `owner_organization_unit_id` (ADR-0011/0012), and the actor's Data Scope is
 * the ordinary `user_role_assignments` row (ADR-0009 hierarchical walk). The
 * workflow task queue is routed with the `submitter_unit` strategy so each
 * task carries its site (ADR-0007).
 */

const stamp = `${Date.now().toString(36)}_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 6)}`;
const TENANT = `site-scope-${stamp}`;
const PASSWORD = "Passw0rd12345!";
const WORKFLOW_CODE = "service_operations_work_order";
const SERVICE_CODE = "site_scope_service";

const PETUGAS_PERMISSIONS = [
  "service_operations.read",
  "service_operations.execute",
  "customer.read",
  "workflow.instance.read",
  "workflow.instance.act",
];

describe("Site-scoping of tasks between field officers", () => {
  const app = buildApp();

  let tenantId: string;
  let adminToken: string;
  let petugasAToken: string;
  let petugasBToken: string;
  let regionManagerToken: string;
  let multiRoleAsPetugasToken: string;
  let multiRoleAsManagerToken: string;

  let woAId: string;
  let woBId: string;
  let instanceAId: string;
  let instanceBId: string;
  let assignmentAId: string;
  let assignmentBId: string;

  let regionId: string;
  let siteAId: string;
  let siteBId: string;
  let leId: string;
  let customerA: string;
  let customerNullOwner: string;
  let woNullOwnerId: string;
  let instanceNullOwnerId: string;
  let siteBManagerToken: string;
  let siteBManagerId: string;
  let regionPetugasToken: string;
  let legalEntityManagerToken: string;
  let noAssignmentToken: string;
  let petugasAId: string;

  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: authHeader(token) });
  const post = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers: authHeader(token), payload });

  async function createUser(name: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, `${name}.${stamp}@site-scope.local`, await hashPassword(PASSWORD), name],
    );
    return r.rows[0].id as string;
  }

  async function assign(
    userId: string,
    roleCode: string,
    unitId: string | null,
  ): Promise<string> {
    const r = await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, scope_type, scope_organization_unit_id)
       SELECT $1, id, $3, $4 FROM roles WHERE tenant_id = $2 AND code = $5
       RETURNING id`,
      [userId, tenantId, unitId ? "organization_unit" : "tenant", unitId, roleCode],
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    const t = await bootstrapTenant(app, TENANT, "Site Scope Tenant");
    tenantId = t.id;
    await activateAllModules(tenantId);
    await provisionFirstAdmin({ tenantId, email: "admin@site-scope.local", password: "Admin12345!" });
    adminToken = (await login(app, TENANT, "admin@site-scope.local", "Admin12345!")).body.accessToken;

    // Org tree: Region R -> Site A, Site B (siblings).
    const le = await pool.query(
      `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, 'Site Scope LE') RETURNING id`,
      [tenantId],
    );
    const unit = async (name: string, parent: string | null) =>
      (
        await pool.query(
          `INSERT INTO organization_units (tenant_id, legal_entity_id, parent_id, name, unit_type)
           VALUES ($1, $2, $3, $4, 'Internal Site') RETURNING id`,
          [tenantId, le.rows[0].id, parent, name],
        )
      ).rows[0].id as string;
    leId = le.rows[0].id as string;
    regionId = await unit("Region Balikpapan", null);
    siteAId = await unit("Site A", regionId);
    siteBId = await unit("Site B", regionId);

    await createReadOnlyRole(tenantId, "PETUGAS", PETUGAS_PERMISSIONS);
    await createReadOnlyRole(tenantId, "SITE_MANAGER", [
      ...PETUGAS_PERMISSIONS,
      "service_operations.manage",
      "workflow.instance.start",
    ]);

    // Customers owned by Site A / Site B.
    const mkCustomer = async (code: string, ownerUnit: string) =>
      (
        await pool.query(
          `INSERT INTO customers (tenant_id, code, name, owner_organization_unit_id)
           VALUES ($1, $2, $2, $3) RETURNING id`,
          [tenantId, code, ownerUnit],
        )
      ).rows[0].id as string;
    customerA = await mkCustomer(`CUST-A-${stamp}`, siteAId);
    const customerB = await mkCustomer(`CUST-B-${stamp}`, siteBId);
    // A Customer with NO owning Organization Unit: its tasks carry no site.
    customerNullOwner = (
      await pool.query(
        `INSERT INTO customers (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
        [tenantId, `CUST-N-${stamp}`],
      )
    ).rows[0].id as string;

    // Tenant Configuration: numbering + a work-order lifecycle whose first
    // task is routed to PETUGAS *within the submitting site* (submitter_unit).
    await post("/config/numbering/work_order", adminToken, { pattern: "WO-{SEQ:5}" });
    await post("/workflow/definitions", adminToken, {
      code: WORKFLOW_CODE,
      name: "Work Order Lifecycle",
      entityType: "work_order",
      description: "Site scoping lifecycle",
    });
    const base = `/workflow/definitions/${WORKFLOW_CODE}/versions/1`;
    await post(`${base}/steps`, adminToken, { code: "PLANNED", name: "Planned", stepType: "task", isInitial: true });
    await post(`${base}/steps`, adminToken, { code: "DONE", name: "Done", stepType: "end", isTerminal: true, terminalStatus: "approved" });
    await post(`${base}/transitions`, adminToken, {
      fromStepCode: "PLANNED",
      toStepCode: "DONE",
      actionCode: "complete",
      name: "Complete",
    });
    await post(`${base}/assignment-rules`, adminToken, {
      stepCode: "PLANNED",
      assignmentType: "role",
      roleCode: "PETUGAS",
      organizationUnitStrategy: "submitter_unit",
    });
    expect((await post(`${base}/publish`, adminToken)).statusCode).toBe(200);
    expect((await post("/service-definitions", adminToken, { code: SERVICE_CODE, name: "Svc" })).statusCode).toBe(201);

    const mkWo = async (customerId: string, title: string) => {
      const r = await post("/work-orders", adminToken, { customerId, serviceDefinitionCode: SERVICE_CODE, title });
      expect(r.statusCode).toBe(201);
      return r.json().id as string;
    };
    woAId = await mkWo(customerA, "Site A task");
    woBId = await mkWo(customerB, "Site B task");
    woNullOwnerId = await mkWo(customerNullOwner, "Unowned customer task");

    const instanceOf = async (woId: string) =>
      (await get(`/work-orders/${woId}`, adminToken)).json().workOrder.workflowInstanceId as string;
    instanceAId = await instanceOf(woAId);
    instanceBId = await instanceOf(woBId);
    instanceNullOwnerId = await instanceOf(woNullOwnerId);
    const pendingOf = async (instanceId: string) => {
      const r = await get(`/workflow/instances/${instanceId}`, adminToken);
      return (r.json().assignments as { id: string; status: string }[]).find((a) => a.status === "pending")!.id;
    };
    assignmentAId = await pendingOf(instanceAId);
    assignmentBId = await pendingOf(instanceBId);

    // Actors: Data Scope = ordinary user_role_assignments rows.
    const petugasA = await createUser("petugasA");
    const petugasB = await createUser("petugasB");
    const regionManager = await createUser("regionManager");
    const multi = await createUser("multiRole");
    siteBManagerId = await createUser("siteBManager");
    const regionPetugas = await createUser("regionPetugas");
    const leManager = await createUser("leManager");
    const nobody = await createUser("nobody");
    petugasAId = petugasA;
    await assign(siteBManagerId, "SITE_MANAGER", siteBId);
    await assign(regionPetugas, "PETUGAS", regionId);
    await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, scope_type, scope_legal_entity_id)
       SELECT $1, id, 'legal_entity', $3 FROM roles WHERE tenant_id = $2 AND code = 'SITE_MANAGER'`,
      [leManager, tenantId, leId],
    );
    await assign(petugasA, "PETUGAS", siteAId);
    await assign(petugasB, "PETUGAS", siteBId);
    await assign(regionManager, "SITE_MANAGER", regionId);
    const multiPetugas = await assign(multi, "PETUGAS", siteAId);
    const multiManager = await assign(multi, "SITE_MANAGER", null);

    petugasAToken = await sessionTokenFor({ userId: petugasA, tenantId });
    petugasBToken = await sessionTokenFor({ userId: petugasB, tenantId });
    regionManagerToken = await sessionTokenFor({ userId: regionManager, tenantId });
    multiRoleAsPetugasToken = await sessionTokenFor({ userId: multi, tenantId, activeAssignmentId: multiPetugas });
    multiRoleAsManagerToken = await sessionTokenFor({ userId: multi, tenantId, activeAssignmentId: multiManager });
    siteBManagerToken = await sessionTokenFor({ userId: siteBManagerId, tenantId });
    regionPetugasToken = await sessionTokenFor({ userId: regionPetugas, tenantId });
    legalEntityManagerToken = await sessionTokenFor({ userId: leManager, tenantId });
    noAssignmentToken = await sessionTokenFor({ userId: nobody, tenantId });
  });

  afterAll(async () => {
    await pool.end();
  });

  const woIds = (res: { json: () => unknown }) =>
    (res.json() as { workOrder: { id: string } }[]).map((r) => r.workOrder.id);

  it("work-order list: each petugas sees only their own site's tasks", async () => {
    const a = await get("/work-orders", petugasAToken);
    expect(a.statusCode).toBe(200);
    expect(woIds(a)).toEqual([woAId]);
    const b = await get("/work-orders", petugasBToken);
    expect(woIds(b)).toEqual([woBId]);
  });

  it("work-order detail: the other site's task is 404, own site's is 200", async () => {
    expect((await get(`/work-orders/${woAId}`, petugasAToken)).statusCode).toBe(200);
    expect((await get(`/work-orders/${woBId}`, petugasAToken)).statusCode).toBe(404);
    expect((await get(`/work-orders/${woBId}`, petugasBToken)).statusCode).toBe(200);
    expect((await get(`/work-orders/${woAId}`, petugasBToken)).statusCode).toBe(404);
  });

  it("my-assignments (task inbox) is per site", async () => {
    const a = (await get("/workflow/my-assignments", petugasAToken)).json() as { id: string }[];
    expect(a.map((x) => x.id)).toEqual([assignmentAId]);
    const b = (await get("/workflow/my-assignments", petugasBToken)).json() as { id: string }[];
    expect(b.map((x) => x.id)).toEqual([assignmentBId]);
  });

  it("raw workflow instance list/detail/history are 404 outside the site", async () => {
    const listA = (await get("/workflow/instances", petugasAToken)).json() as { id: string }[];
    expect(listA.map((i) => i.id)).toEqual([instanceAId]);
    expect((await get(`/workflow/instances/${instanceAId}`, petugasAToken)).statusCode).toBe(200);
    expect((await get(`/workflow/instances/${instanceBId}`, petugasAToken)).statusCode).toBe(404);
    expect((await get(`/workflow/instances/${instanceBId}/history`, petugasAToken)).statusCode).toBe(404);
    const listB = (await get("/workflow/instances", petugasBToken)).json() as { id: string }[];
    expect(listB.map((i) => i.id)).toEqual([instanceBId]);
  });

  it("claim: a petugas cannot claim the other site's task, can claim their own", async () => {
    const foreign = await post(`/workflow/assignments/${assignmentBId}/claim`, petugasAToken);
    expect(foreign.statusCode).toBe(403);
    const own = await post(`/workflow/assignments/${assignmentAId}/claim`, petugasAToken);
    expect(own.statusCode).toBe(200);
    const released = await post(`/workflow/assignments/${assignmentAId}/release-claim`, petugasAToken);
    expect(released.statusCode).toBe(200);
    expect(released.json().id).toBe(assignmentAId);
    expect(released.json().claimedByUserId).toBeNull();
    // Releasing again (no active claim) is a conflict, proving the first call really released.
    expect((await post(`/workflow/assignments/${assignmentAId}/release-claim`, petugasAToken)).statusCode).toBe(409);
  });

  it("act: a petugas cannot act on the other site's task", async () => {
    const res = await post(`/workflow/assignments/${assignmentBId}/act`, petugasAToken, { actionCode: "complete" });
    expect(res.statusCode).toBe(403);
  });

  it("dashboard counts are per site", async () => {
    const a = (await get("/my/dashboard", petugasAToken)).json().blocks;
    expect(a.workOrders.total).toBe(1);
    expect(a.myTasks.pending).toBe(1);
    const b = (await get("/my/dashboard", petugasBToken)).json().blocks;
    expect(b.workOrders.total).toBe(1);
    expect(b.myTasks.pending).toBe(1);
  });

  it("a manager scoped to the Region above both sites sees both; so does the Tenant admin", async () => {
    expect(new Set(woIds(await get("/work-orders", regionManagerToken)))).toEqual(new Set([woAId, woBId]));
    expect((await get(`/work-orders/${woBId}`, regionManagerToken)).statusCode).toBe(200);
    const instances = (await get("/workflow/instances", regionManagerToken)).json() as { id: string }[];
    expect(new Set(instances.map((i) => i.id))).toEqual(new Set([instanceAId, instanceBId]));
    expect(new Set(woIds(await get("/work-orders", adminToken)))).toEqual(new Set([woAId, woBId, woNullOwnerId]));
  });

  it("a user holding both roles is scoped by the ACTIVE assignment, in lists as in detail", async () => {
    expect(woIds(await get("/work-orders", multiRoleAsPetugasToken))).toEqual([woAId]);
    expect((await get(`/work-orders/${woBId}`, multiRoleAsPetugasToken)).statusCode).toBe(404);
    expect(new Set(woIds(await get("/work-orders", multiRoleAsManagerToken)))).toEqual(new Set([woAId, woBId, woNullOwnerId]));
  });

  // ---------------------------------------------------------------------
  // Second review round
  // ---------------------------------------------------------------------

  const instanceIds = (res: { json: () => unknown }) => (res.json() as { id: string }[]).map((i) => i.id);

  it("customer with no owning unit: its task is invisible to site/region scopes, visible to the Tenant", async () => {
    for (const token of [petugasAToken, petugasBToken, regionManagerToken]) {
      expect(woIds(await get("/work-orders", token))).not.toContain(woNullOwnerId);
      expect((await get(`/work-orders/${woNullOwnerId}`, token)).statusCode).toBe(404);
      expect(instanceIds(await get("/workflow/instances", token))).not.toContain(instanceNullOwnerId);
      expect((await get(`/workflow/instances/${instanceNullOwnerId}`, token)).statusCode).toBe(404);
    }
    expect(woIds(await get("/work-orders", adminToken))).toContain(woNullOwnerId);
    expect((await get(`/workflow/instances/${instanceNullOwnerId}`, adminToken)).statusCode).toBe(200);
  });

  it("read sub-resources of an out-of-scope Work Order are 404 like detail (no existence probing)", async () => {
    for (const path of ["cost-items", "invoice", "serving"]) {
      const foreign = await get(`/work-orders/${woBId}/${path}`, petugasAToken);
      expect(foreign.statusCode, path).toBe(404);
      const missing = await get(`/work-orders/${randomUUID()}/${path}`, petugasAToken);
      expect(missing.statusCode, path).toBe(404);
    }
  });

  it("a user without any usable assignment is refused and sees nothing", async () => {
    expect((await get("/work-orders", noAssignmentToken)).statusCode).toBe(403);
    expect((await get("/workflow/instances", noAssignmentToken)).statusCode).toBe(403);
    expect((await get("/workflow/my-assignments", noAssignmentToken)).statusCode).toBe(403);
  });

  it("multi-role user: /workflow/instances, my-assignments and dashboard follow the ACTIVE assignment", async () => {
    // Active = petugas@Site A: only Site A.
    expect(instanceIds(await get("/workflow/instances", multiRoleAsPetugasToken))).toEqual([instanceAId]);
    const mine = (await get("/workflow/my-assignments", multiRoleAsPetugasToken)).json() as { id: string }[];
    expect(mine.map((a) => a.id)).toEqual([assignmentAId]);
    const dash = (await get("/my/dashboard", multiRoleAsPetugasToken)).json().blocks;
    expect(dash.workOrders.total).toBe(1);
    expect(dash.myTasks.pending).toBe(1);
    // Active = tenant-wide SITE_MANAGER: every instance, but the PETUGAS queue is not theirs.
    expect(new Set(instanceIds(await get("/workflow/instances", multiRoleAsManagerToken)))).toEqual(
      new Set([instanceAId, instanceBId, instanceNullOwnerId]),
    );
    expect((await get("/workflow/my-assignments", multiRoleAsManagerToken)).json()).toEqual([]);
    const dashM = (await get("/my/dashboard", multiRoleAsManagerToken)).json().blocks;
    expect(dashM.workOrders.total).toBe(3);
    expect(dashM.myTasks.pending).toBe(0);
  });

  it("region-level petugas can claim and release tasks of both sites below the Region", async () => {
    for (const id of [assignmentAId, assignmentBId]) {
      expect((await post(`/workflow/assignments/${id}/claim`, regionPetugasToken)).statusCode).toBe(200);
      expect((await post(`/workflow/assignments/${id}/release-claim`, regionPetugasToken)).statusCode).toBe(200);
    }
    const mine = (await get("/workflow/my-assignments", regionPetugasToken)).json() as { id: string }[];
    expect(new Set(mine.map((a) => a.id))).toEqual(new Set([assignmentAId, assignmentBId]));
  });

  it("start-time: a scoped actor cannot forge a unit/Legal Entity/Customer outside their scope on POST /workflow/instances", async () => {
    const start = (token: string, contextData: Record<string, unknown>) =>
      post("/workflow/instances", token, {
        definitionCode: WORKFLOW_CODE,
        entityId: randomUUID(),
        contextData,
      });
    // Site B manager: Site A unit is outside their scope.
    expect((await start(siteBManagerToken, { organizationUnitId: siteAId })).statusCode).toBe(403);
    expect((await start(siteBManagerToken, { organizationUnitId: regionId })).statusCode).toBe(403);
    expect((await start(siteBManagerToken, { organizationUnitId: 42 })).statusCode).toBe(400);
    expect((await start(siteBManagerToken, { legalEntityId: leId })).statusCode).toBe(403);
    expect((await start(siteBManagerToken, { customerId: customerA })).statusCode).toBe(403);
    // Own site is fine; so is an unstamped start.
    expect((await start(siteBManagerToken, { organizationUnitId: siteBId })).statusCode).toBe(201);
    // Tenant-scoped actors are not restricted.
    expect((await start(adminToken, { organizationUnitId: siteAId })).statusCode).toBe(201);
  });

  it("started-by exception is consistent across instance list/detail and the work-order read paths", async () => {
    const started = await post("/workflow/instances", siteBManagerToken, {
      definitionCode: WORKFLOW_CODE,
      entityId: randomUUID(),
      contextData: {},
    });
    expect(started.statusCode).toBe(201);
    const id = started.json().instance.id as string;
    expect(instanceIds(await get("/workflow/instances", siteBManagerToken))).toContain(id);
    expect((await get(`/workflow/instances/${id}`, siteBManagerToken)).statusCode).toBe(200);
    expect((await get(`/workflow/instances/${id}/history`, siteBManagerToken)).statusCode).toBe(200);
    // A different site's petugas gets neither.
    expect(instanceIds(await get("/workflow/instances", petugasAToken))).not.toContain(id);
    expect((await get(`/workflow/instances/${id}`, petugasAToken)).statusCode).toBe(404);
  });

  it("eligible-assignee exception: a task handed to a petugas outside their site is visible in list AND detail, everywhere", async () => {
    // Hand Site B's work order to petugas A by name (cross-site hand-off).
    const handoff = await pool.query(
      `INSERT INTO workflow_instance_assignments
         (workflow_instance_id, step_id, assignment_type, assigned_user_id, status)
       SELECT workflow_instance_id, step_id, 'specific_user', $2, 'pending'
         FROM workflow_instance_assignments WHERE id = $1
       RETURNING id`,
      [assignmentBId, petugasAId],
    );
    try {
      expect(instanceIds(await get("/workflow/instances", petugasAToken))).toContain(instanceBId);
      expect((await get(`/workflow/instances/${instanceBId}`, petugasAToken)).statusCode).toBe(200);
      expect((await get(`/workflow/instances/${instanceBId}/history`, petugasAToken)).statusCode).toBe(200);
      expect(woIds(await get("/work-orders", petugasAToken))).toContain(woBId);
      expect((await get(`/work-orders/${woBId}`, petugasAToken)).statusCode).toBe(200);
      const dash = (await get("/my/dashboard", petugasAToken)).json().blocks;
      expect(dash.workOrders.total).toBe(2);
      const mine = (await get("/workflow/my-assignments", petugasAToken)).json() as { id: string }[];
      expect(mine.map((a) => a.id)).toContain(handoff.rows[0].id);
      // ...but petugas B's own view and the other site's strictness are unchanged.
      expect(woIds(await get("/work-orders", petugasBToken))).toEqual([woBId]);
    } finally {
      await pool.query(`DELETE FROM workflow_instance_assignments WHERE id = $1`, [handoff.rows[0].id]);
    }
    expect((await get(`/work-orders/${woBId}`, petugasAToken)).statusCode).toBe(404);
  });

  it("assigned executor sees the work order in list and detail even outside the site scope", async () => {
    await pool.query(`UPDATE work_orders SET assigned_to_user_id = $2 WHERE id = $1`, [woBId, petugasAId]);
    try {
      expect(woIds(await get("/work-orders", petugasAToken))).toContain(woBId);
      expect((await get(`/work-orders/${woBId}`, petugasAToken)).statusCode).toBe(200);
      expect((await get("/my/dashboard", petugasAToken)).json().blocks.workOrders.total).toBe(2);
    } finally {
      await pool.query(`UPDATE work_orders SET assigned_to_user_id = NULL WHERE id = $1`, [woBId]);
    }
    expect((await get(`/work-orders/${woBId}`, petugasAToken)).statusCode).toBe(404);
  });

  it("instances stamped by the five formerly-unstamped modules are visible to the covering scopes (and only them)", async () => {
    // Rows shaped exactly like the modules' contextData: unit-owned (service
    // quality CAPA, asset maintenance, budget with a placed cost center),
    // Legal Entity-owned (tax rule, budget), tenant-level (consolidation).
    const defRes = await pool.query(
      `SELECT d.id AS did, v.id AS vid, s.id AS sid
         FROM workflow_definitions d
         JOIN workflow_versions v ON v.workflow_definition_id = d.id AND v.is_current
         JOIN workflow_steps s ON s.workflow_version_id = v.id AND s.is_initial
        WHERE d.tenant_id = $1 AND d.code = $2`,
      [tenantId, WORKFLOW_CODE],
    );
    const { did, vid, sid } = defRes.rows[0];
    // Started by the Tenant admin so the started-by exception cannot mask the scope rule.
    const adminUserId = (
      await pool.query(`SELECT id FROM users WHERE tenant_id = $1 AND email = 'admin@site-scope.local'`, [tenantId])
    ).rows[0].id as string;
    const mk = async (label: string, ctx: Record<string, unknown>) =>
      (
        await pool.query(
          `INSERT INTO workflow_instances
             (tenant_id, workflow_definition_id, workflow_version_id, entity_type, entity_id, current_step_id, context_data, started_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [tenantId, did, vid, label, randomUUID(), sid, ctx, adminUserId],
        )
      ).rows[0].id as string;
    const capa = await mk("capa_action", { customerId: customerA, organizationUnitId: siteAId });
    const asset = await mk("asset_maintenance_work_order", { organizationUnitId: siteAId });
    const budget = await mk("finance_budget_version", { legalEntityId: leId, organizationUnitId: null });
    const tax = await mk("finance_tax_rule_version", { legalEntityId: leId });
    const consolidation = await mk("finance_consolidation_group", { groupCode: "G" });

    const seenBy = async (token: string) => new Set(instanceIds(await get("/workflow/instances", token)));
    const region = await seenBy(regionManagerToken);
    expect(region.has(capa) && region.has(asset)).toBe(true);
    expect(region.has(budget) || region.has(tax) || region.has(consolidation)).toBe(false);
    const le = await seenBy(legalEntityManagerToken);
    expect([capa, asset, budget, tax].every((i) => le.has(i))).toBe(true);
    expect(le.has(consolidation)).toBe(false);
    const siteB = await seenBy(siteBManagerToken);
    expect([capa, asset, budget, tax, consolidation].some((i) => siteB.has(i))).toBe(false);
    const tenant = await seenBy(adminToken);
    expect([capa, asset, budget, tax, consolidation].every((i) => tenant.has(i))).toBe(true);
    // List and detail agree for each.
    for (const i of [capa, asset, budget, tax, consolidation]) {
      expect((await get(`/workflow/instances/${i}`, regionManagerToken)).statusCode === 200).toBe(region.has(i));
      expect((await get(`/workflow/instances/${i}`, legalEntityManagerToken)).statusCode === 200).toBe(le.has(i));
    }
  });

  it("own-site petugas can claim and act on a fresh task end to end (and the other site's stays 403)", async () => {
    const created = await post("/work-orders", adminToken, {
      customerId: customerA,
      serviceDefinitionCode: SERVICE_CODE,
      title: "Site A task 2",
    });
    expect(created.statusCode).toBe(201);
    const wo = (await get(`/work-orders/${created.json().id}`, adminToken)).json();
    const inst = (await get(`/workflow/instances/${wo.workOrder.workflowInstanceId}`, adminToken)).json();
    const pending = (inst.assignments as { id: string; status: string }[]).find((a) => a.status === "pending")!;
    expect((await post(`/workflow/assignments/${pending.id}/claim`, petugasAToken)).statusCode).toBe(200);
    expect((await post(`/workflow/assignments/${pending.id}/claim`, petugasBToken)).statusCode).toBe(403);
    const acted = await post(`/workflow/assignments/${pending.id}/act`, petugasAToken, { actionCode: "complete" });
    expect(acted.statusCode).toBe(200);
    const after = await get(`/workflow/instances/${wo.workOrder.workflowInstanceId}`, petugasAToken);
    expect(after.json().instance.status).toBe("approved");
  });
});
