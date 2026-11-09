import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AssetAdvancedRepository,
  AssetDowntimeRecord,
  AssetMaintenancePart,
  AssetMaintenanceSchedule,
  AssetMaintenanceWorkOrder,
  AssetMeterReading,
  AssetPredictiveSnapshot,
  AssignMaintenanceWorkOrderInput,
  CompleteMaintenanceWorkOrderInput,
  CreateMaintenanceScheduleInput,
  CreateMaintenanceWorkOrderInput,
  CreatePredictiveSnapshotInput,
  MaintenanceWorkOrderListFilter,
  MeterReadingType,
  RecordDowntimeInput,
  RecordMaintenancePartInput,
  RecordMeterReadingInput,
  StartMaintenanceWorkOrderInput,
  VerifyMaintenanceWorkOrderInput,
} from "../domain/asset-advanced.entity.js";

/**
 * Asset Advanced persistence.
 *
 * Maintenance work order lifecycle guards mirror Asset Core's movement
 * ledger discipline: every transition is a single guarded UPDATE keyed on
 * the previous transition's timestamp being NULL, so two concurrent
 * requests can never double-assign, double-start, double-complete, or
 * double-verify the same work order. No local status column exists —
 * lifecycle STATE lives exclusively in the Workflow Engine via
 * `workflow_instance_id`; these timestamps are bookkeeping written as each
 * Workflow Engine transition fires.
 */
export class PgAssetAdvancedRepository implements AssetAdvancedRepository {
  constructor(private readonly pool: Pool) {}

  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // --- Maintenance Schedules (AST-ADV-001) -------------------------------

