import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  ConditionExpression,
  DemoTransaction,
  OrganizationUnitStrategy,
  SpecificUserSource,
  WorkflowAssignmentRule,
  WorkflowAssignmentStatus,
  WorkflowAssignmentType,
  WorkflowDefinition,
  WorkflowEscalationRule,
  WorkflowHistoryEntry,
  WorkflowInstance,
  WorkflowInstanceAssignment,
  WorkflowInstanceStatus,
  WorkflowNotificationHook,
  WorkflowRepository,
  WorkflowStep,
  WorkflowStepType,
  WorkflowTerminalStatus,
  WorkflowTransition,
  WorkflowVersion,
} from "../../../domain/workflow/workflow.entity.js";
import { NotFoundError } from "../../../domain/shared-kernel/errors.js";

// The invariant guarded here ("no pending specific_user assignment may
// outlive its assignee's activation") lives on the user row, so this locks
// that row only. It deliberately skips the tenant lock inGovernedTransaction
// takes, which would serialize every write in the tenant behind ordinary
// workflow traffic. The lock set is a strict subset of that protocol's
// (tenant -> user), so the two can never deadlock against each other.
async function withLockedUser<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  run: (client: PoolClient, user: { status: string; deleted_at: Date | null }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string; deleted_at: Date | null }>(
      `SELECT status, deleted_at FROM users
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [userId, tenantId],
    );
    if (!locked.rows[0]) throw new NotFoundError("User", userId);
    const result = await run(client, locked.rows[0]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PgWorkflowRepository implements WorkflowRepository {
  constructor(private readonly pool: Pool) {}

  // --- Definitions ---------------------------------------------------

  async createDefinition(input: {
    tenantId: string;
    code: string;
    name: string;
    entityType: string;
    description: string;
    createdBy: string;
  }): Promise<WorkflowDefinition> {
    const result = await this.pool.query(
      `INSERT INTO workflow_definitions (tenant_id, code, name, entity_type, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.tenantId, input.code, input.name, input.entityType, input.description, input.createdBy],
    );
    return mapDefinition(result.rows[0]);
  }

  async findDefinitionByCode(tenantId: string, code: string): Promise<WorkflowDefinition | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_definitions WHERE tenant_id = $1 AND code = $2`,
      [tenantId, code],
    );
    return result.rows[0] ? mapDefinition(result.rows[0]) : null;
  }

  async listDefinitions(tenantId: string): Promise<WorkflowDefinition[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_definitions WHERE tenant_id = $1 ORDER BY code`,
      [tenantId],
    );
    return result.rows.map(mapDefinition);
  }

  // --- Versions --------------------------------------------------------

  async createVersion(input: {
    workflowDefinitionId: string;
    versionNumber: number;
    createdBy: string;
  }): Promise<WorkflowVersion> {
    const result = await this.pool.query(
      `INSERT INTO workflow_versions (workflow_definition_id, version_number, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.workflowDefinitionId, input.versionNumber, input.createdBy],
    );
    return mapVersion(result.rows[0]);
  }

  async findVersion(workflowDefinitionId: string, versionNumber: number): Promise<WorkflowVersion | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_versions WHERE workflow_definition_id = $1 AND version_number = $2`,
      [workflowDefinitionId, versionNumber],
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  async findVersionById(id: string): Promise<WorkflowVersion | null> {
    const result = await this.pool.query(`SELECT * FROM workflow_versions WHERE id = $1`, [id]);
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  async findCurrentVersion(workflowDefinitionId: string): Promise<WorkflowVersion | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_versions WHERE workflow_definition_id = $1 AND is_current = true`,
      [workflowDefinitionId],
    );
    return result.rows[0] ? mapVersion(result.rows[0]) : null;
  }

  async listVersions(workflowDefinitionId: string): Promise<WorkflowVersion[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_versions WHERE workflow_definition_id = $1 ORDER BY version_number`,
      [workflowDefinitionId],
    );
    return result.rows.map(mapVersion);
  }

  async getNextVersionNumber(workflowDefinitionId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM workflow_versions WHERE workflow_definition_id = $1`,
      [workflowDefinitionId],
    );
    return Number(result.rows[0].next);
  }

  async publishVersion(id: string): Promise<WorkflowVersion> {
    const version = await this.findVersionById(id);
    if (!version) throw new NotFoundError("WorkflowVersion", id);

    // Two sequential statements, no explicit transaction wrapper — same
    // simplification used everywhere else in this codebase (see
    // docs/decision-log.md Checkpoint 0D risk note). The partial unique
    // index (workflow_versions_current_unique) still guarantees at most
    // one is_current=true row even if this were interleaved with a
    // concurrent publish — the second UPDATE below would simply fail the
    // unique index and surface as a 500, an acceptable Phase 0 trade-off
    // for a low-frequency, human-triggered design-time operation.
    await this.pool.query(
      `UPDATE workflow_versions SET is_current = false
        WHERE workflow_definition_id = $1 AND is_current = true`,
      [version.workflowDefinitionId],
    );
    const result = await this.pool.query(
      `UPDATE workflow_versions
          SET is_current = true, status = 'published', published_at = now()
        WHERE id = $1
        RETURNING *`,
      [id],
    );
    return mapVersion(result.rows[0]);
  }

  // --- Steps -------------------------------------------------------------

  async createStep(input: {
    workflowVersionId: string;
    code: string;
    name: string;
    stepType: WorkflowStepType;
    isInitial: boolean;
    isTerminal: boolean;
    terminalStatus: WorkflowTerminalStatus | null;
    slaHours: number | null;
    sequenceOrder: number;
  }): Promise<WorkflowStep> {
    const result = await this.pool.query(
      `INSERT INTO workflow_steps
         (workflow_version_id, code, name, step_type, is_initial, is_terminal, terminal_status, sla_hours, sequence_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.workflowVersionId,
        input.code,
        input.name,
        input.stepType,
        input.isInitial,
        input.isTerminal,
        input.terminalStatus,
        input.slaHours,
        input.sequenceOrder,
      ],
    );
    return mapStep(result.rows[0]);
  }

  async listSteps(workflowVersionId: string): Promise<WorkflowStep[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_steps WHERE workflow_version_id = $1 ORDER BY sequence_order`,
      [workflowVersionId],
    );
    return result.rows.map(mapStep);
  }

  async findStepByCode(workflowVersionId: string, code: string): Promise<WorkflowStep | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_steps WHERE workflow_version_id = $1 AND code = $2`,
      [workflowVersionId, code],
    );
    return result.rows[0] ? mapStep(result.rows[0]) : null;
  }

  async findStepById(id: string): Promise<WorkflowStep | null> {
    const result = await this.pool.query(`SELECT * FROM workflow_steps WHERE id = $1`, [id]);
    return result.rows[0] ? mapStep(result.rows[0]) : null;
  }

  async findInitialStep(workflowVersionId: string): Promise<WorkflowStep | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_steps WHERE workflow_version_id = $1 AND is_initial = true`,
      [workflowVersionId],
    );
    return result.rows[0] ? mapStep(result.rows[0]) : null;
  }

  // --- Transitions -------------------------------------------------------

  async createTransition(input: {
    workflowVersionId: string;
    fromStepId: string;
    toStepId: string;
    actionCode: string;
    name: string;
    conditionExpression: ConditionExpression | null;
    sortOrder: number;
  }): Promise<WorkflowTransition> {
    const result = await this.pool.query(
      `INSERT INTO workflow_transitions
         (workflow_version_id, from_step_id, to_step_id, action_code, name, condition_expression, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.workflowVersionId,
        input.fromStepId,
        input.toStepId,
        input.actionCode,
        input.name,
        input.conditionExpression ? JSON.stringify(input.conditionExpression) : null,
        input.sortOrder,
      ],
    );
    return mapTransition(result.rows[0]);
  }

  async listTransitionsFromStep(stepId: string): Promise<WorkflowTransition[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_transitions WHERE from_step_id = $1 ORDER BY sort_order`,
      [stepId],
    );
    return result.rows.map(mapTransition);
  }

  // --- Assignment rules ----------------------------------------------------

  async createAssignmentRule(input: {
    workflowStepId: string;
    sortOrder: number;
    conditionExpression: ConditionExpression | null;
    assignmentType: WorkflowAssignmentType;
    roleCode: string | null;
    organizationUnitStrategy: OrganizationUnitStrategy | null;
    specificUserSource: SpecificUserSource | null;
    fixedUserId: string | null;
  }): Promise<WorkflowAssignmentRule> {
    const result = await this.pool.query(
      `INSERT INTO workflow_assignment_rules
         (workflow_step_id, sort_order, condition_expression, assignment_type, role_code,
          organization_unit_strategy, specific_user_source, fixed_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.workflowStepId,
        input.sortOrder,
        input.conditionExpression ? JSON.stringify(input.conditionExpression) : null,
        input.assignmentType,
        input.roleCode,
        input.organizationUnitStrategy,
        input.specificUserSource,
        input.fixedUserId,
      ],
    );
    return mapAssignmentRule(result.rows[0]);
  }

  async listAssignmentRules(workflowStepId: string): Promise<WorkflowAssignmentRule[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_assignment_rules WHERE workflow_step_id = $1 ORDER BY sort_order`,
      [workflowStepId],
    );
    return result.rows.map(mapAssignmentRule);
  }

  // --- Escalation rules ------------------------------------------------------

  async createEscalationRule(input: {
    workflowStepId: string;
    escalateAfterHours: number;
    escalateToRoleCode: string;
    escalateToOrganizationUnitStrategy: OrganizationUnitStrategy;
    note: string | null;
  }): Promise<WorkflowEscalationRule> {
    const result = await this.pool.query(
      `INSERT INTO workflow_escalation_rules
         (workflow_step_id, escalate_after_hours, escalate_to_role_code, escalate_to_organization_unit_strategy, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.workflowStepId,
        input.escalateAfterHours,
        input.escalateToRoleCode,
        input.escalateToOrganizationUnitStrategy,
        input.note,
      ],
    );
    return mapEscalationRule(result.rows[0]);
  }

  async findEscalationRule(workflowStepId: string): Promise<WorkflowEscalationRule | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_escalation_rules WHERE workflow_step_id = $1`,
      [workflowStepId],
    );
    return result.rows[0] ? mapEscalationRule(result.rows[0]) : null;
  }

  // --- Demo (generic dummy) object ------------------------------------------

  async createDemoTransaction(input: {
    tenantId: string;
    title: string;
    createdBy: string;
  }): Promise<DemoTransaction> {
    const result = await this.pool.query(
      `INSERT INTO demo_transactions (tenant_id, title, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [input.tenantId, input.title, input.createdBy],
    );
    return mapDemoTransaction(result.rows[0]);
  }

  async findDemoTransactionById(id: string): Promise<DemoTransaction | null> {
    const result = await this.pool.query(`SELECT * FROM demo_transactions WHERE id = $1`, [id]);
    return result.rows[0] ? mapDemoTransaction(result.rows[0]) : null;
  }

  // --- Instances ------------------------------------------------------------

  async createInstance(input: {
    tenantId: string;
    workflowDefinitionId: string;
    workflowVersionId: string;
    entityType: string;
    entityId: string;
    currentStepId: string;
    contextData: Record<string, unknown>;
    startedBy: string;
  }): Promise<WorkflowInstance> {
    const result = await this.pool.query(
      `INSERT INTO workflow_instances
         (tenant_id, workflow_definition_id, workflow_version_id, entity_type, entity_id,
          current_step_id, context_data, started_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.tenantId,
        input.workflowDefinitionId,
        input.workflowVersionId,
        input.entityType,
        input.entityId,
        input.currentStepId,
        JSON.stringify(input.contextData),
        input.startedBy,
      ],
    );
    return mapInstance(result.rows[0]);
  }

  async findInstanceById(id: string): Promise<WorkflowInstance | null> {
    const result = await this.pool.query(`SELECT * FROM workflow_instances WHERE id = $1`, [id]);
    return result.rows[0] ? mapInstance(result.rows[0]) : null;
  }

  async findInstancesByIds(ids: string[]): Promise<WorkflowInstance[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM workflow_instances WHERE id = ANY($1)`,
      [ids],
    );
    return result.rows.map(mapInstance);
  }

  async listInstances(tenantId: string): Promise<WorkflowInstance[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_instances WHERE tenant_id = $1 ORDER BY started_at DESC`,
      [tenantId],
    );
    return result.rows.map(mapInstance);
  }

  async updateInstanceCurrentStep(id: string, stepId: string): Promise<void> {
    await this.pool.query(`UPDATE workflow_instances SET current_step_id = $2 WHERE id = $1`, [
      id,
      stepId,
    ]);
  }

  async completeInstance(id: string, status: WorkflowInstanceStatus): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_instances SET status = $2, completed_at = now() WHERE id = $1`,
      [id, status],
    );
  }

  async reopenInstance(id: string, stepId: string): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_instances SET status = 'in_progress', completed_at = NULL, current_step_id = $2 WHERE id = $1`,
      [id, stepId],
    );
  }

  // --- Instance assignments --------------------------------------------------

  async createAssignment(input: {
    workflowInstanceId: string;
    stepId: string;
    assignmentType: WorkflowAssignmentType;
    assignedRoleCode: string | null;
    assignedOrganizationUnitId: string | null;
    assignedUserId: string | null;
    dueAt: Date | null;
  }): Promise<WorkflowInstanceAssignment> {
    const insert = async (client: Pool | PoolClient) => {
      const result = await client.query(
        `INSERT INTO workflow_instance_assignments
           (workflow_instance_id, step_id, assignment_type, assigned_role_code,
            assigned_organization_unit_id, assigned_user_id, due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.workflowInstanceId,
          input.stepId,
          input.assignmentType,
          input.assignedRoleCode,
          input.assignedOrganizationUnitId,
          input.assignedUserId,
          input.dueAt,
        ],
      );
      return mapAssignment(result.rows[0]);
    };

    if (input.assignmentType !== "specific_user" || !input.assignedUserId) {
      return insert(this.pool);
    }

    const userId = input.assignedUserId;

    const instance = await this.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM workflow_instances WHERE id = $1`,
      [input.workflowInstanceId],
    );
    if (!instance.rows[0]) {
      throw new NotFoundError("WorkflowInstance", input.workflowInstanceId);
    }

    return withLockedUser(this.pool, instance.rows[0].tenant_id, userId, async (client, user) => {
      if (user.status !== "active" || user.deleted_at !== null) {
        throw new NotFoundError("User", userId);
      }
      return insert(client);
    });
  }

  async findAssignmentById(id: string): Promise<WorkflowInstanceAssignment | null> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_instance_assignments WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapAssignment(result.rows[0]) : null;
  }

  async listAssignmentsForInstance(workflowInstanceId: string): Promise<WorkflowInstanceAssignment[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_instance_assignments WHERE workflow_instance_id = $1 ORDER BY assigned_at`,
      [workflowInstanceId],
    );
    return result.rows.map(mapAssignment);
  }

  async listAssignmentsForInstances(workflowInstanceIds: string[]): Promise<WorkflowInstanceAssignment[]> {
    if (workflowInstanceIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM workflow_instance_assignments WHERE workflow_instance_id = ANY($1) ORDER BY assigned_at`,
      [workflowInstanceIds],
    );
    return result.rows.map(mapAssignment);
  }

  async listPendingAssignmentsByTenant(tenantId: string): Promise<WorkflowInstanceAssignment[]> {
    const result = await this.pool.query(
      `SELECT wia.* FROM workflow_instance_assignments wia
         JOIN workflow_instances wi ON wi.id = wia.workflow_instance_id
        WHERE wi.tenant_id = $1 AND wia.status = 'pending'
        ORDER BY wia.assigned_at`,
      [tenantId],
    );
    return result.rows.map(mapAssignment);
  }

  async listAssociationCandidateAssignments(
    tenantId: string,
    userId: string,
    roleCode: string | null,
    instanceIds?: string[],
  ): Promise<WorkflowInstanceAssignment[]> {
    const result = await this.pool.query(
      `SELECT wia.* FROM workflow_instance_assignments wia
         JOIN workflow_instances wi ON wi.id = wia.workflow_instance_id
        WHERE wi.tenant_id = $1
          AND ($4::uuid[] IS NULL OR wia.workflow_instance_id = ANY($4::uuid[]))
          AND (
            (wia.assignment_type = 'specific_user' AND wia.assigned_user_id = $2)
            OR (wia.assignment_type <> 'specific_user' AND $3::text IS NOT NULL AND wia.assigned_role_code = $3)
          )
        ORDER BY wia.assigned_at`,
      [tenantId, userId, roleCode, instanceIds ?? null],
    );
    return result.rows.map(mapAssignment);
  }

  async listInstancesNarrowed(
    tenantId: string,
    narrow: {
      startedBy: string;
      instanceIds: string[];
      organizationUnitIds: string[];
      legalEntityIds: string[];
      customerIds: string[];
    },
  ): Promise<WorkflowInstance[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_instances
        WHERE tenant_id = $1
          AND (
            started_by = $2
            OR id = ANY($3::uuid[])
            OR context_data->>'organizationUnitId' = ANY($4::text[])
            OR context_data->>'legalEntityId' = ANY($5::text[])
            OR context_data->>'customerId' = ANY($6::text[])
          )
        ORDER BY started_at DESC`,
      [
        tenantId,
        narrow.startedBy,
        narrow.instanceIds,
        narrow.organizationUnitIds,
        narrow.legalEntityIds,
        narrow.customerIds,
      ],
    );
    return result.rows.map(mapInstance);
  }

  async listInstanceIdsStartedBy(
    tenantId: string,
    userId: string,
    instanceIds?: string[],
  ): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT id FROM workflow_instances
        WHERE tenant_id = $1 AND started_by = $2
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [tenantId, userId, instanceIds ?? null],
    );
    return result.rows.map((r) => r.id as string);
  }

  async claimAssignment(id: string, userId: string, ttlSeconds: number): Promise<WorkflowInstanceAssignment | null> {
    const result = await this.pool.query(
      `UPDATE workflow_instance_assignments
          SET claimed_by_user_id = $2, claimed_at = now()
        WHERE id = $1
          AND status = 'pending'
          AND (
            claimed_by_user_id IS NULL
            OR claimed_by_user_id = $2
            OR claimed_at < now() - ($3 || ' seconds')::interval
          )
        RETURNING *`,
      [id, userId, ttlSeconds],
    );
    return result.rows[0] ? mapAssignment(result.rows[0]) : null;
  }

  async releaseClaim(id: string, userId: string): Promise<WorkflowInstanceAssignment | null> {
    const result = await this.pool.query(
      `UPDATE workflow_instance_assignments
          SET claimed_by_user_id = NULL, claimed_at = NULL
        WHERE id = $1 AND claimed_by_user_id = $2 AND status = 'pending'
        RETURNING *`,
      [id, userId],
    );
    return result.rows[0] ? mapAssignment(result.rows[0]) : null;
  }

  async listOverdueAssignments(tenantId: string): Promise<WorkflowInstanceAssignment[]> {
    const result = await this.pool.query(
      `SELECT wia.* FROM workflow_instance_assignments wia
         JOIN workflow_instances wi ON wi.id = wia.workflow_instance_id
        WHERE wi.tenant_id = $1 AND wia.status = 'pending'
          AND wia.due_at IS NOT NULL AND wia.due_at < now()
        ORDER BY wia.due_at`,
      [tenantId],
    );
    return result.rows.map(mapAssignment);
  }

  async updateAssignmentStatus(
    id: string,
    fields: {
      status: WorkflowAssignmentStatus;
      decidedBy?: string | null;
      decidedAt?: Date | null;
      decisionActionCode?: string | null;
      comment?: string | null;
    },
  ): Promise<WorkflowInstanceAssignment> {
    const assignment = await this.pool.query<{ tenant_id: string; assigned_user_id: string | null }>(
      `SELECT wi.tenant_id, wia.assigned_user_id
         FROM workflow_instance_assignments wia
         JOIN workflow_instances wi ON wi.id = wia.workflow_instance_id
        WHERE wia.id = $1`,
      [id],
    );
    if (!assignment.rows[0]) throw new NotFoundError("WorkflowInstanceAssignment", id);

    const update = async (client: Pool | PoolClient) => {
      const result = await client.query(
        `UPDATE workflow_instance_assignments
            SET status = $2, decided_by = $3, decided_at = $4, decision_action_code = $5, comment = $6
          WHERE id = $1
          RETURNING *`,
        [
          id,
          fields.status,
          fields.decidedBy ?? null,
          fields.decidedAt ?? null,
          fields.decisionActionCode ?? null,
          fields.comment ?? null,
        ],
      );
      if (!result.rows[0]) throw new NotFoundError("WorkflowInstanceAssignment", id);
      return mapAssignment(result.rows[0]);
    };

    const assignedUserId = assignment.rows[0].assigned_user_id;
    if (assignedUserId === null) return update(this.pool);
    return withLockedUser(this.pool, assignment.rows[0].tenant_id, assignedUserId, (client) => update(client));
  }

  // --- History ---------------------------------------------------------------

  async appendHistory(input: {
    workflowInstanceId: string;
    fromStepId: string | null;
    toStepId: string | null;
    actionCode: string;
    actorUserId: string | null;
    comment: string | null;
    metadata: Record<string, unknown> | null;
    decisionAmount?: string | null;
  }): Promise<WorkflowHistoryEntry> {
    const result = await this.pool.query(
      `INSERT INTO workflow_history
         (workflow_instance_id, from_step_id, to_step_id, action_code, actor_user_id, comment, metadata, decision_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.workflowInstanceId,
        input.fromStepId,
        input.toStepId,
        input.actionCode,
        input.actorUserId,
        input.comment,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.decisionAmount ?? null,
      ],
    );
    return mapHistory(result.rows[0]);
  }

  async listHistory(workflowInstanceId: string): Promise<WorkflowHistoryEntry[]> {
    const result = await this.pool.query(
      `SELECT * FROM workflow_history WHERE workflow_instance_id = $1 ORDER BY occurred_at`,
      [workflowInstanceId],
    );
    return result.rows.map(mapHistory);
  }

  // --- Notification-ready hooks ------------------------------------------------

  async recordNotificationHook(input: {
    workflowInstanceId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<WorkflowNotificationHook> {
    const result = await this.pool.query(
      `INSERT INTO workflow_notification_hooks (workflow_instance_id, event_type, payload)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.workflowInstanceId, input.eventType, JSON.stringify(input.payload)],
    );
    return mapNotificationHook(result.rows[0]);
  }
}

