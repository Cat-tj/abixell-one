import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { WorkflowService } from "../../../../application/workflow/workflow.service.js";
import type { ConfigurationService } from "../../../../application/configuration/configuration.service.js";
import {
  CAPA_ACTION_TYPES,
  RISK_ASSESSMENT_TYPES,
  type ContributingFactor,
  type CoreHseRecordRef,
  type HseAdvancedRepository,
  type HseInvestigation,
  type HseInvestigationFramework,
  type HsePermit,
  type HseRiskAssessment,
  type HseRiskMatrix,
  type PermitIsolationCondition,
  type RiskAssessmentType,
  type RiskControl,
  type RiskScalePoint,
} from "../domain/hse-advanced.entity.js";

/** Tenant Configuration code for permit numbers. */
export const HSE_PERMIT_NUMBERING_CODE = "hse_permit";

/**
 * Permit lifecycle definition. Content lives here; state is the Engine's
 * (ADR-0027 §4) — this module owns no status column and no local state machine.
 */
export const HSE_PERMIT_WORKFLOW_DEFINITION_CODE = "hse_permit_lifecycle";

export interface HsePermitDetailView {
  permit: HsePermit;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
}

/**
 * HSE Advanced — investigation, risk and permit (HSE-ADV-001/002/003).
 *
 * Three boundaries from ADR-0027 shape this file:
 *
 * - **§2 Investigation methodology is history.** The framework version is
 *   copied onto the investigation at creation and is never writable again.
 *   Editing a framework produces a new version row; it does not rewrite a
 *   concluded investigation.
 * - **§3 The rating is the assessment's, not the matrix's.** A rating is
 *   resolved from the matrix's cell at assessment time and stored. A later
 *   matrix edit cannot re-rate a historical assessment, because nothing here
 *   ever recomputes a stored rating.
 * - **§4 Permit lifecycle is exclusively the Workflow Engine's.** The only
 *   lifecycle write is binding the Engine instance. There is no status column
 *   to write, and this file does not invent one.
 *
 * Core HSE is never modified: `hse_records` and `hse_follow_ups` are read
 * through clean reference ports and nothing in this module writes them.
 */
export class HseAdvancedService {
  constructor(
    private readonly repo: HseAdvancedRepository,
    private readonly workflow: WorkflowService,
    private readonly configuration: ConfigurationService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  // =====================================================================
  // HSE-ADV-001 — investigations
  // =====================================================================

  async createFramework(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      description?: string | null;
      causeCategories?: string[];
    },
  ): Promise<HseInvestigationFramework> {
    await this.rbac.requirePermission(actor, "hse.advanced.manage");
    const code = requireText(input.code, "code");
    const name = requireText(input.name, "name");
    const framework = await this.repo.createInvestigationFramework({
      tenantId: actor.tenantId,
      code,
      name,
      description: clean(input.description),
      causeCategories: (input.causeCategories ?? []).map((c) => requireText(c, "causeCategory")),
      createdBy: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.investigation_framework.created",
      entityType: "hse_investigation_framework",
      entityId: framework.id,
      metadata: { code: framework.code, version: framework.version },
    });
    return framework;
  }

