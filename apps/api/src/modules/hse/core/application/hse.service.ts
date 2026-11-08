import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { EventBus } from "../../../../application/event/event-bus.js";
import type { ConfigurationService } from "../../../../application/configuration/configuration.service.js";
import type { WorkflowService } from "../../../../application/workflow/workflow.service.js";
import type {
  HseRecord,
  HseFollowUp,
  HsePersonInvolved,
  HseRecordListFilter,
  HseRecordType,
  HseRepository,
} from "../domain/hse.entity.js";
import { HSE_RECORD_TYPES } from "../domain/hse.entity.js";

/** Tenant Configuration codes this module expects. */
export const HSE_NUMBERING_CODE = "hse_record";
export const HSE_CATEGORY_REF_TYPE = "hse_category";
export const HSE_SEVERITY_REF_TYPE = "hse_severity";
export const HSE_WORKFLOW_DEFINITION_CODE = "hse_record_lifecycle";

/** Workflow action codes → domain event names. The Step graph is Tenant
 * Configuration; this only names the events emitted for known action codes. */
const ACTION_EVENT_MAP: Record<string, string> = {
  submit:  "hse.record.submitted",
  review:  "hse.record.reviewed",
  assign:  "hse.record.classified",
  close:   "hse.record.closed",
  cancel:  "hse.record.cancelled",
};

export interface HseRecordDetailView {
  record: HseRecord;
  personsInvolved: HsePersonInvolved[];
  followUps: HseFollowUp[];
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
}

/**
 * HSE Core (Phase 7, HSE-CORE-001…010).
 *
 * Answers: what incident or observation occurred, when and where, who reported
 * it, how is it classified, what evidence exists, what basic follow-up is
 * required, and what is its lifecycle state.
 *
 * Architectural constraints:
 * - **Capture and follow-up, not investigation.** No RCA, CAPA, risk matrix,
 *   investigation methodology, PTW, inspection, environmental monitoring,
 *   occupational health, or safety KPI. All of those are Advanced.
 * - **Workflow owns the lifecycle** (HSE-CORE-006); no status column and no
 *   second lifecycle engine. `startInstance` creates the Workflow instance;
 *   `actOnRecord` delegates to `actOnAssignment`.
 * - **Category and severity are Reference Data** — client terminology is
 *   configurable; no industry-specific taxonomy is hardcoded.
 * - **Evidence uses Document Core** (PC-9) with an entity authorization
 *   resolver (ADR-0012). No HSE-specific blob subsystem.
 * - **Follow-up is NOT CAPA** — simple action with owner + due date +
 *   completion. No root-cause linkage, no effectiveness verification.
 * - **No module-to-module coupling.** Workforce, Service Operations, Asset,
 *   Finance, and Complaint internals are never imported. Cross-domain
 *   references use clean port checks only.
 * - **No hard delete.** Safety records with operational history must remain
 *   readable (prompt §30).
 * - **No industry hardcode.** No mining, coal, catering, or sector-specific
 *   terminology in business logic.
 * - **Privacy.** Full incident narrative is NOT copied into domain event
 *   payloads or audit metadata (prompt §54/§77).
 */
export class HseService {
  constructor(
    private readonly repo: HseRepository,
    private readonly workflow: WorkflowService,
    private readonly configuration: ConfigurationService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly eventBus: EventBus,
  ) {}

  // ===================================================================
  // Record creation (HSE-CORE-001/002/008)
  // ===================================================================

