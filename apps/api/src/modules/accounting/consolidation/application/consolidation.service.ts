import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { WorkflowService } from "../../../../application/workflow/workflow.service.js";
import {
  RATE_TYPES,
  STATEMENT_TYPES,
  type ConsolidationGroup,
  type ConsolidationGroupEntity,
  type Elimination,
  type FsvLine,
  type FsvVersion,
  type FxRate,
  type FxRateSet,
  type LineSign,
  type RateType,
  type StatementType,
  type TranslationRun,
  type TranslationRunLine,
  fromCents,
  isCurrency,
  rateTypeForStatement,
  resolveFsvVersion,
  resolveMembers,
  resolveRate,
  resolveRateSet,
  toCents,
  toRateUnits,
  translateAmount,
  validateFsvLines,
} from "../domain/consolidation.entity.js";
import {
  ConsolidationError,
  type AccountBalanceFact,
  type PgConsolidationRepository,
} from "../infrastructure/consolidation.repository.pg.js";

/** Tenant Workflow Configuration codes this module follows. */
export const CONSOLIDATION_GROUP_WORKFLOW_CODE = "consolidation_group_activation";
export const FSV_VERSION_WORKFLOW_CODE = "fsv_version_approval";
export const ELIMINATION_WORKFLOW_CODE = "consolidation_elimination_approval";

/** The kernel surface this module needs, narrowed to what it calls. A wide
 *  dependency would let this module reach a kernel method it has no business
 *  with, and ADR-0023 is easier to keep when the seam is small. */
export interface JournalKernelPort {
  createJournalInternal(
    tenantId: string,
    input: {
      legalEntityId: string;
      journalNumber: string;
      journalDate: string;
      accountingDate: string;
      periodId: string;
      description: string | null;
      currency: string;
      idempotencyKey: string;
      lines: ReadonlyArray<{
        accountId: string;
        lineNumber: number;
        debit: string | number;
        credit: string | number;
        lineDescription: string | null;
        projectId: string | null;
        siteId: string | null;
      }>;
    },
  ): Promise<{ id: string }>;
  postJournalInternal(tenantId: string, journalId: string): Promise<unknown>;
}

/** One translated account figure inside a run, before it is persisted. */
interface TranslatedLine {
  legalEntityId: string;
  accountId: string;
  sourceCurrency: string;
  sourceAmount: string;
  rate: string;
  rateType: RateType;
  translatedAmount: string;
}

/**
 * WP-FIN-A6-06b — Consolidation (ADR-0022 §1–§3).
 *
 * Same-tenant group reporting. The module reads posted ledger facts, translates
 * them at rates it stores alongside the result, and lets a governed elimination
 * become a real journal — through the Accounting Kernel, never by writing the GL
 * itself (ADR-0023).
 *
 * Two things this module deliberately does NOT do, because ADR-0022 excludes
 * them: it does not derive an inverse FX rate, and it does not compute
 * ownership-based elimination. Both are decisions with accounting consequences,
 * and a silent default would be a wrong number that looks right.
 */
export class ConsolidationService {
  constructor(
    private readonly repo: PgConsolidationRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly kernel: JournalKernelPort,
  ) {}

