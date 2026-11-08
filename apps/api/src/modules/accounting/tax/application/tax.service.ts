import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { WorkflowService } from "../../../../application/workflow/workflow.service.js";
import {
  EXCLUDED_TAX_TYPES,
  ROUNDING_MODES,
  TAX_BASES,
  TAX_TYPES,
  type RoundingMode,
  type TaxBasis,
  type TaxCalculation,
  type TaxRegistration,
  type TaxRule,
  type TaxRuleVersion,
  type TaxType,
  type TaxpayerStatus,
  assertPkpAllows,
  computeTaxAmount,
  fromCents,
  fromRateMicros,
  resolveRegistration,
  resolveRuleVersion,
  toCents,
  toRateMicros,
} from "../domain/tax.entity.js";
import { PgTaxRepository, TaxError } from "../infrastructure/tax.repository.pg.js";

/** Tenant Workflow Configuration code a tax rule version approval follows. */
export const TAX_RULE_WORKFLOW_DEFINITION_CODE = "tax_rule_version_approval";

/** Document tables a calculation may point at. A polymorphic pointer is only
 *  safe when the set of targets is closed. */
const DOCUMENT_REF_TABLES: readonly string[] = [
  "customer_invoices",
  "scm_vendor_invoices",
  "scm_payment_lines",
  "journal_headers",
];

/**
 * WP-FIN-A6-06a — Indonesia tax baseline (ADR-0019).
 *
 * The service never posts to the ledger. A tax calculation is evidence: it
 * records what the rule said on that date and what it produced. Posting is the
 * caller's job through the Accounting Kernel, which keeps ADR-0023 intact —
 * this module has no GL write path to get wrong.
 *
 * Rates are data. Nothing here knows that PPN is 11% or that PPh 23 is 2%; both
 * arrive as an approved rule version and are stored with the calculation.
 */
export class TaxService {
  constructor(
    private readonly repo: PgTaxRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
  ) {}

