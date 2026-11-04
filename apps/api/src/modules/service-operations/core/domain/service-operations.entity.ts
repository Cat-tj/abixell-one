/**
 * Service Operations & Work Management Core — domain types (Phase 2).
 *
 * First module built under the frozen target repository architecture
 * (`modules/<module>/core/{domain,application,infrastructure,api}`, blueprint
 * §11A). It depends on Platform Core through application ports only; it never
 * reaches into another business module's internals.
 *
 * Generic by construction: no industry vocabulary (catering, housekeeping,
 * camp, facility) appears anywhere in this module. Verticals arrive later as
 * Configuration + Vertical Service Packs over these same entities.
 */

import type { PoolClient } from "pg";
import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
export interface AuthorizedCustomer {
  id: string;
  ownerOrganizationUnitId: string | null;
}

export interface CustomerScopePort {
  listScopedCustomerIds(actor: ActorContext): Promise<string[]>;
  getAuthorized(actor: ActorContext, customerId: string): Promise<AuthorizedCustomer>;
  canAccessForDocument(actor: ActorContext, customerId: string): Promise<boolean>;
}


// ---------------------------------------------------------------------------
// Service Definition (template) — SO-CORE-001 / SO-CORE-007
// ---------------------------------------------------------------------------

export interface ServiceDefinition {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceDefinitionChecklistItem {
  id: string;
  serviceDefinitionId: string;
  code: string;
  label: string;
  isRequired: boolean;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Work Request (demand / intake) — SO-CORE-002
// ---------------------------------------------------------------------------

/** Derived from `convertedWorkOrderId` / `cancelledAt` — deliberately NOT a
 * stored status column, so intake bookkeeping can never become a competing
 * lifecycle alongside the Workflow Engine. */
export type WorkRequestState = "open" | "converted" | "cancelled";

export interface WorkRequest {
  id: string;
  tenantId: string;
  requestNumber: string;
  customerId: string;
  contractId: string | null;
  projectId: string | null;
  siteId: string | null;
  serviceDefinitionId: string;
  description: string;
  priority: string | null;
  requestedByUserId: string;
  requestedAt: Date;
  convertedWorkOrderId: string | null;
  convertedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function workRequestState(request: WorkRequest): WorkRequestState {
  if (request.cancelledAt) return "cancelled";
  if (request.convertedWorkOrderId) return "converted";
  return "open";
}

// ---------------------------------------------------------------------------
// Work Order (executable unit) — SO-CORE-003 … SO-CORE-010
// ---------------------------------------------------------------------------

export interface WorkOrder {
  id: string;
  tenantId: string;
  workOrderNumber: string;
  workRequestId: string | null;
  customerId: string;
  contractId: string | null;
  projectId: string | null;
  siteId: string | null;
  serviceDefinitionId: string;
  title: string;
  description: string | null;
  priority: string | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  dueAt: Date | null;
  assignedToUserId: string | null;
  assignedAt: Date | null;
  assignedByUserId: string | null;
  startedAt: Date | null;
  startedByUserId: string | null;
  completionNotes: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  verificationNotes: string | null;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  /** Customer acceptance facts (WP-OPS-01 Phase 6) — evidence columns, not a
   * lifecycle state. `via` is 'token' (public link) or 'internal' (manual). */
  customerAcceptedAt: Date | null;
  customerAcceptedVia: string | null;
  customerAcceptanceComment: string | null;
  customerRejectedAt: Date | null;
  customerRejectionReason: string | null;
  /** The ONE link to the generic Workflow Engine — lifecycle STATE lives
   * there, never as a status column here (SO-CORE-004). */
  workflowInstanceId: string | null;
  /** Cost accumulation (WP-OPS-02) — set once by finalizeCosts; a non-null
   * costs_finalized_at locks further cost-item adds on this WO. */
  costsFinalizedAt: Date | null;
  costsTotal: string | null;
  /** Serving phase (SO-CORE-016) — set once a serving log is recorded. */
  servingRecordedAt: Date | null;
  servingSupervisorUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Work Order cost item (WP-OPS-02 Phase 6) — manual cost entry
// ---------------------------------------------------------------------------

export type WorkOrderCostType = "material" | "labor" | "overhead";

export interface WorkOrderCostItem {
  id: string;
  tenantId: string;
  workOrderId: string;
  costType: WorkOrderCostType;
  description: string | null;
  quantity: string;
  unitCost: string;
  totalCost: string;
  costCenterId: string | null;
  recordedBy: string;
  recordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddCostItemInput {
  costType: WorkOrderCostType;
  description: string | null;
  quantity: string;
  unitCost: string;
  costCenterId: string | null;
  recordedBy: string;
}

export interface FinalizeCostsResult {
  workOrder: WorkOrder;
  costsTotal: string;
  legalEntityId: string;
  periodId: string | null;
  outboxEventEmitted: boolean;
}

// ---------------------------------------------------------------------------
// Customer invoice (WP-OPS-03 Phase 6) — Billing / AR
// ---------------------------------------------------------------------------

/** Row shape of `customer_invoices`. One invoice per Work Order; value =
 * cost × (1 + markup). Money columns are NUMERIC(18,4) strings. */
export interface CustomerInvoice {
  id: string;
  tenantId: string;
  workOrderId: string;
  invoiceNumber: string;
  customerId: string;
  legalEntityId: string;
  periodId: string;
  costBasis: string;
  markupRate: string;
  baseAmount: string;
  isTaxable: boolean;
  taxRate: string | null;
  taxAmount: string;
  totalAmount: string;
  currency: string;
  arStatus: string;
  issuedAt: Date;
  issuedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInvoiceInput {
  legalEntityId: string;
  /** Optional per-invoice override of the tenant default markup rate. */
  markupRate?: string;
  isTaxable: boolean;
  /** Required when isTaxable; defaults to 0.11 (PPN) in the service. */
  taxRate?: string;
}

export interface CreateInvoiceResult {
  invoice: CustomerInvoice;
  outboxEventsEmitted: number;
}

// ---------------------------------------------------------------------------
// Work Order serving log (SO-CORE-016) — last-mile meal tracking
// ---------------------------------------------------------------------------

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface WorkOrderServingLog {
  id: string;
  tenantId: string;
  workOrderId: string;
  servingNumber: string;
  servicePointId: string | null;
  mealDate: string; // YYYY-MM-DD
  mealType: MealType;
  openingTime: Date;
  closingTime: Date | null;
  receivedQty: string;
  servedQty: string;
  returnedQty: string;
  wastedQty: string;
  remainingQty: string; // GENERATED: received - served - returned - wasted
  servingSupervisorUserId: string | null;
  notes: string | null;
  recordedBy: string;
  recordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateServingLogInput {
  tenantId: string;
  workOrderId: string;
  servingNumber: string;
  servicePointId?: string | null;
  mealDate: string;
  mealType: MealType;
  openingTime: Date;
  closingTime?: Date | null;
  receivedQty: string;
  servedQty: string;
  returnedQty: string;
  wastedQty: string;
  servingSupervisorUserId?: string | null;
  notes?: string | null;
  recordedBy: string;
}

export interface UpdateServingLogInput {
  closingTime?: Date | null;
  servedQty?: string;
  returnedQty?: string;
  wastedQty?: string;
  servingSupervisorUserId?: string | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Work Order acceptance token (WP-OPS-01 Phase 6) — public sign-off link
// ---------------------------------------------------------------------------

/** Row shape of `work_order_acceptance_tokens`. The raw token is never
 * stored — only its SHA256 hash — and is returned once at issue time. */
export interface WorkOrderAcceptanceToken {
  id: string;
  tenantId: string;
  workOrderId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

/** Snapshot of the Service Definition's checklist taken when the Work Order
 * is created, so editing the template later cannot rewrite the history of
 * already-executed work. */
export interface WorkOrderChecklistItem {
  id: string;
  workOrderId: string;
  sourceChecklistItemId: string | null;
  code: string;
  label: string;
  isRequired: boolean;
  sortOrder: number;
  isCompleted: boolean;
  note: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateServiceDefinitionInput {
  tenantId: string;
  code: string;
  name: string;
  description?: string | null;
  category?: string | null;
  createdBy: string | null;
}

export interface CreateWorkRequestInput {
  tenantId: string;
  requestNumber: string;
  customerId: string;
  contractId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  serviceDefinitionId: string;
  description: string;
  priority?: string | null;
  requestedByUserId: string;
  createdBy: string | null;
}

export interface CreateWorkOrderInput {
  tenantId: string;
  workOrderNumber: string;
  workRequestId?: string | null;
  customerId: string;
  contractId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  serviceDefinitionId: string;
  title: string;
  description?: string | null;
  priority?: string | null;
  plannedStartAt?: Date | null;
  plannedEndAt?: Date | null;
  dueAt?: Date | null;
  createdBy: string | null;
}

export interface ScheduleWorkOrderInput {
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  dueAt: Date | null;
}

export interface IssueAcceptanceTokenInput {
  /** Number of days until the token expires (default 30). */
  expiresInDays?: number;
  createdBy: string | null;
}

export interface MarkCustomerAcceptedInput {
  via: "token" | "internal";
  comment: string | null;
  acceptedBy: string | null;
}

export interface MarkCustomerRejectedInput {
  reason: string | null;
  rejectedBy: string | null;
}

// ---------------------------------------------------------------------------
// Repository port
// ---------------------------------------------------------------------------

export interface ServiceOperationsRepository {
  // --- Project membership (owner request: project isolation) --------------
  listProjectMembers(tenantId: string, projectId: string): Promise<{ userId: string; roleCode: string | null; grantedAt: Date }[]>;
  addProjectMember(tenantId: string, projectId: string, userId: string, roleCode: string | null, grantedBy: string): Promise<void>;
  removeProjectMember(tenantId: string, projectId: string, userId: string, revokedBy: string): Promise<void>;
  isProjectMember(tenantId: string, projectId: string, userId: string): Promise<boolean>;
  listUserProjectIds(tenantId: string, userId: string): Promise<Set<string>>;
  setWorkOrderProject(workOrderId: string, projectId: string | null, tenantId: string): Promise<void>;
  listProjectMemberIds(tenantId: string, projectId: string): Promise<Set<string>>;
  /** Tenant of a user — used to reject cross-tenant assignment without
   * pulling in the Identity module's internals. */
  findUserTenantId(userId: string): Promise<string | null>;

  // Service Definition
  createServiceDefinition(input: CreateServiceDefinitionInput): Promise<ServiceDefinition>;
  findServiceDefinitionById(id: string): Promise<ServiceDefinition | null>;
  findServiceDefinitionByCode(tenantId: string, code: string): Promise<ServiceDefinition | null>;
  listServiceDefinitions(tenantId: string): Promise<ServiceDefinition[]>;
  setServiceDefinitionActive(id: string, isActive: boolean, updatedBy: string | null): Promise<ServiceDefinition | null>;

  addChecklistTemplateItem(input: {
    serviceDefinitionId: string;
    code: string;
    label: string;
    isRequired: boolean;
    sortOrder: number;
  }): Promise<ServiceDefinitionChecklistItem>;
  listChecklistTemplateItems(serviceDefinitionId: string): Promise<ServiceDefinitionChecklistItem[]>;

  // Work Request
  createWorkRequest(input: CreateWorkRequestInput): Promise<WorkRequest>;
  findWorkRequestById(id: string): Promise<WorkRequest | null>;
  listWorkRequests(tenantId: string, filter: { customerIds?: string[] }): Promise<WorkRequest[]>;
  markWorkRequestConverted(id: string, workOrderId: string, updatedBy: string | null): Promise<WorkRequest | null>;
  cancelWorkRequest(id: string, reason: string | null, updatedBy: string | null): Promise<WorkRequest | null>;

  // Work Order
  createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder>;
  findWorkOrderById(id: string): Promise<WorkOrder | null>;
  listWorkOrders(
    tenantId: string,
    filter: { customerIds?: string[]; assignedToUserId?: string; siteId?: string },
  ): Promise<WorkOrder[]>;
  setWorkOrderWorkflowInstance(id: string, workflowInstanceId: string): Promise<void>;
  assignWorkOrder(id: string, assigneeUserId: string, assignedByUserId: string): Promise<WorkOrder | null>;
  scheduleWorkOrder(id: string, input: ScheduleWorkOrderInput, updatedBy: string | null): Promise<WorkOrder | null>;
  /** Guarded start: only sets execution facts when not already started —
   * returns null when a concurrent/duplicate start already won. */
  markWorkOrderStarted(id: string, userId: string): Promise<WorkOrder | null>;
  /** Guarded completion: only records completion when not already completed. */
  markWorkOrderCompleted(id: string, notes: string | null, userId: string): Promise<WorkOrder | null>;
  /** Guarded verification: only records verification when not already verified. */
  markWorkOrderVerified(id: string, notes: string | null, userId: string): Promise<WorkOrder | null>;
  /** Guarded acceptance: only when verified and not already accepted —
   * returns null when the guard fails (already accepted / not verified). */
  markCustomerAccepted(id: string, input: MarkCustomerAcceptedInput): Promise<WorkOrder | null>;
  /** Guarded rejection: only when verified and not accepted. Rejection is not
   * terminal — the WO can be reworked and a fresh token issued. */
  markCustomerRejected(id: string, input: MarkCustomerRejectedInput): Promise<WorkOrder | null>;

  // Work Order acceptance tokens (WP-OPS-01 Phase 6)
  /** Revokes every live (unused, unrevoked) token of the WO, then inserts a
   * new one — at most one live link per WO at any time. */
  replaceAcceptanceToken(
    tenantId: string,
    workOrderId: string,
    tokenHash: string,
    expiresAt: Date,
    createdBy: string | null,
  ): Promise<WorkOrderAcceptanceToken>;
  /** Global lookup by hash — the public route has no tenant context. */
  findAcceptanceTokenByHash(tokenHash: string): Promise<WorkOrderAcceptanceToken | null>;
  /** Atomic single-use claim: false when already used/revoked/expired. */
  claimAcceptanceToken(id: string): Promise<boolean>;

  // Work Order checklist
  createWorkOrderChecklistItems(
    workOrderId: string,
    items: {
      sourceChecklistItemId: string | null;
      code: string;
      label: string;
      isRequired: boolean;
      sortOrder: number;
    }[],
  ): Promise<WorkOrderChecklistItem[]>;
  listWorkOrderChecklistItems(workOrderId: string): Promise<WorkOrderChecklistItem[]>;
  findWorkOrderChecklistItem(id: string): Promise<WorkOrderChecklistItem | null>;
  setChecklistItemCompletion(
    id: string,
    input: { isCompleted: boolean; note: string | null; userId: string },
  ): Promise<WorkOrderChecklistItem | null>;

  // Work Order cost items (WP-OPS-02 Phase 6)
  /** DB-guarded insert: returns null when the Work Order is already
   * finalized (the row-locked EXISTS fence loses the race → 409 in caller). */
  insertCostItem(
    tenantId: string,
    workOrderId: string,
    input: AddCostItemInput,
  ): Promise<WorkOrderCostItem | null>;
  listCostItems(tenantId: string, workOrderId: string): Promise<WorkOrderCostItem[]>;
  sumCostItems(tenantId: string, workOrderId: string, client?: PoolClient): Promise<string>;
  /** Row lock for the finalize critical section: SELECT … FOR UPDATE on the
   * WO row while it is still unfinalized — null when already finalized. */
  lockWorkOrderForCostFinalize(id: string, client: PoolClient): Promise<WorkOrder | null>;
  /** Guarded finalize: UPDATE WHERE costs_finalized_at IS NULL — returns null
   * when a concurrent finalize already won (→ 409 in caller). Sets
   * costs_finalized_at = now() and costs_total = computed sum. */
  finalizeWorkOrderCosts(
    id: string,
    costsTotal: string,
    updatedBy: string | null,
    client?: PoolClient,
  ): Promise<WorkOrder | null>;
  /** Tenant-existence checks so a caller cannot attach another tenant's
   * cost center / legal entity to this tenant's WO. */
  costCenterBelongsToTenant(tenantId: string, costCenterId: string): Promise<boolean>;
  legalEntityBelongsToTenant(tenantId: string, legalEntityId: string): Promise<boolean>;
  /** Transaction wrapper — lets the service coordinate finalize + outbox
   * atomically without importing pg directly into the application layer. */
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Open accounting period covering the DB's CURRENT_DATE — compared in
   * SQL so the server's timezone cannot shift the decision date. */
  findOpenAccountingPeriodIdForToday(tenantId: string, legalEntityId: string): Promise<string | null>;

  // Customer invoice (WP-OPS-03 Phase 6)
  /** Insert one invoice per Work Order. ON CONFLICT (tenant_id,
   * work_order_id) DO NOTHING returns null on a concurrency duplicate (→
   * 409 in caller). Money is computed in SQL NUMERIC, never JS float. */
  insertCustomerInvoice(
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
  ): Promise<CustomerInvoice | null>;
  findInvoiceByWorkOrder(tenantId: string, workOrderId: string): Promise<CustomerInvoice | null>;

  // Work Order serving log (SO-CORE-016)
  createServingLog(input: CreateServingLogInput): Promise<WorkOrderServingLog>;
  findServingLogByWorkOrder(workOrderId: string): Promise<WorkOrderServingLog | null>;
  updateServingLog(id: string, input: UpdateServingLogInput): Promise<WorkOrderServingLog | null>;
  /** Mark WO as serving-recorded: SET serving_recorded_at = now(). Guarded
   * so multiple serves on the same WO cannot happen. */
  markWorkOrderServingRecorded(
    id: string,
    servingSupervisorUserId: string | null,
  ): Promise<WorkOrder | null>;

  // KPI aggregates (SO-CORE-017) — all 4 queries scoped to [periodStart, periodEnd).
  // Percentages/ratios calculated by PostgreSQL NUMERIC (no JS float).
  /** KPI 1: Production Achievement — sum(output_quantity) vs sum(planned_portions)
   * for confirmed/consumed meal batches with a meal_plan_id in range. */
  getProductionAchievement(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ actualQty: string; plannedQty: string; achievementPct: string; batchCount: number }>;

  /** KPI 2+3: Meal Fulfillment + Food Waste — sums from serving logs in range. */
  getServingTotals(
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
  }>;

  /** KPI 4: Food Cost per Meal — WO costs_total summed against the WO's own
   * serving log served_qty, for WOs whose serving was recorded in range. */
  getFoodCostTotals(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ totalCost: string; servedQty: string; costPerMeal: string; workOrderCount: number }>;
}
