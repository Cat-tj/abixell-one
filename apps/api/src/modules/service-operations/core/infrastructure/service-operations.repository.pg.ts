import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AddCostItemInput,
  CustomerInvoice,
  CustomerInvoiceListFilter,
  CustomerInvoiceListItem,
  CreateServiceDefinitionInput,
  CreateServingLogInput,
  CreateWorkOrderInput,
  CreateWorkRequestInput,
  MarkCustomerAcceptedInput,
  MarkCustomerRejectedInput,
  ScheduleWorkOrderInput,
  ServiceDefinition,
  ServiceDefinitionChecklistItem,
  ServiceOperationsRepository,
  UpdateServingLogInput,
  WorkOrder,
  WorkOrderAcceptanceToken,
  WorkOrderChecklistItem,
  WorkOrderCostItem,
  WorkOrderCostType,
  WorkOrderServingLog,
  WorkRequest,
} from "../domain/service-operations.entity.js";
import { ConflictError } from "../../../../domain/shared-kernel/errors.js";

export class PgServiceOperationsRepository implements ServiceOperationsRepository {
  constructor(private readonly pool: Pool) {}

  async findUserTenantId(userId: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT tenant_id FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    return r.rows[0]?.tenant_id ?? null;
  }

  // --- Service Definition ---------------------------------------------