  async reportRecord(
    actor: ActorContext,
    input: {
      recordType: string;
      categoryCode?: string | null;
      severityCode?: string | null;
      occurredAt: string;
      title: string;
      summary?: string | null;
      description?: string | null;
      immediateAction?: string | null;
      organizationUnitId?: string | null;
      projectId?: string | null;
      siteId?: string | null;
      locationDetail?: string | null;
      responsibleUserId?: string | null;
      responsibleOrgUnitId?: string | null;
    },
  ): Promise<HseRecord> {
    await this.rbac.requirePermission(actor, "hse.report");

    if (!HSE_RECORD_TYPES.includes(input.recordType as HseRecordType)) {
      throw new ValidationError(
        `record_type must be one of: ${HSE_RECORD_TYPES.join(", ")}`,
      );
    }

    const occurredAt = new Date(input.occurredAt);
    if (isNaN(occurredAt.getTime())) {
      throw new ValidationError("occurred_at must be a valid ISO timestamp");
    }

    // Validate cross-domain references (clean port checks — no module imports)
    if (input.organizationUnitId) {
      if (!(await this.repo.organizationUnitExists(actor.tenantId, input.organizationUnitId))) {
        throw new NotFoundError("OrganizationUnit", input.organizationUnitId);
      }
    }
    if (input.projectId) {
      if (!(await this.repo.projectExists(actor.tenantId, input.projectId))) {
        throw new NotFoundError("Project", input.projectId);
      }
    }
    if (input.siteId) {
      if (!(await this.repo.siteExists(actor.tenantId, input.siteId))) {
        throw new NotFoundError("Site", input.siteId);
      }
    }
    if (input.responsibleUserId) {
      if (!(await this.repo.userExists(actor.tenantId, input.responsibleUserId))) {
        throw new NotFoundError("User", input.responsibleUserId);
      }
    }
    if (input.responsibleOrgUnitId) {
      if (
        !(await this.repo.organizationUnitExists(actor.tenantId, input.responsibleOrgUnitId))
      ) {
        throw new NotFoundError("OrganizationUnit", input.responsibleOrgUnitId);
      }
    }

    // Business number (HSE-CORE-008) via Numbering Core
    const { number: recordNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      HSE_NUMBERING_CODE,
      actor.userId,
    );

    const record = await this.repo.createRecord({
      tenantId: actor.tenantId,
      recordNumber,
      recordType: input.recordType as HseRecordType,
      categoryCode: input.categoryCode ?? null,
      severityCode: input.severityCode ?? null,
      occurredAt,
      title: input.title.trim(),
      summary: input.summary?.trim() ?? null,
      description: input.description?.trim() ?? null,
      immediateAction: input.immediateAction?.trim() ?? null,
      organizationUnitId: input.organizationUnitId ?? null,
      projectId: input.projectId ?? null,
      siteId: input.siteId ?? null,
      locationDetail: input.locationDetail?.trim() ?? null,
      reportedByUserId: actor.userId,
      responsibleUserId: input.responsibleUserId ?? null,
      responsibleOrgUnitId: input.responsibleOrgUnitId ?? null,
      createdBy: actor.userId,
    });

    // Domain event — full narrative NOT included (prompt §54/§77 privacy)
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "hse.record.created",
      entityType: "hse_record",
      entityId: record.id,
      payload: { recordNumber: record.recordNumber, recordType: record.recordType },
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.record.created",
      entityType: "hse_record",
      entityId: record.id,
      metadata: { recordNumber: record.recordNumber, recordType: record.recordType },
    });

    return record;
  }

  // ===================================================================
  // Read (HSE-CORE-009/010)
  // ===================================================================

  async getRecord(actor: ActorContext, id: string): Promise<HseRecordDetailView> {
    await this.rbac.requirePermission(actor, "hse.read");

    const record = await this.repo.findRecordById(id);
    if (!record) throw new NotFoundError("HseRecord", id);
    if (record.tenantId !== actor.tenantId) throw new ForbiddenError("Access denied");

    // Data Scope: the reporter always retains read access to their own record
    if (record.reportedByUserId !== actor.userId) {
      await this.requireHseScope(actor, record);
    }

    const [personsInvolved, followUps] = await Promise.all([
      this.repo.listPersonsInvolved(id),
      this.repo.listFollowUps(id),
    ]);

    let status: HseRecordDetailView["status"] = null;
    let availableActions: HseRecordDetailView["availableActions"] = [];
    if (record.workflowInstanceId) {
      const s = await this.workflow.getEntityStatus(actor, record.workflowInstanceId);
      status = { stepCode: s.stepCode, stepName: s.stepName, instanceStatus: s.instanceStatus };
      const view = await this.workflow.getEntityWorkflowView(actor, record.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }

    return { record, personsInvolved, followUps, status, availableActions };
  }

  async listRecords(
    actor: ActorContext,
    filter: HseRecordListFilter,
  ): Promise<HseRecord[]> {
    await this.rbac.requirePermission(actor, "hse.read");

    const orgUnitIds = await this.resolveOrgUnitScope(actor);
    return this.repo.listRecords(actor.tenantId, filter, orgUnitIds);
  }

  // ===================================================================
  // Update (HSE-CORE-001/002)
  // ===================================================================

  async updateRecord(
    actor: ActorContext,
    id: string,
    input: {
      categoryCode?: string | null;
      severityCode?: string | null;
      occurredAt?: string;
      title?: string;
      summary?: string | null;
      description?: string | null;
      immediateAction?: string | null;
      organizationUnitId?: string | null;
      projectId?: string | null;
      siteId?: string | null;
      locationDetail?: string | null;
      responsibleUserId?: string | null;
      responsibleOrgUnitId?: string | null;
    },
  ): Promise<HseRecord> {
    await this.rbac.requirePermission(actor, "hse.manage");

    const record = await this.repo.findRecordById(id);
    if (!record) throw new NotFoundError("HseRecord", id);
    if (record.tenantId !== actor.tenantId) throw new ForbiddenError("Access denied");
    await this.requireHseScope(actor, record);

    if (input.organizationUnitId !== undefined && input.organizationUnitId) {
      if (!(await this.repo.organizationUnitExists(actor.tenantId, input.organizationUnitId))) {
        throw new NotFoundError("OrganizationUnit", input.organizationUnitId);
      }
    }
    if (input.projectId !== undefined && input.projectId) {
      if (!(await this.repo.projectExists(actor.tenantId, input.projectId))) {
        throw new NotFoundError("Project", input.projectId);
      }
    }
    if (input.siteId !== undefined && input.siteId) {
      if (!(await this.repo.siteExists(actor.tenantId, input.siteId))) {
        throw new NotFoundError("Site", input.siteId);
      }
    }
    if (input.responsibleUserId !== undefined && input.responsibleUserId) {
      if (!(await this.repo.userExists(actor.tenantId, input.responsibleUserId))) {
        throw new NotFoundError("User", input.responsibleUserId);
      }
    }

    let occurredAt: Date | undefined;
    if (input.occurredAt !== undefined) {
      occurredAt = new Date(input.occurredAt);
      if (isNaN(occurredAt.getTime())) {
        throw new ValidationError("occurred_at must be a valid ISO timestamp");
      }
    }

    const updated = await this.repo.updateRecord(id, {
      categoryCode: input.categoryCode,
      severityCode: input.severityCode,
      occurredAt,
      title: input.title?.trim(),
      summary: input.summary !== undefined ? (input.summary?.trim() ?? null) : undefined,
      description:
        input.description !== undefined ? (input.description?.trim() ?? null) : undefined,
      immediateAction:
        input.immediateAction !== undefined
          ? (input.immediateAction?.trim() ?? null)
          : undefined,
      organizationUnitId: input.organizationUnitId,
      projectId: input.projectId,
      siteId: input.siteId,
      locationDetail:
        input.locationDetail !== undefined ? (input.locationDetail?.trim() ?? null) : undefined,
      responsibleUserId: input.responsibleUserId,
      responsibleOrgUnitId: input.responsibleOrgUnitId,
      updatedBy: actor.userId,
    });
    if (!updated) throw new NotFoundError("HseRecord", id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.record.updated",
      entityType: "hse_record",
      entityId: id,
      metadata: { recordNumber: record.recordNumber },
    });

    return updated;
  }

  // ===================================================================
  // Workflow lifecycle (HSE-CORE-006)
  // ===================================================================

  /**
   * Start the configured Workflow lifecycle for an HSE record.
   * The Workflow Definition `hse_record_lifecycle` must be configured
   * by the tenant (Tenant Configuration). hse.manage permission required.
   */
  async startLifecycle(actor: ActorContext, id: string): Promise<HseRecord> {
    await this.rbac.requirePermission(actor, "hse.manage");

    const record = await this.repo.findRecordById(id);
    if (!record) throw new NotFoundError("HseRecord", id);
    if (record.tenantId !== actor.tenantId) throw new ForbiddenError("Access denied");
    if (record.workflowInstanceId) {
      throw new ConflictError("HSE record lifecycle has already been started");
    }
    await this.requireHseScope(actor, record);

    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: HSE_WORKFLOW_DEFINITION_CODE,
      entityId: id,
      // ADR-0012: the record's owning Organization Unit (site-scoped read visibility).
      contextData: { organizationUnitId: record.organizationUnitId },
    });

    await this.repo.setRecordWorkflowInstance(id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.record.lifecycle.started",
      entityType: "hse_record",
      entityId: id,
      metadata: { workflowInstanceId: instance.id },
    });

    return (await this.repo.findRecordById(id))!;
  }

  /**
   * Advance the HSE record lifecycle. Delegates entirely to the Workflow
   * Engine (HSE-CORE-006). The action code must be valid for the current
   * Workflow step — the Engine validates this.
   */
  async actOnRecord(
    actor: ActorContext,
    id: string,
    actionCode: string,
    comment: string | null,
  ): Promise<HseRecord> {
    const closingActions = ["close", "cancel"];
    const requiredPerm = closingActions.includes(actionCode) ? "hse.close" : "hse.manage";
    await this.rbac.requirePermission(actor, requiredPerm);

    const record = await this.repo.findRecordById(id);
    if (!record) throw new NotFoundError("HseRecord", id);
    if (record.tenantId !== actor.tenantId) throw new ForbiddenError("Access denied");
    if (!record.workflowInstanceId) {
      throw new ValidationError("HSE record lifecycle has not been started yet");
    }
    await this.requireHseScope(actor, record);

    // Resolve the pending Workflow Assignment (same pattern as Finance/Asset)
    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      record.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this record");

    await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    const eventType = ACTION_EVENT_MAP[actionCode] ?? `hse.record.action.${actionCode}`;
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType,
      entityType: "hse_record",
      entityId: id,
      payload: { recordNumber: record.recordNumber, actionCode },
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: eventType,
      entityType: "hse_record",
      entityId: id,
      metadata: { actionCode, recordNumber: record.recordNumber },
    });

    return (await this.repo.findRecordById(id))!;
  }

  // ===================================================================
  // Persons involved (HSE-CORE-004)
  // ===================================================================

  async addPersonInvolved(
    actor: ActorContext,
    hseRecordId: string,
    input: {
      employeeId?: string | null;
      personName?: string | null;
      personRole?: string | null;
    },
  ): Promise<HsePersonInvolved> {
    await this.rbac.requirePermission(actor, "hse.manage");

    const record = await this.repo.findRecordById(hseRecordId);
    if (!record) throw new NotFoundError("HseRecord", hseRecordId);
    if (record.tenantId !== actor.tenantId) throw new ForbiddenError("Access denied");
    await this.requireHseScope(actor, record);

    if (!input.employeeId && !input.personName) {
      throw new ValidationError("Either employeeId or personName is required");
    }
    if (input.employeeId) {
      if (!(await this.repo.employeeExists(actor.tenantId, input.employeeId))) {
        throw new NotFoundError("Employee", input.employeeId);
      }
    }

    return this.repo.addPersonInvolved(hseRecordId, {
      employeeId: input.employeeId ?? null,
      personName: input.personName?.trim() ?? null,
      personRole: input.personRole?.trim() ?? null,
    });
  }

  // ===================================================================
  // Follow-up (HSE-CORE-007)
  // ===================================================================

  async createFollowUp(
    actor: ActorContext,
    hseRecordId: string,
    input: {
      title: string;
      description?: string | null;
      assignedToUserId?: string | null;
      assignedToOrgUnitId?: string | null;
      dueDate?: string | null;
    },
  ): Promise<HseFollowUp> {
    await this.rbac.requirePermission(actor, "hse.manage");

    const record = await this.repo.findRecordById(hseRecordId);
    if (!record) throw new NotFoundError("HseRecord", hseRecordId);
    if (record.tenantId !== actor.tenantId) throw new ForbiddenError("Access denied");
    await this.requireHseScope(actor, record);

    if (!input.title?.trim()) throw new ValidationError("Follow-up title is required");

    if (input.assignedToUserId) {
      if (!(await this.repo.userExists(actor.tenantId, input.assignedToUserId))) {
        throw new NotFoundError("User", input.assignedToUserId);
      }
    }
    if (input.assignedToOrgUnitId) {
      if (
        !(await this.repo.organizationUnitExists(actor.tenantId, input.assignedToOrgUnitId))
      ) {
        throw new NotFoundError("OrganizationUnit", input.assignedToOrgUnitId);
      }
    }
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
      throw new ValidationError("due_date must be YYYY-MM-DD");
    }

    const followUp = await this.repo.createFollowUp({
      tenantId: actor.tenantId,
      hseRecordId,
      title: input.title.trim(),
      description: input.description?.trim() ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
      assignedToOrgUnitId: input.assignedToOrgUnitId ?? null,
      dueDate: input.dueDate ?? null,
      createdBy: actor.userId,
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "hse.follow_up.assigned",
      entityType: "hse_record",
      entityId: hseRecordId,
      payload: { followUpId: followUp.id, title: followUp.title },
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.follow_up.created",
      entityType: "hse_record",
      entityId: hseRecordId,
      metadata: { followUpId: followUp.id },
    });

    return followUp;
  }

  async completeFollowUp(
    actor: ActorContext,
    hseRecordId: string,
    followUpId: string,
    completionNotes: string | null,
  ): Promise<HseFollowUp> {
    // hse.read holders + hse.manage holders can complete.
    // The assignee can complete their own follow-up with hse.read.
    const permissions = await this.rbac.getActivePermissions(actor);
    const hasManage = permissions.has("hse.manage");
    const hasRead = permissions.has("hse.read");
    if (!hasManage && !hasRead) throw new ForbiddenError("hse.read permission required");

    const record = await this.repo.findRecordById(hseRecordId);
    if (!record) throw new NotFoundError("HseRecord", hseRecordId);
    if (record.tenantId !== actor.tenantId) throw new ForbiddenError("Access denied");

    const followUp = await this.repo.findFollowUpById(followUpId);
    if (!followUp) throw new NotFoundError("HseFollowUp", followUpId);
    if (followUp.hseRecordId !== hseRecordId) throw new ForbiddenError("Access denied");

    // Scoped actors: must be the assignee OR have hse.manage
    if (!hasManage && followUp.assignedToUserId !== actor.userId) {
      throw new ForbiddenError("Not authorised to complete this follow-up");
    }

    // Idempotent: if already completed, return unchanged
    if (followUp.completedAt) return followUp;

    const completed = await this.repo.completeFollowUp(followUpId, {
      completionNotes: completionNotes?.trim() ?? null,
      completedBy: actor.userId,
    });
    if (!completed) throw new NotFoundError("HseFollowUp", followUpId);

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "hse.follow_up.completed",
      entityType: "hse_record",
      entityId: hseRecordId,
      payload: { followUpId },
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "hse.follow_up.completed",
      entityType: "hse_record",
      entityId: hseRecordId,
      metadata: { followUpId },
    });

    return completed;
  }

  // ===================================================================
  // Document authorization (ADR-0012, HSE-CORE-005/009)
  // ===================================================================

  /**
   * Entity Authorization Resolver for HSE evidence documents.
   * Called by DocumentService when entityType === 'hse_record' (ADR-0012).
   *
   * Access requires: tenant match + (hse.documents.read OR hse.manage) +
   * Data Scope coverage OR reporter self-access.
   *
   * `hse.read` alone is NOT sufficient for evidence — consistent with
   * `workforce.documents.read` / `finance.documents.read` pattern (prompt §19/§20).
   */
  async canAccessForDocument(actor: ActorContext, hseRecordId: string): Promise<boolean> {
    const record = await this.repo.findRecordById(hseRecordId);
    if (!record || record.tenantId !== actor.tenantId) return false;

    // Epic 1 (§4.1 C) — enforcement reads the ACTIVE Role, never the union.
    const permissions = await this.rbac.getActivePermissions(actor);
    if (!permissions.has("hse.documents.read") && !permissions.has("hse.manage")) return false;

    // Reporter retains access to their own record's evidence (prompt §34)
    if (record.reportedByUserId === actor.userId) return true;

    if (!record.organizationUnitId) {
      return this.rbac.hasTenantScope(actor);
    }

    return this.rbac.isActiveOrganizationUnitScopeCovered(
      actor,
      record.organizationUnitId,
    );
  }

  // ===================================================================
  // Private helpers
  // ===================================================================

  /**
   * Enforce Data Scope for an HSE record. The record's organizationUnitId
   * is the anchor (hierarchical, ADR-0009). Records with no org unit are
   * accessible to tenant-wide actors only.
   */
  private async requireHseScope(
    actor: ActorContext,
    record: { organizationUnitId: string | null },
  ): Promise<void> {
    if (!record.organizationUnitId) {
      // No anchor — require tenant-wide scope
      const tenantWide = await this.rbac.hasTenantScope(actor);
      if (!tenantWide) {
        throw new ForbiddenError(
          "Your Data Scope does not cover this HSE record (no organization unit set)",
        );
      }
      return;
    }
    await this.rbac.requireOrganizationUnitScopeForActor(actor, record.organizationUnitId);
  }

  /**
   * Resolve org-unit IDs reachable by the actor for list filtering.
   * Returns null for tenant-wide actors (no filter applied).
   */
  private async resolveOrgUnitScope(actor: ActorContext): Promise<string[] | null> {
    const tenantWide = await this.rbac.hasTenantScope(actor);
    if (tenantWide) return null;
    const assignments = await this.rbac.getAssignments(actor.userId);
    const ids = assignments
      .filter((a) => a.scopeType === "organization_unit" && a.scopeOrganizationUnitId)
      .map((a) => a.scopeOrganizationUnitId as string);
    return ids.length > 0 ? ids : [];
  }
}