  async listFrameworks(actor: ActorContext): Promise<HseInvestigationFramework[]> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    return this.repo.listInvestigationFrameworks(actor.tenantId);
  }

  /**
   * Start an investigation on a Core record. One per record by constraint; a
   * second attempt is a conflict rather than a silent second row, because a
   * record with two investigations has two stories and no single root cause.
   */
  async createInvestigation(
    actor: ActorContext,
    hseRecordId: string,
    input: { frameworkId: string; leadInvestigatorUserId?: string | null },
  ): Promise<HseInvestigation> {
    await this.rbac.requirePermission(actor, "hse.advanced.manage");
    const record = await this.requireRecord(actor, hseRecordId);

    const framework = await this.repo.findInvestigationFrameworkById(input.frameworkId);
    if (!framework || framework.tenantId !== actor.tenantId) {
      throw new NotFoundError("HseInvestigationFramework", input.frameworkId);
    }
    if (!framework.isActive) {
      throw new ConflictError(
        `Investigation framework '${framework.code}' version ${framework.version} is not active`,
      );
    }
    if (await this.repo.findInvestigationByRecord(record.id)) {
      throw new ConflictError("This HSE record already has an investigation");
    }
    if (input.leadInvestigatorUserId) {
      if (!(await this.repo.userExists(actor.tenantId, input.leadInvestigatorUserId))) {
        throw new NotFoundError("User", input.leadInvestigatorUserId);
      }
    }

    const investigation = await this.repo.createInvestigation({
      tenantId: actor.tenantId,
      hseRecordId: record.id,
      frameworkId: framework.id,
      frameworkCode: framework.code,
      frameworkVersion: framework.version,
      leadInvestigatorUserId: input.leadInvestigatorUserId ?? null,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.investigation.created",
      entityType: "hse_investigation",
      entityId: investigation.id,
      metadata: {
        hseRecordId: record.id,
        frameworkCode: framework.code,
        frameworkVersion: framework.version,
      },
    });
    return investigation;
  }

  async getInvestigation(actor: ActorContext, id: string): Promise<HseInvestigation> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    return this.requireInvestigation(actor, id);
  }

  async listInvestigations(actor: ActorContext): Promise<HseInvestigation[]> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    return this.repo.listInvestigations(actor.tenantId, await this.scopeOf(actor));
  }

  /**
   * Record findings and the root-cause determination.
   *
   * `hse.investigation.lead` is the permission, not the broader manage: naming
   * a root cause is a professional judgement about an event, and it should be
   * held by the people qualified to make it.
   *
   * The framework is deliberately absent from the updatable surface (ADR-0027
   * §2). Re-opening a concluded investigation clears `concludedAt` and keeps
   * the framework it started under.
   */
  async updateInvestigation(
    actor: ActorContext,
    id: string,
    input: {
      leadInvestigatorUserId?: string | null;
      findings?: string | null;
      rootCause?: string | null;
      contributingFactors?: ContributingFactor[];
      concluded?: boolean;
    },
  ): Promise<HseInvestigation> {
    await this.rbac.requirePermission(actor, "hse.investigation.lead");
    const existing = await this.requireInvestigation(actor, id);

    if (input.leadInvestigatorUserId) {
      if (!(await this.repo.userExists(actor.tenantId, input.leadInvestigatorUserId))) {
        throw new NotFoundError("User", input.leadInvestigatorUserId);
      }
    }

    const factors = input.contributingFactors
      ? input.contributingFactors.map(normalizeFactor)
      : undefined;

    // Concluding without a stated root cause would leave a closed investigation
    // that answers nothing — the one thing an investigation exists to do.
    const rootCause = input.rootCause === undefined ? existing.rootCause : clean(input.rootCause);
    const concluding = input.concluded === true;
    if (concluding && !rootCause) {
      throw new ValidationError("An investigation cannot conclude without a root cause");
    }

    const updated = await this.repo.updateInvestigation(id, {
      leadInvestigatorUserId: input.leadInvestigatorUserId,
      findings: input.findings === undefined ? undefined : clean(input.findings),
      rootCause: input.rootCause === undefined ? undefined : clean(input.rootCause),
      contributingFactors: factors,
      concludedAt: concluding ? new Date() : input.concluded === false ? null : undefined,
      updatedBy: actor.userId,
    });
    if (!updated) throw new NotFoundError("HseInvestigation", id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: concluding ? "hse.investigation.concluded" : "hse.investigation.updated",
      entityType: "hse_investigation",
      entityId: id,
      metadata: { frameworkCode: updated.frameworkCode, frameworkVersion: updated.frameworkVersion },
    });
    return updated;
  }

  // =====================================================================
  // HSE-ADV-002 — risk matrix and assessments
  // =====================================================================

  async createMatrix(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      likelihoodScale: RiskScalePoint[];
      severityScale: RiskScalePoint[];
      cells: { likelihood: number; severity: number; bandCode: string; score: string }[];
    },
  ): Promise<HseRiskMatrix> {
    await this.rbac.requirePermission(actor, "hse.advanced.manage");
    const code = requireText(input.code, "code");
    const name = requireText(input.name, "name");

    const likelihood = normalizeScale(input.likelihoodScale, "likelihood");
    const severity = normalizeScale(input.severityScale, "severity");
    const cells = input.cells.map((c) => {
      if (!likelihood.some((p) => p.value === c.likelihood)) {
        throw new ValidationError(`Cell likelihood ${c.likelihood} is not on the likelihood scale`);
      }
      if (!severity.some((p) => p.value === c.severity)) {
        throw new ValidationError(`Cell severity ${c.severity} is not on the severity scale`);
      }
      return {
        likelihood: c.likelihood,
        severity: c.severity,
        bandCode: requireText(c.bandCode, "bandCode"),
        score: requireDecimal(c.score, "score", 2),
      };
    });

    // Every combination must resolve, otherwise a real assessment could find no
    // rating and the matrix would be decorative.
    for (const l of likelihood) {
      for (const s of severity) {
        if (!cells.some((c) => c.likelihood === l.value && c.severity === s.value)) {
          throw new ValidationError(
            `Matrix has no cell for likelihood ${l.value} × severity ${s.value}`,
          );
        }
      }
    }

    const matrix = await this.repo.createRiskMatrix({
      tenantId: actor.tenantId,
      code,
      name,
      likelihoodScale: likelihood,
      severityScale: severity,
      cells,
      createdBy: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.risk_matrix.created",
      entityType: "hse_risk_matrix",
      entityId: matrix.id,
      metadata: { code, cells: cells.length },
    });
    return matrix;
  }

  async getActiveMatrix(actor: ActorContext): Promise<HseRiskMatrix | null> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    return this.repo.findActiveRiskMatrix(actor.tenantId);
  }

  /**
   * Record a JSA/HIRA. The rating is resolved from the matrix and stored on the
   * assessment (ADR-0027 §3), so this is the only moment the matrix decides
   * anything — after this, the assessment owns its own numbers.
   */
  async createRiskAssessment(
    actor: ActorContext,
    input: {
      hseRecordId?: string | null;
      projectId?: string | null;
      assessmentType: RiskAssessmentType;
      title: string;
      taskDescription?: string | null;
      matrixId?: string;
      likelihood: number;
      severity: number;
      controls?: RiskControl[];
      residualLikelihood?: number | null;
      residualSeverity?: number | null;
    },
  ): Promise<HseRiskAssessment> {
    await this.rbac.requirePermission(actor, "hse.advanced.manage");

    if (!RISK_ASSESSMENT_TYPES.includes(input.assessmentType)) {
      throw new ValidationError(`Unknown assessment type '${input.assessmentType}'`);
    }
    if (!input.hseRecordId && !input.projectId) {
      throw new ValidationError(
        "A risk assessment must hang off an HSE record or a project — an assessment nobody can find is not a control",
      );
    }
    if (input.hseRecordId) await this.requireRecord(actor, input.hseRecordId);
    if (input.projectId && !(await this.repo.projectExists(actor.tenantId, input.projectId))) {
      throw new NotFoundError("Project", input.projectId);
    }

    const matrix = input.matrixId
      ? await this.repo.findRiskMatrixById(input.matrixId)
      : await this.repo.findActiveRiskMatrix(actor.tenantId);
    if (!matrix || matrix.tenantId !== actor.tenantId) {
      throw new NotFoundError("HseRiskMatrix", input.matrixId ?? "(active)");
    }

    const cell = await this.repo.riskMatrixCell(matrix.id, input.likelihood, input.severity);
    if (!cell) {
      throw new ValidationError(
        `Risk matrix '${matrix.code}' has no cell for likelihood ${input.likelihood} × severity ${input.severity}`,
      );
    }

    const residual = await this.resolveResidual(matrix.id, input);

    const assessment = await this.repo.createRiskAssessment({
      tenantId: actor.tenantId,
      hseRecordId: input.hseRecordId ?? null,
      projectId: input.projectId ?? null,
      assessmentType: input.assessmentType,
      title: requireText(input.title, "title"),
      taskDescription: clean(input.taskDescription),
      matrixId: matrix.id,
      likelihood: input.likelihood,
      severity: input.severity,
      bandCode: cell.bandCode,
      score: cell.score,
      controls: (input.controls ?? []).map(normalizeControl),
      ...residual,
      assessedByUserId: actor.userId,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.risk_assessment.created",
      entityType: "hse_risk_assessment",
      entityId: assessment.id,
      metadata: {
        assessmentType: assessment.assessmentType,
        matrixCode: matrix.code,
        bandCode: assessment.bandCode,
        residualBandCode: assessment.residualBandCode,
      },
    });
    return assessment;
  }

  async getRiskAssessment(actor: ActorContext, id: string): Promise<HseRiskAssessment> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    const assessment = await this.repo.findRiskAssessmentById(id);
    if (!assessment || assessment.tenantId !== actor.tenantId) {
      throw new NotFoundError("HseRiskAssessment", id);
    }
    if (assessment.hseRecordId) await this.requireRecord(actor, assessment.hseRecordId);
    return assessment;
  }

  async listRiskAssessments(
    actor: ActorContext,
    filter: { hseRecordId?: string; projectId?: string },
  ): Promise<HseRiskAssessment[]> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    return this.repo.listRiskAssessments(actor.tenantId, filter, await this.scopeOf(actor));
  }

  // =====================================================================
  // HSE-ADV-003 — Permit to Work
  // =====================================================================

  /**
   * Create a permit and hand its lifecycle to the Workflow Engine.
   *
   * If the tenant has not published `hse_permit_lifecycle` yet, the permit is
   * still created with no instance bound — a permit with no lifecycle is a
   * draft, and refusing to record it would lose the content. The Engine binds
   * on the next attempt. Nothing here ever writes a status.
   */
  async createPermit(
    actor: ActorContext,
    input: {
      permitTypeCode: string;
      title: string;
      description?: string | null;
      organizationUnitId?: string | null;
      projectId?: string | null;
      siteId?: string | null;
      locationDetail?: string | null;
      validFrom: string;
      validTo: string;
      isolationConditions?: PermitIsolationCondition[];
      riskAssessmentId?: string | null;
    },
  ): Promise<HsePermit> {
    await this.rbac.requirePermission(actor, "hse.permit.request");

    const validFrom = requireDate(input.validFrom, "validFrom");
    const validTo = requireDate(input.validTo, "validTo");
    if (validTo <= validFrom) {
      throw new ValidationError("validTo must be after validFrom");
    }

    if (input.organizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, input.organizationUnitId);
      if (!(await this.repo.organizationUnitExists(actor.tenantId, input.organizationUnitId))) {
        throw new NotFoundError("OrganizationUnit", input.organizationUnitId);
      }
    }
    if (input.projectId && !(await this.repo.projectExists(actor.tenantId, input.projectId))) {
      throw new NotFoundError("Project", input.projectId);
    }
    if (input.siteId && !(await this.repo.siteExists(actor.tenantId, input.siteId))) {
      throw new NotFoundError("Site", input.siteId);
    }
    if (input.riskAssessmentId) {
      const assessment = await this.repo.findRiskAssessmentById(input.riskAssessmentId);
      if (!assessment || assessment.tenantId !== actor.tenantId) {
        throw new NotFoundError("HseRiskAssessment", input.riskAssessmentId);
      }
    }

    const { number: permitNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      HSE_PERMIT_NUMBERING_CODE,
      actor.userId,
    );

    const permit = await this.repo.createPermit({
      tenantId: actor.tenantId,
      permitNumber,
      permitTypeCode: requireText(input.permitTypeCode, "permitTypeCode"),
      title: requireText(input.title, "title"),
      description: clean(input.description),
      organizationUnitId: input.organizationUnitId ?? null,
      projectId: input.projectId ?? null,
      siteId: input.siteId ?? null,
      locationDetail: clean(input.locationDetail),
      validFrom,
      validTo,
      isolationConditions: (input.isolationConditions ?? []).map(normalizeIsolation),
      riskAssessmentId: input.riskAssessmentId ?? null,
      requestedByUserId: actor.userId,
      createdBy: actor.userId,
    });

    await this.startPermitWorkflow(actor, permit);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.permit.created",
      entityType: "hse_permit",
      entityId: permit.id,
      metadata: { permitNumber, permitTypeCode: permit.permitTypeCode },
    });
    return permit;
  }

  async getPermit(actor: ActorContext, id: string): Promise<HsePermitDetailView> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    const permit = await this.requirePermit(actor, id);

    if (!permit.workflowInstanceId) {
      return { permit, status: null, availableActions: [] };
    }
    // The Engine is the only authority on state, so the view is read from it and
    // never from a local column (ADR-0027 §4).
    const [status, view] = await Promise.all([
      this.workflow.getEntityStatus(actor, permit.workflowInstanceId),
      this.workflow.getEntityWorkflowView(actor, permit.workflowInstanceId),
    ]);
    return {
      permit,
      status: {
        stepCode: status.stepCode ?? null,
        stepName: status.stepName ?? null,
        instanceStatus: status.instanceStatus,
      },
      availableActions: view.availableActions ?? [],
    };
  }

  async listPermits(actor: ActorContext): Promise<HsePermit[]> {
    await this.rbac.requirePermission(actor, "hse.advanced.read");
    return this.repo.listPermits(actor.tenantId, await this.scopeOf(actor));
  }

  /**
   * Edit permit content. Lifecycle is untouchable here: `validFrom`/`validTo`
   * and the isolation conditions are content the Engine's transitions read, not
   * a second state machine.
   */
  async updatePermit(
    actor: ActorContext,
    id: string,
    input: {
      permitTypeCode?: string;
      title?: string;
      description?: string | null;
      organizationUnitId?: string | null;
      projectId?: string | null;
      siteId?: string | null;
      locationDetail?: string | null;
      validFrom?: string;
      validTo?: string;
      isolationConditions?: PermitIsolationCondition[];
      riskAssessmentId?: string | null;
    },
  ): Promise<HsePermit> {
    await this.rbac.requirePermission(actor, "hse.advanced.manage");
    const existing = await this.requirePermit(actor, id);

    const validFrom = input.validFrom ? requireDate(input.validFrom, "validFrom") : undefined;
    const validTo = input.validTo ? requireDate(input.validTo, "validTo") : undefined;
    const from = validFrom ?? existing.validFrom;
    const to = validTo ?? existing.validTo;
    if (to <= from) {
      throw new ValidationError("validTo must be after validFrom");
    }

    if (input.organizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, input.organizationUnitId);
    }

    const updated = await this.repo.updatePermit(id, {
      permitTypeCode: input.permitTypeCode,
      title: input.title,
      description: input.description === undefined ? undefined : clean(input.description),
      organizationUnitId: input.organizationUnitId,
      projectId: input.projectId,
      siteId: input.siteId,
      locationDetail: input.locationDetail === undefined ? undefined : clean(input.locationDetail),
      validFrom,
      validTo,
      isolationConditions: input.isolationConditions?.map(normalizeIsolation),
      riskAssessmentId: input.riskAssessmentId,
      updatedBy: actor.userId,
    });
    if (!updated) throw new NotFoundError("HsePermit", id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.permit.updated",
      entityType: "hse_permit",
      entityId: id,
      metadata: { permitNumber: updated.permitNumber },
    });
    return updated;
  }

  /**
   * Advance the permit's Engine instance. The domain action is delegated whole:
   * this method decides who may act, and the Engine decides what the action
   * does. Nothing here interprets the action.
   */
  async actOnPermit(
    actor: ActorContext,
    id: string,
    input: { actionCode: string; comment?: string | null },
  ): Promise<HsePermitDetailView> {
    await this.rbac.requirePermission(actor, "hse.advanced.manage");
    const permit = await this.requirePermit(actor, id);
    if (!permit.workflowInstanceId) {
      throw new ConflictError(
        "This permit has no workflow instance — the lifecycle definition is not published for this tenant",
      );
    }
    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      permit.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("This permit has no pending workflow assignment to act on");
    }
    await this.workflow.actOnAssignment(
      actor,
      pending.id,
      requireText(input.actionCode, "actionCode"),
      clean(input.comment),
    );
    return this.getPermit(actor, id);
  }

  /** Retry binding the Engine instance for a permit created before publication. */
  async startPermitLifecycle(actor: ActorContext, id: string): Promise<HsePermit> {
    await this.rbac.requirePermission(actor, "hse.advanced.manage");
    const permit = await this.requirePermit(actor, id);
    if (permit.workflowInstanceId) {
      throw new ConflictError("This permit already has a workflow instance");
    }
    return this.startPermitWorkflow(actor, permit);
  }

  // =====================================================================
  // Internals
  // =====================================================================

  private async startPermitWorkflow(actor: ActorContext, permit: HsePermit): Promise<HsePermit> {
    let instanceId: string;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: HSE_PERMIT_WORKFLOW_DEFINITION_CODE,
        entityId: permit.id,
        // ADR-0012: the permit's owning Organization Unit (site-scoped read visibility).
        contextData: { organizationUnitId: permit.organizationUnitId },
      });
      instanceId = instance.id;
    } catch (err) {
      // Definitions are tenant configuration and may not exist or be published
      // yet — `startInstance` answers NotFoundError for the first and
      // ConflictError for the second. The permit content is worth keeping
      // regardless; `start-lifecycle` binds the Engine later.
      if (err instanceof ConflictError || err instanceof NotFoundError) {
        return permit;
      }
      throw err;
    }
    await this.repo.setPermitWorkflowInstance(permit.id, instanceId);
    return { ...permit, workflowInstanceId: instanceId };
  }

  /**
   * Residual rating, resolved from the same matrix so a residual cannot be
   * expressed on a scale the primary rating does not use. Both fields move
   * together — a half-recorded residual is a rating nobody can act on, which
   * the table's own constraint also enforces.
   */
  private async resolveResidual(
    matrixId: string,
    input: { residualLikelihood?: number | null; residualSeverity?: number | null },
  ): Promise<{
    residualLikelihood: number | null;
    residualSeverity: number | null;
    residualBandCode: string | null;
    residualScore: string | null;
  }> {
    const hasL = input.residualLikelihood !== undefined && input.residualLikelihood !== null;
    const hasS = input.residualSeverity !== undefined && input.residualSeverity !== null;
    if (!hasL && !hasS) {
      return {
        residualLikelihood: null,
        residualSeverity: null,
        residualBandCode: null,
        residualScore: null,
      };
    }
    if (hasL !== hasS) {
      throw new ValidationError(
        "Residual likelihood and residual severity must be supplied together",
      );
    }
    const cell = await this.repo.riskMatrixCell(
      matrixId,
      input.residualLikelihood as number,
      input.residualSeverity as number,
    );
    if (!cell) {
      throw new ValidationError(
        `Residual ${input.residualLikelihood} × ${input.residualSeverity} is not a cell of this matrix`,
      );
    }
    return {
      residualLikelihood: cell.likelihood,
      residualSeverity: cell.severity,
      residualBandCode: cell.bandCode,
      residualScore: cell.score,
    };
  }

  private async requireRecord(actor: ActorContext, id: string): Promise<CoreHseRecordRef> {
    const record = await this.repo.findCoreRecord(actor.tenantId, id);
    if (!record) throw new NotFoundError("HseRecord", id);
    // Core scope follows the record's own organization unit (Core HSE posture),
    // so Advanced inherits exactly the visibility Core already granted.
    if (record.organizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, record.organizationUnitId);
    } else if (!(await this.rbac.hasTenantScope(actor))) {
      throw new ForbiddenError(
        "Your Data Scope does not cover this HSE record (no organization unit set)",
      );
    }
    return record;
  }

  private async requireInvestigation(actor: ActorContext, id: string): Promise<HseInvestigation> {
    const investigation = await this.repo.findInvestigationById(id);
    if (!investigation || investigation.tenantId !== actor.tenantId) {
      throw new NotFoundError("HseInvestigation", id);
    }
    await this.requireRecord(actor, investigation.hseRecordId);
    return investigation;
  }

  private async requirePermit(actor: ActorContext, id: string): Promise<HsePermit> {
    const permit = await this.repo.findPermitById(id);
    if (!permit || permit.tenantId !== actor.tenantId) throw new NotFoundError("HsePermit", id);
    if (permit.organizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, permit.organizationUnitId);
    } else if (!(await this.rbac.hasTenantScope(actor))) {
      throw new ForbiddenError(
        "Your Data Scope does not cover this permit (no organization unit set)",
      );
    }
    return permit;
  }

  private async scopeOf(actor: ActorContext): Promise<string[] | null> {
    const scoped = await this.rbac.listScopedOrganizationUnitIds(actor);
    if (scoped !== null && scoped.length === 0) {
      throw new ForbiddenError("The active Role's Data Scope covers no Organization Unit");
    }
    return scoped;
  }
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function requireText(value: string | undefined | null, field: string): string {
  const text = (value ?? "").trim();
  if (!text) throw new ValidationError(`${field} is required`);
  return text;
}

