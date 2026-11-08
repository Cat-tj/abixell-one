import type { AuditService } from "../audit/audit.service.js";
import type { ActiveOrganizationUnitCoverage, RbacService } from "../rbac/rbac.service.js";
import type { EventBus } from "../event/event-bus.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../domain/shared-kernel/errors.js";
import type {
  ConditionExpression,
  OrganizationUnitStrategy,
  SpecificUserSource,
  WorkflowAssignmentType,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowInstanceAssignment,
  WorkflowInstanceStatus,
  WorkflowRepository,
  WorkflowStepType,
  WorkflowTerminalStatus,
  WorkflowVersion,
} from "../../domain/workflow/workflow.entity.js";
import { evaluateCondition } from "./condition-evaluator.js";
import type { ApprovalAuthorityService } from "../../domain/rbac/approval-authority.service.js";
import {
  MissingConversionRateError,
  type ApprovalDecision,
} from "../../domain/rbac/approval-authority.entity.js";

/**
 * Checkpoint 1C.2 — generic, read-only projections a business module
 * exposes to its own authorized entity owner (e.g. a Customer reading
 * their own Complaint). All are computed live from the existing authoritative
 * Workflow tables — no denormalized store, no materialized view, no CQRS
 * (FD-1C-01). `entityType`-agnostic, same posture as the rest of this class.
 */
export interface EntityWorkflowStatus {
  stepCode: string | null;
  stepName: string | null;
  instanceStatus: WorkflowInstanceStatus;
  /** SLA state derived from the pending Assignment's due date + the current
   * Step's configured SLA hours — the authoritative source, never a
   * frontend recomputation. */
  sla: { dueAt: Date | null; slaHours: number | null } | null;
  /** Current pending Assignment summary (Checkpoint 1C.3) — who the task is
   * routed to, and whether the asking actor is eligible to act on it now
   * (`isMine`). Null when there is no pending Assignment (e.g. completed). */
  assignment: { roleCode: string | null; userId: string | null; isMine: boolean } | null;
}

export interface EntityWorkflowStatusByInstance extends EntityWorkflowStatus {
  instanceId: string;
}

export interface EntityWorkflowTimelineEntry {
  occurredAt: Date;
  actionCode: string;
  fromStepCode: string | null;
  fromStepName: string | null;
  toStepCode: string | null;
  toStepName: string | null;
  actorUserId: string | null;
  comment: string | null;
}

export interface EntityWorkflowAction {
  actionCode: string;
  name: string;
  toStepCode: string;
}

export interface EntityWorkflowView {
  instanceStatus: WorkflowInstanceStatus;
  currentStep: { code: string; name: string } | null;
  sla: { dueAt: Date | null; slaHours: number | null } | null;
  /** Transitions the actor is actually eligible to take from the current
   * Step right now (Role+Scope / specific_user match, Condition satisfied)
   * — lets the UI render actions from workflow state instead of hardcoding
   * lifecycle rules (guard: no `if status===X show button Y`). */
  availableActions: EntityWorkflowAction[];
  timeline: EntityWorkflowTimelineEntry[];
  /** Non-terminal Steps of this Instance's Version — the valid reopen
   * targets a business module can offer (it decides who may reopen). */
  nonTerminalSteps: { code: string; name: string }[];
}

/** Checkpoint 1C.6 — read-only definition view for an admin config surface. */
export interface EntityWorkflowDefinitionView {
  definition: { code: string; name: string; entityType: string; isActive: boolean };
  versionNumber: number | null;
  versionStatus: string | null;
  steps: {
    code: string;
    name: string;
    stepType: string;
    isInitial: boolean;
    isTerminal: boolean;
    terminalStatus: string | null;
    slaHours: number | null;
    transitions: { actionCode: string; name: string; toStepCode: string | null; condition: ConditionExpression | null }[];
    assignmentRules: {
      assignmentType: string;
      roleCode: string | null;
      organizationUnitStrategy: string | null;
      specificUserSource: string | null;
      condition: ConditionExpression | null;
    }[];
  }[];
}

/** ADR-0008: how long an opt-in claim (see `claimAssignment`) blocks
 * other eligible users from acting, before it auto-expires and the task
 * reverts to plain first-decision-wins. 15 minutes — long enough to
 * cover reading + deciding on one task, short enough that an actor who
 * closes their browser mid-review doesn't strand the task. Not yet
 * Tenant Configuration (see docs/decision-log.md open items). */
const CLAIM_TTL_SECONDS = 15 * 60;

/** Epic 1 (§4.1 D): the document amount an approve decision carries into
 * `workflow_history.decision_amount`, read from the instance's caller-
 * supplied `contextData`. The three keys are the conventions the existing
 * document workflows already write (`sales`: `totalAmount`, `complaint`:
 * `approvedAmount`) plus a plain `amount` fallback for any future caller.
 * Only a well-formed decimal string is accepted — a malformed value must
 * yield NULL, not a failed INSERT or a silently wrong sum. A document with
 * no amount configured (no key present) yields NULL, and the accumulation
 * step is then effectively a no-op for it. */
function documentAmountOf(instance: { contextData: Record<string, unknown> }): string | null {
  for (const key of ["approvedAmount", "totalAmount", "amount"]) {
    const raw = instance.contextData[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw.toFixed(2);
    if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) return raw.trim();
  }
  return null;
}

/**
 * Application-layer orchestration for the Workflow & Approval Engine
 * (Checkpoint 0D), per 04-Workflow-Approval-Engine-Foundation.md.
 *
 * Two halves:
 *  - Design-time: authoring a Workflow Definition/Version/Step/
 *    Transition/Assignment Rule/Escalation Rule, then publishing a
 *    version. Gated by `workflow.definition.manage`/`.read`.
 *  - Runtime: starting a Workflow Instance against a generic object,
 *    resolving Assignment (Condition-driven dynamic routing), acting on
 *    an Assignment (Approve/Reject/Return/Resubmit), and the Escalation
 *    sweep. Gated by `workflow.instance.*`.
 *
 * Every mutating operation calls AuditService (cross-cutting Audit Trail,
 * per doc 02/06) IN ADDITION to `workflow_history` (the domain-specific
 * full journey of one instance, per doc 04's "History" component) — the
 * two serve different audiences: Audit Trail is "what changed, who did
 * it, when", workflow_history is "how did this specific transaction get
 * from Submit to Complete".
 */
interface InstanceVisibility {
  coverage: ActiveOrganizationUnitCoverage;
  associatedInstanceIds: Set<string>;
  customerId: string | null;
  isVisible(instance: WorkflowInstance): boolean;
}

export class WorkflowService {
  constructor(
    private readonly repo: WorkflowRepository,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    /** Optional so 0D's existing integration test setup (constructed
     * without an EventBus) keeps compiling — Checkpoint 0E additive
     * dependency, not a breaking one. When absent, Event Foundation /
     * Notification dispatch is simply skipped; `workflow_notification_hooks`
     * (0D) still records every hook point regardless. */
    private readonly eventBus?: EventBus,
    /** WP-APR-01 — optional approval authority resolver (DEC-002/005). When
     * absent, assignment routing keeps its original role/specific_user
     * behavior; when present, a role-typed Step on a document with an amount
     * is routed through the ceiling resolver instead. */
    private readonly approvalAuthority?: ApprovalAuthorityService,
  ) {}

  // ======================================================================
  // Design-time
  // ======================================================================

