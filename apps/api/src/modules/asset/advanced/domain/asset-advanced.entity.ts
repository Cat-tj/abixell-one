/**
 * Asset Advanced — domain types and port interface.
 *
 * Scope discipline:
 * - AST-ADV-001 (Preventive maintenance scheduling) + AST-ADV-002 (Corrective
 *   maintenance / work orders): `AssetMaintenanceSchedule` and
 *   `AssetMaintenanceWorkOrder`. Lifecycle is owned EXCLUSIVELY by the
 *   generic Workflow Engine via `workflowInstanceId` — this module never
 *   stores a competing status column, and it NEVER mutates Asset Core's
 *   `AssetStatus` ("in_use" | "idle" | "retired" | "disposed").
 * - AST-ADV-003 (Meter reading / usage triggers): `AssetMeterReading`.
 * - AST-ADV-004 (Spare parts, with Supply Chain): `AssetMaintenancePart`,
 *   referencing `items(id)` from Supply Chain Core through a narrow
 *   `itemExists` port method — this module never imports SupplyChainService.
 * - AST-ADV-005 (Downtime tracking): `AssetDowntimeRecord`.
 * - AST-ADV-006 (Reliability metrics MTBF/MTTR) + AST-ADV-007 (Predictive
 *   maintenance): `AssetPredictiveSnapshot`, deterministic advisory-only.
 * - AST-ADV-008 (fixed-asset accounting/depreciation) is OUT OF SCOPE for
 *   this wave (Finance Advanced / Wave A6).
 */

// ---------------------------------------------------------------------------
// Maintenance Schedules (AST-ADV-001)
// ---------------------------------------------------------------------------

export type MaintenanceFrequencyType = "calendar" | "meter";

export type MeterReadingType = "hours" | "km" | "cycles";

