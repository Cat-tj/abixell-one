import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { PgBudgetRepository, BudgetError } from "../../src/modules/accounting/budget/infrastructure/budget.repository.pg.js";
import { BudgetService, BUDGET_WORKFLOW_DEFINITION_CODE } from "../../src/modules/accounting/budget/application/budget.service.js";
import { distributeTotal, toUnits, fromUnits, policyRank } from "../../src/modules/accounting/budget/domain/budget.entity.js";
import { PgRbacRepository } from "../../src/infrastructure/persistence/repositories/rbac.repository.pg.js";
import { PgAuditLogRepository } from "../../src/infrastructure/persistence/repositories/audit-log.repository.pg.js";
import { RbacService } from "../../src/application/rbac/rbac.service.js";
import { AuditService } from "../../src/application/audit/audit.service.js";
import type { ActorContext } from "../../src/domain/shared-kernel/audit-context.js";
import type { WorkflowService } from "../../src/application/workflow/workflow.service.js";
import { ConflictError } from "../../src/domain/shared-kernel/errors.js";

/**
 * WP-FIN-A6-03 — Budget control + accounting dimensions (ADR-0020).
 *
 * Contract under test:
 *   - period distribution is exact at 4 decimals, residual to the last period;
 *   - a budget version becomes active only via Workflow approval, and approval
 *     supersedes the previous baseline (never edits it);
 *   - consumption is idempotent per idempotency key;
 *   - hard_stop fails closed (nothing recorded), advisory records the variance,
 *     escalation records and flags;
 *   - release is a compensating row and cannot itself be released;
 *   - utilization is a projection: available = baseline + adjustments − actual
 *     − commitment + released, never stored.
 *
 * Pattern: real DB pool, dedicated tenant, CASCADE cleanup. The Workflow
 * Engine is mocked at the service seam (maker-checker orchestration is out of
 * scope here; the version lifecycle in the repo is what is under test).
 */

const TS = `ak-bg-${Date.now()}`;