  private unwrap<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err: unknown) => {
      if (err instanceof TaxError) throw new ConflictError(err.message);
      throw err;
    });
  }

  private assertTaxType(taxType: string): asserts taxType is TaxType {
    if (EXCLUDED_TAX_TYPES.includes(taxType)) {
      throw new ValidationError(
        `${taxType} is outside the Wave A6 tax baseline; it requires separate authorization`,
      );
    }
    if (!TAX_TYPES.includes(taxType as TaxType)) {
      throw new ValidationError(`taxType must be one of ${TAX_TYPES.join(", ")}`);
    }
  }

  // ------------------------------------------------------------------
  // Registrations (ADR-0019 §1)
  // ------------------------------------------------------------------

  /**
   * Record the entity's PKP / Non-PKP status from `effectiveFrom` onward.
   *
   * A change supersedes the open row rather than editing it: a posting dated
   * before the change must still resolve the status that applied to it. The
   * first registration for an entity simply opens.
   */
  async registerTaxpayer(
    actor: ActorContext,
    input: {
      legalEntityId: string;
      taxpayerStatus: TaxpayerStatus;
      effectiveFrom: string;
      registrationNumber?: string | null;
      evidenceDocumentId?: string | null;
    },
  ): Promise<TaxRegistration> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    await this.rbac.requireLegalEntityScopeForActor(actor, input.legalEntityId);
    if (input.taxpayerStatus !== "pkp" && input.taxpayerStatus !== "non_pkp") {
      throw new ValidationError("taxpayerStatus must be pkp or non_pkp");
    }

    const existing = await this.repo.listRegistrations(actor.tenantId, input.legalEntityId);
    // A status change is effective-dated policy, so it must not rewrite a date
    // already described: a back-dated change would silently restate history.
    const future = existing.find((r) => r.effectiveFrom >= input.effectiveFrom);
    if (future) {
      throw new ValidationError(
        `A registration already starts on or after ${input.effectiveFrom}; choose a later effective date`,
      );
    }

    const open = existing.find((r) => r.status === "active" && r.effectiveTo === null);
    const registration = await this.unwrap(() =>
      open
        ? this.repo.supersedeRegistration({
            tenantId: actor.tenantId,
            legalEntityId: input.legalEntityId,
            taxpayerStatus: input.taxpayerStatus,
            registrationNumber: input.registrationNumber ?? null,
            effectiveFrom: input.effectiveFrom,
            evidenceDocumentId: input.evidenceDocumentId ?? null,
            createdBy: actor.userId,
          })
        : this.repo.createRegistration({
            tenantId: actor.tenantId,
            legalEntityId: input.legalEntityId,
            taxpayerStatus: input.taxpayerStatus,
            registrationNumber: input.registrationNumber ?? null,
            effectiveFrom: input.effectiveFrom,
            evidenceDocumentId: input.evidenceDocumentId ?? null,
            createdBy: actor.userId,
          }),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.tax_registration.recorded",
      entityType: "finance_tax_registration",
      entityId: registration.id,
      metadata: {
        legalEntityId: input.legalEntityId,
        taxpayerStatus: registration.taxpayerStatus,
        effectiveFrom: registration.effectiveFrom,
        supersedesId: open?.id ?? null,
      },
    });
    return registration;
  }

  async listRegistrations(actor: ActorContext, legalEntityId: string): Promise<TaxRegistration[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    await this.rbac.requireLegalEntityScopeForActor(actor, legalEntityId);
    return this.repo.listRegistrations(actor.tenantId, legalEntityId);
  }

  /** The status in force on a date. Refuses rather than guessing. */
  async taxpayerStatusAt(
    actor: ActorContext,
    legalEntityId: string,
    asOf: string,
  ): Promise<TaxRegistration> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    await this.rbac.requireLegalEntityScopeForActor(actor, legalEntityId);
    const rows = await this.repo.listRegistrations(actor.tenantId, legalEntityId);
    const found = resolveRegistration(rows, asOf);
    if (!found) {
      throw new NotFoundError("TaxRegistration", `${legalEntityId}@${asOf}`);
    }
    return found;
  }

  // ------------------------------------------------------------------
  // Rules + versions (ADR-0019 §3)
  // ------------------------------------------------------------------

  async createRule(
    actor: ActorContext,
    input: {
      legalEntityId: string;
      ruleCode: string;
      taxType: string;
      description?: string | null;
    },
  ): Promise<TaxRule> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    await this.rbac.requireLegalEntityScopeForActor(actor, input.legalEntityId);
    const taxType = input.taxType;
    this.assertTaxType(taxType);

    const rule = await this.unwrap(() =>
      this.repo.createRule({
        tenantId: actor.tenantId,
        legalEntityId: input.legalEntityId,
        ruleCode: input.ruleCode,
        taxType,
        description: input.description ?? null,
        createdBy: actor.userId,
      }),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.tax_rule.created",
      entityType: "finance_tax_rule",
      entityId: rule.id,
      metadata: { legalEntityId: rule.legalEntityId, ruleCode: rule.ruleCode, taxType: rule.taxType },
    });
    return rule;
  }

  async listRules(actor: ActorContext, legalEntityId?: string): Promise<TaxRule[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    if (legalEntityId) await this.rbac.requireLegalEntityScopeForActor(actor, legalEntityId);
    return this.repo.listRules(actor.tenantId, legalEntityId);
  }

  async listVersions(actor: ActorContext, taxRuleId: string): Promise<TaxRuleVersion[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const rule = await this.repo.findRuleById(actor.tenantId, taxRuleId);
    if (!rule) throw new NotFoundError("TaxRule", taxRuleId);
    await this.rbac.requireLegalEntityScopeForActor(actor, rule.legalEntityId);
    return this.repo.listVersions(actor.tenantId, taxRuleId);
  }

  /**
   * Draft a new rule version and hand its lifecycle to the Workflow Engine.
   * A draft is never a candidate for a calculation; approval is what makes a
   * version usable, and the version it replaces is superseded at that point.
   */
  async createVersion(
    actor: ActorContext,
    taxRuleId: string,
    input: {
      rate: string;
      basis: TaxBasis;
      roundingMode?: RoundingMode;
      requiresPkp?: boolean;
      accountId: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
    },
  ): Promise<TaxRuleVersion> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    const rule = await this.repo.findRuleById(actor.tenantId, taxRuleId);
    if (!rule) throw new NotFoundError("TaxRule", taxRuleId);
    await this.rbac.requireLegalEntityScopeForActor(actor, rule.legalEntityId);

    const rateMicros = toRateMicros(input.rate);
    if (rateMicros === null) {
      throw new ValidationError("rate must be a decimal fraction with at most 6 decimals, e.g. 0.110000");
    }
    if (rateMicros < 0n || rateMicros >= 1_000_000n) {
      throw new ValidationError("rate must be a fraction between 0 and 1");
    }
    if (!TAX_BASES.includes(input.basis)) {
      throw new ValidationError(`basis must be one of ${TAX_BASES.join(", ")}`);
    }
    const roundingMode = input.roundingMode ?? "half_up";
    if (!ROUNDING_MODES.includes(roundingMode)) {
      throw new ValidationError(`roundingMode must be one of ${ROUNDING_MODES.join(", ")}`);
    }
    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
      throw new ValidationError("effectiveTo must be after effectiveFrom");
    }

    const version = await this.unwrap(() =>
      this.repo.createVersion({
        tenantId: actor.tenantId,
        taxRuleId,
        rate: fromRateMicros(rateMicros),
        basis: input.basis,
        roundingMode,
        requiresPkp: input.requiresPkp ?? false,
        accountId: input.accountId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        createdBy: actor.userId,
      }),
    );

    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: TAX_RULE_WORKFLOW_DEFINITION_CODE,
      entityId: version.id,
      contextData: {
        taxRuleId,
        ruleCode: rule.ruleCode,
        taxType: rule.taxType,
        versionNumber: version.versionNumber,
        rate: version.rate,
        // A tax rule belongs to a Legal Entity, not to an Organization Unit
        // (no owning unit exists). Stamp the Legal Entity so Legal
        // Entity-scoped actors keep seeing the approval; unit-scoped actors do
        // not, by design (ADR-0007 amendment 2026-11-08).
        legalEntityId: rule.legalEntityId,
      },
    });
    await this.repo.setVersionWorkflowInstance(actor.tenantId, version.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.tax_rule_version.drafted",
      entityType: "finance_tax_rule_version",
      entityId: version.id,
      metadata: {
        taxRuleId,
        versionNumber: version.versionNumber,
        rate: version.rate,
        basis: version.basis,
        roundingMode: version.roundingMode,
        effectiveFrom: version.effectiveFrom,
      },
    });
    return { ...version, workflowInstanceId: instance.id };
  }

  /** Workflow action dispatch (approve / reject) on a rule version. */
  async actOnVersion(
    actor: ActorContext,
    versionId: string,
    actionCode: string,
    comment: string | null,
  ): Promise<TaxRuleVersion> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const version = await this.repo.findVersionById(actor.tenantId, versionId);
    if (!version) throw new NotFoundError("TaxRuleVersion", versionId);
    const rule = await this.repo.findRuleById(actor.tenantId, version.taxRuleId);
    if (!rule) throw new NotFoundError("TaxRule", version.taxRuleId);
    await this.rbac.requireLegalEntityScopeForActor(actor, rule.legalEntityId);

    if (!version.workflowInstanceId) {
      throw new ConflictError("This rule version has no active Workflow Instance");
    }
    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      version.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this rule version");

    await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);
    const status = await this.workflow.getEntityStatus(actor, version.workflowInstanceId);

    if (status.instanceStatus === "approved") {
      const approved = await this.unwrap(() =>
        this.repo.approveVersion(actor.tenantId, versionId, actor.userId),
      );
      if (!approved) throw new ConflictError("Rule version is no longer approvable");
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.tax_rule_version.approved",
        entityType: "finance_tax_rule_version",
        entityId: versionId,
        metadata: {
          taxRuleId: version.taxRuleId,
          versionNumber: version.versionNumber,
          rate: version.rate,
          effectiveFrom: version.effectiveFrom,
          comment,
        },
      });
      return approved;
    }
    if (status.instanceStatus === "rejected") {
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "accounting.tax_rule_version.rejected",
        entityType: "finance_tax_rule_version",
        entityId: versionId,
        metadata: { taxRuleId: version.taxRuleId, comment },
      });
    }
    return version;
  }

  // ------------------------------------------------------------------
  // Calculation (ADR-0019 §3)
  // ------------------------------------------------------------------

  /**
   * Compute and record the tax for one basis on one date.
   *
   * Resolves the taxpayer status and the approved rule version that were in
   * force on `calculationDate` — not the current ones — and stores both with
   * the result, so the row explains itself years later.
   *
   * Idempotent on the caller's key: a retry returns the row it already wrote.
   */
  async calculate(
    actor: ActorContext,
    input: {
      legalEntityId: string;
      ruleCode: string;
      basisAmount: string;
      calculationDate: string;
      currency?: string;
      documentRefTable?: string | null;
      documentRefId?: string | null;
      idempotencyKey: string;
    },
  ): Promise<TaxCalculation> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    await this.rbac.requireLegalEntityScopeForActor(actor, input.legalEntityId);

    const replay = await this.repo.findCalculationByIdempotencyKey(actor.tenantId, input.idempotencyKey);
    if (replay) return replay;

    const basis = toCents(input.basisAmount);
    if (basis === null || basis < 0n) {
      throw new ValidationError("basisAmount must be a non-negative 2-decimal money value");
    }

    if (input.documentRefTable !== undefined && input.documentRefTable !== null) {
      if (!DOCUMENT_REF_TABLES.includes(input.documentRefTable)) {
        throw new ValidationError(`documentRefTable must be one of ${DOCUMENT_REF_TABLES.join(", ")}`);
      }
      if (!input.documentRefId) {
        throw new ValidationError("documentRefId is required when documentRefTable is given");
      }
    }

    const registrations = await this.repo.listRegistrations(actor.tenantId, input.legalEntityId);
    const registration = resolveRegistration(registrations, input.calculationDate);
    if (!registration) {
      throw new ValidationError(
        `The Legal Entity has no tax registration in force on ${input.calculationDate}`,
      );
    }

    const rules = await this.repo.listRules(actor.tenantId, input.legalEntityId);
    const rule = rules.find((r) => r.ruleCode === input.ruleCode);
    if (!rule) throw new NotFoundError("TaxRule", input.ruleCode);

    const versions = await this.repo.listVersions(actor.tenantId, rule.id);
    const version = resolveRuleVersion(versions, input.calculationDate);
    if (!version) {
      throw new ValidationError(
        `No approved version of rule "${input.ruleCode}" is in force on ${input.calculationDate}`,
      );
    }

    // A PKP-only rule on a Non-PKP entity is refused, never zeroed: a zero
    // would look like a legitimate exempt result.
    try {
      assertPkpAllows(version, registration.taxpayerStatus);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }

    const rateMicros = toRateMicros(version.rate);
    if (rateMicros === null) {
      throw new ConflictError(`Rule version ${version.id} carries an unparseable rate`);
    }
    const taxAmount = computeTaxAmount(basis, rateMicros, version.roundingMode);

    const calculation = await this.unwrap(() =>
      this.repo.createCalculation({
        tenantId: actor.tenantId,
        legalEntityId: input.legalEntityId,
        ruleVersionId: version.id,
        taxpayerStatus: registration.taxpayerStatus,
        basisAmount: fromCents(basis),
        rate: version.rate,
        roundingMode: version.roundingMode,
        taxAmount: fromCents(taxAmount),
        currency: input.currency ?? "IDR",
        calculationDate: input.calculationDate,
        documentRefTable: input.documentRefTable ?? null,
        documentRefId: input.documentRefId ?? null,
        idempotencyKey: input.idempotencyKey,
        createdBy: actor.userId,
      }),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.tax_calculation.recorded",
      entityType: "finance_tax_calculation",
      entityId: calculation.id,
      metadata: {
        legalEntityId: input.legalEntityId,
        ruleCode: input.ruleCode,
        ruleVersionId: version.id,
        taxpayerStatus: registration.taxpayerStatus,
        basisAmount: calculation.basisAmount,
        rate: calculation.rate,
        roundingMode: calculation.roundingMode,
        taxAmount: calculation.taxAmount,
        calculationDate: calculation.calculationDate,
      },
    });
    return calculation;
  }

  async listCalculations(
    actor: ActorContext,
    filter: { legalEntityId?: string; ruleVersionId?: string; documentRefId?: string },
  ): Promise<TaxCalculation[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    if (filter.legalEntityId) {
      await this.rbac.requireLegalEntityScopeForActor(actor, filter.legalEntityId);
    }
    return this.repo.listCalculations(actor.tenantId, filter);
  }
}