  async createServiceDefinition(input: CreateServiceDefinitionInput): Promise<ServiceDefinition> {
    const result = await this.pool.query(
      `INSERT INTO service_definitions (tenant_id, code, name, description, category, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [input.tenantId, input.code, input.name, input.description ?? null, input.category ?? null, input.createdBy],
    );
    return toServiceDefinition(result.rows[0]);
  }

  async findServiceDefinitionById(id: string): Promise<ServiceDefinition | null> {
    const r = await this.pool.query(`SELECT * FROM service_definitions WHERE id = $1`, [id]);
    return r.rows[0] ? toServiceDefinition(r.rows[0]) : null;
  }

  async findServiceDefinitionByCode(tenantId: string, code: string): Promise<ServiceDefinition | null> {
    const r = await this.pool.query(
      `SELECT * FROM service_definitions WHERE tenant_id = $1 AND code = $2`,
      [tenantId, code],
    );
    return r.rows[0] ? toServiceDefinition(r.rows[0]) : null;
  }

  async listServiceDefinitions(tenantId: string): Promise<ServiceDefinition[]> {
    const r = await this.pool.query(
      `SELECT * FROM service_definitions WHERE tenant_id = $1 ORDER BY code`,
      [tenantId],
    );
    return r.rows.map(toServiceDefinition);
  }

  async setServiceDefinitionActive(
    id: string,
    isActive: boolean,
    updatedBy: string | null,
  ): Promise<ServiceDefinition | null> {
    const r = await this.pool.query(
      `UPDATE service_definitions SET is_active = $2, updated_by = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, isActive, updatedBy],
    );
    return r.rows[0] ? toServiceDefinition(r.rows[0]) : null;
  }

  async addChecklistTemplateItem(input: {
    serviceDefinitionId: string;
    code: string;
    label: string;
    isRequired: boolean;
    sortOrder: number;
  }): Promise<ServiceDefinitionChecklistItem> {
    const r = await this.pool.query(
      `INSERT INTO service_definition_checklist_items (service_definition_id, code, label, is_required, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.serviceDefinitionId, input.code, input.label, input.isRequired, input.sortOrder],
    );
    return toTemplateItem(r.rows[0]);
  }

  async listChecklistTemplateItems(serviceDefinitionId: string): Promise<ServiceDefinitionChecklistItem[]> {
    const r = await this.pool.query(
      `SELECT * FROM service_definition_checklist_items
        WHERE service_definition_id = $1 ORDER BY sort_order, code`,
      [serviceDefinitionId],
    );
    return r.rows.map(toTemplateItem);
  }

  // --- Work Request ----------------------------------------------------

  async createWorkRequest(input: CreateWorkRequestInput): Promise<WorkRequest> {
    const r = await this.pool.query(
      `INSERT INTO work_requests
         (tenant_id, request_number, customer_id, contract_id, project_id, site_id,
          service_definition_id, description, priority, requested_by_user_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
      [
        input.tenantId,
        input.requestNumber,
        input.customerId,
        input.contractId ?? null,
        input.projectId ?? null,
        input.siteId ?? null,
        input.serviceDefinitionId,
        input.description,
        input.priority ?? null,
        input.requestedByUserId,
        input.createdBy,
      ],
    );
    return toWorkRequest(r.rows[0]);
  }

  async findWorkRequestById(id: string): Promise<WorkRequest | null> {
    const r = await this.pool.query(
      `SELECT * FROM work_requests WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return r.rows[0] ? toWorkRequest(r.rows[0]) : null;
  }

  async listWorkRequests(tenantId: string, filter: { customerIds?: string[] }): Promise<WorkRequest[]> {
    const conditions = [`tenant_id = $1`, `deleted_at IS NULL`];
    const params: unknown[] = [tenantId];
    if (filter.customerIds) {
      params.push(filter.customerIds);
      conditions.push(`customer_id = ANY($${params.length})`);
    }
    const r = await this.pool.query(
      `SELECT * FROM work_requests WHERE ${conditions.join(" AND ")} ORDER BY requested_at DESC`,
      params,
    );
    return r.rows.map(toWorkRequest);
  }

  async markWorkRequestConverted(
    id: string,
    workOrderId: string,
    updatedBy: string | null,
  ): Promise<WorkRequest | null> {
    // Guarded: an already-converted or cancelled request cannot convert again.
    const r = await this.pool.query(
      `UPDATE work_requests
          SET converted_work_order_id = $2, converted_at = now(), updated_by = $3, updated_at = now()
        WHERE id = $1 AND converted_work_order_id IS NULL AND cancelled_at IS NULL
        RETURNING *`,
      [id, workOrderId, updatedBy],
    );
    return r.rows[0] ? toWorkRequest(r.rows[0]) : null;
  }

  async cancelWorkRequest(id: string, reason: string | null, updatedBy: string | null): Promise<WorkRequest | null> {
    const r = await this.pool.query(
      `UPDATE work_requests
          SET cancelled_at = now(), cancellation_reason = $2, updated_by = $3, updated_at = now()
        WHERE id = $1 AND converted_work_order_id IS NULL AND cancelled_at IS NULL
        RETURNING *`,
      [id, reason, updatedBy],
    );
    return r.rows[0] ? toWorkRequest(r.rows[0]) : null;
  }

  // --- Work Order ------------------------------------------------------

  async createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder> {
    const r = await this.pool.query(
      `INSERT INTO work_orders
         (tenant_id, work_order_number, work_request_id, customer_id, contract_id, project_id, site_id,
          service_definition_id, title, description, priority, planned_start_at, planned_end_at, due_at,
          created_by, updated_by, wo_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16) RETURNING *`,
      [
        input.tenantId,
        input.workOrderNumber,
        input.workRequestId ?? null,
        input.customerId,
        input.contractId ?? null,
        input.projectId ?? null,
        input.siteId ?? null,
        input.serviceDefinitionId,
        input.title,
        input.description ?? null,
        input.priority ?? null,
        input.plannedStartAt ?? null,
        input.plannedEndAt ?? null,
        input.dueAt ?? null,
        input.createdBy,
        input.woType ?? "regular",
      ],
    );
    return toWorkOrder(r.rows[0]);
  }

  async findWorkOrderById(id: string): Promise<WorkOrder | null> {
    const r = await this.pool.query(`SELECT * FROM work_orders WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async listWorkOrders(
    tenantId: string,
    filter: {
      customerIds?: string[];
      assignedToUserId?: string;
      siteId?: string;
      visibleTo?: { customerIds: string[]; assignedToUserId: string; workflowInstanceIds: string[] };
    },
  ): Promise<WorkOrder[]> {
    const conditions = [`tenant_id = $1`, `deleted_at IS NULL`];
    const params: unknown[] = [tenantId];
    if (filter.visibleTo) {
      params.push(filter.visibleTo.customerIds, filter.visibleTo.assignedToUserId, filter.visibleTo.workflowInstanceIds);
      const n = params.length;
      conditions.push(
        `(customer_id = ANY($${n - 2}::uuid[]) OR assigned_to_user_id = $${n - 1} OR workflow_instance_id = ANY($${n}::uuid[]))`,
      );
    }
    if (filter.customerIds) {
      params.push(filter.customerIds);
      conditions.push(`customer_id = ANY($${params.length})`);
    }
    if (filter.assignedToUserId) {
      params.push(filter.assignedToUserId);
      conditions.push(`assigned_to_user_id = $${params.length}`);
    }
    if (filter.siteId) {
      params.push(filter.siteId);
      conditions.push(`site_id = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM work_orders WHERE ${conditions.join(" AND ")}
        ORDER BY COALESCE(due_at, planned_start_at, created_at) ASC`,
      params,
    );
    return r.rows.map(toWorkOrder);
  }

  async setWorkOrderWorkflowInstance(id: string, workflowInstanceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE work_orders SET workflow_instance_id = $2, updated_at = now() WHERE id = $1`,
      [id, workflowInstanceId],
    );
  }

  async assignWorkOrder(id: string, assigneeUserId: string, assignedByUserId: string): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
          SET assigned_to_user_id = $2, assigned_by_user_id = $3, assigned_at = now(),
              updated_by = $3, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, assigneeUserId, assignedByUserId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async scheduleWorkOrder(
    id: string,
    input: ScheduleWorkOrderInput,
    updatedBy: string | null,
  ): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
          SET planned_start_at = $2, planned_end_at = $3, due_at = $4, updated_by = $5, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, input.plannedStartAt, input.plannedEndAt, input.dueAt, updatedBy],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async markWorkOrderStarted(id: string, userId: string): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
          SET started_at = now(), started_by_user_id = $2, updated_by = $2, updated_at = now()
        WHERE id = $1 AND started_at IS NULL AND deleted_at IS NULL RETURNING *`,
      [id, userId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async markWorkOrderCompleted(id: string, notes: string | null, userId: string): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
          SET completion_notes = $2, completed_at = now(), completed_by_user_id = $3,
              updated_by = $3, updated_at = now()
        WHERE id = $1 AND completed_at IS NULL AND deleted_at IS NULL RETURNING *`,
      [id, notes, userId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async markWorkOrderVerified(id: string, notes: string | null, userId: string): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
          SET verification_notes = $2, verified_at = now(), verified_by_user_id = $3,
              updated_by = $3, updated_at = now()
        WHERE id = $1 AND verified_at IS NULL AND deleted_at IS NULL RETURNING *`,
      [id, notes, userId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  // --- Work Order acceptance (WP-OPS-01 Phase 6) ----------------------

  async markCustomerAccepted(id: string, input: MarkCustomerAcceptedInput): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
          SET customer_accepted_at = now(),
              customer_accepted_via = $2,
              customer_acceptance_comment = $3,
              customer_rejected_at = NULL,
              customer_rejection_reason = NULL,
              updated_by = $4,
              updated_at = now()
        WHERE id = $1
          AND verified_at IS NOT NULL
          AND customer_accepted_at IS NULL
          AND deleted_at IS NULL
        RETURNING *`,
      [id, input.via, input.comment, input.acceptedBy],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async markCustomerRejected(id: string, input: MarkCustomerRejectedInput): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
          SET customer_rejected_at = now(),
              customer_rejection_reason = $2,
              updated_by = $3,
              updated_at = now()
        WHERE id = $1
          AND verified_at IS NOT NULL
          AND customer_accepted_at IS NULL
          AND deleted_at IS NULL
        RETURNING *`,
      [id, input.reason, input.rejectedBy],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async replaceAcceptanceToken(
    tenantId: string,
    workOrderId: string,
    tokenHash: string,
    expiresAt: Date,
    createdBy: string | null,
  ): Promise<WorkOrderAcceptanceToken> {
    // One live link per WO: revoke whatever is still usable, then insert.
    // Both statements run in one transaction so a reader can never observe
    // two live tokens for the same work order.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE work_order_acceptance_tokens
            SET revoked_at = now()
          WHERE tenant_id = $1 AND work_order_id = $2
            AND used_at IS NULL AND revoked_at IS NULL`,
        [tenantId, workOrderId],
      );
      const r = await client.query(
        `INSERT INTO work_order_acceptance_tokens
           (tenant_id, work_order_id, token_hash, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tenantId, workOrderId, tokenHash, expiresAt, createdBy],
      );
      await client.query("COMMIT");
      return toAcceptanceToken(r.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async findAcceptanceTokenByHash(tokenHash: string): Promise<WorkOrderAcceptanceToken | null> {
    const r = await this.pool.query(
      `SELECT * FROM work_order_acceptance_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return r.rows[0] ? toAcceptanceToken(r.rows[0]) : null;
  }

  async claimAcceptanceToken(id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE work_order_acceptance_tokens
          SET used_at = now()
        WHERE id = $1
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING id`,
      [id],
    );
    return r.rowCount === 1;
  }

  // --- Work Order checklist -------------------------------------------

  async createWorkOrderChecklistItems(
    workOrderId: string,
    items: {
      sourceChecklistItemId: string | null;
      code: string;
      label: string;
      isRequired: boolean;
      sortOrder: number;
    }[],
  ): Promise<WorkOrderChecklistItem[]> {
    const created: WorkOrderChecklistItem[] = [];
    for (const item of items) {
      const r = await this.pool.query(
        `INSERT INTO work_order_checklist_items
           (work_order_id, source_checklist_item_id, code, label, is_required, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [workOrderId, item.sourceChecklistItemId, item.code, item.label, item.isRequired, item.sortOrder],
      );
      created.push(toChecklistItem(r.rows[0]));
    }
    return created;
  }

  async listWorkOrderChecklistItems(workOrderId: string): Promise<WorkOrderChecklistItem[]> {
    const r = await this.pool.query(
      `SELECT * FROM work_order_checklist_items WHERE work_order_id = $1 ORDER BY sort_order, code`,
      [workOrderId],
    );
    return r.rows.map(toChecklistItem);
  }

  async findWorkOrderChecklistItem(id: string): Promise<WorkOrderChecklistItem | null> {
    const r = await this.pool.query(`SELECT * FROM work_order_checklist_items WHERE id = $1`, [id]);
    return r.rows[0] ? toChecklistItem(r.rows[0]) : null;
  }

  async setChecklistItemCompletion(
    id: string,
    input: { isCompleted: boolean; note: string | null; userId: string },
  ): Promise<WorkOrderChecklistItem | null> {
    const r = await this.pool.query(
      `UPDATE work_order_checklist_items
          SET is_completed = $2,
              note = $3,
              completed_at = CASE WHEN $2 THEN now() ELSE NULL END,
              completed_by_user_id = CASE WHEN $2 THEN $4::uuid ELSE NULL END
        WHERE id = $1 RETURNING *`,
      [id, input.isCompleted, input.note, input.userId],
    );
    return r.rows[0] ? toChecklistItem(r.rows[0]) : null;
  }

  // --- Work Order cost items (WP-OPS-02 Phase 6) -----------------------

  async insertCostItem(
    tenantId: string,
    workOrderId: string,
    input: AddCostItemInput,
  ): Promise<WorkOrderCostItem | null> {
    // DB-level finalize fence. FOR SHARE conflicts with the FOR UPDATE taken
    // by finalize: an insert racing a finalize either commits first (and is
    // counted in the sum) or waits, re-checks the committed row, and inserts
    // nothing (null → 409 in caller).
    const r = await this.pool.query(
      `INSERT INTO work_order_cost_items
         (tenant_id, work_order_id, cost_type, description, quantity, unit_cost, cost_center_id, recorded_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8
        WHERE EXISTS (
          SELECT 1 FROM work_orders
           WHERE id = $2 AND tenant_id = $1
             AND costs_finalized_at IS NULL AND deleted_at IS NULL
           FOR SHARE
        )
       RETURNING *`,
      [tenantId, workOrderId, input.costType, input.description, input.quantity, input.unitCost, input.costCenterId, input.recordedBy],
    );
    return r.rows[0] ? toCostItem(r.rows[0]) : null;
  }

  async listCostItems(tenantId: string, workOrderId: string): Promise<WorkOrderCostItem[]> {
    const r = await this.pool.query(
      `SELECT * FROM work_order_cost_items WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY recorded_at, id`,
      [tenantId, workOrderId],
    );
    return r.rows.map(toCostItem);
  }

  async sumCostItems(tenantId: string, workOrderId: string, client?: PoolClient): Promise<string> {
    const r = await (client ?? this.pool).query(
      `SELECT COALESCE(SUM(total_cost), 0) AS total FROM work_order_cost_items
        WHERE tenant_id = $1 AND work_order_id = $2`,
      [tenantId, workOrderId],
    );
    return String(r.rows[0]?.total ?? "0");
  }

  async lockWorkOrderForCostFinalize(id: string, client: PoolClient): Promise<WorkOrder | null> {
    const r = await client.query(
      `SELECT * FROM work_orders
        WHERE id = $1 AND costs_finalized_at IS NULL AND deleted_at IS NULL
        FOR UPDATE`,
      [id],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async finalizeWorkOrderCosts(
    id: string,
    costsTotal: string,
    updatedBy: string | null,
    client?: PoolClient,
  ): Promise<WorkOrder | null> {
    const r = await (client ?? this.pool).query(
      `UPDATE work_orders
          SET costs_finalized_at = now(), costs_total = $2, updated_by = $3, updated_at = now()
        WHERE id = $1 AND costs_finalized_at IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [id, costsTotal, updatedBy],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async costCenterBelongsToTenant(tenantId: string, costCenterId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM finance_cost_centers WHERE id = $1 AND tenant_id = $2`,
      [costCenterId, tenantId],
    );
    return r.rowCount === 1;
  }

  async legalEntityBelongsToTenant(tenantId: string, legalEntityId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
      [legalEntityId, tenantId],
    );
    return r.rowCount === 1;
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // --- Project membership (owner request: project isolation) -------------

  async listProjectMembers(tenantId: string, projectId: string): Promise<{ userId: string; roleCode: string | null; grantedAt: Date }[]> {
    const r = await this.pool.query(
      `SELECT user_id, role_code, granted_at FROM project_members
        WHERE tenant_id = $1 AND project_id = $2 AND revoked_at IS NULL ORDER BY granted_at`,
      [tenantId, projectId],
    );
    return r.rows;
  }

  async addProjectMember(tenantId: string, projectId: string, userId: string, roleCode: string | null, grantedBy: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_members (tenant_id, project_id, user_id, role_code, granted_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, user_id) DO UPDATE SET revoked_at=NULL, role_code=EXCLUDED.role_code`,
      [tenantId, projectId, userId, roleCode, grantedBy],
    );
  }

  async removeProjectMember(tenantId: string, projectId: string, userId: string, revokedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE project_members SET revoked_at=now(), revoked_by=$4
        WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 AND revoked_at IS NULL`,
      [tenantId, projectId, userId, revokedBy],
    );
  }

  /** All project ids the user is an active member of (for read filtering). */
  async listUserProjectIds(tenantId: string, userId: string): Promise<Set<string>> {
    const r = await this.pool.query(
      `SELECT project_id FROM project_members WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [tenantId, userId],
    );
    return new Set(r.rows.map((row: { project_id: string }) => row.project_id));
  }
  async isProjectMember(tenantId: string, projectId: string, userId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM project_members WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3 AND revoked_at IS NULL LIMIT 1`,
      [tenantId, projectId, userId],
    );
    return r.rows.length > 0;
  }

  async setWorkOrderProject(workOrderId: string, projectId: string | null, tenantId: string): Promise<void> {
    await this.pool.query(
      `UPDATE work_orders SET project_id=$2, updated_at=now() WHERE id=$1 AND tenant_id=$3`,
      [workOrderId, projectId, tenantId],
    );
  }

  async listProjectMemberIds(tenantId: string, projectId: string): Promise<Set<string>> {
    const r = await this.pool.query(
      `SELECT user_id FROM project_members WHERE tenant_id=$1 AND project_id=$2 AND revoked_at IS NULL`,
      [tenantId, projectId],
    );
    return new Set(r.rows.map((row: { user_id: string }) => row.user_id));
  }
  async findOpenAccountingPeriodIdForToday(tenantId: string, legalEntityId: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT id
         FROM accounting_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'open'
          AND date_from <= CURRENT_DATE AND date_to >= CURRENT_DATE
        LIMIT 1`,
      [tenantId, legalEntityId],
    );
    return r.rows[0]?.id ?? null;
  }

  // --- Customer invoice (WP-OPS-03 Phase 6) -----------------------------

  async insertCustomerInvoice(
    input: {
      tenantId: string;
      workOrderId: string;
      invoiceNumber: string;
      customerId: string;
      legalEntityId: string;
      periodId: string;
      costBasis: string;
      markupRate: string;
      isTaxable: boolean;
      taxRate: string | null;
      issuedBy: string;
    },
    client?: PoolClient,
  ): Promise<CustomerInvoice | null> {
    // Money in SQL NUMERIC (no JS float round-trip). `total_amount` is the sum
    // of the already-rounded parts so it always equals base + tax — the table
    // CHECK enforces the same identity. Tenant scoping is enforced by the
    // composite FK plus the WHERE EXISTS guard.
    // 23505 on `customer_invoices_number_uq` means a concurrent request got the
    // same invoice number; surface as ConflictError so the caller receives 409.
    let r;
    try {
      r = await (client ?? this.pool).query(
        `INSERT INTO customer_invoices
           (tenant_id, work_order_id, invoice_number, customer_id, legal_entity_id, period_id,
            cost_basis, markup_rate, base_amount, is_taxable, tax_rate, tax_amount, total_amount,
            issued_by)
         SELECT $1, $2, $3, $4, $5, $6,
                $7, $8, base.base_amount, $9, $10, base.tax_amount, base.base_amount + base.tax_amount,
                $11
           FROM (SELECT round($7::numeric * (1 + $8::numeric), 4) AS base_amount,
                        CASE WHEN $9 THEN round(round($7::numeric * (1 + $8::numeric), 4) * $10::numeric, 4)
                             ELSE 0 END AS tax_amount) base
          WHERE EXISTS (SELECT 1 FROM work_orders WHERE id = $2 AND tenant_id = $1 AND deleted_at IS NULL)
         ON CONFLICT (tenant_id, work_order_id) DO NOTHING
         RETURNING *`,
        [
          input.tenantId,
          input.workOrderId,
          input.invoiceNumber,
          input.customerId,
          input.legalEntityId,
          input.periodId,
          input.costBasis,
          input.markupRate,
          input.isTaxable,
          input.taxRate,
          input.issuedBy,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictError("Invoice number already in use; retry the create");
      }
      throw error;
    }
    return r.rows[0] ? toCustomerInvoice(r.rows[0]) : null;
  }

  async listInvoices(tenantId: string, filter: CustomerInvoiceListFilter): Promise<CustomerInvoiceListItem[]> {
    if (filter.workOrderIds.length === 0) return [];
    const params: unknown[] = [tenantId, filter.workOrderIds];
    const conditions = [`ci.tenant_id = $1`, `ci.work_order_id = ANY($2::uuid[])`];
    if (filter.arStatus) {
      params.push(filter.arStatus);
      conditions.push(`ci.ar_status = $${params.length}`);
    }
    if (filter.customerId) {
      params.push(filter.customerId);
      conditions.push(`ci.customer_id = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      conditions.push(`ci.issued_at >= $${params.length}::date`);
    }
    if (filter.to) {
      params.push(filter.to);
      conditions.push(`ci.issued_at < ($${params.length}::date + 1)`);
    }
    if (filter.q) {
      params.push(`%${filter.q}%`);
      const n = params.length;
      conditions.push(
        `(ci.invoice_number ILIKE $${n} OR c.name ILIKE $${n} OR wo.work_order_number ILIKE $${n} OR wo.title ILIKE $${n})`,
      );
    }
    const r = await this.pool.query(
      `SELECT ci.*, wo.work_order_number, wo.title AS work_order_title,
              c.name AS customer_name, s.name AS site_name
         FROM customer_invoices ci
         JOIN work_orders wo ON wo.tenant_id = ci.tenant_id AND wo.id = ci.work_order_id
         JOIN customers c ON c.tenant_id = ci.tenant_id AND c.id = ci.customer_id
         LEFT JOIN sites s ON s.id = wo.site_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY ci.issued_at DESC, ci.created_at DESC
        LIMIT 500`,
      params,
    );
    return r.rows.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoice_number,
      workOrderId: row.work_order_id,
      workOrderNumber: row.work_order_number,
      workOrderTitle: row.work_order_title,
      customerId: row.customer_id,
      customerName: row.customer_name,
      siteName: row.site_name ?? null,
      invoiceDate: row.issued_at,
      createdAt: row.created_at,
      costBasis: row.cost_basis,
      markupRate: row.markup_rate,
      baseAmount: row.base_amount,
      taxRate: row.tax_rate,
      taxAmount: row.tax_amount,
      totalAmount: row.total_amount,
      currency: row.currency,
      status: row.ar_status,
      arStatus: row.ar_status,
    }));
  }

  async findInvoiceByWorkOrder(tenantId: string, workOrderId: string): Promise<CustomerInvoice | null> {
    const r = await this.pool.query(
      `SELECT * FROM customer_invoices WHERE tenant_id = $1 AND work_order_id = $2`,
      [tenantId, workOrderId],
    );
    return r.rows[0] ? toCustomerInvoice(r.rows[0]) : null;
  }

  // ========================================================================
  // Work Order Serving Log (SO-CORE-016)
  // ========================================================================

  async createServingLog(input: CreateServingLogInput): Promise<WorkOrderServingLog> {
    const r = await this.pool.query(
      `INSERT INTO work_order_serving_logs (
        tenant_id, work_order_id, serving_number, service_point_id,
        meal_date, meal_type, opening_time, closing_time,
        received_qty, served_qty, returned_qty, wasted_qty,
        serving_supervisor_user_id, notes, recorded_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        input.tenantId,
        input.workOrderId,
        input.servingNumber,
        input.servicePointId ?? null,
        input.mealDate,
        input.mealType,
        input.openingTime,
        input.closingTime ?? null,
        input.receivedQty,
        input.servedQty,
        input.returnedQty,
        input.wastedQty,
        input.servingSupervisorUserId ?? null,
        input.notes ?? null,
        input.recordedBy,
      ],
    );
    return toServingLog(r.rows[0]);
  }

  async findServingLogByWorkOrder(workOrderId: string): Promise<WorkOrderServingLog | null> {
    const r = await this.pool.query(
      `SELECT * FROM work_order_serving_logs WHERE work_order_id = $1`,
      [workOrderId],
    );
    return r.rows[0] ? toServingLog(r.rows[0]) : null;
  }

  async updateServingLog(
    id: string,
    input: UpdateServingLogInput,
  ): Promise<WorkOrderServingLog | null> {
    const fields: string[] = ["updated_at = now()"];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (input.closingTime !== undefined) {
      fields.push(`closing_time = $${paramIdx++}`);
      values.push(input.closingTime);
    }
    if (input.servedQty !== undefined) {
      fields.push(`served_qty = $${paramIdx++}`);
      values.push(input.servedQty);
    }
    if (input.returnedQty !== undefined) {
      fields.push(`returned_qty = $${paramIdx++}`);
      values.push(input.returnedQty);
    }
    if (input.wastedQty !== undefined) {
      fields.push(`wasted_qty = $${paramIdx++}`);
      values.push(input.wastedQty);
    }
    if (input.servingSupervisorUserId !== undefined) {
      fields.push(`serving_supervisor_user_id = $${paramIdx++}`);
      values.push(input.servingSupervisorUserId);
    }
    if (input.notes !== undefined) {
      fields.push(`notes = $${paramIdx++}`);
      values.push(input.notes);
    }

    if (fields.length === 1) return null; // no fields to update

    values.push(id);
    const sql = `UPDATE work_order_serving_logs SET ${fields.join(", ")}
                 WHERE id = $${paramIdx} RETURNING *`;

    const r = await this.pool.query(sql, values);
    return r.rows[0] ? toServingLog(r.rows[0]) : null;
  }

  async markWorkOrderServingRecorded(
    id: string,
    servingSupervisorUserId: string | null,
  ): Promise<WorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE work_orders
        SET serving_recorded_at = now(),
            serving_supervisor_user_id = $2,
            updated_at = now()
        WHERE id = $1 AND serving_recorded_at IS NULL
        RETURNING *`,
      [id, servingSupervisorUserId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  // ========================================================================
  // KPI Aggregates (SO-CORE-017)
  // ========================================================================

  async getProductionAchievement(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ actualQty: string; plannedQty: string; achievementPct: string; batchCount: number }> {
    const r = await this.pool.query(
      `SELECT
        COUNT(*) as batch_count,
        COALESCE(SUM(cmb.output_quantity), 0) as actual_qty,
        COALESCE(SUM(cmp.planned_portions), 0) as planned_qty,
        CASE WHEN COALESCE(SUM(cmp.planned_portions), 0) = 0 THEN '0'
             ELSE ROUND(SUM(cmb.output_quantity) / SUM(cmp.planned_portions) * 100, 2)::text
        END as achievement_pct
      FROM catering_meal_batches cmb
      LEFT JOIN catering_meal_plans cmp ON cmb.tenant_id = cmp.tenant_id
        AND cmb.meal_plan_id = cmp.id
      WHERE cmb.tenant_id = $1
        AND cmb.status IN ('confirmed', 'consumed')
        AND cmb.produced_at >= $2::timestamptz
        AND cmb.produced_at < $3::timestamptz`,
      [tenantId, periodStart, periodEnd],
    );
    const row = r.rows[0];
    return {
      actualQty: String(row.actual_qty),
      plannedQty: String(row.planned_qty),
      achievementPct: row.achievement_pct,
      batchCount: Number(row.batch_count),
    };
  }

  async getServingTotals(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{
    receivedQty: string;
    servedQty: string;
    wastedQty: string;
    returnedQty: string;
    fulfillmentPct: string;
    wastePct: string;
    logCount: number;
  }> {
    const r = await this.pool.query(
      `SELECT
        COUNT(*) as log_count,
        COALESCE(SUM(received_qty), 0) as received_qty,
        COALESCE(SUM(served_qty), 0) as served_qty,
        COALESCE(SUM(wasted_qty), 0) as wasted_qty,
        COALESCE(SUM(returned_qty), 0) as returned_qty,
        CASE WHEN COALESCE(SUM(received_qty), 0) = 0 THEN '0'
             ELSE ROUND(SUM(served_qty) / SUM(received_qty) * 100, 2)::text
        END as fulfillment_pct,
        CASE WHEN COALESCE(SUM(received_qty), 0) = 0 THEN '0'
             ELSE ROUND(SUM(wasted_qty) / SUM(received_qty) * 100, 2)::text
        END as waste_pct
      FROM work_order_serving_logs
      WHERE tenant_id = $1
        AND recorded_at >= $2::timestamptz
        AND recorded_at < $3::timestamptz`,
      [tenantId, periodStart, periodEnd],
    );
    const row = r.rows[0];
    return {
      receivedQty: String(row.received_qty),
      servedQty: String(row.served_qty),
      wastedQty: String(row.wasted_qty),
      returnedQty: String(row.returned_qty),
      fulfillmentPct: row.fulfillment_pct,
      wastePct: row.waste_pct,
      logCount: Number(row.log_count),
    };
  }

  async getFoodCostTotals(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ totalCost: string; servedQty: string; costPerMeal: string; workOrderCount: number }> {
    const r = await this.pool.query(
      `SELECT
        COUNT(DISTINCT wo.id) as wo_count,
        COALESCE(SUM(wo.costs_total), 0) as total_cost,
        COALESCE(SUM(wosl.served_qty), 0) as served_qty,
        CASE WHEN COALESCE(SUM(wosl.served_qty), 0) = 0 THEN '0'
             ELSE ROUND(SUM(wo.costs_total) / SUM(wosl.served_qty), 4)::text
        END as cost_per_meal
      FROM work_orders wo
      LEFT JOIN work_order_serving_logs wosl ON wo.id = wosl.work_order_id
      WHERE wo.tenant_id = $1
        AND wo.serving_recorded_at >= $2::timestamptz
        AND wo.serving_recorded_at < $3::timestamptz
        AND wo.costs_total IS NOT NULL`,
      [tenantId, periodStart, periodEnd],
    );
    const row = r.rows[0];
    return {
      totalCost: String(row.total_cost),
      servedQty: String(row.served_qty),
      costPerMeal: row.cost_per_meal,
      workOrderCount: Number(row.wo_count),
    };
  }
}

// --- Row mappers (snake_case → camelCase) -----------------------------

function toServiceDefinition(r: QueryResultRow): ServiceDefinition {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    description: r.description,
    category: r.category,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTemplateItem(r: QueryResultRow): ServiceDefinitionChecklistItem {
  return {
    id: r.id,
    serviceDefinitionId: r.service_definition_id,
    code: r.code,
    label: r.label,
    isRequired: r.is_required,
    sortOrder: r.sort_order,
  };
}

function toWorkRequest(r: QueryResultRow): WorkRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    requestNumber: r.request_number,
    customerId: r.customer_id,
    contractId: r.contract_id,
    projectId: r.project_id,
    siteId: r.site_id,
    serviceDefinitionId: r.service_definition_id,
    description: r.description,
    priority: r.priority,
    requestedByUserId: r.requested_by_user_id,
    requestedAt: r.requested_at,
    convertedWorkOrderId: r.converted_work_order_id,
    convertedAt: r.converted_at,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toWorkOrder(r: QueryResultRow): WorkOrder {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workOrderNumber: r.work_order_number,
    workRequestId: r.work_request_id,
    customerId: r.customer_id,
    contractId: r.contract_id,
    woType: r.wo_type ?? "regular",
    projectId: r.project_id,
    siteId: r.site_id,
    serviceDefinitionId: r.service_definition_id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    plannedStartAt: r.planned_start_at,
    plannedEndAt: r.planned_end_at,
    dueAt: r.due_at,
    assignedToUserId: r.assigned_to_user_id,
    assignedAt: r.assigned_at,
    assignedByUserId: r.assigned_by_user_id,
    startedAt: r.started_at,
    startedByUserId: r.started_by_user_id,
    completionNotes: r.completion_notes,
    completedAt: r.completed_at,
    completedByUserId: r.completed_by_user_id,
    verificationNotes: r.verification_notes,
    verifiedAt: r.verified_at,
    verifiedByUserId: r.verified_by_user_id,
    customerAcceptedAt: r.customer_accepted_at,
    customerAcceptedVia: r.customer_accepted_via,
    customerAcceptanceComment: r.customer_acceptance_comment,
    customerRejectedAt: r.customer_rejected_at,
    customerRejectionReason: r.customer_rejection_reason,
    workflowInstanceId: r.workflow_instance_id,
    costsFinalizedAt: r.costs_finalized_at,
    costsTotal: r.costs_total,
    servingRecordedAt: r.serving_recorded_at,
    servingSupervisorUserId: r.serving_supervisor_user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toServingLog(r: QueryResultRow): WorkOrderServingLog {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workOrderId: r.work_order_id,
    servingNumber: r.serving_number,
    servicePointId: r.service_point_id,
    mealDate: r.meal_date,
    mealType: r.meal_type,
    openingTime: r.opening_time,
    closingTime: r.closing_time,
    receivedQty: r.received_qty,
    servedQty: r.served_qty,
    returnedQty: r.returned_qty,
    wastedQty: r.wasted_qty,
    remainingQty: r.remaining_qty,
    servingSupervisorUserId: r.serving_supervisor_user_id,
    notes: r.notes,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toCostItem(r: QueryResultRow): WorkOrderCostItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workOrderId: r.work_order_id,
    costType: r.cost_type as WorkOrderCostType,
    description: r.description,
    quantity: r.quantity,
    unitCost: r.unit_cost,
    totalCost: r.total_cost,
    costCenterId: r.cost_center_id,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toCustomerInvoice(r: QueryResultRow): CustomerInvoice {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workOrderId: r.work_order_id,
    invoiceNumber: r.invoice_number,
    customerId: r.customer_id,
    legalEntityId: r.legal_entity_id,
    periodId: r.period_id,
    costBasis: r.cost_basis,
    markupRate: r.markup_rate,
    baseAmount: r.base_amount,
    isTaxable: r.is_taxable,
    taxRate: r.tax_rate,
    taxAmount: r.tax_amount,
    totalAmount: r.total_amount,
    currency: r.currency,
    arStatus: r.ar_status,
    issuedAt: r.issued_at,
    issuedBy: r.issued_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAcceptanceToken(r: QueryResultRow): WorkOrderAcceptanceToken {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workOrderId: r.work_order_id,
    tokenHash: r.token_hash,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toChecklistItem(r: QueryResultRow): WorkOrderChecklistItem {
  return {
    id: r.id,
    workOrderId: r.work_order_id,
    sourceChecklistItemId: r.source_checklist_item_id,
    code: r.code,
    label: r.label,
    isRequired: r.is_required,
    sortOrder: r.sort_order,
    isCompleted: r.is_completed,
    note: r.note,
    completedAt: r.completed_at,
    completedByUserId: r.completed_by_user_id,
  };
}