describe("WP-FIN-A6-03 — Budget control", () => {
  let tenantId: string;
  let legalEntityId: string;
  let userId: string;
  let repo: PgBudgetRepository;
  let service: BudgetService;
  let mockWorkflow: WorkflowService;
  let workflowDefId = "";
  let workflowVersionId = "";
  let initialStepId = "";
  let roleSeq = 0;
  let budgetSeq = 0;
  let outcomeStatus: "approved" | "rejected" = "approved";

  /** Each budget needs a distinct dimension scope: one tenant cannot hold two
   *  budgets with the same LE + year + scenario + scope. */
  function nextScope() {
    const seq = String(++budgetSeq).padStart(4, "0");
    return { accountFrom: `9${seq}`, accountTo: `9${seq}` };
  }

  async function actorWith(permissions: string[]): Promise<ActorContext> {
    const roleCode = `ROLE-BG-${++roleSeq}-${userId.slice(0, 8)}`;
    const roleRes = await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [tenantId, roleCode],
    );
    const roleId = roleRes.rows[0].id;
    if (permissions.length > 0) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, p.id FROM permissions p WHERE p.code = ANY($2)`,
        [roleId, permissions],
      );
    }
    const assignRes = await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, scope_type)
       VALUES ($1, $2, 'tenant') RETURNING id`,
      [userId, roleId],
    );
    return {
      userId,
      tenantId,
      sessionId: "00000000-0000-4000-8000-000000000002",
      assignmentId: assignRes.rows[0].id,
      roleId,
      roleCode,
      scopeType: "tenant",
      scopeLegalEntityId: null,
      scopeOrganizationUnitId: null,
      scopeCustomerId: null,
    };
  }

  /** Policies are per Legal Entity, so every policy test gets its own LE and
   *  never inherits a sibling test's rules. */
  async function newLegalEntity(name: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, name],
    );
    return r.rows[0].id as string;
  }

  async function approveVersion(versionId: string) {
    const actor = await actorWith(["finance.accounting.approve"]);
    return service.actOnVersion(actor, versionId, "approve", "ok");
  }

  async function makeActiveBudget(
    name: string,
    weights: { periodCode: string; weight: string }[],
    totalAmount: string,
    leId: string = legalEntityId,
  ) {
    const configure = await actorWith(["finance.accounting.configure"]);
    const budget = await service.createBudget(configure, {
      legalEntityId: leId,
      fiscalYearCode: "2026",
      scenario: "original",
      currency: "IDR",
      name,
      scope: nextScope(),
    });
    const version = await service.createDraftVersion(configure, budget.id, { totalAmount, weights });
    const active = await approveVersion(version.id);
    expect(active.status).toBe("active");
    return { budget, version: active };
  }

  beforeAll(async () => {
    const tenantResult = await pool.query(
      `INSERT INTO tenants (code, name) VALUES ($1, 'Budget Test Tenant') RETURNING id`,
      [TS],
    );
    tenantId = tenantResult.rows[0].id;

    const leResult = await pool.query(
      `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, 'LE Budget') RETURNING id`,
      [tenantId],
    );
    legalEntityId = leResult.rows[0].id;

    const userResult = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1, $2, 'x', 'Budget Tester') RETURNING id`,
      [tenantId, `${TS}@test.local`],
    );
    userId = userResult.rows[0].id;

    repo = new PgBudgetRepository(pool);
    const rbac = new RbacService(new PgRbacRepository(pool));
    const audit = new AuditService(new PgAuditLogRepository(pool));

    // Seed a workflow definition + published version so the instance insert
    // satisfies FKs; orchestration itself is mocked (same posture as WP-PRO-01).
    let res = await pool.query(
      `INSERT INTO workflow_definitions (tenant_id, code, name, entity_type, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, BUDGET_WORKFLOW_DEFINITION_CODE, "Budget Version Approval", "finance_budget_version", "Budget baseline maker-checker"],
    );
    workflowDefId = res.rows[0].id;
    res = await pool.query(
      `INSERT INTO workflow_versions (workflow_definition_id, version_number, status, is_current)
       VALUES ($1, 1, 'published', true) RETURNING id`,
      [workflowDefId],
    );
    workflowVersionId = res.rows[0].id;
    res = await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, sequence_order)
       VALUES ($1, $2, $3, $4, true, 0) RETURNING id`,
      [workflowVersionId, "initial", "Initial Submission", "task"],
    );
    initialStepId = res.rows[0].id;

    mockWorkflow = {
      startInstance: async (_actor: ActorContext, input: { definitionCode: string; entityId: string; contextData?: unknown }) => {
        const r = await pool.query(
          `INSERT INTO workflow_instances
             (tenant_id, workflow_definition_id, workflow_version_id, entity_type, entity_id, current_step_id, context_data, started_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [tenantId, workflowDefId, workflowVersionId, "finance_budget_version", input.entityId, initialStepId, input.contextData ?? {}, userId],
        );
        return { instance: { id: r.rows[0].id } } as never;
      },
      getInstanceForEntityOwner: async (_tenantId: string, instanceId: string) => ({
        instance: { id: instanceId },
        assignments: [{ id: randomUUID(), status: "pending" } as never],
        currentStep: null,
        history: [],
      }) as never,
      actOnAssignment: async () => undefined,
      getEntityStatus: async () => ({
        instanceStatus: outcomeStatus,
        currentStepCode: "final",
        currentStepName: "Final",
        pendingActionCode: null,
        pendingAssignment: null,
      }) as never,
      getEntityStatuses: async () => [],
      listVersions: async () => [],
      createVersion: async () => ({ versionNumber: 1 }) as never,
      publishVersion: async () => undefined,
      updateStep: async () => undefined,
      removeStep: async () => undefined,
      addTransition: async () => undefined,
      removeTransition: async () => undefined,
    } as unknown as WorkflowService;

    service = new BudgetService(repo, rbac, audit, mockWorkflow);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  });

  // -------------------------------------------------------------------------
  // Exact decimal + distribution
  // -------------------------------------------------------------------------

  it("distributes totals exactly, absorbing the residual in the last period", () => {
    const lines = distributeTotal("100.0003", [
      { periodCode: "2026-01", weight: "1" },
      { periodCode: "2026-02", weight: "1" },
      { periodCode: "2026-03", weight: "1" },
    ]);
    expect(lines).not.toBeNull();
    const total = lines!.reduce((acc, l) => acc + (toUnits(l.amount) ?? 0n), 0n);
    expect(fromUnits(total)).toBe("100.0003");
    // 100.0003 / 3 floors to 33.3334, 33.3334; the last takes the residual.
    expect(lines!.map((l) => l.amount)).toEqual(["33.3334", "33.3334", "33.3335"]);
  });

  it("rejects invalid weights instead of inventing shares", () => {
    expect(distributeTotal("10.0000", [])).toBeNull();
    expect(distributeTotal("10.0000", [{ periodCode: "2026-01", weight: "0" }])).toBeNull();
    expect(distributeTotal("10.0000", [{ periodCode: "2026-01", weight: "-1" }])).toBeNull();
    expect(toUnits("12.34567")).toBeNull(); // > 4 decimals fails closed
  });

  // -------------------------------------------------------------------------
  // Version lifecycle (Workflow maker-checker)
  // -------------------------------------------------------------------------

  it("stamps the Legal Entity, and the cost center's Organization Unit, on the approval Instance", async () => {
    const configure = await actorWith(["finance.accounting.configure"]);
    const unit = await pool.query(
      `INSERT INTO organization_units (tenant_id, legal_entity_id, name, unit_type)
       VALUES ($1, $2, 'Budget Site', 'Internal Site') RETURNING id`,
      [tenantId, legalEntityId],
    );
    const cc = await pool.query(
      `INSERT INTO finance_cost_centers (tenant_id, code, name, org_unit_id, effective_from)
       VALUES ($1, $2, 'CC placed', $3, '2026-01-01') RETURNING id`,
      [tenantId, `CC-${TS}`.slice(0, 40), unit.rows[0].id],
    );
    const placed = await service.createBudget(configure, {
      legalEntityId,
      fiscalYearCode: "2027",
      scenario: "original",
      currency: "IDR",
      name: "Placed budget",
      scope: { ...nextScope(), costCenterId: cc.rows[0].id },
    });
    const v = await service.createDraftVersion(configure, placed.id, {
      totalAmount: "100.0000",
      weights: [{ periodCode: "2027-01", weight: "1" }],
    });
    const ctx = async (id: string | null) =>
      (await pool.query(`SELECT context_data FROM workflow_instances WHERE id = $1`, [id])).rows[0].context_data;
    expect(await ctx(v.workflowInstanceId)).toMatchObject({
      legalEntityId,
      organizationUnitId: unit.rows[0].id,
    });

    const unplaced = await service.createBudget(configure, {
      legalEntityId,
      fiscalYearCode: "2027",
      scenario: "original",
      currency: "IDR",
      name: "Unplaced budget",
      scope: nextScope(),
    });
    const v2 = await service.createDraftVersion(configure, unplaced.id, {
      totalAmount: "100.0000",
      weights: [{ periodCode: "2027-01", weight: "1" }],
    });
    const ctx2 = await ctx(v2.workflowInstanceId);
    expect(ctx2.legalEntityId).toBe(legalEntityId);
    expect(ctx2.organizationUnitId ?? null).toBeNull();
  });

  it("activates a version only through the Workflow approval and supersedes the prior baseline", async () => {
    const configure = await actorWith(["finance.accounting.configure"]);
    const budget = await service.createBudget(configure, {
      legalEntityId,
      fiscalYearCode: "2026",
      scenario: "original",
      currency: "IDR",
      name: "Lifecycle budget",
      scope: nextScope(),
    });

    const v1 = await service.createDraftVersion(configure, budget.id, {
      totalAmount: "1200000.0000",
      weights: [
        { periodCode: "2026-01", weight: "1" },
        { periodCode: "2026-02", weight: "1" },
      ],
    });
    expect(v1.status).toBe("draft");
    expect(v1.workflowInstanceId).not.toBeNull();

    // Consumption before any approval is refused — there is no active baseline.
    await expect(
      service.consume(await actorWith(["finance.accounting.configure"]), {
        budgetId: budget.id,
        periodCode: "2026-01",
        amount: "1.0000",
        kind: "commitment",
        idempotencyKey: `${TS}-too-early`,
      }),
    ).rejects.toThrow(ConflictError);

    const active1 = await approveVersion(v1.id);
    expect(active1.status).toBe("active");

    const v2 = await service.createDraftVersion(configure, budget.id, {
      totalAmount: "2400000.0000",
      weights: [
        { periodCode: "2026-01", weight: "1" },
        { periodCode: "2026-02", weight: "1" },
      ],
      note: "revision",
    });
    const active2 = await approveVersion(v2.id);
    expect(active2.status).toBe("active");
    expect(active2.supersedesVersionId).toBe(v1.id);

    const versions = await service.listVersions(await actorWith(["finance.accounting.read"]), budget.id);
    const v1After = versions.find((v) => v.id === v1.id)!;
    expect(v1After.status).toBe("superseded");
    expect(v1After.approvedAt).not.toBeNull(); // history preserved, never edited

    const read = await service.getBudget(await actorWith(["finance.accounting.read"]), budget.id);
    expect(read.activeVersionId).toBe(v2.id);
  });

  // Regression: consumption is a fact about the budget scope, not about one
  // baseline version (ADR-0020 §4). Scoping the sum to the active version made
  // both the utilization projection and the hard_stop check forget every
  // prior actual the moment a revision superseded v1 — the control failed OPEN
  // exactly when a re-plan landed.
  it("carries consumption across a revision instead of resetting it", async () => {
    const le = await newLegalEntity("LE Revision Carryover");
    await service.createPolicy(await actorWith(["finance.accounting.configure"]), {
      legalEntityId: le,
      effect: "hard_stop",
      effectiveFrom: "2026-01-01",
    });

    const configure = await actorWith(["finance.accounting.configure"]);
    const budget = await service.createBudget(configure, {
      legalEntityId: le,
      fiscalYearCode: "2026",
      scenario: "original",
      currency: "IDR",
      name: "Revision carryover budget",
      scope: nextScope(),
    });
    const v1 = await approveVersion(
      (await service.createDraftVersion(configure, budget.id, {
        totalAmount: "1000.0000",
        weights: [{ periodCode: "2026-01", weight: "1" }],
      })).id,
    );
    expect(v1.status).toBe("active");

    // Spend 800 of the 1000 baseline against v1.
    const first = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "800.0000",
      kind: "actual",
      idempotencyKey: `${TS}-carry-1`,
    });
    expect(first.decision).toBe("ok");

    // Revise the baseline up to 2000. The 800 already spent is still spent.
    const v2 = await approveVersion(
      (await service.createDraftVersion(configure, budget.id, {
        totalAmount: "2000.0000",
        weights: [{ periodCode: "2026-01", weight: "1" }],
        note: "revision",
      })).id,
    );
    expect(v2.status).toBe("active");

    const util = await service.utilization(await actorWith(["finance.accounting.read"]), budget.id);
    const jan = util.periods.find((p) => p.periodCode === "2026-01")!;
    expect(jan.baseline).toBe("2000.0000");
    expect(jan.actual).toBe("800.0000");
    expect(jan.available).toBe("1200.0000");
    expect(util.total.actual).toBe("800.0000");

    // 1300 against 1200 available must still trip the hard stop. Before the
    // fix the check read 2000 available and let it through.
    await expect(
      service.consume(configure, {
        budgetId: budget.id,
        periodCode: "2026-01",
        amount: "1300.0000",
        kind: "actual",
        idempotencyKey: `${TS}-carry-2`,
      }),
    ).rejects.toThrow(ConflictError);

    // And the boundary still passes: exactly the remaining 1200.
    const exact = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "1200.0000",
      kind: "actual",
      idempotencyKey: `${TS}-carry-3`,
    });
    expect(exact.decision).toBe("ok");
    expect(exact.availableBefore).toBe("1200.0000");
    expect(exact.availableAfter).toBe("0.0000");
  });

  it("rejects a version when the Workflow instance rejects it", async () => {
    outcomeStatus = "rejected";
    try {
      const configure = await actorWith(["finance.accounting.configure"]);
      const budget = await service.createBudget(configure, {
        legalEntityId,
        fiscalYearCode: "2026",
        scenario: "forecast",
        currency: "IDR",
        name: "Rejected budget",
        scope: nextScope(),
      });
      const v = await service.createDraftVersion(configure, budget.id, {
        totalAmount: "500.0000",
        weights: [{ periodCode: "2026-01", weight: "1" }],
      });
      const result = await approveVersion(v.id);
      expect(result.status).toBe("rejected");
      const read = await service.getBudget(await actorWith(["finance.accounting.read"]), budget.id);
      expect(read.activeVersionId).toBeNull();
    } finally {
      outcomeStatus = "approved";
    }
  });

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  it("selects the most specific effective policy", async () => {
    const le = await newLegalEntity("LE Policy Ranking");
    const configure = await actorWith(["finance.accounting.configure"]);
    const broad = await service.createPolicy(configure, {
      legalEntityId: le,
      effect: "advisory",
      effectiveFrom: "2026-01-01",
    });
    const specific = await service.createPolicy(configure, {
      legalEntityId: le,
      effect: "hard_stop",
      documentType: "purchase_request",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
    });
    expect(policyRank(specific)).toBeGreaterThan(policyRank(broad));

    const policies = await service.listPolicies(await actorWith(["finance.accounting.read"]), le);
    const match = {
      costCenterId: null,
      projectId: null,
      accountFrom: null,
      accountTo: null,
      amount: "100.0000",
    };

    // A matching document type picks the specific hard_stop rule.
    expect(
      repo.selectPolicy(policies, { ...match, documentType: "purchase_request", onDate: "2026-06-01" })?.id,
    ).toBe(specific.id);

    // A different document type falls back to the broad advisory rule.
    expect(
      repo.selectPolicy(policies, { ...match, documentType: "other_doc", onDate: "2026-06-01" })?.id,
    ).toBe(broad.id);

    // Outside the specific rule's window it no longer applies.
    expect(
      repo.selectPolicy(policies, { ...match, documentType: "purchase_request", onDate: "2027-03-01" })?.id,
    ).toBe(broad.id);
  });

  // -------------------------------------------------------------------------
  // Consumption: idempotency, hard_stop, advisory, escalation
  // -------------------------------------------------------------------------

  it("records consumption idempotently and keeps the utilization projection exact", async () => {
    const { budget } = await makeActiveBudget(
      "Consumption budget",
      [
        { periodCode: "2026-01", weight: "1" },
        { periodCode: "2026-02", weight: "1" },
      ],
      "1000.0000",
    );
    const configure = await actorWith(["finance.accounting.configure"]);

    const first = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "250.0000",
      kind: "commitment",
      idempotencyKey: `${TS}-consume-1`,
    });
    expect(first.decision).toBe("ok");
    expect(first.availableBefore).toBe("500.0000");
    expect(first.availableAfter).toBe("250.0000");

    const replay = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "250.0000",
      kind: "commitment",
      idempotencyKey: `${TS}-consume-1`,
    });
    expect(replay.consumptionId).toBe(first.consumptionId);
    // Replay is a no-op on the ledger: availability is unchanged, not re-applied.
    expect(replay.availableAfter).toBe("250.0000");

    const util = await service.utilization(await actorWith(["finance.accounting.read"]), budget.id);
    const jan = util.periods.find((p) => p.periodCode === "2026-01")!;
    expect(jan.baseline).toBe("500.0000");
    expect(jan.committed).toBe("250.0000");
    expect(jan.available).toBe("250.0000");
  });

  it("fails closed on hard_stop without recording the overspend", async () => {
    const le = await newLegalEntity("LE Hard Stop");
    const { budget } = await makeActiveBudget(
      "Hard stop budget",
      [{ periodCode: "2026-01", weight: "1" }],
      "100.0000",
      le,
    );
    const configure = await actorWith(["finance.accounting.configure"]);
    await service.createPolicy(configure, {
      legalEntityId: le,
      effect: "hard_stop",
      effectiveFrom: "2026-01-01",
    });

    await expect(
      service.consume(configure, {
        budgetId: budget.id,
        periodCode: "2026-01",
        amount: "250.0000",
        kind: "actual",
        idempotencyKey: `${TS}-hard-stop`,
      }),
    ).rejects.toThrow(ConflictError);

    // Nothing was recorded: the full baseline is still available.
    const util = await service.utilization(await actorWith(["finance.accounting.read"]), budget.id);
    expect(util.periods[0]!.available).toBe("100.0000");
  });

  it("records an advisory variance but allows the overspend", async () => {
    const le = await newLegalEntity("LE Advisory");
    const { budget } = await makeActiveBudget(
      "Advisory budget",
      [{ periodCode: "2026-01", weight: "1" }],
      "100.0000",
      le,
    );
    const configure = await actorWith(["finance.accounting.configure"]);
    await service.createPolicy(configure, {
      legalEntityId: le,
      effect: "advisory",
      effectiveFrom: "2026-01-01",
    });

    const result = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "250.0000",
      kind: "actual",
      idempotencyKey: `${TS}-advisory`,
    });
    expect(result.decision).toBe("variance");
    expect(result.variance).toBe("150.0000");
    expect(result.consumptionId).not.toBeNull();

    const util = await service.utilization(await actorWith(["finance.accounting.read"]), budget.id);
    expect(util.periods[0]!.available).toBe("-150.0000");
    expect(util.periods[0]!.variance).toBe("150.0000");
  });

  it("flags an escalation decision on the escalation policy", async () => {
    const le = await newLegalEntity("LE Escalation");
    const { budget } = await makeActiveBudget(
      "Escalation budget",
      [{ periodCode: "2026-01", weight: "1" }],
      "100.0000",
      le,
    );
    const configure = await actorWith(["finance.accounting.configure"]);
    await service.createPolicy(configure, {
      legalEntityId: le,
      effect: "escalation",
      effectiveFrom: "2026-01-01",
    });

    const result = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "150.0000",
      kind: "commitment",
      idempotencyKey: `${TS}-escalation`,
    });
    expect(result.decision).toBe("escalate");
    expect(result.effect).toBe("escalation");
    expect(result.consumptionId).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Releases
  // -------------------------------------------------------------------------

  it("releases a consumption as a compensating row and restores availability", async () => {
    const { budget } = await makeActiveBudget(
      "Release budget",
      [{ periodCode: "2026-01", weight: "1" }],
      "100.0000",
    );
    const configure = await actorWith(["finance.accounting.configure"]);
    const consumption = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "40.0000",
      kind: "commitment",
      idempotencyKey: `${TS}-release-src`,
    });

    const release = await service.release(configure, consumption.consumptionId!, {
      idempotencyKey: `${TS}-release-1`,
    });
    expect(release.kind).toBe("release");
    expect(release.reversesId).toBe(consumption.consumptionId);
    expect(release.amount).toBe("40.0000");

    // Replay is idempotent: the same compensating row comes back.
    const replay = await service.release(configure, consumption.consumptionId!, {
      idempotencyKey: `${TS}-release-2`,
    });
    expect(replay.id).toBe(release.id);

    // A release cannot itself be released.
    await expect(
      service.release(configure, release.id, { idempotencyKey: `${TS}-release-of-release` }),
    ).rejects.toThrow(ConflictError);

    const util = await service.utilization(await actorWith(["finance.accounting.read"]), budget.id);
    expect(util.periods[0]!.available).toBe("100.0000");
    expect(util.periods[0]!.released).toBe("40.0000");
    expect(util.periods[0]!.committed).toBe("40.0000");
  });

  it("refuses releases across tenants", async () => {
    const { budget } = await makeActiveBudget(
      "Tenant isolation budget",
      [{ periodCode: "2026-01", weight: "1" }],
      "10.0000",
    );
    const configure = await actorWith(["finance.accounting.configure"]);
    const consumption = await service.consume(configure, {
      budgetId: budget.id,
      periodCode: "2026-01",
      amount: "1.0000",
      kind: "actual",
      idempotencyKey: `${TS}-isolation`,
    });

    const foreignRepo = new PgBudgetRepository(pool);
    await expect(
      foreignRepo.releaseConsumption({
        tenantId: randomUUID(), // a different tenant
        consumptionId: consumption.consumptionId!,
        idempotencyKey: `${TS}-isolation-release`,
        note: null,
        createdBy: userId,
      }),
    ).rejects.toThrow(BudgetError);
  });
});
