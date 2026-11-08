/**
 * Domain types for the Workflow & Approval Engine (Checkpoint 0D), per
 * 04-Workflow-Approval-Engine-Foundation.md. This is the hexagonal
 * boundary: `WorkflowRepository` is the interface the application layer
 * (`WorkflowService`) depends on — the PostgreSQL implementation lives in
 * `infrastructure/persistence/repositories/workflow.repository.pg.ts`.
 *
 * Nothing here knows about Complaint, Survey, or any business module —
 * `entityType`/`entityId` on a Workflow Instance are an opaque polymorphic
 * reference, and `contextData` is caller-supplied JSON used to evaluate
 * Conditions. The only concrete entity this checkpoint ships is
 * `DemoTransaction`, a generic dummy object that exists purely to give the
 * engine something real to point at during proof/testing.
 */

export type WorkflowVersionStatus = "draft" | "published" | "retired";
export type WorkflowStepType = "task" | "approval" | "end";
export type WorkflowTerminalStatus = "approved" | "rejected" | "cancelled";
export type WorkflowInstanceStatus = "in_progress" | "approved" | "rejected" | "cancelled";
export type WorkflowAssignmentStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "returned"
  | "escalated"
  | "superseded";
export type WorkflowAssignmentType = "role" | "specific_user";
export type OrganizationUnitStrategy = "submitter_unit" | "tenant";
export type SpecificUserSource = "submitter" | "fixed";

/** A simple, generic condition evaluated against a Workflow Instance's
 * `contextData` — deliberately minimal (per anti-overengineering
 * guidance): a full expression language is not needed to prove dynamic,
 * Condition-driven routing works end-to-end. */
export interface ConditionExpression {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";
  value: unknown;
}

export interface WorkflowDefinition {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  entityType: string;
  description: string;
  isActive: boolean;
  createdAt: Date;
}