  async createDefinition(
    actor: ActorContext,
    input: { code: string; name: string; entityType: string; description: string },
  ) {
    await this.rbac.requirePermission(actor, "workflow.definition.manage");
    const definition = await this.repo.createDefinition({
      tenantId: actor.tenantId,
      code: input.code,
      name: input.name,
      entityType: input.entityType,
      description: input.description,
      createdBy: actor.userId,
    });
    const version = await this.repo.createVersion({
      workflowDefinitionId: definition.id,
      versionNumber: 1,
      createdBy: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workflow.definition.created",
      entityType: "workflow_definition",
      entityId: definition.id,
      metadata: { code: definition.code, initialVersion: version.versionNumber },
    });
    return { definition, version };
  }

  async listDefinitions(actor: ActorContext): Promise<WorkflowDefinition[]> {
    await this.rbac.requirePermission(actor, "workflow.definition.read");
    return this.repo.listDefinitions(actor.tenantId);
  }

  async createVersion(actor: ActorContext, definitionCode: string) {
    await this.rbac.requirePermission(actor, "workflow.definition.manage");
    const definition = await this.getDefinitionOrThrow(actor.tenantId, definitionCode);
    const nextVersionNumber = await this.repo.getNextVersionNumber(definition.id);
    const version = await this.repo.createVersion({
      workflowDefinitionId: definition.id,
      versionNumber: nextVersionNumber,
      createdBy: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workflow.version.created",
      entityType: "workflow_version",
      entityId: version.id,
      metadata: { definitionCode, versionNumber: version.versionNumber },
    });
    return version;
  }

  async listVersions(actor: ActorContext, definitionCode: string): Promise<WorkflowVersion[]> {
    await this.rbac.requirePermission(actor, "workflow.definition.read");
    const definition = await this.getDefinitionOrThrow(actor.tenantId, definitionCode);
    return this.repo.listVersions(definition.id);
  }

  async addStep(
    actor: ActorContext,
    definitionCode: string,
    versionNumber: number,
    input: {
      code: string;
      name: string;
      stepType: WorkflowStepType;
      isInitial?: boolean;
      isTerminal?: boolean;
      terminalStatus?: WorkflowTerminalStatus | null;
      slaHours?: number | null;
      sequenceOrder?: number;
    },
  ) {
    await this.rbac.requirePermission(actor, "workflow.definition.manage");
    const version = await this.getEditableVersionOrThrow(actor.tenantId, definitionCode, versionNumber);
    return this.repo.createStep({
      workflowVersionId: version.id,
      code: input.code,
      name: input.name,
      stepType: input.stepType,
      isInitial: input.isInitial ?? false,
      isTerminal: input.isTerminal ?? false,
      terminalStatus: input.terminalStatus ?? null,
      slaHours: input.slaHours ?? null,
      sequenceOrder: input.sequenceOrder ?? 0,
    });
  }