function clean(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  return text ? text : null;
}

function requireDecimal(value: string, field: string, scale: number): string {
  const re = new RegExp(`^\\d{1,16}(\\.\\d{1,${scale}})?$`);
  const text = String(value ?? "").trim();
  if (!re.test(text)) throw new ValidationError(`${field} must be a non-negative decimal`);
  return text;
}

function requireDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${field} must be an ISO date`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} is not a valid date`);
  return date;
}

function normalizeScale(points: RiskScalePoint[], field: string): RiskScalePoint[] {
  if (!Array.isArray(points) || points.length === 0) {
    throw new ValidationError(`${field} scale must have at least one point`);
  }
  const seen = new Set<number>();
  return points.map((p) => {
    if (!Number.isInteger(p.value) || p.value <= 0) {
      throw new ValidationError(`${field} scale values must be positive integers`);
    }
    if (seen.has(p.value)) throw new ValidationError(`${field} scale repeats value ${p.value}`);
    seen.add(p.value);
    return { value: p.value, label: requireText(p.label, `${field} label`) };
  });
}

function normalizeFactor(factor: ContributingFactor): ContributingFactor {
  return {
    category: requireText(factor.category, "contributing factor category"),
    description: requireText(factor.description, "contributing factor description"),
    isRootCause: factor.isRootCause === true,
  };
}

function normalizeControl(control: RiskControl): RiskControl {
  return {
    description: requireText(control.description, "control description"),
    controlType: clean(control.controlType),
    residualLikelihood: control.residualLikelihood ?? null,
    residualSeverity: control.residualSeverity ?? null,
  };
}

function normalizeIsolation(condition: PermitIsolationCondition): PermitIsolationCondition {
  return {
    conditionType: requireText(condition.conditionType, "conditionType"),
    description: requireText(condition.description, "condition description"),
    verifiedAt: clean(condition.verifiedAt),
  };
}

/** Kept so the compiler proves the CAPA vocabulary is still the one exported. */
export const CAPA_ACTION_TYPE_SET = new Set(CAPA_ACTION_TYPES);
