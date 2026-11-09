import type { Pool } from "pg";
import type {
  Complaint,
  ComplaintRepository,
  CreateComplaintInput,
  UpdateCustomerConfirmationInput,
  UpdateInvestigationInput,
  UpdateVerificationInput,
} from "../../../domain/complaint/complaint.entity.js";

/** A DATE column comes back from node-pg as a local-midnight Date; the entity
 * (and the web's <input type="date">) wants the plain YYYY-MM-DD it stores. */
function dateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): Complaint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    complaintNumber: row.complaint_number,
    customerId: row.customer_id,
    customerContactId: row.customer_contact_id,
    contractId: row.contract_id,
    projectId: row.project_id,
    siteId: row.site_id,
    serviceId: row.service_id,
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    priority: row.priority,
    severity: row.severity,
    source: row.source,
    channel: row.channel,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: row.submitted_at,
    rootCause: row.root_cause,
    correctiveAction: row.corrective_action,
    preventiveAction: row.preventive_action,
    correctiveActionOwnerUserId: row.corrective_action_owner_user_id,
    correctiveActionTargetDate: dateOnly(row.corrective_action_target_date),
    verificationNote: row.verification_note,
    verifiedByUserId: row.verified_by_user_id,
    verifiedAt: row.verified_at,
    customerConfirmationNote: row.customer_confirmation_note,
    customerConfirmedAt: row.customer_confirmed_at,
    closureDate: row.closure_date,
    workflowInstanceId: row.workflow_instance_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgComplaintRepository implements ComplaintRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateComplaintInput, createdBy: string | null): Promise<Complaint> {
    const result = await this.pool.query(
      `INSERT INTO complaints
         (tenant_id, complaint_number, customer_id, customer_contact_id, contract_id, project_id,
          site_id, service_id, category, subcategory, description, priority, severity, source,
          channel, submitted_by_user_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
       RETURNING *`,
      [
        input.tenantId,
        input.complaintNumber,
        input.customerId,
        input.customerContactId ?? null,
        input.contractId ?? null,
        input.projectId ?? null,
        input.siteId ?? null,
        input.serviceId ?? null,
        input.category,
        input.subcategory ?? null,
        input.description,
        input.priority,
        input.severity,
        input.source ?? null,
        input.channel ?? null,
        input.submittedByUserId,
        createdBy,
      ],
    );
    return mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Complaint | null> {
    const result = await this.pool.query(
      `SELECT * FROM complaints WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listByCustomer(customerId: string): Promise<Complaint[]> {
    const result = await this.pool.query(
      `SELECT * FROM complaints WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [customerId],
    );
    return result.rows.map(mapRow);
  }

  async listByCustomers(customerIds: string[]): Promise<Complaint[]> {
    if (customerIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM complaints WHERE customer_id = ANY($1) AND deleted_at IS NULL ORDER BY created_at DESC`,
      [customerIds],
    );
    return result.rows.map(mapRow);
  }

  async setWorkflowInstance(id: string, workflowInstanceId: string): Promise<void> {
    await this.pool.query(`UPDATE complaints SET workflow_instance_id = $2 WHERE id = $1`, [
      id,
      workflowInstanceId,
    ]);
  }

  async markSubmitted(id: string, submittedAt: Date): Promise<void> {
    await this.pool.query(`UPDATE complaints SET submitted_at = $2 WHERE id = $1`, [id, submittedAt]);
  }

  async updateInvestigation(
    id: string,
    input: UpdateInvestigationInput,
    updatedBy: string | null,
  ): Promise<Complaint> {
    const result = await this.pool.query(
      `UPDATE complaints SET
         root_cause = COALESCE($2, root_cause),
         corrective_action = COALESCE($3, corrective_action),
         preventive_action = COALESCE($4, preventive_action),
         corrective_action_owner_user_id = COALESCE($5, corrective_action_owner_user_id),
         corrective_action_target_date = COALESCE($6, corrective_action_target_date),
         updated_by = $7,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        input.rootCause ?? null,
        input.correctiveAction ?? null,
        input.preventiveAction ?? null,
        input.correctiveActionOwnerUserId ?? null,
        input.correctiveActionTargetDate ?? null,
        updatedBy,
      ],
    );
    return mapRow(result.rows[0]);
  }

  async updateVerification(
    id: string,
    input: UpdateVerificationInput,
    updatedBy: string | null,
  ): Promise<Complaint> {
    const result = await this.pool.query(
      `UPDATE complaints SET
         verification_note = $2,
         verified_by_user_id = $3,
         verified_at = now(),
         updated_by = $4,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, input.verificationNote, input.verifiedByUserId, updatedBy],
    );
    return mapRow(result.rows[0]);
  }

  async updateCustomerConfirmation(
    id: string,
    input: UpdateCustomerConfirmationInput,
    updatedBy: string | null,
  ): Promise<Complaint> {
    const result = await this.pool.query(
      `UPDATE complaints SET
         customer_confirmation_note = $2,
         customer_confirmed_at = now(),
         updated_by = $3,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, input.customerConfirmationNote, updatedBy],
    );
    return mapRow(result.rows[0]);
  }

  async updateSeverity(
    id: string,
    severity: string,
    updatedBy: string | null,
  ): Promise<Complaint> {
    const result = await this.pool.query(
      `UPDATE complaints SET
         severity = $2,
         updated_by = $3,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, severity, updatedBy],
    );
    return mapRow(result.rows[0]);
  }

  async markClosed(id: string, closureDate: Date): Promise<void> {
    await this.pool.query(`UPDATE complaints SET closure_date = $2 WHERE id = $1`, [id, closureDate]);
  }
}