  async addTransition(
    actor: ActorContext,
    definitionCode: string,
    versionNumber: number,
    input: {
      fromStepCode: string;
      toStepCode: string;
      actionCode: string;
      name: string;
      conditionExpression?: ConditionExpression | null;
      sortOrder?: number;
    },
  ) {
    await this.rbac.requirePermission(actor, "workflow.definition.manage");
    const version = await this.getEditableVersionOrThrow(actor.tenantId, definitionCode, versionNumber);
    const fromStep = await this.repo.findStepByCode(version.id, input.fromStepCode);
    const toStep = await this.repo.findStepByCode(version.id, input.toStepCode);
    if (!fromStep) throw new NotFoundError("WorkflowStep", input.fromStepCode);
    if (!toStep) throw new NotFoundError("WorkflowStep", input.toStepCode);
    return this.repo.createTransition({
      workflowVersionId: version.id,
      fromStepId: fromStep.id,
      toStepId: toStep.id,
      actionCode: input.actionCode,
      name: input.name,
      conditionExpression: input.conditionExpression ?? null,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  async addAssignmentRule(
    actor: ActorContext,
    definitionCode: string,
    versionNumber: number,
    input: {
      stepCode: string;
      assignmentType: WorkflowAssignmentType;
      roleCode?: string | null;
      organizationUnitStrategy?: OrganizationUnitStrategy | null;
      specificUserSource?: SpecificUserSource | null;
      fixedUserId?: string | null;
      conditionExpression?: ConditionExpression | null;
      sortOrder?: number;
    },
  ) {
    await this.rbac.requirePermission(actor, "workflow.definition.manage");
    const version = await this.getEditableVersionOrThrow(actor.tenantId, definitionCode, versionNumber);
    const step = await this.repo.findStepByCode(version.id, input.stepCode);
    if (!step) throw new NotFoundError("WorkflowStep", input.stepCode);
    if (input.assignmentType === "role" && !input.roleCode) {
      throw new ValidationError("roleCode is required when assignmentType is 'role'");
    }
    if (input.assignmentType === "specific_user" && !input.specificUserSource) {
      throw new ValidationError("specificUserSource is required when assignmentType is 'specific_user'");
    }
    return this.repo.createAssignmentRule({
      workflowStepId: step.id,
      sortOrder: input.sortOrder ?? 0,
      conditionExpression: input.conditionExpression ?? null,
      assignmentType: input.assignmentType,
      roleCode: input.roleCode ?? null,
      organizationUnitStrategy: input.organizationUnitStrategy ?? null,
      specificUserSource: input.specificUserSource ?? null,
      fixedUserId: input.fixedUserId ?? null,
    });
  }

  async addEscalationRule(
    actor: ActorContext,
    definitionCode: string,
    versionNumber: number,
    input: {
      stepCode: string;
      escalateAfterHours: number;
      escalateToRoleCode: string;
      escalateToOrganizationUnitStrategy?: OrganizationUnitStrategy;
      note?: string | null;
    },
  ) {
    await this.rbac.requirePermission(actor, "workflow.definition.manage");
    const version = await this.getEditableVersionOrThrow(actor.tenantId, definitionCode, versionNumber);
    const step = await this.repo.findStepByCode(version.id, input.stepCode);
    if (!step) throw new NotFoundError("WorkflowStep", input.stepCode);
    return this.repo.createEscalationRule({
      workflowStepId: step.id,
      escalateAfterHours: input.escalateAfterHours,
      escalateToRoleCode: input.escalateToRoleCode,
      escalateToOrganizationUnitStrategy: input.escalateToOrganizationUnitStrategy ?? "tenant",
      note: input.note ?? null,
    });
  }

  async publishVersion(actor: ActorContext, definitionCode: string, versionNumber: number) {
    await this.rbac.requirePermission(actor, "workflow.definition.manage");
    const definition = await this.getDefinitionOrThrow(actor.tenantId, definitionCode);
    const version = await this.repo.findVersion(definition.id, versionNumber);
    if (!version) throw new NotFoundError("WorkflowVersion", String(versionNumber));
    if (version.status !== "draft") {
      throw new ConflictError(`Workflow Version ${versionNumber} is already '${version.status}', not 'draft'`);
    }

    const steps = await this.repo.listSteps(version.id);
    const problems: string[] = [];
    const initialSteps = steps.filter((s) => s.isInitial);
    if (initialSteps.length !== 1) {
      problems.push(`Version must have exactly one initial Step (found ${initialSteps.length})`);
    }
    const terminalSteps = steps.filter((s) => s.isTerminal);
    if (terminalSteps.length === 0) {
      problems.push("Version must have at least one terminal Step");
    }
    for (const step of steps) {
      if (step.isTerminal) continue;
      const transitions = await this.repo.listTransitionsFromStep(step.id);
      if (transitions.length === 0) {
        problems.push(`Step '${step.code}' is non-terminal but has no outgoing Transition`);
      }
      const rules = await this.repo.listAssignmentRules(step.id);
      if (rules.length === 0) {
        problems.push(`Step '${step.code}' is non-terminal but has no Assignment Rule`);
      }
    }
    if (problems.length > 0) {
      throw new ValidationError("Workflow Version failed publish validation", problems);
    }

    const published = await this.repo.publishVersion(version.id);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workflow.version.published",
      entityType: "workflow_version",
      entityId: published.id,
      metadata: { definitionCode, versionNumber: published.versionNumber },
    });
    return published;
  }

  // ======================================================================
  // Runtime — generic dummy object, engine proof only
  // ======================================================================

  async createDemoTransaction(actor: ActorContext, title: string) {
    await this.rbac.requirePermission(actor, "workflow.instance.start");
    const tx = await this.repo.createDemoTransaction({
      tenantId: actor.tenantId,
      title,
      createdBy: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workflow.demo_transaction.created",
      entityType: "demo_transaction",
      entityId: tx.id,
      metadata: { title },
    });
    return tx;
  }

  /**
   * HTTP entry point (`POST /workflow/instances`). `contextData` is
   * caller-supplied here and now drives read visibility
   * (`organizationUnitId` / `legalEntityId` / `customerId`), so for a
   * non-tenant-scoped actor each such stamp must lie inside the actor's ACTIVE
   * Data Scope; otherwise a scoped actor could plant an Instance into another
   * site's queue. Internal business modules call `startInstance` directly
   * (trusted callers deriving the stamps from the parent entity, ADR-0012) and
   * are not subject to this check.
   */
  async startInstanceFromRequest(
    actor: ActorContext,
    input: { definitionCode: string; entityId: string; contextData?: Record<string, unknown> },
  ) {
    await this.rbac.requirePermission(actor, "workflow.instance.start");
    await this.assertRequestContextStampsWithinScope(actor, input.contextData ?? {});
    return this.startInstance(actor, input);
  }

  private async assertRequestContextStampsWithinScope(
    actor: ActorContext,
    contextData: Record<string, unknown>,
  ): Promise<void> {
    if (actor.scopeType === "tenant") return;
    const unitId = contextData.organizationUnitId;
    if (unitId !== undefined && unitId !== null) {
      if (typeof unitId !== "string") {
        throw new ValidationError("contextData.organizationUnitId must be a string");
      }
      if (!(await this.rbac.isActiveOrganizationUnitScopeCovered(actor, unitId))) {
        throw new ForbiddenError(
          "contextData.organizationUnitId is outside the active Role's Data Scope",
        );
      }
    }
    const legalEntityId = contextData.legalEntityId;
    if (legalEntityId !== undefined && legalEntityId !== null) {
      if (actor.scopeType !== "legal_entity" || actor.scopeLegalEntityId !== legalEntityId) {
        throw new ForbiddenError("contextData.legalEntityId is outside the active Role's Data Scope");
      }
    }
    const customerId = contextData.customerId;
    if (customerId !== undefined && customerId !== null) {
      if (actor.scopeType !== "customer" || actor.scopeCustomerId !== customerId) {
        throw new ForbiddenError("contextData.customerId is outside the active Role's Data Scope");
      }
    }
  }

  async startInstance(
    actor: ActorContext,
    input: { definitionCode: string; entityId: string; contextData?: Record<string, unknown> },
  ) {
    await this.rbac.requirePermission(actor, "workflow.instance.start");
    const definition = await this.getDefinitionOrThrow(actor.tenantId, input.definitionCode);
    const version = await this.repo.findCurrentVersion(definition.id);
    if (!version) {
      throw new ConflictError(
        `Workflow Definition '${input.definitionCode}' has no published (current) Version yet`,
      );
    }
    const initialStep = await this.repo.findInitialStep(version.id);
    if (!initialStep) {
      // Publish validation guarantees this in practice; guarded here too
      // so a data-integrity bug fails loudly instead of silently.
      throw new ConflictError(`Published Version has no initial Step — data integrity issue`);
    }

    const contextData = input.contextData ?? {};
    const instance = await this.repo.createInstance({
      tenantId: actor.tenantId,
      workflowDefinitionId: definition.id,
      workflowVersionId: version.id,
      entityType: definition.entityType,
      entityId: input.entityId,
      currentStepId: initialStep.id,
      contextData,
      startedBy: actor.userId,
    });

    await this.repo.appendHistory({
      workflowInstanceId: instance.id,
      fromStepId: null,
      toStepId: initialStep.id,
      actionCode: "started",
      actorUserId: actor.userId,
      comment: null,
      metadata: { definitionCode: definition.code, versionNumber: version.versionNumber },
    });

    const assignment = await this.createAssignmentForStep(instance, initialStep.id, initialStep.code, initialStep.slaHours, actor);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workflow.instance.started",
      entityType: "workflow_instance",
      entityId: instance.id,
      metadata: { definitionCode: definition.code, versionNumber: version.versionNumber },
    });