export interface AssetMaintenanceSchedule {
  id: string;
  tenantId: string;
  assetId: string;
  scheduleCode: string;
  title: string;
  description: string | null;
  frequencyType: MaintenanceFrequencyType;
  intervalDays: number | null;
  meterInterval: number | null;
  meterType: MeterReadingType | null;
  lastPerformedAt: Date | null;
  lastMeterReading: number | null;
  nextDueDate: string | null; // YYYY-MM-DD
  nextDueMeter: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

export interface CreateMaintenanceScheduleInput {
  tenantId: string;
  assetId: string;
  scheduleCode: string;
  title: string;
  description?: string | null;
  frequencyType: MaintenanceFrequencyType;
  intervalDays?: number | null;
  meterInterval?: number | null;
  meterType?: MeterReadingType | null;
  nextDueDate?: string | null;
  nextDueMeter?: number | null;
  createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Maintenance Work Orders (AST-ADV-001 preventive / AST-ADV-002 corrective)
// ---------------------------------------------------------------------------

export type MaintenanceType = "preventive" | "corrective" | "emergency";

export type MaintenancePriority = "low" | "medium" | "high" | "critical";

/**
 * NOTE: deliberately NO `status` field. Lifecycle state (draft, assigned,
 * in progress, completed, verified, cancelled) is read from the Workflow
 * Engine via `workflowInstanceId` — see Asset Core's `WorkOrder`/`Asset`
 * pattern and Service Operations Core's `WorkOrder`. Timestamps below are
 * bookkeeping written by the application service as each Workflow Engine
 * transition fires; they are NOT an independent state machine.
 */
export interface AssetMaintenanceWorkOrder {
  id: string;
  tenantId: string;
  orderNumber: string;
  assetId: string;
  scheduleId: string | null;
  maintenanceType: MaintenanceType;
  priority: MaintenancePriority;
  title: string;
  description: string | null;
  assignedToUserId: string | null;
  assignedAt: Date | null;
  assignedByUserId: string | null;
  startedAt: Date | null;
  startedByUserId: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  verificationNotes: string | null;
  downtimeHours: number;
  costEstimate: number | null;
  actualCost: number | null;
  /** The ONE link to the generic Workflow Engine. */
  workflowInstanceId: string | null;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
}

export interface CreateMaintenanceWorkOrderInput {
  tenantId: string;
  orderNumber: string;
  assetId: string;
  scheduleId?: string | null;
  maintenanceType: MaintenanceType;
  priority?: MaintenancePriority;
  title: string;
  description?: string | null;
  costEstimate?: number | null;
  createdBy: string | null;
}

export interface AssignMaintenanceWorkOrderInput {
  tenantId: string;
  id: string;
  assignedToUserId: string;
  assignedByUserId: string;
}

export interface StartMaintenanceWorkOrderInput {
  tenantId: string;
  id: string;
  startedByUserId: string;
}

export interface CompleteMaintenanceWorkOrderInput {
  tenantId: string;
  id: string;
  completedByUserId: string;
  completionNotes?: string | null;
  actualCost?: number | null;
  downtimeHours?: number | null;
}

export interface VerifyMaintenanceWorkOrderInput {
  tenantId: string;
  id: string;
  verifiedByUserId: string;
  verificationNotes?: string | null;
}

export interface MaintenanceWorkOrderListFilter {
  assetId?: string;
  maintenanceType?: MaintenanceType;
  assignedToUserId?: string;
  includeDeleted?: boolean;
}

// ---------------------------------------------------------------------------
// Spare Parts Usage (AST-ADV-004)
// ---------------------------------------------------------------------------

export interface AssetMaintenancePart {
  id: string;
  tenantId: string;
  maintenanceWorkOrderId: string;
  itemId: string;
  quantity: number;
  unitCost: number | null;
  notes: string | null;
  recordedAt: Date;
  recordedByUserId: string | null;
}

export interface RecordMaintenancePartInput {
  tenantId: string;
  maintenanceWorkOrderId: string;
  itemId: string;
  quantity: number;
  unitCost?: number | null;
  notes?: string | null;
  recordedByUserId: string | null;
}

// ---------------------------------------------------------------------------
// Meter Readings (AST-ADV-003)
// ---------------------------------------------------------------------------

export interface AssetMeterReading {
  id: string;
  tenantId: string;
  assetId: string;
  readingType: MeterReadingType;
  readingValue: number;
  readingDate: Date;
  recordedByUserId: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface RecordMeterReadingInput {
  tenantId: string;
  assetId: string;
  readingType: MeterReadingType;
  readingValue: number;
  readingDate: string; // ISO timestamp
  recordedByUserId: string | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Downtime Tracking (AST-ADV-005)
// ---------------------------------------------------------------------------

export type DowntimeReasonCategory =
  | "breakdown"
  | "scheduled_maintenance"
  | "power_failure"
  | "operator_error"
  | "other";

export interface AssetDowntimeRecord {
  id: string;
  tenantId: string;
  assetId: string;
  maintenanceWorkOrderId: string | null;
  startTime: Date;
  endTime: Date | null;
  durationMinutes: number | null;
  reasonCategory: DowntimeReasonCategory;
  notes: string | null;
  createdAt: Date;
  createdBy: string | null;
}

export interface RecordDowntimeInput {
  tenantId: string;
  assetId: string;
  maintenanceWorkOrderId?: string | null;
  startTime: string; // ISO timestamp
  endTime?: string | null;
  reasonCategory: DowntimeReasonCategory;
  notes?: string | null;
  createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Reliability Metrics & Predictive Snapshots (AST-ADV-006, AST-ADV-007)
// ---------------------------------------------------------------------------

/**
 * Deterministic, advisory-only reliability metrics:
 * - Total Operational Hours = Elapsed Period Hours − Total Downtime Hours.
 * - MTBF = Operational Hours / Corrective Failure Count (0 failures →
 *   MTBF = Operational Hours; no division by zero).
 * - MTTR = Repair Downtime Hours / Failure Count (0 failures → MTTR = 0).
 * - Availability % = Operational / (Operational + Downtime) * 100.
 */
export interface ReliabilityMetrics {
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  elapsedHours: number;
  downtimeHours: number;
  operationalHours: number;
  correctiveFailureCount: number;
  mtbfHours: number;
  mttrHours: number;
  availabilityPct: number;
}

export interface AssetPredictiveSnapshot {
  id: string;
  tenantId: string;
  assetId: string;
  analysisDate: string; // YYYY-MM-DD
  mtbfHours: number | null;
  mttrHours: number | null;
  availabilityPct: number | null;
  healthScore: number;
  predictedFailureDate: string | null;
  confidencePct: number | null;
  recommendation: string | null;
  algorithmVersion: string;
  createdAt: Date;
  createdBy: string | null;
}

export interface CreatePredictiveSnapshotInput {
  tenantId: string;
  assetId: string;
  analysisDate: string;
  mtbfHours: number | null;
  mttrHours: number | null;
  availabilityPct: number | null;
  healthScore: number;
  predictedFailureDate: string | null;
  confidencePct: number | null;
  recommendation: string | null;
  createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Repository port
// ---------------------------------------------------------------------------

export interface AssetAdvancedRepository {
  // --- Maintenance Schedules (AST-ADV-001) -----------------------------
  createMaintenanceSchedule(input: CreateMaintenanceScheduleInput): Promise<AssetMaintenanceSchedule>;
  findMaintenanceScheduleById(tenantId: string, id: string): Promise<AssetMaintenanceSchedule | null>;
  listMaintenanceSchedules(tenantId: string, assetId?: string): Promise<AssetMaintenanceSchedule[]>;
  /** Schedules whose next_due_date/next_due_meter has been reached, still active. */
  listDueMaintenanceSchedules(tenantId: string, asOfDate: string): Promise<AssetMaintenanceSchedule[]>;
  advanceScheduleAfterCompletion(
    tenantId: string,
    id: string,
    performedAt: Date,
    performedMeterReading: number | null,
  ): Promise<AssetMaintenanceSchedule | null>;

  // --- Maintenance Work Orders (AST-ADV-001/002) ------------------------
  createMaintenanceWorkOrder(input: CreateMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder>;
  findMaintenanceWorkOrderById(tenantId: string, id: string): Promise<AssetMaintenanceWorkOrder | null>;
  findMaintenanceWorkOrderByNumber(tenantId: string, orderNumber: string): Promise<AssetMaintenanceWorkOrder | null>;
  listMaintenanceWorkOrders(
    tenantId: string,
    filter: MaintenanceWorkOrderListFilter,
  ): Promise<AssetMaintenanceWorkOrder[]>;
  setMaintenanceWorkOrderWorkflowInstance(tenantId: string, id: string, workflowInstanceId: string): Promise<void>;
  /** Compensates a failed workflow start; no workflow-less order may remain actionable. */
  deleteMaintenanceWorkOrderWithoutWorkflow(tenantId: string, id: string): Promise<void>;
  /** Guarded: only succeeds when the order has not already been assigned. */
  assignMaintenanceWorkOrder(input: AssignMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder | null>;
  /** Guarded: only succeeds when the order has not already been started. */
  startMaintenanceWorkOrder(input: StartMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder | null>;
  /** Guarded: only succeeds when the order has not already been completed. */
  completeMaintenanceWorkOrder(input: CompleteMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder | null>;
  /** Guarded: only succeeds when the order has been completed but not yet verified. */
  verifyMaintenanceWorkOrder(input: VerifyMaintenanceWorkOrderInput): Promise<AssetMaintenanceWorkOrder | null>;

  // --- Spare Parts Usage (AST-ADV-004) -----------------------------------
  recordMaintenancePart(input: RecordMaintenancePartInput): Promise<AssetMaintenancePart>;
  listMaintenanceParts(tenantId: string, maintenanceWorkOrderId: string): Promise<AssetMaintenancePart[]>;

  // --- Meter Readings (AST-ADV-003) --------------------------------------
  /** Atomic monotonic insert; null means the reading lost a concurrency guard. */
  recordMeterReading(input: RecordMeterReadingInput): Promise<AssetMeterReading | null>;
  findLatestMeterReading(tenantId: string, assetId: string, readingType: MeterReadingType): Promise<AssetMeterReading | null>;
  listMeterReadings(tenantId: string, assetId: string, readingType?: MeterReadingType): Promise<AssetMeterReading[]>;

  // --- Downtime Tracking (AST-ADV-005) ------------------------------------
  recordDowntime(input: RecordDowntimeInput): Promise<AssetDowntimeRecord>;
  closeDowntime(tenantId: string, id: string, endTime: Date): Promise<AssetDowntimeRecord | null>;
  listDowntimeRecords(tenantId: string, assetId: string): Promise<AssetDowntimeRecord[]>;
  sumDowntimeHours(tenantId: string, assetId: string, periodStart: Date, periodEnd: Date): Promise<number>;
  countCorrectiveFailures(tenantId: string, assetId: string, periodStart: Date, periodEnd: Date): Promise<number>;
  sumRepairDowntimeHours(tenantId: string, assetId: string, periodStart: Date, periodEnd: Date): Promise<number>;

  // --- Predictive Snapshots (AST-ADV-006/007) -----------------------------
  createPredictiveSnapshot(input: CreatePredictiveSnapshotInput): Promise<AssetPredictiveSnapshot>;
  listPredictiveSnapshots(tenantId: string, assetId: string, limit?: number): Promise<AssetPredictiveSnapshot[]>;
  findLatestPredictiveSnapshot(tenantId: string, assetId: string): Promise<AssetPredictiveSnapshot | null>;

  // --- Narrow cross-domain reads kept behind this port --------------------
  /** Asset Core's asset existence check — never imports AssetService. */
  assetExists(tenantId: string, assetId: string): Promise<boolean>;
  /** The asset's responsible Organization Unit (Data Scope anchor), or null. */
  findAssetOrganizationUnitId(tenantId: string, assetId: string): Promise<string | null>;
  /** Supply Chain Core's item existence check — never imports SupplyChainService. */
  itemExists(tenantId: string, itemId: string): Promise<boolean>;
}
