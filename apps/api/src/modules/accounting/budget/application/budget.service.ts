import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { WorkflowService } from "../../../../application/workflow/workflow.service.js";
import {
  BUDGET_CONTROL_EFFECTS,
  BUDGET_CONSUMPTION_KINDS,
  BUDGET_SCENARIOS,
  type BudgetAvailabilityResult,
  type BudgetConsumption,
  type BudgetConsumptionKind,
  type BudgetControlEffect,
  type BudgetDimensionScope,
  type BudgetLine,
  type BudgetPolicy,
  type BudgetScenario,
  type BudgetUtilization,
  type BudgetVersion,
  type FinanceBudget,
} from "../domain/budget.entity.js";
import { PgBudgetRepository, BudgetError } from "../infrastructure/budget.repository.pg.js";

/** Tenant Workflow Configuration code the budget baseline approval follows. */
export const BUDGET_WORKFLOW_DEFINITION_CODE = "budget_version_approval";

export class BudgetService {
  constructor(
    private readonly repo: PgBudgetRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
  ) {}

  private unwrap<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err: unknown) => {
      if (err instanceof BudgetError) throw new ConflictError(err.message);
      throw err;
    });
  }

  // ------------------------------------------------------------------
  // Budgets
  // ------------------------------------------------------------------

  async createBudget(
    actor: ActorContext,
    input: {
      legalEntityId: string;
      fiscalYearCode: string;
      scenario: BudgetScenario;
      currency: string;
      name: string;
      ownerUserId?: string | null;
      scope?: Partial<BudgetDimensionScope>;
    },
  ): Promise<FinanceBudget> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (!BUDGET_SCENARIOS.includes(input.scenario)) {
      throw new ValidationError(`scenario must be one of ${BUDGET_SCENARIOS.join(", ")}`);
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new ValidationError("currency must be a 3-letter ISO code");
    }
    return this.unwrap(() =>
      this.repo.createBudget({
        tenantId: actor.tenantId,
        legalEntityId: input.legalEntityId,
        fiscalYearCode: input.fiscalYearCode,
        scenario: input.scenario,
        currency: input.currency,
        name: input.name,
        ownerUserId: input.ownerUserId ?? null,
        scope: {
          costCenterId: input.scope?.costCenterId ?? null,
          projectId: input.scope?.projectId ?? null,
          siteId: input.scope?.siteId ?? null,
          accountFrom: input.scope?.accountFrom ?? null,
          accountTo: input.scope?.accountTo ?? null,
        },
        createdBy: actor.userId,
      }),
    );
  }

  async listBudgets(
    actor: ActorContext,
    filter: { legalEntityId?: string; fiscalYearCode?: string; scenario?: BudgetScenario },
  ): Promise<FinanceBudget[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listBudgets(actor.tenantId, filter);
  }

  async getBudget(actor: ActorContext, id: string): Promise<FinanceBudget> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const budget = await this.repo.findBudgetById(actor.tenantId, id);
    if (!budget) throw new NotFoundError("Budget", id);
    return budget;
  }

  // ------------------------------------------------------------------
  // Versions — draft revision → Workflow maker-checker → active
  // ------------------------------------------------------------------

  /**
   * Draft a new baseline version. Per ADR-0020 §2 the maker-checker lives in
   * the Workflow Engine — this service starts the instance and never encodes
   * its own step graph. The version goes active only when that instance
   * reaches its approved terminal state.
   */
  async createDraftVersion(
    actor: ActorContext,
    budgetId: string,
    input: {
      totalAmount: string;
      weights: { periodCode: string; weight: string }[];
      note?: string | null;
    },
  ): Promise<BudgetVersion> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    const budget = await this.repo.findBudgetById(actor.tenantId, budgetId);
    if (!budget) throw new NotFoundError("Budget", budgetId);

    const supersedesVersionId = budget.activeVersionId;
    const version = await this.unwrap(() =>
      this.repo.createVersionDistributed({
        tenantId: actor.tenantId,
        budgetId,
        supersedesVersionId,
        note: input.note ?? null,
        totalAmount: input.totalAmount,
        weights: input.weights,
        createdBy: actor.userId,
      }),
    );

    // Hand the lifecycle to the Workflow Engine (ADR-0020 §2: draft revisions
    // use the Workflow Engine for maker-checker approval).
    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: BUDGET_WORKFLOW_DEFINITION_CODE,
      entityId: version.id,
      contextData: {
        budgetId,
        versionNumber: version.versionNumber,
        totalAmount: input.totalAmount,
        // The budget always belongs to a Legal Entity; when it is pinned to a
        // cost center that is placed in an Organization Unit, that unit owns
        // it (ADR-0012). Both stamps feed read visibility only.
        legalEntityId: budget.legalEntityId,
        organizationUnitId: budget.costCenterId
          ? await this.repo.findCostCenterOrganizationUnitId(actor.tenantId, budget.costCenterId)
          : null,
      },
    });
    await this.repo.setVersionWorkflowInstance(actor.tenantId, version.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.budget.version_drafted",
      entityType: "finance_budget_version",
      entityId: version.id,
      metadata: { budgetId, versionNumber: version.versionNumber, totalAmount: input.totalAmount },
    });
    return { ...version, workflowInstanceId: instance.id };
  }

  async listVersions(actor: ActorContext, budgetId: string): Promise<BudgetVersion[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listVersions(actor.tenantId, budgetId);
  }

  async getVersionLines(actor: ActorContext, versionId: string): Promise<BudgetLine[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listLines(actor.tenantId, versionId);
  }

  /**
   * Workflow action dispatch on a budget version (approve / reject). When the
   * instance reaches its approved terminal state the version goes active and
   * the previous baseline is superseded — never edited in place.
   */
  async actOnVersion(
    actor: ActorContext,
    versionId: string,
    actionCode: string,
    comment: string | null,
  ): Promise<BudgetVersion> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const version = await this.repo.findVersionById(actor.tenantId, versionId);
    if (!version) throw new NotFoundError("BudgetVersion", versionId);
    if (!version.workflowInstanceId) {
      throw new ConflictError("This budget version has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      version.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this budget version");

    await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    const status = await this.workflow.getEntityStatus(actor, version.workflowInstanceId);
    let updated = version;
    if (status.instanceStatus === "approved") {
      const activated = await this.unwrap(() =>
        this.repo.activateVersion(actor.tenantId, versionId, actor.userId),
      );
      if (!activated) throw new ConflictError("Budget version is no longer activatable");
      updated = activated;
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.budget.version_activated",
        entityType: "finance_budget_version",
        entityId: versionId,
        metadata: { budgetId: version.budgetId, versionNumber: version.versionNumber, comment },
      });
    } else if (status.instanceStatus === "rejected") {
      const rejected = await this.unwrap(() => this.repo.rejectVersion(actor.tenantId, versionId));
      if (rejected) updated = rejected;
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.budget.version_rejected",
        entityType: "finance_budget_version",
        entityId: versionId,
        metadata: { budgetId: version.budgetId, versionNumber: version.versionNumber, comment },
      });
    }
    return updated;
  }

  // ------------------------------------------------------------------
  // Policies (ADR-0020 §3)
  // ------------------------------------------------------------------

  async createPolicy(
    actor: ActorContext,
    input: {
      legalEntityId: string;
      effect: BudgetControlEffect;
      documentType?: string | null;
      costCenterId?: string | null;
      projectId?: string | null;
      accountFrom?: string | null;
      accountTo?: string | null;
      amountThreshold?: string | null;
      effectiveFrom: string;
      effectiveTo?: string | null;
    },
  ): Promise<BudgetPolicy> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (!BUDGET_CONTROL_EFFECTS.includes(input.effect)) {
      throw new ValidationError(`effect must be one of ${BUDGET_CONTROL_EFFECTS.join(", ")}`);
    }
    if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw new ValidationError("effectiveTo must not be before effectiveFrom");
    }
    return this.unwrap(() =>
      this.repo.createPolicy({
        tenantId: actor.tenantId,
        legalEntityId: input.legalEntityId,
        effect: input.effect,
        documentType: input.documentType ?? null,
        costCenterId: input.costCenterId ?? null,
        projectId: input.projectId ?? null,
        accountFrom: input.accountFrom ?? null,
        accountTo: input.accountTo ?? null,
        amountThreshold: input.amountThreshold ?? null,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        createdBy: actor.userId,
      }),
    );
  }

  async listPolicies(actor: ActorContext, legalEntityId: string): Promise<BudgetPolicy[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listPolicies(actor.tenantId, legalEntityId);
  }

  // ------------------------------------------------------------------
  // Consumption + utilization (ADR-0020 §4)
  // ------------------------------------------------------------------

  /**
   * Consume budget against the active baseline: idempotent via the
   * idempotency key, concurrency-safe under row locks, and fail-closed on a
   * hard_stop policy when the request would overspend.
   */
  async consume(
    actor: ActorContext,
    input: {
      budgetId: string;
      periodCode: string;
      amount: string;
      kind: BudgetConsumptionKind;
      documentType?: string | null;
      costCenterId?: string | null;
      projectId?: string | null;
      sourceRefTable?: string | null;
      sourceRefId?: string | null;
      idempotencyKey: string;
      note?: string | null;
    },
  ): Promise<BudgetAvailabilityResult & { consumptionId: string | null }> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (!BUDGET_CONSUMPTION_KINDS.includes(input.kind)) {
      throw new ValidationError(`kind must be one of ${BUDGET_CONSUMPTION_KINDS.join(", ")}`);
    }
    const budget = await this.repo.findBudgetById(actor.tenantId, input.budgetId);
    if (!budget) throw new NotFoundError("Budget", input.budgetId);

    const policies = await this.repo.listPolicies(actor.tenantId, budget.legalEntityId);
    const policy = this.repo.selectPolicy(policies, {
      documentType: input.documentType ?? null,
      costCenterId: input.costCenterId ?? budget.costCenterId,
      projectId: input.projectId ?? budget.projectId,
      accountFrom: budget.accountFrom,
      accountTo: budget.accountTo,
      amount: input.amount,
      onDate: new Date().toISOString().slice(0, 10),
    });

    const outcome = await this.unwrap(() =>
      this.repo.consumeWithCheck({
        tenantId: actor.tenantId,
        budgetId: input.budgetId,
        periodCode: input.periodCode,
        amount: input.amount,
        kind: input.kind,
        policy,
        sourceRefTable: input.sourceRefTable ?? null,
        sourceRefId: input.sourceRefId ?? null,
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
        createdBy: actor.userId,
      }),
    );

    // Advisory variances are recorded, not blocked (ADR-0020 §3). The audit
    // trail is the record — there is no separate variance table.
    if (outcome.decision !== "ok") {
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: outcome.decision === "escalate" ? "accounting.budget.escalation_required" : "accounting.budget.variance",
        entityType: "finance_budget",
        entityId: input.budgetId,
        metadata: {
          periodCode: input.periodCode,
          amount: input.amount,
          effect: policy?.effect ?? "advisory",
          variance: outcome.variance,
          policyId: policy?.id ?? null,
        },
      });
    }

    return {
      decision: outcome.decision,
      policyId: policy?.id ?? null,
      effect: policy?.effect ?? null,
      periodCode: input.periodCode,
      requestedAmount: input.amount,
      availableBefore: outcome.availableBefore,
      availableAfter: outcome.availableAfter,
      variance: outcome.variance,
      consumptionId: outcome.consumption?.id ?? null,
    };
  }

  /** Compensating release of a consumption row — history is never deleted. */
  async release(
    actor: ActorContext,
    consumptionId: string,
    input: { idempotencyKey: string; note?: string | null },
  ): Promise<BudgetConsumption> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    return this.unwrap(() =>
      this.repo.releaseConsumption({
        tenantId: actor.tenantId,
        consumptionId,
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
        createdBy: actor.userId,
      }),
    );
  }

  async utilization(
    actor: ActorContext,
    budgetId: string,
    versionId?: string | null,
  ): Promise<BudgetUtilization> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.unwrap(() => this.repo.utilization(actor.tenantId, budgetId, versionId ?? null));
  }
}