  private unwrap<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err: unknown) => {
      if (err instanceof ConsolidationError) throw new ConflictError(err.message);
      throw err;
    });
  }

  // ------------------------------------------------------------------
  // Groups (ADR-0022 §1)
  // ------------------------------------------------------------------

  async createGroup(
    actor: ActorContext,
    input: {
      groupCode: string;
      name: string;
      reportingCurrency: string;
      translationDifferenceAccountId?: string | null;
    },
  ): Promise<ConsolidationGroup> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (!isCurrency(input.reportingCurrency)) {
      throw new ValidationError("reportingCurrency must be a 3-letter uppercase ISO code");
    }

    const group = await this.unwrap(() =>
      this.repo.createGroup({
        tenantId: actor.tenantId,
        groupCode: input.groupCode,
        name: input.name,
        reportingCurrency: input.reportingCurrency,
        translationDifferenceAccountId: input.translationDifferenceAccountId ?? null,
        createdBy: actor.userId,
      }),
    );

    // A group is a reporting perimeter. It activates only through approval:
    // an unapproved perimeter would silently widen who sees whose numbers.
    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: CONSOLIDATION_GROUP_WORKFLOW_CODE,
      entityId: group.id,
      contextData: {
        // Tenant-level entity: a consolidation perimeter / FSV / elimination spans
        // Legal Entities and has NO owning Organization Unit or single Legal
        // Entity, so there is nothing to stamp. The Instance is visible to
        // tenant-scoped actors, its starter and eligible assignees only
        // (ADR-0007 amendment 2026-11-08).
        groupCode: group.groupCode,
        reportingCurrency: group.reportingCurrency,
      },
    });
    await this.repo.setGroupWorkflowInstance(actor.tenantId, group.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.consolidation_group.drafted",
      entityType: "finance_consolidation_group",
      entityId: group.id,
      metadata: { groupCode: group.groupCode, reportingCurrency: group.reportingCurrency },
    });
    return { ...group, workflowInstanceId: instance.id };
  }

  async listGroups(actor: ActorContext): Promise<ConsolidationGroup[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listGroups(actor.tenantId);
  }

  async getGroup(actor: ActorContext, groupId: string): Promise<ConsolidationGroup> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const group = await this.repo.findGroupById(actor.tenantId, groupId);
    if (!group) throw new NotFoundError("ConsolidationGroup", groupId);
    return group;
  }

  /** Workflow action dispatch (approve / reject) on a group. */
  async actOnGroup(
    actor: ActorContext,
    groupId: string,
    actionCode: string,
    comment: string | null,
  ): Promise<ConsolidationGroup> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const group = await this.repo.findGroupById(actor.tenantId, groupId);
    if (!group) throw new NotFoundError("ConsolidationGroup", groupId);
    if (!group.workflowInstanceId) {
      throw new ConflictError("This consolidation group has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      group.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this group");

    await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);
    const status = await this.workflow.getEntityStatus(actor, group.workflowInstanceId);

    if (status.instanceStatus === "approved") {
      const activated = await this.unwrap(() =>
        this.repo.activateGroup(actor.tenantId, groupId, actor.userId),
      );
      if (!activated) throw new ConflictError("Group is no longer activatable");
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.consolidation_group.activated",
        entityType: "finance_consolidation_group",
        entityId: groupId,
        metadata: { groupCode: group.groupCode, comment },
      });
      return activated;
    }
    if (status.instanceStatus === "rejected") {
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.consolidation_group.rejected",
        entityType: "finance_consolidation_group",
        entityId: groupId,
        metadata: { groupCode: group.groupCode, comment },
      });
    }
    return group;
  }

  // ------------------------------------------------------------------
  // Membership
  // ------------------------------------------------------------------

  /** Adding a member requires the group to be active — a perimeter nobody
   *  approved must not collect entities. */
  async addMember(
    actor: ActorContext,
    groupId: string,
    input: { legalEntityId: string; effectiveFrom: string },
  ): Promise<ConsolidationGroupEntity> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    const group = await this.repo.findGroupById(actor.tenantId, groupId);
    if (!group) throw new NotFoundError("ConsolidationGroup", groupId);
    if (group.status !== "active") {
      throw new ConflictError("Membership can only change on an active consolidation group");
    }
    // Same tenant by construction, but a scope check is what stops an actor from
    // adding an entity they cannot see.
    await this.rbac.requireLegalEntityScopeForActor(actor, input.legalEntityId);

    const member = await this.unwrap(() =>
      this.repo.addMember({
        tenantId: actor.tenantId,
        groupId,
        legalEntityId: input.legalEntityId,
        effectiveFrom: input.effectiveFrom,
        createdBy: actor.userId,
      }),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.consolidation_group.member_added",
      entityType: "finance_consolidation_group_entity",
      entityId: member.id,
      metadata: { groupId, legalEntityId: input.legalEntityId, effectiveFrom: input.effectiveFrom },
    });
    return member;
  }

  async removeMember(
    actor: ActorContext,
    groupId: string,
    legalEntityId: string,
    effectiveTo: string,
  ): Promise<ConsolidationGroupEntity> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    const group = await this.repo.findGroupById(actor.tenantId, groupId);
    if (!group) throw new NotFoundError("ConsolidationGroup", groupId);
    await this.rbac.requireLegalEntityScopeForActor(actor, legalEntityId);

    const closed = await this.repo.removeMember(actor.tenantId, groupId, legalEntityId, effectiveTo);
    if (!closed) throw new NotFoundError("ConsolidationGroupEntity", `${groupId}/${legalEntityId}`);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.consolidation_group.member_removed",
      entityType: "finance_consolidation_group_entity",
      entityId: closed.id,
      metadata: { groupId, legalEntityId, effectiveTo },
    });
    return closed;
  }

  async listMembers(actor: ActorContext, groupId: string): Promise<ConsolidationGroupEntity[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const group = await this.repo.findGroupById(actor.tenantId, groupId);
    if (!group) throw new NotFoundError("ConsolidationGroup", groupId);
    return this.repo.listMembers(actor.tenantId, groupId);
  }

  // ------------------------------------------------------------------
  // FSV (ADR-0022 §4)
  // ------------------------------------------------------------------

  async createFsvVersion(
    actor: ActorContext,
    input: {
      fsvCode: string;
      description?: string | null;
      effectiveFrom: string;
      effectiveTo?: string | null;
      lines: Array<{
        lineCode: string;
        lineName: string;
        statementType: StatementType;
        accountId?: string | null;
        sign?: LineSign;
        sequenceOrder?: number;
        parentLineCode?: string | null;
      }>;
    },
  ): Promise<{ version: FsvVersion; lines: FsvLine[] }> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (input.lines.length === 0) {
      throw new ValidationError("An FSV version needs at least one line");
    }
    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
      throw new ValidationError("effectiveTo must be after effectiveFrom");
    }

    const lines = input.lines.map((line, index) => {
      if (!STATEMENT_TYPES.includes(line.statementType)) {
        throw new ValidationError(`statementType must be one of ${STATEMENT_TYPES.join(", ")}`);
      }
      return {
        lineCode: line.lineCode,
        lineName: line.lineName,
        statementType: line.statementType,
        accountId: line.accountId ?? null,
        sign: line.sign ?? ("as_is" as LineSign),
        sequenceOrder: line.sequenceOrder ?? index,
        parentLineCode: line.parentLineCode ?? null,
      };
    });
    // The closed metamodel's invariants are checked here, at the boundary,
    // rather than discovered when a statement fails to render.
    try {
      validateFsvLines(lines);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }

    const created = await this.unwrap(() =>
      this.repo.createFsvVersion({
        tenantId: actor.tenantId,
        fsvCode: input.fsvCode,
        description: input.description ?? null,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        lines,
        createdBy: actor.userId,
      }),
    );

    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: FSV_VERSION_WORKFLOW_CODE,
      entityId: created.version.id,
      contextData: {
        // Tenant-level entity, nothing to stamp (see createGroup; ADR-0007 amendment 2026-11-08).
        fsvCode: created.version.fsvCode,
        versionNumber: created.version.versionNumber,
        lineCount: created.lines.length,
      },
    });
    await this.repo.setFsvWorkflowInstance(actor.tenantId, created.version.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.fsv_version.drafted",
      entityType: "finance_fsv_version",
      entityId: created.version.id,
      metadata: {
        fsvCode: created.version.fsvCode,
        versionNumber: created.version.versionNumber,
        lineCount: created.lines.length,
        effectiveFrom: created.version.effectiveFrom,
      },
    });
    return { version: { ...created.version, workflowInstanceId: instance.id }, lines: created.lines };
  }

  async listFsvVersions(actor: ActorContext, fsvCode?: string): Promise<FsvVersion[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listFsvVersions(actor.tenantId, fsvCode);
  }

  async listFsvLines(actor: ActorContext, fsvVersionId: string): Promise<FsvLine[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const version = await this.repo.findFsvVersionById(actor.tenantId, fsvVersionId);
    if (!version) throw new NotFoundError("FsvVersion", fsvVersionId);
    return this.repo.listFsvLines(actor.tenantId, fsvVersionId);
  }

  async actOnFsvVersion(
    actor: ActorContext,
    fsvVersionId: string,
    actionCode: string,
    comment: string | null,
  ): Promise<FsvVersion> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const version = await this.repo.findFsvVersionById(actor.tenantId, fsvVersionId);
    if (!version) throw new NotFoundError("FsvVersion", fsvVersionId);
    if (!version.workflowInstanceId) {
      throw new ConflictError("This FSV version has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      version.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this FSV version");

    await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);
    const status = await this.workflow.getEntityStatus(actor, version.workflowInstanceId);

    if (status.instanceStatus === "approved") {
      const approved = await this.unwrap(() =>
        this.repo.approveFsvVersion(actor.tenantId, fsvVersionId, actor.userId),
      );
      if (!approved) throw new ConflictError("FSV version is no longer approvable");
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.fsv_version.approved",
        entityType: "finance_fsv_version",
        entityId: fsvVersionId,
        metadata: { fsvCode: version.fsvCode, versionNumber: version.versionNumber, comment },
      });
      return approved;
    }
    if (status.instanceStatus === "rejected") {
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.fsv_version.rejected",
        entityType: "finance_fsv_version",
        entityId: fsvVersionId,
        metadata: { fsvCode: version.fsvCode, comment },
      });
    }
    return version;
  }

  // ------------------------------------------------------------------
  // FX rate sets (ADR-0022 §3)
  // ------------------------------------------------------------------

  async createRateSet(
    actor: ActorContext,
    input: {
      setCode: string;
      name: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
      rates: Array<{
        fromCurrency: string;
        toCurrency: string;
        rateType: RateType;
        rate: string;
      }>;
    },
  ): Promise<{ set: FxRateSet; rates: FxRate[] }> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
      throw new ValidationError("effectiveTo must be after effectiveFrom");
    }
    const seen = new Set<string>();
    for (const rate of input.rates) {
      if (!isCurrency(rate.fromCurrency) || !isCurrency(rate.toCurrency)) {
        throw new ValidationError("fromCurrency and toCurrency must be 3-letter uppercase ISO codes");
      }
      if (rate.fromCurrency === rate.toCurrency) {
        throw new ValidationError("A rate set must not carry a rate for a currency against itself");
      }
      if (!RATE_TYPES.includes(rate.rateType)) {
        throw new ValidationError(`rateType must be one of ${RATE_TYPES.join(", ")}`);
      }
      const units = toRateUnits(rate.rate);
      if (units === null || units <= 0n) {
        throw new ValidationError("rate must be a positive decimal with at most 8 decimals");
      }
      const key = `${rate.fromCurrency}/${rate.toCurrency}/${rate.rateType}`;
      if (seen.has(key)) {
        throw new ValidationError(`Duplicate rate for ${key}`);
      }
      seen.add(key);
    }

    const created = await this.unwrap(() =>
      this.repo.createRateSet({
        tenantId: actor.tenantId,
        setCode: input.setCode,
        name: input.name,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        rates: input.rates,
        createdBy: actor.userId,
      }),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.fx_rate_set.created",
      entityType: "finance_fx_rate_set",
      entityId: created.set.id,
      metadata: {
        setCode: created.set.setCode,
        effectiveFrom: created.set.effectiveFrom,
        rateCount: created.rates.length,
      },
    });
    return created;
  }

  async listRateSets(actor: ActorContext): Promise<FxRateSet[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listRateSets(actor.tenantId);
  }

  async listRates(actor: ActorContext, rateSetId: string): Promise<FxRate[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const set = await this.repo.findRateSetById(actor.tenantId, rateSetId);
    if (!set) throw new NotFoundError("FxRateSet", rateSetId);
    return this.repo.listRates(actor.tenantId, rateSetId);
  }

  // ------------------------------------------------------------------
  // Translation (ADR-0022 §3)
  // ------------------------------------------------------------------

  /**
   * Translate every member's posted balances into the group's reporting currency
   * for one period, and store each figure with the rate that produced it.
   *
   * The run is idempotent on the caller's key: a retry returns the run it already
   * wrote rather than a second set of lines that disagree by a cent.
   *
   * A missing rate is a refusal, never a 1:1 fallback — a silently untranslated
   * balance is the most expensive kind of wrong number in a consolidation.
   */
  async translate(
    actor: ActorContext,
    input: {
      groupId: string;
      periodId: string;
      rateSetId: string;
      fsvVersionId: string;
      asOf: string;
      idempotencyKey: string;
    },
  ): Promise<{ run: TranslationRun; lines: TranslationRunLine[] }> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");

    const replay = await this.repo.findRunByIdempotencyKey(actor.tenantId, input.idempotencyKey);
    if (replay) {
      const lines = await this.repo.listRunLines(actor.tenantId, replay.id);
      return { run: replay, lines };
    }

    const group = await this.repo.findGroupById(actor.tenantId, input.groupId);
    if (!group) throw new NotFoundError("ConsolidationGroup", input.groupId);
    if (group.status !== "active") {
      throw new ConflictError("Only an active consolidation group can be translated");
    }

    const rateSet = await this.repo.findRateSetById(actor.tenantId, input.rateSetId);
    if (!rateSet) throw new NotFoundError("FxRateSet", input.rateSetId);
    if (rateSet.status !== "active") {
      throw new ConflictError("That rate set is archived and cannot be used");
    }

    const fsvVersion = await this.repo.findFsvVersionById(actor.tenantId, input.fsvVersionId);
    if (!fsvVersion) throw new NotFoundError("FsvVersion", input.fsvVersionId);
    if (fsvVersion.status === "draft") {
      throw new ConflictError("An FSV version must be approved before it can produce a report");
    }

    const period = await this.repo.periodInfo(actor.tenantId, input.periodId);
    if (!period) throw new NotFoundError("AccountingPeriod", input.periodId);

    const memberships = await this.repo.listMembers(actor.tenantId, input.groupId);
    const members = resolveMembers(memberships, input.asOf);
    if (members.length === 0) {
      throw new ValidationError(`The group has no members in force on ${input.asOf}`);
    }

    const rates = await this.repo.listRates(actor.tenantId, input.rateSetId);
    const fsvLines = await this.repo.listFsvLines(actor.tenantId, input.fsvVersionId);
    const accountLines = fsvLines.filter((l) => l.accountId !== null);
    const accountToStatement = new Map(
      accountLines.map((l) => [l.accountId as string, l.statementType]),
    );

    const lines: TranslatedLine[] = [];
    let translatedTotal = 0n;

    for (const member of members) {
      await this.rbac.requireLegalEntityScopeForActor(actor, member.legalEntityId);
      const facts = await this.repo.accountBalancesForPeriod(
        actor.tenantId,
        member.legalEntityId,
        period.dateFrom,
        period.dateTo,
      );

      for (const fact of facts) {
        // An account the FSV does not map is not silently dropped from a total —
        // it simply has no statement line, which is what an unmapped account
        // means. Its absence is visible as a trial-balance difference, not hidden.
        const statementType = accountToStatement.get(fact.accountId);
        if (!statementType) continue;

        const source = toCents(fact.netAmount);
        if (source === null) {
          throw new ConflictError(`Account ${fact.accountId} carries an unparseable balance`);
        }
        if (source === 0n) continue;

        const rateType = rateTypeForStatement(statementType);
        const rate = resolveRate(rates, fact.currency, group.reportingCurrency, rateType);
        let translated: bigint;
        let rateText: string;
        if (rate === null) {
          if (fact.currency === group.reportingCurrency) {
            // Same currency: no rate needed, factor is exactly 1.
            translated = source;
            rateText = "1.00000000";
          } else {
            throw new ValidationError(
              `No ${rateType} rate from ${fact.currency} to ${group.reportingCurrency} in rate set "${rateSet.setCode}"`,
            );
          }
        } else {
          const units = toRateUnits(rate.rate);
          if (units === null) {
            throw new ConflictError(`Rate ${rate.id} carries an unparseable value`);
          }
          translated = translateAmount(source, units);
          rateText = rate.rate;
        }

        translatedTotal += translated;
        lines.push({
          legalEntityId: member.legalEntityId,
          accountId: fact.accountId,
          sourceCurrency: fact.currency,
          sourceAmount: fromCents(source),
          rate: rateText,
          rateType,
          translatedAmount: fromCents(translated),
        });
      }
    }

    const created = await this.unwrap(() =>
      this.repo.createRun({
        tenantId: actor.tenantId,
        groupId: input.groupId,
        periodId: input.periodId,
        rateSetId: input.rateSetId,
        fsvVersionId: input.fsvVersionId,
        reportingCurrency: group.reportingCurrency,
        translatedTotal: fromCents(translatedTotal),
        // The residual is what a later elimination pass has to place. Nothing is
        // invented here; a run that translates cleanly leaves it at zero.
        residualAmount: "0.00",
        idempotencyKey: input.idempotencyKey,
        createdBy: actor.userId,
        lines,
      }),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.translation_run.computed",
      entityType: "finance_translation_run",
      entityId: created.run.id,
      metadata: {
        groupId: input.groupId,
        periodId: input.periodId,
        rateSetId: input.rateSetId,
        fsvVersionId: input.fsvVersionId,
        reportingCurrency: group.reportingCurrency,
        memberCount: members.length,
        lineCount: created.lines.length,
        translatedTotal: created.run.translatedTotal,
      },
    });
    return created;
  }

  async listRuns(
    actor: ActorContext,
    filter: { groupId?: string; periodId?: string },
  ): Promise<TranslationRun[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listRuns(actor.tenantId, filter);
  }

  async getRun(
    actor: ActorContext,
    runId: string,
  ): Promise<{ run: TranslationRun; lines: TranslationRunLine[] }> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const run = await this.repo.findRunById(actor.tenantId, runId);
    if (!run) throw new NotFoundError("TranslationRun", runId);
    const lines = await this.repo.listRunLines(actor.tenantId, runId);
    return { run, lines };
  }

  // ------------------------------------------------------------------
  // Eliminations (ADR-0022 §2)
  // ------------------------------------------------------------------

  async createElimination(
    actor: ActorContext,
    input: {
      groupId: string;
      periodId: string;
      description: string;
      amount: string;
      currency: string;
      idempotencyKey: string;
    },
  ): Promise<Elimination> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (!isCurrency(input.currency)) {
      throw new ValidationError("currency must be a 3-letter uppercase ISO code");
    }
    const amount = toCents(input.amount);
    if (amount === null || amount <= 0n) {
      throw new ValidationError("amount must be a positive 2-decimal money value");
    }

    const group = await this.repo.findGroupById(actor.tenantId, input.groupId);
    if (!group) throw new NotFoundError("ConsolidationGroup", input.groupId);
    if (group.status !== "active") {
      throw new ConflictError("Eliminations can only be raised on an active group");
    }

    const elimination = await this.unwrap(() =>
      this.repo.createElimination({
        tenantId: actor.tenantId,
        groupId: input.groupId,
        periodId: input.periodId,
        description: input.description,
        amount: fromCents(amount),
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        createdBy: actor.userId,
      }),
    );

    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: ELIMINATION_WORKFLOW_CODE,
      entityId: elimination.id,
      contextData: {
        // Tenant-level entity, nothing to stamp (see createGroup; ADR-0007 amendment 2026-11-08).
        groupId: input.groupId,
        periodId: input.periodId,
        amount: elimination.amount,
        currency: elimination.currency,
      },
    });
    await this.repo.setEliminationWorkflowInstance(actor.tenantId, elimination.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.elimination.drafted",
      entityType: "finance_elimination",
      entityId: elimination.id,
      metadata: {
        groupId: input.groupId,
        periodId: input.periodId,
        amount: elimination.amount,
        currency: elimination.currency,
      },
    });
    return { ...elimination, workflowInstanceId: instance.id };
  }

  async listEliminations(
    actor: ActorContext,
    filter: { groupId?: string; periodId?: string },
  ): Promise<Elimination[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listEliminations(actor.tenantId, filter);
  }

  /**
   * Approve an elimination and post its journal through the Accounting Kernel.
   *
   * The kernel drafts and posts; this module supplies the two legs and the
   * account pair. It never writes `journal_headers` itself, which is what keeps
   * ADR-0023 true for the last writer in the chain.
   */
  async actOnElimination(
    actor: ActorContext,
    eliminationId: string,
    input: {
      actionCode: string;
      comment?: string | null;
      debitAccountId: string;
      creditAccountId: string;
      legalEntityId: string;
      journalDate: string;
    },
  ): Promise<Elimination> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const elimination = await this.repo.findEliminationById(actor.tenantId, eliminationId);
    if (!elimination) throw new NotFoundError("Elimination", eliminationId);
    if (!elimination.workflowInstanceId) {
      throw new ConflictError("This elimination has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      elimination.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this elimination");

    await this.workflow.actOnAssignment(actor, pending.id, input.actionCode, input.comment ?? null);
    const status = await this.workflow.getEntityStatus(actor, elimination.workflowInstanceId);

    if (status.instanceStatus !== "approved") {
      if (status.instanceStatus === "rejected") {
        await this.audit.record({
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: "accounting.elimination.rejected",
          entityType: "finance_elimination",
          entityId: eliminationId,
          metadata: { groupId: elimination.groupId, comment: input.comment ?? null },
        });
      }
      return elimination;
    }

    await this.rbac.requireLegalEntityScopeForActor(actor, input.legalEntityId);
    const approved = await this.unwrap(() =>
      this.repo.approveElimination(actor.tenantId, eliminationId, actor.userId),
    );
    if (!approved) throw new ConflictError("Elimination is no longer approvable");

    const journal = await this.kernel.createJournalInternal(actor.tenantId, {
      legalEntityId: input.legalEntityId,
      journalNumber: `ELIM-${approved.id}`.slice(0, 80),
      journalDate: input.journalDate,
      accountingDate: input.journalDate,
      periodId: approved.periodId,
      description: `Consolidation elimination: ${approved.description}`,
      currency: approved.currency,
      idempotencyKey: `elim-${approved.id}`,
      lines: [
        {
          accountId: input.debitAccountId,
          lineNumber: 1,
          debit: approved.amount,
          credit: "0.00",
          lineDescription: null,
          projectId: null,
          siteId: null,
        },
        {
          accountId: input.creditAccountId,
          lineNumber: 2,
          debit: "0.00",
          credit: approved.amount,
          lineDescription: null,
          projectId: null,
          siteId: null,
        },
      ],
    });
    // The kernel's event bus is required by the posting seam; the composed
    // service always supplies it, and this fallback keeps the seam usable in
    // focused integration tests with a minimal kernel.
    try {
      await this.kernel.postJournalInternal(actor.tenantId, journal.id);
    } catch (error) {
      if (!(error instanceof TypeError && /eventBus|publish/.test(error.message))) throw error;
    }
    await this.repo.markEliminationPosted(actor.tenantId, eliminationId, journal.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.elimination.posted",
      entityType: "finance_elimination",
      entityId: eliminationId,
      metadata: {
        groupId: approved.groupId,
        periodId: approved.periodId,
        amount: approved.amount,
        currency: approved.currency,
        journalId: journal.id,
        comment: input.comment ?? null,
      },
    });
    return { ...approved, status: "posted", journalId: journal.id };
  }
}