    return { instance, assignment };
  }

  async getInstance(actor: ActorContext, id: string) {
    await this.rbac.requirePermission(actor, "workflow.instance.read");
    const instance = await this.getVisibleInstanceOrThrow(actor, id);
    const assignments = await this.repo.listAssignmentsForInstance(instance.id);
    return { instance, assignments };
  }

  /**
   * Checkpoint 1B — trusted-caller variant of `getInstance`/`getHistory`:
   * no `workflow.instance.read` permission check. `workflow.instance.read`
   * is Tenant-wide (the generic engine has no Data-Scope-aware reading —
   * documented, pre-existing Phase 0 characteristic, not something 1B
   * changes for the raw `/workflow/*` routes). A business module that has
   * ALREADY authorized the actor against the specific business entity
   * (e.g. `ComplaintService.get` via Customer Data Scope) can read that
   * entity's Instance/Assignments/History through here instead — this is
   * specifically what lets a Customer User read their OWN Complaint's
   * workflow state without being granted the broad, Tenant-wide
   * `workflow.instance.read` permission (which would otherwise let them
   * browse every Instance in the Tenant via `GET /workflow/instances`).
   */
  async getInstanceForEntityOwner(tenantId: string, id: string) {
    const instance = await this.getInstanceOrThrow(tenantId, id);
    const assignments = await this.repo.listAssignmentsForInstance(instance.id);
    const currentStep = instance.currentStepId ? await this.repo.findStepById(instance.currentStepId) : null;
    const history = await this.repo.listHistory(instance.id);
    return { instance, assignments, currentStep, history };
  }

  /**
   * Checkpoint 1C.2 — light status projection for list rows. Trusted-caller
   * (no `workflow.instance.read`): the business module has already
   * authorized the actor against the parent entity, same posture as
   * `getInstanceForEntityOwner`. Loads only what a list row needs
   * (current Step + pending Assignment), never the full history/transitions.
   */
  async getEntityStatus(actor: ActorContext, instanceId: string): Promise<EntityWorkflowStatus> {
    const statuses = await this.getEntityStatuses(actor, [instanceId]);
    const status = statuses[0];
    if (!status) throw new NotFoundError("WorkflowInstance", instanceId);
    return status;
  }

  /** Phase H / PH-5 — batched form of `getEntityStatus` for operational
   * queues. It preserves the exact live Workflow projection semantics while
   * avoiding one Instance + Assignment query per row. */
  async getEntityStatuses(actor: ActorContext, instanceIds: string[]): Promise<EntityWorkflowStatusByInstance[]> {
    if (instanceIds.length === 0) return [];
    const uniqueIds = Array.from(new Set(instanceIds));
    const instances = (await this.repo.findInstancesByIds(uniqueIds)).filter((instance) => instance.tenantId === actor.tenantId);
    const stepIds = Array.from(new Set(instances.map((instance) => instance.currentStepId).filter((id): id is string => id !== null)));
    const steps = await Promise.all(stepIds.map((id) => this.repo.findStepById(id)));
    const stepById = new Map(steps.filter((step): step is NonNullable<typeof step> => step !== null).map((step) => [step.id, step]));
    const assignments = await this.repo.listAssignmentsForInstances(instances.map((instance) => instance.id));
    const pendingByInstanceId = new Map<string, WorkflowInstanceAssignment>();
    for (const assignment of assignments) {
      if (assignment.status === "pending" && !pendingByInstanceId.has(assignment.workflowInstanceId)) {
        pendingByInstanceId.set(assignment.workflowInstanceId, assignment);
      }
    }

    const statuses: EntityWorkflowStatusByInstance[] = [];
    for (const instance of instances) {
      const currentStep = instance.currentStepId ? stepById.get(instance.currentStepId) ?? null : null;
      const pending = pendingByInstanceId.get(instance.id) ?? null;
      const sla =
        currentStep && (pending?.dueAt != null || currentStep.slaHours != null)
          ? { dueAt: pending?.dueAt ?? null, slaHours: currentStep.slaHours ?? null }
          : null;
      const assignment = pending
        ? {
            roleCode: pending.assignedRoleCode,
            userId: pending.assignedUserId,
            isMine:
              pending.assignmentType === "specific_user"
                ? pending.assignedUserId === actor.userId
                : await this.rbac.hasActiveRoleCoveringScope(
                    actor,
                    pending.assignedRoleCode!,
                    pending.assignedOrganizationUnitId,
                  ),
          }
        : null;
      statuses.push({
        instanceId: instance.id,
        stepCode: currentStep?.code ?? null,
        stepName: currentStep?.name ?? null,
        instanceStatus: instance.status,
        sla,
        assignment,
      });
    }
    return statuses;
  }

  /**
   * Checkpoint 1C.2 — full composite view for an entity-detail screen.
   * Trusted-caller (see `getEntityStatus`). Composed live in the
   * application layer from existing tables (FD-1C-01: no new read store).
   * `actor` is needed to compute `availableActions` (eligibility depends
   * on who is asking).
   */
  async getEntityWorkflowView(actor: ActorContext, instanceId: string): Promise<EntityWorkflowView> {
    const instance = await this.getInstanceOrThrow(actor.tenantId, instanceId);
    const steps = await this.repo.listSteps(instance.workflowVersionId);
    const stepById = new Map(steps.map((s) => [s.id, s]));
    const currentStep = instance.currentStepId ? stepById.get(instance.currentStepId) ?? null : null;

    const assignments = await this.repo.listAssignmentsForInstance(instance.id);
    const pending = assignments.find((a) => a.status === "pending") ?? null;
    const sla =
      currentStep && (pending?.dueAt != null || currentStep.slaHours != null)
        ? { dueAt: pending?.dueAt ?? null, slaHours: currentStep.slaHours ?? null }
        : null;

    const history = await this.repo.listHistory(instance.id);
    const timeline: EntityWorkflowTimelineEntry[] = history.map((h) => ({
      occurredAt: h.occurredAt,
      actionCode: h.actionCode,
      fromStepCode: h.fromStepId ? stepById.get(h.fromStepId)?.code ?? null : null,
      fromStepName: h.fromStepId ? stepById.get(h.fromStepId)?.name ?? null : null,
      toStepCode: h.toStepId ? stepById.get(h.toStepId)?.code ?? null : null,
      toStepName: h.toStepId ? stepById.get(h.toStepId)?.name ?? null : null,
      actorUserId: h.actorUserId,
      comment: h.comment,
    }));

    let availableActions: EntityWorkflowAction[] = [];
    if (
      instance.status === "in_progress" &&
      currentStep &&
      pending &&
      (await this.isActorEligibleForAssignment(actor, pending))
    ) {
      const transitions = await this.repo.listTransitionsFromStep(currentStep.id);
      availableActions = transitions
        .filter((t) => evaluateCondition(t.conditionExpression, instance.contextData))
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((t) => ({
          actionCode: t.actionCode,
          name: t.name,
          toStepCode: stepById.get(t.toStepId)?.code ?? "",
        }));
    }

    const nonTerminalSteps = steps
      .filter((s) => !s.isTerminal)
      .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
      .map((s) => ({ code: s.code, name: s.name }));

    return {
      instanceStatus: instance.status,
      currentStep: currentStep ? { code: currentStep.code, name: currentStep.name } : null,
      sla,
      availableActions,
      timeline,
      nonTerminalSteps,
    };
  }

  async listInstances(actor: ActorContext): Promise<WorkflowInstance[]> {
    await this.rbac.requirePermission(actor, "workflow.instance.read");
    if (actor.scopeType === "tenant") return this.repo.listInstances(actor.tenantId);
    // Constant number of queries: units once, association assignments once, one
    // SQL-narrowed instance read; the same in-memory predicate as the single
    // read then confirms each row (list and detail cannot drift).
    const visibility = await this.buildInstanceVisibility(actor);
    const candidates = await this.repo.listInstancesNarrowed(actor.tenantId, {
      startedBy: actor.userId,
      instanceIds: [...visibility.associatedInstanceIds],
      organizationUnitIds: [...visibility.coverage.coveredUnitIds],
      legalEntityIds: visibility.coverage.usableLegalEntityId
        ? [visibility.coverage.usableLegalEntityId]
        : [],
      customerIds: visibility.customerId ? [visibility.customerId] : [],
    });
    return candidates.filter((instance) => visibility.isVisible(instance));
  }

  /**
   * Checkpoint 1C.6 — trusted-caller, read-only view of a Definition's CURRENT
   * published version (steps + SLA + transitions + assignment rules). No
   * `workflow.definition.read` permission: a business admin surface that has
   * already authorized the actor for its own scope (e.g.
   * ComplaintConfigurationService, gated on `complaint.configure`) uses this
   * to SHOW the configured lifecycle without granting the broad, engine-wide
   * definition-read permission. Read-only by design — it exposes no mutation
   * (authoring stays on the RBAC-gated `/workflow/definitions/*` routes).
   */
  async getDefinitionView(tenantId: string, code: string): Promise<EntityWorkflowDefinitionView | null> {
    const definition = await this.repo.findDefinitionByCode(tenantId, code);
    if (!definition) return null;
    const version = await this.repo.findCurrentVersion(definition.id);
    const base = {
      code: definition.code,
      name: definition.name,
      entityType: definition.entityType,
      isActive: definition.isActive,
    };
    if (!version) {
      return { definition: base, versionNumber: null, versionStatus: null, steps: [] };
    }
    const steps = await this.repo.listSteps(version.id);
    const codeByStepId = new Map(steps.map((s) => [s.id, s.code]));
    const ordered = [...steps].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
    const stepViews = [];
    for (const s of ordered) {
      const [transitions, rules] = await Promise.all([
        this.repo.listTransitionsFromStep(s.id),
        this.repo.listAssignmentRules(s.id),
      ]);
      stepViews.push({
        code: s.code,
        name: s.name,
        stepType: s.stepType,
        isInitial: s.isInitial,
        isTerminal: s.isTerminal,
        terminalStatus: s.terminalStatus,
        slaHours: s.slaHours,
        transitions: transitions
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((t) => ({
            actionCode: t.actionCode,
            name: t.name,
            toStepCode: codeByStepId.get(t.toStepId) ?? null,
            condition: t.conditionExpression,
          })),
        assignmentRules: rules.map((r) => ({
          assignmentType: r.assignmentType,
          roleCode: r.roleCode,
          organizationUnitStrategy: r.organizationUnitStrategy,
          specificUserSource: r.specificUserSource,
          condition: r.conditionExpression,
        })),
      });
    }
    return { definition: base, versionNumber: version.versionNumber, versionStatus: version.status, steps: stepViews };
  }

  async getHistory(actor: ActorContext, instanceId: string) {
    await this.rbac.requirePermission(actor, "workflow.instance.read");
    const instance = await this.getVisibleInstanceOrThrow(actor, instanceId);
    return this.repo.listHistory(instance.id);
  }

  /** "My Tasks": pending Assignments the actor is actually eligible to act
   * on — either they hold the assigned Role within the assigned scope, or
   * the Assignment names them specifically. */
  async listMyAssignments(actor: ActorContext): Promise<WorkflowInstanceAssignment[]> {
    await this.rbac.requirePermission(actor, "workflow.instance.read");
    const pending = await this.repo.listPendingAssignmentsByTenant(actor.tenantId);
    // Coverage is computed once per request, then matched in memory — the same
    // rule as `RbacService.hasActiveRoleCoveringScope` per assignment.
    const coverage = await this.rbac.buildActiveOrganizationUnitCoverage(actor);
    return pending.filter((assignment) => this.isActorEligibleWithCoverage(actor, coverage, assignment));
  }

  /**
   * ADR-0008: claim a pending Assignment for `CLAIM_TTL_SECONDS`. Purely
   * an opt-in courtesy reservation — nothing requires a claim before
   * acting (see `actOnAssignment` below: a claim held by someone else
   * blocks others only while it is still fresh; an unclaimed Assignment
   * is exactly 0D's original first-decision-wins behavior). Eligibility
   * is checked with the same Role+Scope / specific_user logic as acting,
   * so a claim can never be taken by someone who couldn't act anyway.
   */
  async claimAssignment(actor: ActorContext, assignmentId: string) {
    await this.rbac.requirePermission(actor, "workflow.instance.act");
    const assignment = await this.repo.findAssignmentById(assignmentId);
    if (!assignment) throw new NotFoundError("WorkflowInstanceAssignment", assignmentId);
    await this.getInstanceOrThrow(actor.tenantId, assignment.workflowInstanceId);
    await this.assertEligible(actor, assignment);

    const claimed = await this.repo.claimAssignment(assignmentId, actor.userId, CLAIM_TTL_SECONDS);
    if (!claimed) {
      throw new ConflictError("This task is already claimed by another user");
    }
    return claimed;
  }

  async releaseClaim(actor: ActorContext, assignmentId: string) {
    await this.rbac.requirePermission(actor, "workflow.instance.act");
    const released = await this.repo.releaseClaim(assignmentId, actor.userId);
    if (!released) {
      throw new ConflictError("No active claim by you to release on this Assignment");
    }
    return released;
  }

  async actOnAssignment(
    actor: ActorContext,
    assignmentId: string,
    actionCode: string,
    comment: string | null,
  ) {
    await this.rbac.requirePermission(actor, "workflow.instance.act");

    const assignment = await this.repo.findAssignmentById(assignmentId);
    if (!assignment) throw new NotFoundError("WorkflowInstanceAssignment", assignmentId);
    if (assignment.status !== "pending") {
      throw new ConflictError(`This Assignment is already '${assignment.status}', not actionable`);
    }
    if (
      assignment.claimedByUserId &&
      assignment.claimedByUserId !== actor.userId &&
      assignment.claimedAt &&
      Date.now() - assignment.claimedAt.getTime() < CLAIM_TTL_SECONDS * 1000
    ) {
      throw new ConflictError(
        `This task is currently claimed by another user (claim expires ${CLAIM_TTL_SECONDS / 60} minutes after it was taken)`,
      );
    }

    const instance = await this.getInstanceOrThrow(actor.tenantId, assignment.workflowInstanceId);
    await this.assertEligible(actor, assignment);

    const currentStep = await this.repo.findStepById(assignment.stepId);
    if (!currentStep) throw new NotFoundError("WorkflowStep", assignment.stepId);

    const transitions = await this.repo.listTransitionsFromStep(currentStep.id);
    const candidates = transitions
      .filter((t) => t.actionCode === actionCode)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const chosen = candidates.find((t) => evaluateCondition(t.conditionExpression, instance.contextData));
    if (!chosen) {
      throw new ValidationError(
        `No Transition configured for action '${actionCode}' from step '${currentStep.code}' matching the current context`,
      );
    }

    const decidedStatus = actionCode === "reject" ? "rejected" : actionCode === "return" ? "returned" : "approved";
    await this.repo.updateAssignmentStatus(assignment.id, {
      status: decidedStatus,
      decidedBy: actor.userId,
      decidedAt: new Date(),
      decisionActionCode: actionCode,
      comment,
    });

    const nextStep = await this.repo.findStepById(chosen.toStepId);
    if (!nextStep) throw new NotFoundError("WorkflowStep", chosen.toStepId);

    await this.repo.appendHistory({
      workflowInstanceId: instance.id,
      fromStepId: currentStep.id,
      toStepId: nextStep.id,
      actionCode,
      actorUserId: actor.userId,
      comment,
      metadata: null,
      // Epic 1 (§4.1 D): the decision row the accumulation window sums.
      // Only an approve carries an amount; reject/return rows stay NULL.
      decisionAmount: actionCode === "approve" ? documentAmountOf(instance) : null,
    });
    await this.repo.recordNotificationHook({
      workflowInstanceId: instance.id,
      eventType: decidedStatus,
      payload: { fromStepCode: currentStep.code, toStepCode: nextStep.code, actorUserId: actor.userId, comment },
    });
    await this.eventBus?.publish({
      tenantId: actor.tenantId,
      eventType: `workflow.${decidedStatus}`,
      entityType: instance.entityType,
      entityId: instance.entityId,
      payload: {
        workflowInstanceId: instance.id,
        // Whoever started the instance is the natural recipient of a
        // decision notice on their own submission — same "submitter"
        // convention 0D's specific_user Assignment type already uses.
        targetUserId: instance.startedBy,
        fromStepCode: currentStep.code,
        toStepCode: nextStep.code,
        actorUserId: actor.userId,
        comment,
      },
      createdBy: actor.userId,
    });

    await this.repo.updateInstanceCurrentStep(instance.id, nextStep.id);

    let newAssignment: WorkflowInstanceAssignment | null = null;
    if (nextStep.isTerminal) {
      await this.repo.completeInstance(instance.id, nextStep.terminalStatus!);
      await this.repo.appendHistory({
        workflowInstanceId: instance.id,
        fromStepId: currentStep.id,
        toStepId: nextStep.id,
        actionCode: "completed",
        actorUserId: null,
        comment: null,
        metadata: { terminalStatus: nextStep.terminalStatus },
      });
      await this.repo.recordNotificationHook({
        workflowInstanceId: instance.id,
        eventType: "completed",
        payload: { terminalStatus: nextStep.terminalStatus },
      });
      await this.eventBus?.publish({
        tenantId: actor.tenantId,
        eventType: "workflow.completed",
        entityType: instance.entityType,
        entityId: instance.entityId,
        payload: { workflowInstanceId: instance.id, targetUserId: instance.startedBy, terminalStatus: nextStep.terminalStatus },
        createdBy: actor.userId,
      });
    } else {
      newAssignment = await this.createAssignmentForStep(instance, nextStep.id, nextStep.code, nextStep.slaHours, actor);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workflow.instance.acted",
      entityType: "workflow_instance",
      entityId: instance.id,
      metadata: { actionCode, fromStep: currentStep.code, toStep: nextStep.code },
    });

    return {
      instance: (await this.repo.findInstanceById(instance.id))!,
      decidedAssignmentId: assignment.id,
      newAssignment,
    };
  }

  /**
   * Escalation sweep — explicit, RBAC-gated operation that reassigns
   * every overdue pending Assignment per its Step's Escalation Rule (if
   * one is configured; Steps without one are left overdue on purpose,
   * since Escalation is opt-in per Step). No automatic scheduler invokes
   * this in Phase 0 — see the migration file header and
   * docs/decision-log.md for why that's an accepted, documented gap
   * rather than a silent omission.
   */
  /**
   * Checkpoint 1B — generic, entity-agnostic reopen (does NOT know
   * "Complaint" exists, same posture as everything else in this class).
   * Resolves a real gap: `actOnAssignment` requires a PENDING Assignment
   * to act on, and a completed Instance's terminal Step never has one —
   * so "reopen a closed Complaint" cannot be expressed as an ordinary
   * Transition no matter how the Workflow Definition is authored.
   *
   * Deliberately does NOT itself enforce a Tenant-wide RBAC permission —
   * unlike every other method here, it is meant to be called by a
   * business module's own service (e.g. `ComplaintService.reopen`)
   * AFTER that module has authorized the specific business entity
   * (permission + Data Scope) — the same "trusted caller" posture
   * `escalateOverdueAssignmentsForTenant` already established for the
   * Scheduler. `actor` is still required, for audit/history attribution.
   */
  async reopenInstance(
    actor: ActorContext,
    instanceId: string,
    input: { toStepCode: string; comment: string | null },
  ) {
    const instance = await this.getInstanceOrThrow(actor.tenantId, instanceId);
    if (instance.status === "in_progress") {
      throw new ConflictError("Only a completed Workflow Instance can be reopened");
    }
    const toStep = await this.repo.findStepByCode(instance.workflowVersionId, input.toStepCode);
    if (!toStep) throw new NotFoundError("WorkflowStep", input.toStepCode);
    if (toStep.isTerminal) {
      throw new ValidationError("Cannot reopen into another terminal Step");
    }

    const fromStepId = instance.currentStepId;
    await this.repo.reopenInstance(instance.id, toStep.id);
    await this.repo.appendHistory({
      workflowInstanceId: instance.id,
      fromStepId,
      toStepId: toStep.id,
      actionCode: "reopened",
      actorUserId: actor.userId,
      comment: input.comment,
      metadata: null,
    });
    const newAssignment = await this.createAssignmentForStep(instance, toStep.id, toStep.code, toStep.slaHours, actor);

    await this.eventBus?.publish({
      tenantId: actor.tenantId,
      eventType: "workflow.reopened",
      entityType: instance.entityType,
      entityId: instance.entityId,
      payload: {
        workflowInstanceId: instance.id,
        targetUserId: instance.startedBy,
        toStepCode: toStep.code,
        actorUserId: actor.userId,
        comment: input.comment,
      },
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workflow.instance.reopened",
      entityType: "workflow_instance",
      entityId: instance.id,
      metadata: { toStepCode: toStep.code },
    });

    return { instance: (await this.repo.findInstanceById(instance.id))!, newAssignment };
  }

  /**
   * Checkpoint 1B — "is this actor legitimately connected to this
   * Instance" (started it, currently/previously assigned to it — by
   * name or by Role+Scope eligibility re-evaluated NOW, same as
   * `assertEligible`). Generic across any entityType; used by
   * `ComplaintService.canAccessForDocument` as one of several ways an
   * actor can be authorized for a Complaint's evidence, alongside the
   * Customer Data Scope path (ADR-0011/0012) — an investigator routed to
   * a Complaint through an Organization Unit unrelated to the Customer's
   * own `ownerOrganizationUnitId` still needs to reach the evidence they
   * were assigned to review.
   */
  async isActorAssociatedWithInstance(actor: ActorContext, instanceId: string): Promise<boolean> {
    const instance = await this.repo.findInstanceById(instanceId);
    if (!instance || instance.tenantId !== actor.tenantId) return false;
    if (instance.startedBy === actor.userId) return true;

    const assignments = await this.repo.listAssignmentsForInstance(instanceId);
    for (const assignment of assignments) {
      if (assignment.assignmentType === "specific_user") {
        if (assignment.assignedUserId === actor.userId) return true;
        continue;
      }
      const covers = await this.rbac.hasActiveRoleCoveringScope(
        actor,
        assignment.assignedRoleCode!,
        assignment.assignedOrganizationUnitId,
      );
      if (covers) return true;
    }
    return false;
  }

  async escalateOverdueAssignments(actor: ActorContext) {
    await this.rbac.requirePermission(actor, "workflow.instance.manage");
    return this.runEscalationSweep(actor.tenantId);
  }

  /**
   * System-context variant of the escalation sweep — no `ActorContext`,
   * no RBAC permission check, because there is no authenticated HTTP
   * user when this runs: it exists solely so the Scheduler (Checkpoint
   * 0E, a trusted internal component, never directly reachable by an
   * end user) can invoke the exact same sweep logic the RBAC-gated
   * `/workflow/escalation-sweep` endpoint uses for a manual trigger.
   * `escalateOverdueAssignments` above remains the only HTTP-facing path
   * and still requires `workflow.instance.manage` — this method is never
   * registered as a route.
   */
  async escalateOverdueAssignmentsForTenant(tenantId: string) {
    return this.runEscalationSweep(tenantId);
  }

  private async runEscalationSweep(tenantId: string) {
    const overdue = await this.repo.listOverdueAssignments(tenantId);
    const escalated: WorkflowInstanceAssignment[] = [];

    for (const assignment of overdue) {
      const rule = await this.repo.findEscalationRule(assignment.stepId);
      if (!rule) continue;

      const step = await this.repo.findStepById(assignment.stepId);
      const instance = await this.repo.findInstanceById(assignment.workflowInstanceId);
      if (!step || !instance) continue;

      await this.repo.updateAssignmentStatus(assignment.id, {
        status: "escalated",
        decidedBy: null,
        decidedAt: new Date(),
        decisionActionCode: "escalated",
        comment: `Escalated automatically: SLA of ${step.slaHours ?? "?"}h exceeded`,
      });

      const organizationUnitId =
        rule.escalateToOrganizationUnitStrategy === "submitter_unit"
          ? ((instance.contextData as Record<string, unknown>).organizationUnitId as string | undefined) ??
            null
          : null;
      const dueAt = step.slaHours != null ? new Date(Date.now() + step.slaHours * 3600 * 1000) : null;

      const newAssignment = await this.repo.createAssignment({
        workflowInstanceId: instance.id,
        stepId: step.id,
        assignmentType: "role",
        assignedRoleCode: rule.escalateToRoleCode,
        assignedOrganizationUnitId: organizationUnitId,
        assignedUserId: null,
        dueAt,
      });

      await this.repo.appendHistory({
        workflowInstanceId: instance.id,
        fromStepId: step.id,
        toStepId: step.id,
        actionCode: "escalated",
        actorUserId: null,
        comment: `Escalated to role '${rule.escalateToRoleCode}' after ${rule.escalateAfterHours}h SLA`,
        metadata: { originalAssignmentId: assignment.id, newAssignmentId: newAssignment.id },
      });
      await this.repo.recordNotificationHook({
        workflowInstanceId: instance.id,
        eventType: "escalated",
        payload: {
          stepCode: step.code,
          escalateToRoleCode: rule.escalateToRoleCode,
          newAssignmentId: newAssignment.id,
        },
      });
      await this.audit.record({
        tenantId,
        actorUserId: null,
        action: "workflow.instance.escalated",
        entityType: "workflow_instance",
        entityId: instance.id,
        metadata: { stepCode: step.code, escalateToRoleCode: rule.escalateToRoleCode },
      });
      await this.eventBus?.publish({
        tenantId,
        eventType: "workflow.escalated",
        entityType: instance.entityType,
        entityId: instance.entityId,
        payload: {
          workflowInstanceId: instance.id,
          newAssignmentId: newAssignment.id,
          targetRoleCode: rule.escalateToRoleCode,
          targetOrganizationUnitId: organizationUnitId,
          stepCode: step.code,
        },
        createdBy: null,
      });

      escalated.push(newAssignment);
    }

    return escalated;
  }

  // ======================================================================
  // Internals
  // ======================================================================

  private async getDefinitionOrThrow(tenantId: string, code: string): Promise<WorkflowDefinition> {
    const definition = await this.repo.findDefinitionByCode(tenantId, code);
    if (!definition) throw new NotFoundError("WorkflowDefinition", code);
    return definition;
  }

  private async getEditableVersionOrThrow(
    tenantId: string,
    definitionCode: string,
    versionNumber: number,
  ): Promise<WorkflowVersion> {
    const definition = await this.getDefinitionOrThrow(tenantId, definitionCode);
    const version = await this.repo.findVersion(definition.id, versionNumber);
    if (!version) throw new NotFoundError("WorkflowVersion", String(versionNumber));
    if (version.status !== "draft") {
      throw new ConflictError(
        `Workflow Version ${versionNumber} is '${version.status}' — only a 'draft' Version can be edited`,
      );
    }
    return version;
  }

  /**
   * Site-scoping of tasks. The raw `/workflow/instances*` reads were
   * Tenant-wide for any holder of `workflow.instance.read`. For an actor whose
   * ACTIVE Data Scope is narrower than the Tenant (a field officer scoped to
   * one Site / Organization Unit), an Instance is visible only when:
   *  - the actor started it, or is a named/eligible assignee on it
   *    (`isActorAssociatedWithInstance` — Role+Scope for role queues), OR
   *  - its owning Organization Unit (`contextData.organizationUnitId`, set by
   *    business modules from the parent entity's owning unit — ADR-0012 style)
   *    is covered by the active Data Scope (ADR-0009 hierarchical walk).
   * Tenant-scoped actors are unchanged. Reuses existing RbacService checks;
   * no new authorization mechanism.
   */
  /**
   * One request-scoped description of "which Instances may this actor read",
   * shared by the list and the single read so they cannot drift. Built once:
   * the tenant's units (one query), the actor's candidate Assignments (one
   * query, optionally narrowed to `instanceIds`).
   *
   * Visible when (tenant-wide actors: always):
   *  - the actor started it, or
   *  - the actor is associated with it (named assignee, or holder of the
   *    assigned Role whose ACTIVE scope covers the assignment — any status), or
   *  - `contextData.organizationUnitId` is covered by the active Data Scope
   *    (ADR-0009), or
   *  - `contextData.legalEntityId` equals the active (usable) Legal Entity
   *    scope — for Instances whose parent entity belongs to a Legal Entity but
   *    to no Organization Unit (tax rule, budget), or
   *  - `contextData.customerId` equals the active customer scope (ADR-0011).
   * Instances with none of these stamps (tenant-level entities such as a
   * consolidation group) are visible only to tenant-wide actors, their starter
   * and eligible assignees.
   */
  private async buildInstanceVisibility(
    actor: ActorContext,
    instanceIds?: string[],
  ): Promise<InstanceVisibility> {
    const coverage = await this.rbac.buildActiveOrganizationUnitCoverage(actor);
    const candidates = coverage.tenantWide
      ? []
      : await this.repo.listAssociationCandidateAssignments(
          actor.tenantId,
          actor.userId,
          actor.assignmentId === null ? null : actor.roleCode,
          instanceIds,
        );
    const associatedInstanceIds = new Set<string>();
    for (const assignment of candidates) {
      if (this.isActorEligibleWithCoverage(actor, coverage, assignment)) {
        associatedInstanceIds.add(assignment.workflowInstanceId);
      }
    }
    const customerId =
      actor.assignmentId !== null && actor.scopeType === "customer" ? actor.scopeCustomerId : null;
    const isVisible = (instance: WorkflowInstance): boolean => {
      if (instance.tenantId !== actor.tenantId) return false;
      if (coverage.tenantWide) return true;
      if (instance.startedBy === actor.userId) return true;
      if (associatedInstanceIds.has(instance.id)) return true;
      const ctx = (instance.contextData ?? {}) as Record<string, unknown>;
      if (typeof ctx.organizationUnitId === "string" && coverage.covers(ctx.organizationUnitId)) {
        return true;
      }
      if (
        coverage.usableLegalEntityId !== null &&
        ctx.legalEntityId === coverage.usableLegalEntityId
      ) {
        return true;
      }
      return customerId !== null && ctx.customerId === customerId;
    };
    return { coverage, associatedInstanceIds, customerId, isVisible };
  }

  /** Role+Scope / specific_user eligibility with a pre-built coverage — the
   * synchronous twin of `RbacService.hasActiveRoleCoveringScope` /
   * `isActorEligibleForAssignment`. */
  private isActorEligibleWithCoverage(
    actor: ActorContext,
    coverage: ActiveOrganizationUnitCoverage,
    assignment: WorkflowInstanceAssignment,
  ): boolean {
    if (assignment.assignmentType === "specific_user") {
      return assignment.assignedUserId === actor.userId;
    }
    if (actor.assignmentId === null || actor.roleCode !== assignment.assignedRoleCode) return false;
    if (actor.scopeType === "tenant") return true;
    if (assignment.assignedOrganizationUnitId === null) return false;
    return coverage.covers(assignment.assignedOrganizationUnitId);
  }

  /** Batched association: of `instanceIds` (or every tenant Instance when
   * omitted), the ones `actor` started or is eligible assignee of — the same
   * rule as `isActorAssociatedWithInstance`, in two queries total. */
  async listAssociatedInstanceIds(
    actor: ActorContext,
    instanceIds?: string[],
  ): Promise<Set<string>> {
    if (instanceIds && instanceIds.length === 0) return new Set();
    const coverage = await this.rbac.buildActiveOrganizationUnitCoverage(actor);
    const candidates = await this.repo.listAssociationCandidateAssignments(
      actor.tenantId,
      actor.userId,
      actor.assignmentId === null ? null : actor.roleCode,
      instanceIds,
    );
    const result = new Set<string>();
    for (const assignment of candidates) {
      if (this.isActorEligibleWithCoverage(actor, coverage, assignment)) {
        result.add(assignment.workflowInstanceId);
      }
    }
    const started = await this.repo.listInstanceIdsStartedBy(actor.tenantId, actor.userId, instanceIds);
    for (const id of started) result.add(id);
    return result;
  }

  /** Out-of-scope reads are a 404, not a differently-shaped refusal. */
  private async getVisibleInstanceOrThrow(
    actor: ActorContext,
    id: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getInstanceOrThrow(actor.tenantId, id);
    if (actor.scopeType === "tenant") return instance;
    const visibility = await this.buildInstanceVisibility(actor, [id]);
    if (!visibility.isVisible(instance)) {
      throw new NotFoundError("WorkflowInstance", id);
    }
    return instance;
  }

  private async getInstanceOrThrow(tenantId: string, id: string): Promise<WorkflowInstance> {
    const instance = await this.repo.findInstanceById(id);
    if (!instance || instance.tenantId !== tenantId) {
      throw new NotFoundError("WorkflowInstance", id);
    }
    return instance;
  }

  /** Non-throwing eligibility check (Checkpoint 1C.2) — same Role+Scope /
   * specific_user rule as `assertEligible`, returned as a boolean so a
   * read-only projection (`getEntityWorkflowView.availableActions`) can
   * report what the actor could do without raising. */
  private async isActorEligibleForAssignment(
    actor: ActorContext,
    assignment: WorkflowInstanceAssignment,
  ): Promise<boolean> {
    if (assignment.assignmentType === "specific_user") {
      return assignment.assignedUserId === actor.userId;
    }
    return this.rbac.hasActiveRoleCoveringScope(
      actor,
      assignment.assignedRoleCode!,
      assignment.assignedOrganizationUnitId,
    );
  }

  /** Shared by `actOnAssignment` and `claimAssignment` (ADR-0008) — the
   * same "can this actor touch this Assignment" check either way, so a
   * claim can never be taken by someone who couldn't act on the task. */
  private async assertEligible(actor: ActorContext, assignment: WorkflowInstanceAssignment): Promise<void> {
    if (assignment.assignmentType === "specific_user") {
      if (assignment.assignedUserId !== actor.userId) {
        throw new ForbiddenError("This task is assigned to a different user");
      }
      return;
    }
    const covers = await this.rbac.hasActiveRoleCoveringScope(
      actor,
      assignment.assignedRoleCode!,
      assignment.assignedOrganizationUnitId,
    );
    if (!covers) {
      throw new ForbiddenError(
        `You do not hold role '${assignment.assignedRoleCode}' in the scope this task is assigned to`,
      );
    }
  }

  /** Resolves the Assignment Rule that matches (first Condition match
   * wins, per doc 04's "Dynamic Routing"), creates the resulting
   * Assignment + due date (SLA-ready hook), and fires the
   * Notification-ready hook. */
  private async createAssignmentForStep(
    instance: WorkflowInstance,
    stepId: string,
    stepCode: string,
    slaHours: number | null,
    /** WP-APR-01 — the acting user at assignment time (the starter on
     * startInstance, the actor on act/reopen). The ceiling resolver walks
     * THEIR approval authority, iDempiere-style. */
    actor?: ActorContext,
  ): Promise<WorkflowInstanceAssignment> {
    const rules = await this.repo.listAssignmentRules(stepId);
    const matched = rules
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .find((rule) => evaluateCondition(rule.conditionExpression, instance.contextData));
    if (!matched) {
      throw new ConflictError(`No matching Assignment Rule for the current context at this Step`);
    }

    let assignedRoleCode: string | null = null;
    let assignedOrganizationUnitId: string | null = null;
    let assignedUserId: string | null = null;
    // The ceiling resolver can override a role-typed rule by naming a specific
    // approver. When it does, the assignment's type must become
    // `specific_user` — `assertEligible` routes on that type, and a `role`
    // assignment with a NULL role code and a user id is a dead task no actor
    // can act on. `resolvedAssignmentType` starts as the rule's own type and
    // only flips when the resolver names someone.
    let resolvedAssignmentType: WorkflowAssignmentType = matched.assignmentType;

    if (matched.assignmentType === "role") {
      assignedRoleCode = matched.roleCode;
      assignedOrganizationUnitId =
        matched.organizationUnitStrategy === "submitter_unit"
          ? ((instance.contextData as Record<string, unknown>).organizationUnitId as string | undefined) ??
            null
          : null;

      // WP-APR-01 — approval ceiling routing (DEC-002/005). Only when the
      // resolver is wired AND the acting user is known AND the document
      // carries an amount: resolve the approver by authority instead of
      // blindly assigning the role. NULL amount / missing config keeps the
      // legacy role assignment untouched.
      const amount = documentAmountOf(instance);
      if (this.approvalAuthority && actor) {
        const context = instance.contextData as Record<string, unknown>;
        const organizationUnitId =
          assignedOrganizationUnitId ??
          (context.organizationUnitId as string | undefined) ??
          null;
        const currencyCode =
          (context.currencyCode as string | undefined) ??
          (context.currency as string | undefined) ??
          "IDR";
        let decision: ApprovalDecision;
        try {
          decision = await this.approvalAuthority.resolveApprover(actor, {
            documentUserId: instance.startedBy,
            amount,
            currencyCode,
            organizationUnitId,
            documentTable: instance.entityType,
            documentId: instance.entityId,
          });
        } catch (error) {
          if (error instanceof MissingConversionRateError) {
            throw new ConflictError(error.message);
          }
          throw error;
        }
        if (decision.kind === "escalate") {
          assignedUserId = decision.nextApproverUserId;
          assignedRoleCode = null;
          assignedOrganizationUnitId = null;
          resolvedAssignmentType = "specific_user";
        } else if (decision.kind === "no-approver") {
          throw new ConflictError(
            "No eligible approver found for the document amount (approval ceiling exhausted)",
          );
        } else if (decision.kind === "approve" && decision.approverUserId === actor.userId) {
          // The starter is themselves within ceiling — assign the step to
          // them directly so they can clear it in one action.
          assignedUserId = actor.userId;
          assignedRoleCode = null;
          assignedOrganizationUnitId = null;
          resolvedAssignmentType = "specific_user";
        }
        // "self-approved" (amount null/0) and "ceiling-inactive" (tenant has
        // no positive approval limits configured) keep the legacy role
        // assignment.
      }
    } else {
      assignedUserId =
        matched.specificUserSource === "submitter" ? instance.startedBy : matched.fixedUserId;
    }

    const dueAt = slaHours != null ? new Date(Date.now() + slaHours * 3600 * 1000) : null;

    const assignment = await this.repo.createAssignment({
      workflowInstanceId: instance.id,
      stepId,
      assignmentType: resolvedAssignmentType,
      assignedRoleCode,
      assignedOrganizationUnitId,
      assignedUserId,
      dueAt,
    });

    await this.repo.recordNotificationHook({
      workflowInstanceId: instance.id,
      eventType: "assigned",
      payload: {
        assignmentId: assignment.id,
        assignmentType: resolvedAssignmentType,
        roleCode: assignedRoleCode,
        organizationUnitId: assignedOrganizationUnitId,
        userId: assignedUserId,
        dueAt,
      },
    });
    await this.eventBus?.publish({
      tenantId: instance.tenantId,
      eventType: "workflow.assigned",
      entityType: instance.entityType,
      entityId: instance.entityId,
      payload: {
        workflowInstanceId: instance.id,
        assignmentId: assignment.id,
        targetUserId: assignedUserId,
        targetRoleCode: assignedRoleCode,
        targetOrganizationUnitId: assignedOrganizationUnitId,
        stepCode,
        toStepCode: stepCode,
        dueAt,
      },
      createdBy: null,
    });

    return assignment;
  }
}