  async createMaintenanceSchedule(input: CreateMaintenanceScheduleInput): Promise<AssetMaintenanceSchedule> {
    const r = await this.pool.query(
      `INSERT INTO asset_maintenance_schedules
         (tenant_id, asset_id, schedule_code, title, description, frequency_type,
          interval_days, meter_interval, meter_type, next_due_date, next_due_meter, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.tenantId,
        input.assetId,
        input.scheduleCode,
        input.title,
        input.description ?? null,
        input.frequencyType,
        input.intervalDays ?? null,
        input.meterInterval ?? null,
        input.meterType ?? null,
        input.nextDueDate ?? null,
        input.nextDueMeter ?? null,
        input.createdBy,
      ],
    );
    return toSchedule(r.rows[0]);
  }

  async findMaintenanceScheduleById(tenantId: string, id: string): Promise<AssetMaintenanceSchedule | null> {
    const r = await this.pool.query(
      `SELECT * FROM asset_maintenance_schedules WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return r.rows[0] ? toSchedule(r.rows[0]) : null;
  }

  async listMaintenanceSchedules(tenantId: string, assetId?: string): Promise<AssetMaintenanceSchedule[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (assetId) {
      params.push(assetId);
      conditions.push(`asset_id = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM asset_maintenance_schedules WHERE ${conditions.join(" AND ")} ORDER BY schedule_code`,
      params,
    );
    return r.rows.map(toSchedule);
  }

  /** Due by calendar date, or due by meter (the asset's latest reading of
   * the schedule's meter type has reached or passed the threshold). */
  async listDueMaintenanceSchedules(tenantId: string, asOfDate: string): Promise<AssetMaintenanceSchedule[]> {
    const r = await this.pool.query(
      `SELECT s.* FROM asset_maintenance_schedules s
        WHERE s.tenant_id = $1 AND s.is_active = true
          AND (
            (s.frequency_type = 'calendar' AND s.next_due_date IS NOT NULL AND s.next_due_date <= $2::date)
            OR
            (s.frequency_type = 'meter' AND s.next_due_meter IS NOT NULL AND EXISTS (
               SELECT 1 FROM asset_meter_readings mr
                WHERE mr.tenant_id = s.tenant_id
                  AND mr.asset_id = s.asset_id
                  AND mr.reading_type = s.meter_type
                  AND mr.reading_value >= s.next_due_meter
             ))
          )
        ORDER BY s.schedule_code`,
      [tenantId, asOfDate],
    );
    return r.rows.map(toSchedule);
  }

  async advanceScheduleAfterCompletion(
    tenantId: string,
    id: string,
    performedAt: Date,
    performedMeterReading: number | null,
  ): Promise<AssetMaintenanceSchedule | null> {
    const r = await this.pool.query(
      `UPDATE asset_maintenance_schedules
          SET last_performed_at = $3::timestamptz,
              last_meter_reading = COALESCE($4::numeric, last_meter_reading),
              next_due_date = CASE
                WHEN frequency_type = 'calendar' AND interval_days IS NOT NULL
                  THEN (($3::timestamptz)::date + (interval_days || ' days')::interval)::date
                ELSE next_due_date END,
              next_due_meter = CASE
                WHEN frequency_type = 'meter' AND meter_interval IS NOT NULL AND $4::numeric IS NOT NULL
                  THEN $4::numeric + meter_interval
                ELSE next_due_meter END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [id, tenantId, performedAt, performedMeterReading],
    );
    return r.rows[0] ? toSchedule(r.rows[0]) : null;
  }

  // --- Maintenance Work Orders (AST-ADV-001/002) -------------------------

  async createMaintenanceWorkOrder(input: CreateMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder> {
    const r = await this.pool.query(
      `INSERT INTO asset_maintenance_work_orders
         (tenant_id, order_number, asset_id, schedule_id, maintenance_type, priority, title,
          description, cost_estimate, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING *`,
      [
        input.tenantId,
        input.orderNumber,
        input.assetId,
        input.scheduleId ?? null,
        input.maintenanceType,
        input.priority ?? "medium",
        input.title,
        input.description ?? null,
        input.costEstimate ?? null,
        input.createdBy,
      ],
    );
    return toWorkOrder(r.rows[0]);
  }

  async findMaintenanceWorkOrderById(tenantId: string, id: string): Promise<AssetMaintenanceWorkOrder | null> {
    const r = await this.pool.query(
      `SELECT * FROM asset_maintenance_work_orders WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async findMaintenanceWorkOrderByNumber(
    tenantId: string,
    orderNumber: string,
  ): Promise<AssetMaintenanceWorkOrder | null> {
    const r = await this.pool.query(
      `SELECT * FROM asset_maintenance_work_orders WHERE tenant_id = $1 AND order_number = $2 AND deleted_at IS NULL`,
      [tenantId, orderNumber],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  async listMaintenanceWorkOrders(
    tenantId: string,
    filter: MaintenanceWorkOrderListFilter,
  ): Promise<AssetMaintenanceWorkOrder[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    const add = (sql: (i: number) => string, value: unknown) => {
      params.push(value);
      conditions.push(sql(params.length));
    };
    if (!filter.includeDeleted) conditions.push(`deleted_at IS NULL`);
    if (filter.assetId) add((i) => `asset_id = $${i}`, filter.assetId);
    if (filter.maintenanceType) add((i) => `maintenance_type = $${i}`, filter.maintenanceType);
    if (filter.assignedToUserId) add((i) => `assigned_to_user_id = $${i}`, filter.assignedToUserId);
    const r = await this.pool.query(
      `SELECT * FROM asset_maintenance_work_orders WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toWorkOrder);
  }

  async setMaintenanceWorkOrderWorkflowInstance(tenantId: string, id: string, workflowInstanceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE asset_maintenance_work_orders SET workflow_instance_id = $3 WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId, workflowInstanceId],
    );
  }

  async deleteMaintenanceWorkOrderWithoutWorkflow(tenantId: string, id: string): Promise<void> {
    await this.pool.query(
      `UPDATE asset_maintenance_work_orders
          SET deleted_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND workflow_instance_id IS NULL`,
      [id, tenantId],
    );
  }

  /** Guarded on `assigned_at IS NULL` — a second concurrent assignment is a no-op, not a silent overwrite. */
  async assignMaintenanceWorkOrder(input: AssignMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE asset_maintenance_work_orders
          SET assigned_to_user_id = $3, assigned_at = now(), assigned_by_user_id = $4,
              updated_by = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND assigned_at IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [input.id, input.tenantId, input.assignedToUserId, input.assignedByUserId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  /** Guarded on `started_at IS NULL`. */
  async startMaintenanceWorkOrder(input: StartMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE asset_maintenance_work_orders
          SET started_at = now(), started_by_user_id = $3, updated_by = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND started_at IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [input.id, input.tenantId, input.startedByUserId],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  /** Guarded on `completed_at IS NULL`. */
  async completeMaintenanceWorkOrder(
    input: CompleteMaintenanceWorkOrderInput,
  ): Promise<AssetMaintenanceWorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE asset_maintenance_work_orders
          SET completed_at = now(), completed_by_user_id = $3,
              completion_notes = COALESCE($4, completion_notes),
              actual_cost = COALESCE($5, actual_cost),
              downtime_hours = COALESCE($6, downtime_hours),
              updated_by = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND completed_at IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [
        input.id,
        input.tenantId,
        input.completedByUserId,
        input.completionNotes ?? null,
        input.actualCost ?? null,
        input.downtimeHours ?? null,
      ],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  /** Guarded on `completed_at IS NOT NULL AND verified_at IS NULL`. */
  async verifyMaintenanceWorkOrder(input: VerifyMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder | null> {
    const r = await this.pool.query(
      `UPDATE asset_maintenance_work_orders
          SET verified_at = now(), verified_by_user_id = $3,
              verification_notes = COALESCE($4, verification_notes),
              updated_by = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND completed_at IS NOT NULL AND verified_at IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [input.id, input.tenantId, input.verifiedByUserId, input.verificationNotes ?? null],
    );
    return r.rows[0] ? toWorkOrder(r.rows[0]) : null;
  }

  // --- Spare Parts Usage (AST-ADV-004) ------------------------------------

  async recordMaintenancePart(input: RecordMaintenancePartInput): Promise<AssetMaintenancePart> {
    const r = await this.pool.query(
      `INSERT INTO asset_maintenance_parts
         (tenant_id, maintenance_work_order_id, item_id, quantity, unit_cost, notes, recorded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, maintenance_work_order_id, item_id)
       DO UPDATE SET quantity = asset_maintenance_parts.quantity + EXCLUDED.quantity,
                     unit_cost = COALESCE(EXCLUDED.unit_cost, asset_maintenance_parts.unit_cost),
                     notes = COALESCE(EXCLUDED.notes, asset_maintenance_parts.notes)
       RETURNING *`,
      [
        input.tenantId,
        input.maintenanceWorkOrderId,
        input.itemId,
        input.quantity,
        input.unitCost ?? null,
        input.notes ?? null,
        input.recordedByUserId,
      ],
    );
    return toPart(r.rows[0]);
  }

  async listMaintenanceParts(tenantId: string, maintenanceWorkOrderId: string): Promise<AssetMaintenancePart[]> {
    const r = await this.pool.query(
      `SELECT * FROM asset_maintenance_parts
        WHERE tenant_id = $1 AND maintenance_work_order_id = $2
        ORDER BY recorded_at`,
      [tenantId, maintenanceWorkOrderId],
    );
    return r.rows.map(toPart);
  }

  // --- Meter Readings (AST-ADV-003) ---------------------------------------

  /** Atomic monotonic append. The application service pre-read gives a precise
   * validation error in the usual path; the parent asset row lock serializes
   * concurrent writers for the same tenant-owned asset before the authoritative
   * latest-reading check and insert happen in one transaction. */
  async recordMeterReading(input: RecordMeterReadingInput): Promise<AssetMeterReading | null> {
    return this.inTransaction(async (client) => {
      const lockedAsset = await client.query(
        `SELECT 1 FROM assets
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE`,
        [input.assetId, input.tenantId],
      );
      if ((lockedAsset.rowCount ?? 0) === 0) return null;

      const latest = await client.query(
        `SELECT * FROM asset_meter_readings
          WHERE tenant_id = $1 AND asset_id = $2 AND reading_type = $3
          ORDER BY reading_date DESC, created_at DESC
          LIMIT 1`,
        [input.tenantId, input.assetId, input.readingType],
      );
      const latestReading = latest.rows[0] ? toMeterReading(latest.rows[0]) : null;
      if (latestReading) {
        if (input.readingValue < latestReading.readingValue) return null;
        if (new Date(input.readingDate).getTime() < latestReading.readingDate.getTime()) return null;
      }

      const r = await client.query(
        `INSERT INTO asset_meter_readings
           (tenant_id, asset_id, reading_type, reading_value, reading_date, recorded_by_user_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          input.tenantId,
          input.assetId,
          input.readingType,
          input.readingValue,
          input.readingDate,
          input.recordedByUserId,
          input.notes ?? null,
        ],
      );
      return toMeterReading(r.rows[0]);
    });
  }

  async findLatestMeterReading(
    tenantId: string,
    assetId: string,
    readingType: MeterReadingType,
  ): Promise<AssetMeterReading | null> {
    const r = await this.pool.query(
      `SELECT * FROM asset_meter_readings
        WHERE tenant_id = $1 AND asset_id = $2 AND reading_type = $3
        ORDER BY reading_date DESC, created_at DESC
        LIMIT 1`,
      [tenantId, assetId, readingType],
    );
    return r.rows[0] ? toMeterReading(r.rows[0]) : null;
  }

  async listMeterReadings(
    tenantId: string,
    assetId: string,
    readingType?: MeterReadingType,
  ): Promise<AssetMeterReading[]> {
    const conditions = [`tenant_id = $1`, `asset_id = $2`];
    const params: unknown[] = [tenantId, assetId];
    if (readingType) {
      params.push(readingType);
      conditions.push(`reading_type = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM asset_meter_readings WHERE ${conditions.join(" AND ")} ORDER BY reading_date DESC`,
      params,
    );
    return r.rows.map(toMeterReading);
  }

  // --- Downtime Tracking (AST-ADV-005) ------------------------------------

  async recordDowntime(input: RecordDowntimeInput): Promise<AssetDowntimeRecord> {
    const r = await this.pool.query(
      `INSERT INTO asset_downtime_records
         (tenant_id, asset_id, maintenance_work_order_id, start_time, end_time, duration_minutes,
          reason_category, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,
               CASE WHEN $5::timestamptz IS NOT NULL
                 THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM ($5::timestamptz - $4::timestamptz)) / 60))::integer
                 ELSE NULL END,
               $6,$7,$8)
       RETURNING *`,
      [
        input.tenantId,
        input.assetId,
        input.maintenanceWorkOrderId ?? null,
        input.startTime,
        input.endTime ?? null,
        input.reasonCategory,
        input.notes ?? null,
        input.createdBy,
      ],
    );
    return toDowntime(r.rows[0]);
  }

  /** Guarded on `end_time IS NULL` — an already-closed downtime period stays untouched. */
  async closeDowntime(tenantId: string, id: string, endTime: Date): Promise<AssetDowntimeRecord | null> {
    const r = await this.pool.query(
      `UPDATE asset_downtime_records
          SET end_time = $3,
              duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM ($3::timestamptz - start_time)) / 60))::integer
        WHERE id = $1 AND tenant_id = $2 AND end_time IS NULL
        RETURNING *`,
      [id, tenantId, endTime],
    );
    return r.rows[0] ? toDowntime(r.rows[0]) : null;
  }

  async listDowntimeRecords(tenantId: string, assetId: string): Promise<AssetDowntimeRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM asset_downtime_records WHERE tenant_id = $1 AND asset_id = $2 ORDER BY start_time DESC`,
      [tenantId, assetId],
    );
    return r.rows.map(toDowntime);
  }

  /** Sums downtime hours clipped to the analysis period — a record that starts
   * before the period or is still open at the period end is counted only for
   * the portion that overlaps. */
  async sumDowntimeHours(tenantId: string, assetId: string, periodStart: Date, periodEnd: Date): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(
          GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(COALESCE(end_time, $4::timestamptz), $4::timestamptz) -
            GREATEST(start_time, $3::timestamptz)
          )) / 3600.0)
        ), 0) AS total_hours
        FROM asset_downtime_records
        WHERE tenant_id = $1 AND asset_id = $2
          AND start_time < $4::timestamptz
          AND COALESCE(end_time, $4::timestamptz) > $3::timestamptz`,
      [tenantId, assetId, periodStart, periodEnd],
    );
    return Number(r.rows[0]?.total_hours ?? 0);
  }

  async countCorrectiveFailures(tenantId: string, assetId: string, periodStart: Date, periodEnd: Date): Promise<number> {
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM asset_maintenance_work_orders
        WHERE tenant_id = $1 AND asset_id = $2 AND maintenance_type = 'corrective'
          AND deleted_at IS NULL AND completed_at IS NOT NULL
          AND completed_at >= $3 AND completed_at < $4`,
      [tenantId, assetId, periodStart, periodEnd],
    );
    return Number(r.rows[0]?.count ?? 0);
  }

  async sumRepairDowntimeHours(tenantId: string, assetId: string, periodStart: Date, periodEnd: Date): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(downtime_hours), 0) AS total FROM asset_maintenance_work_orders
        WHERE tenant_id = $1 AND asset_id = $2 AND maintenance_type = 'corrective'
          AND deleted_at IS NULL AND completed_at IS NOT NULL
          AND completed_at >= $3 AND completed_at < $4`,
      [tenantId, assetId, periodStart, periodEnd],
    );
    return Number(r.rows[0]?.total ?? 0);
  }

  // --- Predictive Snapshots (AST-ADV-006/007) -----------------------------

  async createPredictiveSnapshot(input: CreatePredictiveSnapshotInput): Promise<AssetPredictiveSnapshot> {
    const r = await this.pool.query(
      `INSERT INTO asset_predictive_snapshots
         (tenant_id, asset_id, analysis_date, mtbf_hours, mttr_hours, availability_pct,
          health_score, predicted_failure_date, confidence_pct, recommendation, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.tenantId,
        input.assetId,
        input.analysisDate,
        input.mtbfHours,
        input.mttrHours,
        input.availabilityPct,
        input.healthScore,
        input.predictedFailureDate,
        input.confidencePct,
        input.recommendation,
        input.createdBy,
      ],
    );
    return toSnapshot(r.rows[0]);
  }

  async listPredictiveSnapshots(tenantId: string, assetId: string, limit?: number): Promise<AssetPredictiveSnapshot[]> {
    const r = await this.pool.query(
      `SELECT * FROM asset_predictive_snapshots
        WHERE tenant_id = $1 AND asset_id = $2
        ORDER BY analysis_date DESC
        LIMIT $3`,
      [tenantId, assetId, limit ?? 50],
    );
    return r.rows.map(toSnapshot);
  }

  async findLatestPredictiveSnapshot(tenantId: string, assetId: string): Promise<AssetPredictiveSnapshot | null> {
    const r = await this.pool.query(
      `SELECT * FROM asset_predictive_snapshots
        WHERE tenant_id = $1 AND asset_id = $2
        ORDER BY analysis_date DESC
        LIMIT 1`,
      [tenantId, assetId],
    );
    return r.rows[0] ? toSnapshot(r.rows[0]) : null;
  }

  // --- Narrow cross-domain reads kept behind this port --------------------

  async assetExists(tenantId: string, assetId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM assets WHERE id = $1 AND tenant_id = $2`, [assetId, tenantId]);
    return r.rowCount! > 0;
  }

  /** The asset's responsible Organization Unit (Asset Core's Data Scope anchor),
   * or null when the asset is unplaced / not found. */
  async findAssetOrganizationUnitId(tenantId: string, assetId: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT organization_unit_id FROM assets WHERE id = $1 AND tenant_id = $2`,
      [assetId, tenantId],
    );
    return r.rows.length > 0 ? ((r.rows[0].organization_unit_id as string | null) ?? null) : null;
  }

  /** Asset Advanced never imports SupplyChainService — see module boundary
   * convention (Asset's own `siteExists`/`organizationUnitExists`). */
  async itemExists(tenantId: string, itemId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM items WHERE id = $1 AND tenant_id = $2`, [itemId, tenantId]);
    return r.rowCount! > 0;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** pg returns a `date` column as a Date at LOCAL midnight; converting via
 * toISOString() would shift it a day for negative UTC offsets. Read the
 * local components instead (the Phase 3 calendar-date lesson). */
function toDateString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toSchedule(row: QueryResultRow): AssetMaintenanceSchedule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assetId: row.asset_id,
    scheduleCode: row.schedule_code,
    title: row.title,
    description: row.description,
    frequencyType: row.frequency_type,
    intervalDays: row.interval_days === null ? null : Number(row.interval_days),
    meterInterval: toNumberOrNull(row.meter_interval),
    meterType: row.meter_type,
    lastPerformedAt: row.last_performed_at,
    lastMeterReading: toNumberOrNull(row.last_meter_reading),
    nextDueDate: toDateString(row.next_due_date),
    nextDueMeter: toNumberOrNull(row.next_due_meter),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function toWorkOrder(row: QueryResultRow): AssetMaintenanceWorkOrder {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderNumber: row.order_number,
    assetId: row.asset_id,
    scheduleId: row.schedule_id,
    maintenanceType: row.maintenance_type,
    priority: row.priority,
    title: row.title,
    description: row.description,
    assignedToUserId: row.assigned_to_user_id,
    assignedAt: row.assigned_at,
    assignedByUserId: row.assigned_by_user_id,
    startedAt: row.started_at,
    startedByUserId: row.started_by_user_id,
    completedAt: row.completed_at,
    completedByUserId: row.completed_by_user_id,
    completionNotes: row.completion_notes,
    verifiedAt: row.verified_at,
    verifiedByUserId: row.verified_by_user_id,
    verificationNotes: row.verification_notes,
    downtimeHours: Number(row.downtime_hours),
    costEstimate: toNumberOrNull(row.cost_estimate),
    actualCost: toNumberOrNull(row.actual_cost),
    workflowInstanceId: row.workflow_instance_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at,
  };
}

function toPart(row: QueryResultRow): AssetMaintenancePart {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    maintenanceWorkOrderId: row.maintenance_work_order_id,
    itemId: row.item_id,
    quantity: Number(row.quantity),
    unitCost: toNumberOrNull(row.unit_cost),
    notes: row.notes,
    recordedAt: row.recorded_at,
    recordedByUserId: row.recorded_by_user_id,
  };
}

function toMeterReading(row: QueryResultRow): AssetMeterReading {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assetId: row.asset_id,
    readingType: row.reading_type,
    readingValue: Number(row.reading_value),
    readingDate: row.reading_date,
    recordedByUserId: row.recorded_by_user_id,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function toDowntime(row: QueryResultRow): AssetDowntimeRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assetId: row.asset_id,
    maintenanceWorkOrderId: row.maintenance_work_order_id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
    reasonCategory: row.reason_category,
    notes: row.notes,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function toSnapshot(row: QueryResultRow): AssetPredictiveSnapshot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assetId: row.asset_id,
    analysisDate: toDateString(row.analysis_date)!,
    mtbfHours: toNumberOrNull(row.mtbf_hours),
    mttrHours: toNumberOrNull(row.mttr_hours),
    availabilityPct: toNumberOrNull(row.availability_pct),
    healthScore: Number(row.health_score),
    predictedFailureDate: toDateString(row.predicted_failure_date),
    confidencePct: toNumberOrNull(row.confidence_pct),
    recommendation: row.recommendation,
    algorithmVersion: row.algorithm_version,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