// --- Row mappers ---------------------------------------------------------

function mapDefinition(row: QueryResultRow): WorkflowDefinition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    entityType: row.entity_type,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

function mapVersion(row: QueryResultRow): WorkflowVersion {
  return {
    id: row.id,
    workflowDefinitionId: row.workflow_definition_id,
    versionNumber: row.version_number,
    status: row.status,
    isCurrent: row.is_current,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

function mapStep(row: QueryResultRow): WorkflowStep {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    code: row.code,
    name: row.name,
    stepType: row.step_type,
    isInitial: row.is_initial,
    isTerminal: row.is_terminal,
    terminalStatus: row.terminal_status,
    slaHours: row.sla_hours,
    sequenceOrder: row.sequence_order,
  };
}

function mapTransition(row: QueryResultRow): WorkflowTransition {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    fromStepId: row.from_step_id,
    toStepId: row.to_step_id,
    actionCode: row.action_code,
    name: row.name,
    conditionExpression: row.condition_expression,
    sortOrder: row.sort_order,
  };
}

function mapAssignmentRule(row: QueryResultRow): WorkflowAssignmentRule {
  return {
    id: row.id,
    workflowStepId: row.workflow_step_id,
    sortOrder: row.sort_order,
    conditionExpression: row.condition_expression,
    assignmentType: row.assignment_type,
    roleCode: row.role_code,
    organizationUnitStrategy: row.organization_unit_strategy,
    specificUserSource: row.specific_user_source,
    fixedUserId: row.fixed_user_id,
  };
}