export interface WorkflowVersion {
  id: string;
  workflowDefinitionId: string;
  versionNumber: number;
  status: WorkflowVersionStatus;
  isCurrent: boolean;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface WorkflowStep {
  id: string;
  workflowVersionId: string;
  code: string;
  name: string;
  stepType: WorkflowStepType;
  isInitial: boolean;
  isTerminal: boolean;
  terminalStatus: WorkflowTerminalStatus | null;
  slaHours: number | null;
  sequenceOrder: number;
}

export interface WorkflowTransition {
  id: string;
  workflowVersionId: string;
  fromStepId: string;
  toStepId: string;
  actionCode: string;
  name: string;
  conditionExpression: ConditionExpression | null;
  sortOrder: number;
}

export interface WorkflowAssignmentRule {
  id: string;
  workflowStepId: string;
  sortOrder: number;
  conditionExpression: ConditionExpression | null;
  assignmentType: WorkflowAssignmentType;
  roleCode: string | null;
  organizationUnitStrategy: OrganizationUnitStrategy | null;
  specificUserSource: SpecificUserSource | null;
  fixedUserId: string | null;
}

export interface WorkflowEscalationRule {
  id: string;
  workflowStepId: string;
  escalateAfterHours: number;
  escalateToRoleCode: string;
  escalateToOrganizationUnitStrategy: OrganizationUnitStrategy;
  note: string | null;
}

/** Generic dummy object — Checkpoint 0D's ONLY concrete entity, used
 * solely to prove the engine. Never a business module. */
export interface DemoTransaction {
  id: string;
  tenantId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
}

export interface WorkflowInstance {
  id: string;
  tenantId: string;
  workflowDefinitionId: string;
  workflowVersionId: string;
  entityType: string;
  entityId: string;
  currentStepId: string | null;
  status: WorkflowInstanceStatus;
  contextData: Record<string, unknown>;
  startedBy: string;
  startedAt: Date;
  completedAt: Date | null;
}

export interface WorkflowInstanceAssignment {
  id: string;
  workflowInstanceId: string;
  stepId: string;
  assignmentType: WorkflowAssignmentType;
  assignedRoleCode: string | null;
  assignedOrganizationUnitId: string | null;
  assignedUserId: string | null;
  assignedAt: Date;
  dueAt: Date | null;
  status: WorkflowAssignmentStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionActionCode: string | null;
  comment: string | null;
  /** ADR-0008 (Checkpoint 0E): an opt-in, TTL-based reservation on top of
   * ADR-0007's Role+Scope queue — see `workflow.service.ts#claimAssignment`
   * and `docs/adr/0008-workflow-assignment-claim-lock.md`. Purely additive:
   * a null `claimedByUserId` behaves exactly like 0D (first decision
   * wins, no locking). */
  claimedByUserId: string | null;
  claimedAt: Date | null;
}

export interface WorkflowHistoryEntry {
  id: string;
  workflowInstanceId: string;
  fromStepId: string | null;
  toStepId: string | null;
  actionCode: string;
  actorUserId: string | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  /** Epic 1 (§4.1 D): the monetary amount of the document being approved,
   * carried on the decision row so the approval-authority accumulation
   * window (iDempiere getAmtAccum) has one table to sum. Set on 'approve'
   * decisions, NULL for every other row. numeric(18,2) string. */
  decisionAmount: string | null;
  occurredAt: Date;
}

export interface WorkflowNotificationHook {
  id: string;
  workflowInstanceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface WorkflowRepository {
  // --- Definitions ---------------------------------------------------
  createDefinition(input: {
    tenantId: string;
    code: string;
    name: string;
    entityType: string;
    description: string;
    createdBy: string;
  }): Promise<WorkflowDefinition>;
  findDefinitionByCode(tenantId: string, code: string): Promise<WorkflowDefinition | null>;
  listDefinitions(tenantId: string): Promise<WorkflowDefinition[]>;

  // --- Versions --------------------------------------------------------
  createVersion(input: {
    workflowDefinitionId: string;
    versionNumber: number;
    createdBy: string;
  }): Promise<WorkflowVersion>;
  findVersion(workflowDefinitionId: string, versionNumber: number): Promise<WorkflowVersion | null>;
  findVersionById(id: string): Promise<WorkflowVersion | null>;
  findCurrentVersion(workflowDefinitionId: string): Promise<WorkflowVersion | null>;
  listVersions(workflowDefinitionId: string): Promise<WorkflowVersion[]>;
  getNextVersionNumber(workflowDefinitionId: string): Promise<number>;
  /** Unsets is_current on every other version of the definition, then
   * marks this version published + is_current. Two sequential statements
   * (no explicit transaction wrapper — consistent with the rest of this
   * codebase, see docs/decision-log.md Checkpoint 0D risk note). */
  publishVersion(id: string): Promise<WorkflowVersion>;

  // --- Steps -------------------------------------------------------------
  createStep(input: {
    workflowVersionId: string;
    code: string;
    name: string;
    stepType: WorkflowStepType;
    isInitial: boolean;
    isTerminal: boolean;
    terminalStatus: WorkflowTerminalStatus | null;
    slaHours: number | null;
    sequenceOrder: number;
  }): Promise<WorkflowStep>;
  listSteps(workflowVersionId: string): Promise<WorkflowStep[]>;
  findStepByCode(workflowVersionId: string, code: string): Promise<WorkflowStep | null>;
  findStepById(id: string): Promise<WorkflowStep | null>;
  findInitialStep(workflowVersionId: string): Promise<WorkflowStep | null>;

  // --- Transitions -------------------------------------------------------
  createTransition(input: {
    workflowVersionId: string;
    fromStepId: string;
    toStepId: string;
    actionCode: string;
    name: string;
    conditionExpression: ConditionExpression | null;
    sortOrder: number;
  }): Promise<WorkflowTransition>;
  listTransitionsFromStep(stepId: string): Promise<WorkflowTransition[]>;

  // --- Assignment rules ----------------------------------------------------
  createAssignmentRule(input: {
    workflowStepId: string;
    sortOrder: number;
    conditionExpression: ConditionExpression | null;
    assignmentType: WorkflowAssignmentType;
    roleCode: string | null;
    organizationUnitStrategy: OrganizationUnitStrategy | null;
    specificUserSource: SpecificUserSource | null;
    fixedUserId: string | null;
  }): Promise<WorkflowAssignmentRule>;
  listAssignmentRules(workflowStepId: string): Promise<WorkflowAssignmentRule[]>;

  // --- Escalation rules ------------------------------------------------------
  createEscalationRule(input: {
    workflowStepId: string;
    escalateAfterHours: number;
    escalateToRoleCode: string;
    escalateToOrganizationUnitStrategy: OrganizationUnitStrategy;
    note: string | null;
  }): Promise<WorkflowEscalationRule>;
  findEscalationRule(workflowStepId: string): Promise<WorkflowEscalationRule | null>;

  // --- Demo (generic dummy) object ------------------------------------------
  createDemoTransaction(input: {
    tenantId: string;
    title: string;
    createdBy: string;
  }): Promise<DemoTransaction>;
  findDemoTransactionById(id: string): Promise<DemoTransaction | null>;

  // --- Instances ------------------------------------------------------------
  createInstance(input: {
    tenantId: string;
    workflowDefinitionId: string;
    workflowVersionId: string;
    entityType: string;
    entityId: string;
    currentStepId: string;
    contextData: Record<string, unknown>;
    startedBy: string;
  }): Promise<WorkflowInstance>;
  findInstanceById(id: string): Promise<WorkflowInstance | null>;
  findInstancesByIds(ids: string[]): Promise<WorkflowInstance[]>;
  listInstances(tenantId: string): Promise<WorkflowInstance[]>;
  updateInstanceCurrentStep(id: string, stepId: string): Promise<void>;
  completeInstance(id: string, status: WorkflowInstanceStatus): Promise<void>;
  /** Checkpoint 1B — generic, entity-agnostic reopen: resets a completed
   * Instance back to `in_progress` at `stepId`, clearing `completedAt`.
   * See `WorkflowService.reopenInstance`. */
  reopenInstance(id: string, stepId: string): Promise<void>;

  // --- Instance assignments --------------------------------------------------
  createAssignment(input: {
    workflowInstanceId: string;
    stepId: string;
    assignmentType: WorkflowAssignmentType;
    assignedRoleCode: string | null;
    assignedOrganizationUnitId: string | null;
    assignedUserId: string | null;
    dueAt: Date | null;
  }): Promise<WorkflowInstanceAssignment>;
  findAssignmentById(id: string): Promise<WorkflowInstanceAssignment | null>;
  listAssignmentsForInstance(workflowInstanceId: string): Promise<WorkflowInstanceAssignment[]>;
  listAssignmentsForInstances(workflowInstanceIds: string[]): Promise<WorkflowInstanceAssignment[]>;
  listPendingAssignmentsByTenant(tenantId: string): Promise<WorkflowInstanceAssignment[]>;
  /** Site-scoping (batched): every Assignment, in any status, that could make
   * `userId` "associated" with its Instance — a specific_user row naming them,
   * or a role row for `roleCode` (the actor's ACTIVE role; null = none). One
   * query for the whole tenant (or the given Instances) instead of one per
   * Instance. */
  listAssociationCandidateAssignments(
    tenantId: string,
    userId: string,
    roleCode: string | null,
    instanceIds?: string[],
  ): Promise<WorkflowInstanceAssignment[]>;
  /** Site-scoping (batched): Instances of the tenant narrowed in SQL to those
   * started by `startedBy`, in `instanceIds`, owned by one of
   * `organizationUnitIds` (`context_data.organizationUnitId`) or stamped with
   * one of `legalEntityIds` (`context_data.legalEntityId`). */
  listInstancesNarrowed(
    tenantId: string,
    narrow: {
      startedBy: string;
      instanceIds: string[];
      organizationUnitIds: string[];
      legalEntityIds: string[];
      customerIds: string[];
    },
  ): Promise<WorkflowInstance[]>;
  /** Ids of Instances started by `userId` (optionally limited to `instanceIds`). */
  listInstanceIdsStartedBy(
    tenantId: string,
    userId: string,
    instanceIds?: string[],
  ): Promise<string[]>;
  listOverdueAssignments(tenantId: string): Promise<WorkflowInstanceAssignment[]>;
  /** ADR-0008: atomic optimistic claim. Succeeds (returns the row) only
   * if the Assignment is still `pending` AND (unclaimed, already claimed
   * by this same user, or the existing claim has expired past
   * `ttlSeconds`) — a single `UPDATE ... WHERE ... RETURNING`, so two
   * concurrent claims can never both succeed. Returns null if the claim
   * was lost to someone else. */
  claimAssignment(id: string, userId: string, ttlSeconds: number): Promise<WorkflowInstanceAssignment | null>;
  releaseClaim(id: string, userId: string): Promise<WorkflowInstanceAssignment | null>;
  updateAssignmentStatus(
    id: string,
    fields: {
      status: WorkflowAssignmentStatus;
      decidedBy?: string | null;
      decidedAt?: Date | null;
      decisionActionCode?: string | null;
      comment?: string | null;
    },
  ): Promise<WorkflowInstanceAssignment>;

  // --- History ---------------------------------------------------------------
  appendHistory(input: {
    workflowInstanceId: string;
    fromStepId: string | null;
    toStepId: string | null;
    actionCode: string;
    actorUserId: string | null;
    comment: string | null;
    metadata: Record<string, unknown> | null;
    /** Epic 1 (§4.1 D): the approved document amount on an 'approve'
     * decision — NULL everywhere else. */
    decisionAmount?: string | null;
  }): Promise<WorkflowHistoryEntry>;
  listHistory(workflowInstanceId: string): Promise<WorkflowHistoryEntry[]>;

  // --- Notification-ready hooks ------------------------------------------------
  recordNotificationHook(input: {
    workflowInstanceId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<WorkflowNotificationHook>;
}