function mapEscalationRule(row: QueryResultRow): WorkflowEscalationRule {
  return {
    id: row.id,
    workflowStepId: row.workflow_step_id,
    escalateAfterHours: row.escalate_after_hours,
    escalateToRoleCode: row.escalate_to_role_code,
    escalateToOrganizationUnitStrategy: row.escalate_to_organization_unit_strategy,
    note: row.note,
  };
}

function mapDemoTransaction(row: QueryResultRow): DemoTransaction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapInstance(row: QueryResultRow): WorkflowInstance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowDefinitionId: row.workflow_definition_id,
    workflowVersionId: row.workflow_version_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    currentStepId: row.current_step_id,
    status: row.status,
    contextData: row.context_data,
    startedBy: row.started_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapAssignment(row: QueryResultRow): WorkflowInstanceAssignment {
  return {
    id: row.id,
    workflowInstanceId: row.workflow_instance_id,
    stepId: row.step_id,
    assignmentType: row.assignment_type,
    assignedRoleCode: row.assigned_role_code,
    assignedOrganizationUnitId: row.assigned_organization_unit_id,
    assignedUserId: row.assigned_user_id,
    assignedAt: row.assigned_at,
    dueAt: row.due_at,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionActionCode: row.decision_action_code,
    comment: row.comment,
    claimedByUserId: row.claimed_by_user_id,
    claimedAt: row.claimed_at,
  };
}

function mapHistory(row: QueryResultRow): WorkflowHistoryEntry {
  return {
    id: row.id,
    workflowInstanceId: row.workflow_instance_id,
    fromStepId: row.from_step_id,
    toStepId: row.to_step_id,
    actionCode: row.action_code,
    actorUserId: row.actor_user_id,
    comment: row.comment,
    metadata: row.metadata,
    decisionAmount: row.decision_amount,
    occurredAt: row.occurred_at,
  };
}

function mapNotificationHook(row: QueryResultRow): WorkflowNotificationHook {
  return {
    id: row.id,
    workflowInstanceId: row.workflow_instance_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}
