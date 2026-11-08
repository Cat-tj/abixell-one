/**
 * Supply Chain Advanced Application Service (Wave A5: SCM-ADV-001…008).
 *
 * Implements the six Advanced Supply Chain capability groups:
 * 1. Multi-warehouse, Bin/Location, Batch/Lot, and Serial Tracking (SCM-ADV-001, SCM-ADV-002, SCM-ADV-003)
 * 2. Reservation, Reorder, Transfer, and Stock Opname (SCM-ADV-004) — generic Workflow Engine lifecycle delegation
 * 3. Inventory Valuation and Landed Cost (SCM-ADV-005) — deterministic exact-decimal calculation engine
 * 4. RFQ, Tender, and Bid Comparison (SCM-ADV-006) — generic Workflow Engine lifecycle delegation & scoring
 * 5. Supplier Evaluation and Contract Purchasing (SCM-ADV-007) — generic Workflow Engine lifecycle delegation
 * 6. Spend Analytics (SCM-ADV-008) — bounded parameterized spend aggregation
 *
 * Architectural constraints:
 * - Supply Chain Core is never mutated or directly imported; narrow repository read ports only.
 * - All lifecycles with workflows use WorkflowService exclusively with zero competing state machines.
 * - Workflow start failures are safely compensated (deleted if workflow fails to initialize).
 * - Valuation and landed cost use exact scaled integer arithmetic via valuation-policy.ts (no binary floating-point drift).
 * - Enforces the 14 Wave A5 RBAC permissions and centralized Organization Unit Data Scope (RbacService).
 */

import crypto from "node:crypto";
import { assertGradeCompatible, assertWarehouseRegradeAllowed } from "../domain/grade-policy.js";
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
import type {
  EntityWorkflowAction,
  EntityWorkflowStatus,
  WorkflowService,
} from "../../../../application/workflow/workflow.service.js";
import type {
  ApplyScmLandedCostInput,
  AwardScmSupplierBidInput,
  ConsumeScmValuationLayerInput,
  CreateScmAccountingReadyEventInput,
  CreateScmConsignmentSettlementInput,
  CreateScmDiscrepancyRecordInput,
  CreateScmInspectionInput,
  CreateScmInventoryDisposalInput,
  CreateScmItemBatchInput,
  CreateScmItemSerialInput,
  CreateScmLandedCostInput,
  CreateScmPaymentBatchInput,
  CreateScmReceiptReversalInput,
  CreateScmReceivingRecordInput,
  CreateScmReplacementDeliveryInput,
  CreateScmReturnToVendorInput,
  CreateScmRfqInput,
  CreateScmServiceAcceptanceInput,
  CreateScmSpendAnalyticsSnapshotInput,
  CreateScmStockOpnameInput,
  CreateScmStockReservationInput,
  CreateScmStockTransferInput,
  CreateScmSupplierBidInput,
  CreateScmSupplierContractInput,
  CreateScmSupplierEvaluationInput,
  CreateScmVendorInvoiceInput,
  CreateScmValuationLayerAllocationInput,
  CreateScmValuationLayerInput,
  CreateScmWarehouseInput,
  CreateScmWarehouseLocationInput,
  CreateScmWarehouseTaskInput,
  RecordScmAdvancedStockMovementInput,
  RecordScmStockOpnameCountInput,
  RecordScmStockTransferReceiptInput,
  RecordScmStockTransferShipmentInput,
  RecordScmSupplierContractSpendInput,
  ResolveScmDiscrepancyRecordInput,
  ScmAccountAssignmentConfig,
  ScmAccountAssignmentDimensions,
  ScmAccountAssignmentType,
  ScmAccountingEventStateKind,
  ScmAccountingOutboxState,
  ScmAccountingReadyEvent,
  ScmAccountingReadyEventFilter,
  ScmAccountingReadyEventStateTransition,
  ScmAccountingReadyEventType,
  ScmAccountingReconciliationState,
  ScmAdvancedStockBalance,
  ScmAdvancedStockBalanceFilter,
  ScmAdvancedStockMovement,
  ScmAdvancedStockMovementFilter,
  ScmConsignmentSettlement,
  ScmConsignmentSettlementFilter,
  ScmConsignmentSettlementLine,
  ScmDiscrepancyRecord,
  ScmDiscrepancyRecordFilter,
  ScmDiscrepancyStatus,
  ScmDiscrepancyType,
  ScmDisposalStatus,
  ScmDisposalType,
  ScmInspection,
  ScmInspectionResult,
  ScmInventoryAgingBucket,
  ScmInventoryAgingFilter,
  ScmInventoryDisposal,
  ScmInventoryDisposalFilter,
  ScmInventoryDisposalLine,
  ScmItemBatch,
  ScmItemBatchListFilter,
  ScmItemSerial,
  ScmItemSerialListFilter,
  ScmLandedCost,
  ScmLandedCostAllocation,
  ScmLandedCostFilter,
  ScmReceiptReversal,
  ScmReceiptReversalLine,
  ScmReceivingLine,
  ScmReceivingRecord,
  ScmReceivingRecordFilter,
  ScmReceivingStatus,
  ScmReorderPolicy,
  ScmReorderPolicyFilter,
  ScmReplacementDelivery,
  ScmReplacementDeliveryFilter,
  ScmReplacementDeliveryLine,
  ScmReplacementDeliveryStatus,
  ScmReturnToVendor,
  ScmReturnToVendorFilter,
  ScmReturnToVendorLine,
  ScmReturnToVendorStatus,
  ScmRfq,
  ScmRfqFilter,
  ScmRfqInvitedSupplier,
  ScmRfqItem,
  ScmRfqStatus,
  ScmServiceAcceptance,
  ScmServiceAcceptanceFilter,
  ScmServiceAcceptanceLine,
  ScmServiceAcceptanceStatus,
  ScmPaymentBatch,
  ScmPaymentBatchFilter,
  ScmPaymentBatchStatus,
  ScmPaymentLine,
  ScmVendorInvoice,
  ScmVendorInvoiceFilter,
  ScmVendorInvoiceLine,
  ScmVendorInvoiceStatus,
  ScmSpendAnalyticsSnapshot,
  ScmSpendAnalyticsSnapshotFilter,
  ScmStockCondition,
  ScmStockOpname,
  ScmStockOpnameFilter,
  ScmStockOpnameLine,
  ScmStockOwnerType,
  ScmStockReservation,
  ScmStockReservationFilter,
  ScmStockTransfer,
  ScmStockTransferFilter,
  ScmStockTransferLine,
  ScmSupplierBid,
  ScmSupplierBidFilter,
  ScmSupplierBidLine,
  ScmSupplierBidStatus,
  ScmSupplierContract,
  ScmSupplierContractFilter,
  ScmSupplierContractItem,
  ScmSupplierEvaluation,
  ScmSupplierEvaluationFilter,
  ScmValuationAllocationType,
  ScmValuationLayer,
  ScmValuationLayerAllocation,
  ScmValuationLayerAllocationFilter,
  ScmValuationLayerFilter,
  ScmWarehouse,
  ScmWarehouseListFilter,
  ScmWarehouseLocation,
  ScmWarehouseLocationListFilter,
  ScmWarehouseTask,
  ScmWarehouseTaskFilter,
  ScmWarehouseTaskItem,
  ScmWarehouseTaskItemStatus,
  ScmWarehouseTaskPriority,
  ScmWarehouseTaskStatus,
  ScmWarehouseTaskType,
  SupplyChainAdvancedRepository,
  UpdateScmAccountAssignmentConfigInput,
  UpdateScmAccountingReadyEventStateInput,
  UpdateScmInventoryDisposalStatusInput,
  UpdateScmItemSerialInput,
  UpdateScmReceivingLineInspectionProjectionInput,
  UpdateScmReceivingRecordStatusInput,
  UpdateScmRfqProjectionInput,
  UpdateScmServiceAcceptanceStatusInput,
  UpdateScmVendorInvoiceStatusInput,
  UpdateScmStockOpnameProjectionInput,
  UpdateScmStockTransferProjectionInput,
  UpdateScmSupplierBidScoreInput,
  UpdateScmSupplierContractProjectionInput,
  UpdateScmSupplierEvaluationProjectionInput,
  UpdateScmWarehouseInput,
  UpdateScmWarehouseLocationInput,
  UpdateScmWarehouseTaskItemInput,
  UpdateScmWarehouseTaskStatusInput,
  UpsertScmReorderPolicyInput,
} from "../domain/supply-chain-advanced.entity.js";
import {
  allocateLandedCost,
  divideCostQuantity,
} from "../domain/valuation-policy.js";

/** Configuration numbering codes for Supply Chain Advanced. */
export const SCM_STOCK_TRANSFER_NUMBERING_CODE = "scm_stock_transfer";
export const SCM_STOCK_OPNAME_NUMBERING_CODE = "scm_stock_opname";
export const SCM_RFQ_NUMBERING_CODE = "scm_rfq";
export const SCM_SUPPLIER_BID_NUMBERING_CODE = "scm_supplier_bid";
export const SCM_SUPPLIER_EVALUATION_NUMBERING_CODE = "scm_supplier_evaluation";
export const SCM_SUPPLIER_CONTRACT_NUMBERING_CODE = "scm_supplier_contract";
export const SCM_LANDED_COST_NUMBERING_CODE = "scm_landed_cost";
export const SCM_ITEM_BATCH_NUMBERING_CODE = "scm_item_batch";
export const SCM_RECEIVING_RECORD_NUMBERING_CODE = "scm_receiving_record";
export const SCM_INSPECTION_NUMBERING_CODE = "scm_inspection";
export const SCM_RETURN_TO_VENDOR_NUMBERING_CODE = "scm_return_to_vendor";
export const SCM_RECEIPT_REVERSAL_NUMBERING_CODE = "scm_receipt_reversal";
export const SCM_REPLACEMENT_DELIVERY_NUMBERING_CODE = "scm_replacement_delivery";
export const SCM_SERVICE_ACCEPTANCE_NUMBERING_CODE = "scm_service_acceptance";
export const SCM_CONSIGNMENT_SETTLEMENT_NUMBERING_CODE = "scm_consignment_settlement";
export const SCM_INVENTORY_DISPOSAL_NUMBERING_CODE = "scm_inventory_disposal";
export const SCM_WAREHOUSE_TASK_NUMBERING_CODE = "scm_warehouse_task";
export const SCM_VENDOR_INVOICE_NUMBERING_CODE = "scm_vendor_invoice";
export const SCM_PAYMENT_BATCH_NUMBERING_CODE = "scm_payment_batch";

/** WP-PRO-04: bid/RFQ states from which an award is still eligible. */
const SUPPLIER_BID_AWARDABLE_STATUSES = new Set<ScmSupplierBidStatus>(["evaluated", "shortlisted"]);
const RFQ_AWARDABLE_STATUSES = new Set<ScmRfqStatus>(["published", "in_evaluation"]);

/** Workflow definition codes for Supply Chain Advanced. */
export const SCM_STOCK_TRANSFER_WORKFLOW_DEFINITION_CODE = "scm_stock_transfer";
export const SCM_STOCK_OPNAME_WORKFLOW_DEFINITION_CODE = "scm_stock_opname";
export const SCM_RFQ_WORKFLOW_DEFINITION_CODE = "scm_rfq";
export const SCM_SUPPLIER_EVALUATION_WORKFLOW_DEFINITION_CODE = "scm_supplier_evaluation";
export const SCM_SUPPLIER_CONTRACT_WORKFLOW_DEFINITION_CODE = "scm_supplier_contract";

export interface StockTransferDetailView {
  transfer: ScmStockTransfer;
  lines: ScmStockTransferLine[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface StockOpnameDetailView {
  opname: ScmStockOpname;
  lines: ScmStockOpnameLine[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface RfqDetailView {
  rfq: ScmRfq;
  items: ScmRfqItem[];
  invitedSuppliers: ScmRfqInvitedSupplier[];
  bids: ScmSupplierBid[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface SupplierBidDetailView {
  bid: ScmSupplierBid;
  lines: ScmSupplierBidLine[];
}

export interface SupplierEvaluationDetailView {
  evaluation: ScmSupplierEvaluation;
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface SupplierContractDetailView {
  contract: ScmSupplierContract;
  items: ScmSupplierContractItem[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface LandedCostDetailView {
  landedCost: ScmLandedCost;
  allocations: ScmLandedCostAllocation[];
}

export class SupplyChainAdvancedService {
  constructor(
    private readonly repo: SupplyChainAdvancedRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly events: EventBus,
    private readonly configuration: ConfigurationService,
  ) {}

  // =========================================================================
  // 1. Warehouses & Storage Locations (SCM-ADV-001)
  // =========================================================================

  async createWarehouse(
    actor: ActorContext,
    input: Omit<CreateScmWarehouseInput, "createdBy">,
  ): Promise<ScmWarehouse> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.manage");
    await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);

    const warehouse = await this.repo.createWarehouse(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.warehouse.created",
      entityType: "scm_warehouse",
      entityId: warehouse.id,
      metadata: { code: warehouse.code, name: warehouse.name },
    });

    return warehouse;
  }

  async updateWarehouse(
    actor: ActorContext,
    warehouseId: string,
    input: UpdateScmWarehouseInput,
  ): Promise<ScmWarehouse> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.manage");
    const existing = await this.repo.findWarehouseById(actor.tenantId, warehouseId);
    if (!existing) {
      throw new NotFoundError("ScmWarehouse", warehouseId);
    }
    await this.assertOrganizationUnitInScope(actor, existing.organizationUnitId);
    if (input.organizationUnitId !== undefined) {
      await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);
    }
    // Re-grading must not strand stock of the other grade inside the warehouse.
    // The held-stock check runs inside the repository transaction under a row lock.
    const updated = await this.repo.updateWarehouse(
      actor.tenantId,
      warehouseId,
      { ...input, updatedBy: actor.userId },
      input.grade !== undefined
        ? (current, held) => assertWarehouseRegradeAllowed(current.code, input.grade ?? null, held)
        : undefined,
    );
    if (!updated) {
      throw new NotFoundError("ScmWarehouse", warehouseId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.warehouse.updated",
      entityType: "scm_warehouse",
      entityId: warehouseId,
      metadata: { input },
    });

    return updated;
  }

  async getWarehouse(actor: ActorContext, warehouseId: string): Promise<ScmWarehouse> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.read");
    const warehouse = await this.repo.findWarehouseById(actor.tenantId, warehouseId);
    if (!warehouse) {
      throw new NotFoundError("ScmWarehouse", warehouseId);
    }
    await this.assertOrganizationUnitInScope(actor, warehouse.organizationUnitId);
    return warehouse;
  }

  async listWarehouses(
    actor: ActorContext,
    filter: ScmWarehouseListFilter = {},
  ): Promise<ScmWarehouse[]> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.read");
    const scopedOrgUnitIds = await this.resolveScopedOrganizationUnitIds(
      actor,
      filter.organizationUnitIds && filter.organizationUnitIds.length > 0
        ? filter.organizationUnitIds[0]
        : undefined,
    );

    return this.repo.listWarehouses(actor.tenantId, {
      ...filter,
      organizationUnitIds: scopedOrgUnitIds ?? undefined,
    });
  }

  async createWarehouseLocation(
    actor: ActorContext,
    input: Omit<CreateScmWarehouseLocationInput, "createdBy">,
  ): Promise<ScmWarehouseLocation> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    const location = await this.repo.createWarehouseLocation(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.warehouse_location.created",
      entityType: "scm_warehouse_location",
      entityId: location.id,
      metadata: { locationCode: location.code, warehouseId: location.warehouseId },
    });

    return location;
  }

  async updateWarehouseLocation(
    actor: ActorContext,
    locationId: string,
    input: UpdateScmWarehouseLocationInput,
  ): Promise<ScmWarehouseLocation> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.manage");
    const existing = await this.repo.findWarehouseLocationById(actor.tenantId, locationId);
    if (!existing) {
      throw new NotFoundError("ScmWarehouseLocation", locationId);
    }
    await this.assertWarehouseInScope(actor, existing.warehouseId);

    const updated = await this.repo.updateWarehouseLocation(actor.tenantId, locationId, {
      ...input,
      updatedBy: actor.userId,
    });
    if (!updated) {
      throw new NotFoundError("ScmWarehouseLocation", locationId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.warehouse_location.updated",
      entityType: "scm_warehouse_location",
      entityId: locationId,
      metadata: { input },
    });

    return updated;
  }

  async getWarehouseLocation(actor: ActorContext, locationId: string): Promise<ScmWarehouseLocation> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.read");
    const location = await this.repo.findWarehouseLocationById(actor.tenantId, locationId);
    if (!location) {
      throw new NotFoundError("ScmWarehouseLocation", locationId);
    }
    await this.assertWarehouseInScope(actor, location.warehouseId);
    return location;
  }

  async listWarehouseLocations(
    actor: ActorContext,
    filter: ScmWarehouseLocationListFilter = {},
  ): Promise<ScmWarehouseLocation[]> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.read");
    if (filter.warehouseId) {
      await this.assertWarehouseInScope(actor, filter.warehouseId);
    }
    return this.repo.listWarehouseLocations(actor.tenantId, filter);
  }

  // =========================================================================
  // 2. Batches & Serials (SCM-ADV-002, SCM-ADV-003)
  // =========================================================================

  /**
   * Data Scope exception, stated rather than implied (Epic 5 G3 enforcement
   * batch): `scm_item_batches` carries `item_id` and nothing else — no
   * Organization Unit, no warehouse, no Legal Entity — so a batch master has no
   * placement to narrow by and no parent record to resolve. These three
   * operations are therefore permission-gated only, with the batch's own
   * capability (`supply_chain.inventory.manage` / `.read`). SERIALS, which DO
   * carry `warehouse_id`, are scope-asserted on every operation
   * (`assertWarehouseInScope` in create/update/get and `resolveScopedWarehouseIds`
   * in the list), so a serial recorded in another warehouse is still invisible.
   *
   * Consequence, so the next wave can weigh it: a unit-scoped clerk holding
   * `supply_chain.inventory.read` can read the Tenant's batch master list. The
   * list is item reference data, not stock or value; the stock itself is
   * warehoused and therefore scoped.
   */
  async createBatch(
    actor: ActorContext,
    input: Omit<CreateScmItemBatchInput, "createdBy" | "batchNumber"> & { batchNumber?: string },
  ): Promise<ScmItemBatch> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const batchNumber =
      (input.batchNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_ITEM_BATCH_NUMBERING_CODE,
        actor.userId,
      )).number);

    const batch = await this.repo.createItemBatch(actor.tenantId, {
      ...input,
      batchNumber,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.batch.created",
      entityType: "scm_item_batch",
      entityId: batch.id,
      metadata: { batchNumber: batch.batchNumber, itemId: batch.itemId },
    });

    return batch;
  }

  async getBatch(actor: ActorContext, batchId: string): Promise<ScmItemBatch> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const batch = await this.repo.findItemBatchById(actor.tenantId, batchId);
    if (!batch) {
      throw new NotFoundError("ScmItemBatch", batchId);
    }
    return batch;
  }

  async listBatches(
    actor: ActorContext,
    filter: ScmItemBatchListFilter = {},
  ): Promise<ScmItemBatch[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    return this.repo.listItemBatches(actor.tenantId, filter);
  }

  async createSerial(
    actor: ActorContext,
    input: Omit<CreateScmItemSerialInput, "createdBy">,
  ): Promise<ScmItemSerial> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    if (input.warehouseId) {
      await this.assertWarehouseInScope(actor, input.warehouseId);
    }

    const serial = await this.repo.createItemSerial(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.serial.created",
      entityType: "scm_item_serial",
      entityId: serial.id,
      metadata: { serialNumber: serial.serialNumber, itemId: serial.itemId },
    });

    return serial;
  }

  async updateSerial(
    actor: ActorContext,
    serialId: string,
    input: UpdateScmItemSerialInput,
  ): Promise<ScmItemSerial> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const existing = await this.repo.findItemSerialById(actor.tenantId, serialId);
    if (!existing) {
      throw new NotFoundError("ScmItemSerial", serialId);
    }
    if (existing.warehouseId) {
      await this.assertWarehouseInScope(actor, existing.warehouseId);
    }
    if (input.warehouseId) {
      await this.assertWarehouseInScope(actor, input.warehouseId);
    }

    const updated = await this.repo.updateItemSerial(actor.tenantId, serialId, {
      ...input,
      updatedBy: actor.userId,
    });
    if (!updated) {
      throw new NotFoundError("ScmItemSerial", serialId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.serial.updated",
      entityType: "scm_item_serial",
      entityId: serialId,
      metadata: { input },
    });

    return updated;
  }

  async getSerial(actor: ActorContext, serialId: string): Promise<ScmItemSerial> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const serial = await this.repo.findItemSerialById(actor.tenantId, serialId);
    if (!serial) {
      throw new NotFoundError("ScmItemSerial", serialId);
    }
    if (serial.warehouseId) {
      await this.assertWarehouseInScope(actor, serial.warehouseId);
    }
    return serial;
  }

  async listSerials(
    actor: ActorContext,
    filter: ScmItemSerialListFilter = {},
  ): Promise<ScmItemSerial[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listItemSerials(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // =========================================================================
  // 3. Stock Movements & Balances (SCM-ADV-001, SCM-ADV-004)
  // =========================================================================

  async recordStockMovement(
    actor: ActorContext,
    input: Omit<RecordScmAdvancedStockMovementInput, "createdBy">,
  ): Promise<{ movement: ScmAdvancedStockMovement; balance: ScmAdvancedStockBalance }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    const result = await this.repo.recordAdvancedStockMovement(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_movement.recorded",
      entityType: "scm_stock_movement",
      entityId: result.movement.id,
      metadata: {
        movementType: result.movement.movementType,
        quantity: result.movement.quantity,
        itemId: result.movement.itemId,
        warehouseId: result.movement.warehouseId,
      },
    });

    return result;
  }

  async listStockMovements(
    actor: ActorContext,
    filter: ScmAdvancedStockMovementFilter = {},
  ): Promise<ScmAdvancedStockMovement[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listAdvancedStockMovements(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  async getStockBalance(
    actor: ActorContext,
    itemId: string,
    warehouseId: string,
    locationId?: string,
    batchId?: string,
  ): Promise<ScmAdvancedStockBalance | null> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    await this.assertWarehouseInScope(actor, warehouseId);
    return this.repo.findAdvancedStockBalance(actor.tenantId, itemId, warehouseId, locationId, batchId);
  }

  async listStockBalances(
    actor: ActorContext,
    filter: ScmAdvancedStockBalanceFilter = {},
  ): Promise<ScmAdvancedStockBalance[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listAdvancedStockBalances(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // =========================================================================
  // 4. Reorder Policies & Reservations (SCM-ADV-004)
  // =========================================================================

  async upsertReorderPolicy(
    actor: ActorContext,
    input: Omit<UpsertScmReorderPolicyInput, "updatedBy">,
  ): Promise<ScmReorderPolicy> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.manage");
    if (input.warehouseId) {
      await this.assertWarehouseInScope(actor, input.warehouseId);
    }

    const policy = await this.repo.upsertReorderPolicy(actor.tenantId, {
      ...input,
      updatedBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.reorder_policy.upserted",
      entityType: "scm_reorder_policy",
      entityId: policy.id,
      metadata: { itemId: policy.itemId, warehouseId: policy.warehouseId, minQuantity: policy.minQuantity },
    });

    return policy;
  }

  async listReorderPolicies(
    actor: ActorContext,
    filter: ScmReorderPolicyFilter = {},
  ): Promise<ScmReorderPolicy[]> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listReorderPolicies(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  async computeReorderAlerts(
    actor: ActorContext,
    warehouseId?: string,
  ): Promise<Array<{ policy: ScmReorderPolicy; currentStock: number; suggestedOrderQuantity: number }>> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, warehouseId);

    const policies = await this.repo.listReorderPolicies(actor.tenantId, {
      warehouseId,
      warehouseIds: scopedWarehouseIds ?? undefined,
      activeOnly: true,
    });

    const alerts: Array<{ policy: ScmReorderPolicy; currentStock: number; suggestedOrderQuantity: number }> = [];

    for (const policy of policies) {
      const balance = await this.repo.findAdvancedStockBalance(
        actor.tenantId,
        policy.itemId,
        policy.warehouseId || "default",
      );
      const available = balance ? balance.availableQuantity : 0;

      if (available <= policy.reorderPoint) {
        const targetQuantity = Math.max(policy.minQuantity, policy.reorderPoint + policy.safetyStock);
        const replenishmentGap = Math.max(0, targetQuantity - available);
        const suggested = Math.max(policy.reorderQuantity, replenishmentGap);
        alerts.push({
          policy,
          currentStock: available,
          suggestedOrderQuantity: suggested,
        });
      }
    }

    return alerts;
  }

  async createStockReservation(
    actor: ActorContext,
    input: Omit<CreateScmStockReservationInput, "createdBy">,
  ): Promise<ScmStockReservation> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    const reservation = await this.repo.createStockReservation(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_reservation.created",
      entityType: "scm_stock_reservation",
      entityId: reservation.id,
      metadata: {
        itemId: reservation.itemId,
        warehouseId: reservation.warehouseId,
        quantity: reservation.quantity,
      },
    });

    return reservation;
  }

  async fulfillStockReservation(
    actor: ActorContext,
    reservationId: string,
  ): Promise<ScmStockReservation> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const existing = await this.repo.findStockReservationById(actor.tenantId, reservationId);
    if (!existing) {
      throw new NotFoundError("ScmStockReservation", reservationId);
    }
    await this.assertWarehouseInScope(actor, existing.warehouseId);

    const reservation = await this.repo.updateStockReservationStatus(
      actor.tenantId,
      reservationId,
      "fulfilled",
      new Date(),
      actor.userId,
    );
    if (!reservation) {
      throw new NotFoundError("ScmStockReservation", reservationId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_reservation.fulfilled",
      entityType: "scm_stock_reservation",
      entityId: reservationId,
      metadata: { status: "fulfilled" },
    });

    return reservation;
  }

  async cancelStockReservation(
    actor: ActorContext,
    reservationId: string,
  ): Promise<ScmStockReservation> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const existing = await this.repo.findStockReservationById(actor.tenantId, reservationId);
    if (!existing) {
      throw new NotFoundError("ScmStockReservation", reservationId);
    }
    await this.assertWarehouseInScope(actor, existing.warehouseId);

    const reservation = await this.repo.updateStockReservationStatus(
      actor.tenantId,
      reservationId,
      "cancelled",
      new Date(),
    );
    if (!reservation) {
      throw new NotFoundError("ScmStockReservation", reservationId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_reservation.cancelled",
      entityType: "scm_stock_reservation",
      entityId: reservationId,
      metadata: { status: "cancelled" },
    });

    return reservation;
  }

  async listStockReservations(
    actor: ActorContext,
    filter: ScmStockReservationFilter = {},
  ): Promise<ScmStockReservation[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listStockReservations(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // =========================================================================
  // 5. Stock Transfers & Opnames (SCM-ADV-004)
  // =========================================================================

  async createStockTransfer(
    actor: ActorContext,
    input: Omit<CreateScmStockTransferInput, "createdBy" | "transferNumber"> & { transferNumber?: string },
  ): Promise<StockTransferDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const fromWarehouse = await this.assertWarehouseInScope(actor, input.fromWarehouseId);
    await this.assertWarehouseInScope(actor, input.toWarehouseId);
    // Fail early (before a workflow instance exists) on grade-incompatible lines;
    // the ledger write enforces the same rule again at shipment/receipt time.
    for (const line of input.lines ?? []) {
      for (const warehouseId of [input.fromWarehouseId, input.toWarehouseId]) {
        const ctx = await this.repo.findGradeContext(actor.tenantId, line.itemId, warehouseId);
        if (ctx) assertGradeCompatible(ctx);
      }
    }

    const transferNumber =
      (input.transferNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_STOCK_TRANSFER_NUMBERING_CODE,
        actor.userId,
      )).number);

    const { transfer, lines } = await this.repo.createStockTransfer(actor.tenantId, {
      ...input,
      transferNumber,
      createdBy: actor.userId,
    });

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: SCM_STOCK_TRANSFER_WORKFLOW_DEFINITION_CODE,
        entityId: transfer.id,
        contextData: {
          // ADR-0012: follows the SOURCE warehouse's owning unit (the shipping site).
          organizationUnitId: fromWarehouse.organizationUnitId,
          transferNumber,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
        },
      });
      workflowInstanceId = instance.id;
      await this.repo.updateStockTransferProjection(actor.tenantId, {
        transferId: transfer.id,
        status: "draft",
        workflowInstanceId,
        updatedBy: actor.userId,
      });
      transfer.status = "draft";
      transfer.workflowInstanceId = workflowInstanceId;
    } catch (err) {
      // Compensating delete if workflow startup fails
      await this.repo.deleteStockTransferWithoutWorkflow(actor.tenantId, transfer.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_transfer.created",
      entityType: "scm_stock_transfer",
      entityId: transfer.id,
      metadata: { transferNumber, from: input.fromWarehouseId, to: input.toWarehouseId },
    });

    const status = workflowInstanceId ? await this.workflow.getEntityStatus(actor, workflowInstanceId) : null;
    const availableActions = workflowInstanceId
      ? (await this.workflow.getEntityWorkflowView(actor, workflowInstanceId)).availableActions
      : [];

    return { transfer, lines, status, availableActions };
  }

  async getStockTransfer(actor: ActorContext, transferId: string): Promise<StockTransferDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const result = await this.repo.findStockTransferById(actor.tenantId, transferId);
    if (!result) {
      throw new NotFoundError("ScmStockTransfer", transferId);
    }
    await this.assertWarehouseInScope(actor, result.transfer.fromWarehouseId);
    await this.assertWarehouseInScope(actor, result.transfer.toWarehouseId);

    const instanceId = result.transfer.workflowInstanceId;
    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (instanceId) {
      try {
        status = await this.workflow.getEntityStatus(actor, instanceId);
        const view = await this.workflow.getEntityWorkflowView(actor, instanceId);
        availableActions = view.availableActions;
      } catch {
        // Workflow instance not found or unassigned
      }
    }

    return {
      transfer: result.transfer,
      lines: result.lines,
      status,
      availableActions,
    };
  }

  async listStockTransfers(
    actor: ActorContext,
    filter: ScmStockTransferFilter = {},
  ): Promise<Array<{ transfer: ScmStockTransfer; status: EntityWorkflowStatus | null }>> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(
      actor,
      filter.fromWarehouseId || filter.toWarehouseId,
    );

    const transfers = await this.repo.listStockTransfers(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });

    return this.withWorkflowStatus(
      actor,
      transfers,
      (t) => t.workflowInstanceId,
      (transfer, status) => ({ transfer, status }),
    );
  }

  async actOnStockTransfer(
    actor: ActorContext,
    transferId: string,
    action: string,
    comment?: string,
  ): Promise<StockTransferDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const result = await this.repo.findStockTransferById(actor.tenantId, transferId);
    if (!result) {
      throw new NotFoundError("ScmStockTransfer", transferId);
    }
    await this.assertWarehouseInScope(actor, result.transfer.fromWarehouseId);

    if (!result.transfer.workflowInstanceId) {
      throw new ValidationError(`Transfer ${transferId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.transfer.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending action exists on this transfer");
    }

    await this.workflow.actOnAssignment(actor, pending.id, action, comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, result.transfer.workflowInstanceId);

    let projectedStatus = result.transfer.status;
    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "approved";
    } else if (workflowStatus.instanceStatus === "cancelled" || workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "cancelled";
    }

    const updatedTransfer = await this.repo.updateStockTransferProjection(actor.tenantId, {
      transferId,
      status: projectedStatus,
      cancelledAt: projectedStatus === "cancelled" ? new Date() : undefined,
      updatedBy: actor.userId,
    });

    return this.getStockTransfer(actor, transferId);
  }

  async recordStockTransferShipment(
    actor: ActorContext,
    input: RecordScmStockTransferShipmentInput,
  ): Promise<StockTransferDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const result = await this.repo.findStockTransferById(actor.tenantId, input.transferId);
    if (!result) {
      throw new NotFoundError("ScmStockTransfer", input.transferId);
    }
    await this.assertWarehouseInScope(actor, result.transfer.fromWarehouseId);

    await this.repo.recordStockTransferShipment(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_transfer.shipped",
      entityType: "scm_stock_transfer",
      entityId: input.transferId,
      metadata: { lineShipments: input.lineShipments },
    });

    return this.getStockTransfer(actor, input.transferId);
  }

  async recordStockTransferReceipt(
    actor: ActorContext,
    input: RecordScmStockTransferReceiptInput,
  ): Promise<StockTransferDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const result = await this.repo.findStockTransferById(actor.tenantId, input.transferId);
    if (!result) {
      throw new NotFoundError("ScmStockTransfer", input.transferId);
    }
    await this.assertWarehouseInScope(actor, result.transfer.toWarehouseId);

    await this.repo.recordStockTransferReceipt(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_transfer.received",
      entityType: "scm_stock_transfer",
      entityId: input.transferId,
      metadata: { lineReceipts: input.lineReceipts },
    });

    return this.getStockTransfer(actor, input.transferId);
  }

  /**
   * Receiver rejects part of a shipment: the still-in-transit quantity goes
   * back to the source warehouse and the doc reopens as a draft so the sender
   * can remove lines or change quantities. Receiving itself needs no approval
   * — only the original shipment does.
   */
  async returnStockTransferToDraft(
    actor: ActorContext,
    transferId: string,
    comment?: string,
  ): Promise<StockTransferDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const result = await this.repo.findStockTransferById(actor.tenantId, transferId);
    if (!result) {
      throw new NotFoundError("ScmStockTransfer", transferId);
    }
    await this.assertWarehouseInScope(actor, result.transfer.fromWarehouseId);
    await this.assertWarehouseInScope(actor, result.transfer.toWarehouseId);

    await this.repo.revertStockTransferToDraft(actor.tenantId, transferId, actor.userId);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_transfer.returned_to_draft",
      entityType: "scm_stock_transfer",
      entityId: transferId,
      metadata: { comment: comment ?? null },
    });

    return this.getStockTransfer(actor, transferId);
  }

  async createStockOpname(
    actor: ActorContext,
    input: Omit<CreateScmStockOpnameInput, "createdBy" | "opnameNumber"> & { opnameNumber?: string },
  ): Promise<StockOpnameDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const opnameWarehouse = await this.assertWarehouseInScope(actor, input.warehouseId);

    const opnameNumber =
      (input.opnameNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_STOCK_OPNAME_NUMBERING_CODE,
        actor.userId,
      )).number);

    const { opname, lines } = await this.repo.createStockOpname(actor.tenantId, {
      ...input,
      opnameNumber,
      createdBy: actor.userId,
    });

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: SCM_STOCK_OPNAME_WORKFLOW_DEFINITION_CODE,
        entityId: opname.id,
        contextData: {
          // ADR-0012: follows the warehouse's owning unit.
          organizationUnitId: opnameWarehouse.organizationUnitId,
          opnameNumber,
          warehouseId: input.warehouseId,
        },
      });
      workflowInstanceId = instance.id;
      await this.repo.updateStockOpnameProjection(actor.tenantId, {
        opnameId: opname.id,
        status: "in_progress",
        workflowInstanceId,
        updatedBy: actor.userId,
      });
      opname.status = "in_progress";
      opname.workflowInstanceId = workflowInstanceId;
    } catch (err) {
      await this.repo.deleteStockOpnameWithoutWorkflow(actor.tenantId, opname.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.stock_opname.created",
      entityType: "scm_stock_opname",
      entityId: opname.id,
      metadata: { opnameNumber, warehouseId: input.warehouseId },
    });

    const status = workflowInstanceId ? await this.workflow.getEntityStatus(actor, workflowInstanceId) : null;
    const availableActions = workflowInstanceId
      ? (await this.workflow.getEntityWorkflowView(actor, workflowInstanceId)).availableActions
      : [];

    return { opname, lines, status, availableActions };
  }

  async recordStockOpnameCount(
    actor: ActorContext,
    input: RecordScmStockOpnameCountInput,
  ): Promise<ScmStockOpnameLine> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertInventoryLineInScope(actor, { opnameLineId: input.lineId });
    const line = await this.repo.recordStockOpnameCount(actor.tenantId, input);
    if (!line) {
      throw new NotFoundError("ScmStockOpnameLine", input.lineId);
    }
    return line;
  }

  async getStockOpname(actor: ActorContext, opnameId: string): Promise<StockOpnameDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const result = await this.repo.findStockOpnameById(actor.tenantId, opnameId);
    if (!result) {
      throw new NotFoundError("ScmStockOpname", opnameId);
    }
    await this.assertWarehouseInScope(actor, result.opname.warehouseId);

    const instanceId = result.opname.workflowInstanceId;
    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (instanceId) {
      try {
        status = await this.workflow.getEntityStatus(actor, instanceId);
        const view = await this.workflow.getEntityWorkflowView(actor, instanceId);
        availableActions = view.availableActions;
      } catch {
        // Stale or unassigned instance
      }
    }

    return {
      opname: result.opname,
      lines: result.lines,
      status,
      availableActions,
    };
  }

  async listStockOpnames(
    actor: ActorContext,
    filter: ScmStockOpnameFilter = {},
  ): Promise<Array<{ opname: ScmStockOpname; status: EntityWorkflowStatus | null }>> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    const opnames = await this.repo.listStockOpnames(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });

    return this.withWorkflowStatus(
      actor,
      opnames,
      (o) => o.workflowInstanceId,
      (opname, status) => ({ opname, status }),
    );
  }

  async actOnStockOpname(
    actor: ActorContext,
    opnameId: string,
    action: string,
    comment?: string,
  ): Promise<StockOpnameDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    const result = await this.repo.findStockOpnameById(actor.tenantId, opnameId);
    if (!result) {
      throw new NotFoundError("ScmStockOpname", opnameId);
    }
    await this.assertWarehouseInScope(actor, result.opname.warehouseId);

    if (!result.opname.workflowInstanceId) {
      throw new ValidationError(`Opname ${opnameId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.opname.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending action exists on this opname");
    }

    await this.workflow.actOnAssignment(actor, pending.id, action, comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, result.opname.workflowInstanceId);

    let projectedStatus = result.opname.status;

    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "adjusted";
    } else if (workflowStatus.instanceStatus === "cancelled" || workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "cancelled";
    }

    // Approval is what makes the physical count the truth: the adjustment pass
    // posts the variances and flips the status in ONE transaction, so a failed
    // posting can never leave an opname marked adjusted with no movements.
    if (projectedStatus === "adjusted") {
      const adjusted = await this.repo.applyStockOpnameAdjustments(actor.tenantId, opnameId, actor.userId);
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "scm_advanced.stock_opname.adjusted",
        entityType: "scm_stock_opname",
        entityId: opnameId,
        metadata: { adjustedLines: adjusted.length },
      });
    } else {
      await this.repo.updateStockOpnameProjection(actor.tenantId, {
        opnameId,
        status: projectedStatus,
        updatedBy: actor.userId,
      });
    }

    return this.getStockOpname(actor, opnameId);
  }

  // =========================================================================
  // 6. Valuation & Landed Cost (SCM-ADV-005)
  // =========================================================================

  async createValuationLayer(
    actor: ActorContext,
    input: CreateScmValuationLayerInput,
  ): Promise<ScmValuationLayer> {
    await this.rbac.requirePermission(actor, "supply_chain.valuation.manage");
    if (input.warehouseId) {
      await this.assertWarehouseInScope(actor, input.warehouseId);
    } else {
      const hasTenant = await this.rbac.hasTenantScope(actor);
      if (!hasTenant) {
        throw new ForbiddenError("Tenant-wide scope required for global valuation layers");
      }
    }

    const remainingQuantity = input.remainingQuantity ?? input.originalQuantity;
    const effectiveUnitCost = input.effectiveUnitCost ?? input.unitCost;
    const totalValue = input.totalValue ?? (input.originalQuantity * input.unitCost);

    const layer = await this.repo.createValuationLayer(actor.tenantId, {
      ...input,
      remainingQuantity,
      effectiveUnitCost,
      totalValue,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.valuation_layer.created",
      entityType: "scm_valuation_layer",
      entityId: layer.id,
      metadata: {
        itemId: layer.itemId,
        warehouseId: layer.warehouseId,
        quantity: layer.originalQuantity,
        unitCost: layer.unitCost,
      },
    });

    return layer;
  }

  async consumeValuationLayer(
    actor: ActorContext,
    input: ConsumeScmValuationLayerInput,
  ): Promise<ScmValuationLayer> {
    await this.rbac.requirePermission(actor, "supply_chain.valuation.manage");
    const existing = await this.repo.findValuationLayerById(actor.tenantId, input.layerId);
    if (!existing) {
      throw new NotFoundError("ScmValuationLayer", input.layerId);
    }
    if (existing.warehouseId) {
      await this.assertWarehouseInScope(actor, existing.warehouseId);
    } else {
      const hasTenant = await this.rbac.hasTenantScope(actor);
      if (!hasTenant) {
        throw new ForbiddenError("Tenant-wide scope required for global valuation layers");
      }
    }

    const layer = await this.repo.updateValuationLayerRemainingQuantity(actor.tenantId, input);
    if (!layer) {
      throw new NotFoundError("ScmValuationLayer", input.layerId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.valuation_layer.consumed",
      entityType: "scm_valuation_layer",
      entityId: layer.id,
      metadata: { consumedQuantity: input.remainingQuantity, remaining: layer.remainingQuantity },
    });

    return layer;
  }

  async listValuationLayers(
    actor: ActorContext,
    filter: ScmValuationLayerFilter = {},
  ): Promise<ScmValuationLayer[]> {
    await this.rbac.requirePermission(actor, "supply_chain.valuation.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listValuationLayers(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  async createLandedCost(
    actor: ActorContext,
    input: Omit<CreateScmLandedCostInput, "createdBy" | "voucherNumber"> & {
      voucherNumber?: string;
      itemsToAllocate?: Array<{ itemId: string; quantity: number; baseAmount: number; weight?: number }>;
    },
  ): Promise<LandedCostDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.valuation.manage");
    await this.assertTenantLevelScope(actor, "Landed cost documents");

    const voucherNumber =
      (input.voucherNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_LANDED_COST_NUMBERING_CODE,
        actor.userId,
      )).number);

    let allocationsInput = input.allocations || [];

    // If items to allocate are provided dynamically, calculate allocations using exact decimal policy
    if (input.itemsToAllocate && input.itemsToAllocate.length > 0 && allocationsInput.length === 0) {
      const allocated = allocateLandedCost(
        input.amount,
        input.itemsToAllocate,
        input.allocationMethod,
      );
      allocationsInput = allocated.map((a) => ({
        itemId: a.itemId,
        allocatedAmount: a.allocatedAmount,
        costPerUnitAdded: a.costPerUnitAdded,
      }));
    }

    const { landedCost, allocations } = await this.repo.createLandedCost(actor.tenantId, {
      ...input,
      voucherNumber,
      allocations: allocationsInput,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.landed_cost.created",
      entityType: "scm_landed_cost",
      entityId: landedCost.id,
      metadata: { voucherNumber, amount: landedCost.amount },
    });

    return { landedCost, allocations };
  }

  async applyLandedCost(
    actor: ActorContext,
    landedCostId: string,
  ): Promise<LandedCostDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.valuation.manage");
    await this.assertTenantLevelScope(actor, "Landed cost documents");
    const existing = await this.repo.findLandedCostById(actor.tenantId, landedCostId);
    if (!existing) {
      throw new NotFoundError("ScmLandedCost", landedCostId);
    }

    const appliedAt = new Date();
    const legalEntityId = await this.repo.findLandedCostLegalEntityId(actor.tenantId, landedCostId);
    if (!legalEntityId) {
      throw new ConflictError(`Landed cost ${landedCostId} has no resolvable legal entity`);
    }
    const period = (await this.repo.listOpenPeriods(actor.tenantId, legalEntityId)).find(
      (candidate) => appliedAt >= candidate.dateFrom && appliedAt <= candidate.dateTo,
    );
    if (!period) {
      throw new ConflictError(`No open accounting period contains landed cost application date ${appliedAt.toISOString()}`);
    }

    const applied = await this.repo.applyLandedCost(actor.tenantId, {
      landedCostId,
      appliedAt,
      legalEntityId,
      periodId: period.id,
    });
    if (!applied) {
      throw new ConflictError(
        `Landed cost ${landedCostId} is not in draft status (already applied or cancelled)`,
      );
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.landed_cost.applied",
      entityType: "scm_landed_cost",
      entityId: landedCostId,
      metadata: { status: "applied" },
    });

    const result = await this.repo.findLandedCostById(actor.tenantId, landedCostId);
    return result!;
  }

  async getLandedCost(actor: ActorContext, landedCostId: string): Promise<LandedCostDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.valuation.read");
    await this.assertTenantLevelScope(actor, "Landed cost documents");
    const result = await this.repo.findLandedCostById(actor.tenantId, landedCostId);
    if (!result) {
      throw new NotFoundError("ScmLandedCost", landedCostId);
    }
    return result;
  }

  async listLandedCosts(
    actor: ActorContext,
    filter: ScmLandedCostFilter = {},
  ): Promise<ScmLandedCost[]> {
    await this.rbac.requirePermission(actor, "supply_chain.valuation.read");
    await this.assertTenantLevelScope(actor, "Landed cost documents");
    return this.repo.listLandedCosts(actor.tenantId, filter);
  }

  // =========================================================================
  // 7. RFQ, Tender & Bids (SCM-ADV-006)
  // =========================================================================

  async createRfq(
    actor: ActorContext,
    input: Omit<CreateScmRfqInput, "createdBy" | "rfqNumber"> & { rfqNumber?: string },
  ): Promise<RfqDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.manage");
    await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);

    const rfqNumber =
      (input.rfqNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_RFQ_NUMBERING_CODE,
        actor.userId,
      )).number);

    const { rfq, items, invitedSuppliers } = await this.repo.createRfq(actor.tenantId, {
      ...input,
      rfqNumber,
      createdBy: actor.userId,
    });

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: SCM_RFQ_WORKFLOW_DEFINITION_CODE,
        entityId: rfq.id,
        contextData: {
          rfqNumber,
          title: rfq.title,
          organizationUnitId: input.organizationUnitId,
        },
      });
      workflowInstanceId = instance.id;
      await this.repo.updateRfqProjection(actor.tenantId, {
        rfqId: rfq.id,
        status: "published",
        workflowInstanceId,
        updatedBy: actor.userId,
      });
      rfq.status = "published";
      rfq.workflowInstanceId = workflowInstanceId;
    } catch (err) {
      await this.repo.deleteRfqWithoutWorkflow(actor.tenantId, rfq.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.rfq.created",
      entityType: "scm_rfq",
      entityId: rfq.id,
      metadata: { rfqNumber, title: rfq.title },
    });

    const status = workflowInstanceId ? await this.workflow.getEntityStatus(actor, workflowInstanceId) : null;
    const availableActions = workflowInstanceId
      ? (await this.workflow.getEntityWorkflowView(actor, workflowInstanceId)).availableActions
      : [];

    return {
      rfq,
      items,
      invitedSuppliers,
      bids: [],
      status,
      availableActions,
    };
  }

  async getRfq(actor: ActorContext, rfqId: string): Promise<RfqDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.read");
    const result = await this.repo.findRfqById(actor.tenantId, rfqId);
    if (!result) {
      throw new NotFoundError("ScmRfq", rfqId);
    }
    await this.assertOrganizationUnitInScope(actor, result.rfq.organizationUnitId);

    const bids = await this.repo.listSupplierBids(actor.tenantId, { rfqId });

    const instanceId = result.rfq.workflowInstanceId;
    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (instanceId) {
      try {
        status = await this.workflow.getEntityStatus(actor, instanceId);
        const view = await this.workflow.getEntityWorkflowView(actor, instanceId);
        availableActions = view.availableActions;
      } catch {
        // Stale or unassigned instance
      }
    }

    return {
      rfq: result.rfq,
      items: result.items,
      invitedSuppliers: result.invitedSuppliers,
      bids,
      status,
      availableActions,
    };
  }

  async listRfqs(
    actor: ActorContext,
    filter: ScmRfqFilter = {},
  ): Promise<Array<{ rfq: ScmRfq; status: EntityWorkflowStatus | null }>> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.read");
    const scopedOrgUnitIds = await this.resolveScopedOrganizationUnitIds(
      actor,
      filter.organizationUnitIds && filter.organizationUnitIds.length > 0
        ? filter.organizationUnitIds[0]
        : undefined,
    );

    const rfqs = await this.repo.listRfqs(actor.tenantId, {
      ...filter,
      organizationUnitIds: scopedOrgUnitIds ?? undefined,
    });

    return this.withWorkflowStatus(
      actor,
      rfqs,
      (r) => r.workflowInstanceId,
      (rfq, status) => ({ rfq, status }),
    );
  }

  async actOnRfq(
    actor: ActorContext,
    rfqId: string,
    action: string,
    comment?: string,
  ): Promise<RfqDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.manage");
    const result = await this.repo.findRfqById(actor.tenantId, rfqId);
    if (!result) {
      throw new NotFoundError("ScmRfq", rfqId);
    }
    await this.assertOrganizationUnitInScope(actor, result.rfq.organizationUnitId);

    if (!result.rfq.workflowInstanceId) {
      throw new ValidationError(`RFQ ${rfqId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.rfq.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending action exists on this RFQ");
    }

    await this.workflow.actOnAssignment(actor, pending.id, action, comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, result.rfq.workflowInstanceId);

    let projectedStatus = result.rfq.status;
    let awardedAt: Date | undefined;
    let cancelledAt: Date | undefined;

    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "closed";
      awardedAt = new Date();
    } else if (workflowStatus.instanceStatus === "cancelled" || workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "cancelled";
      cancelledAt = new Date();
    }

    await this.repo.updateRfqProjection(actor.tenantId, {
      rfqId,
      status: projectedStatus,
      awardedAt,
      cancelledAt,
      updatedBy: actor.userId,
    });

    return this.getRfq(actor, rfqId);
  }

  async submitSupplierBid(
    actor: ActorContext,
    input: Omit<CreateScmSupplierBidInput, "createdBy" | "bidNumber"> & { bidNumber?: string },
  ): Promise<SupplierBidDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.manage");
    const rfqResult = await this.repo.findRfqById(actor.tenantId, input.rfqId);
    if (!rfqResult) {
      throw new NotFoundError("ScmRfq", input.rfqId);
    }
    await this.assertOrganizationUnitInScope(actor, rfqResult.rfq.organizationUnitId);

    const bidNumber =
      (input.bidNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_SUPPLIER_BID_NUMBERING_CODE,
        actor.userId,
      )).number);

    const { bid, lines } = await this.repo.createSupplierBid(actor.tenantId, {
      ...input,
      bidNumber,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.supplier_bid.submitted",
      entityType: "scm_supplier_bid",
      entityId: bid.id,
      metadata: { bidNumber, rfqId: input.rfqId, supplierId: input.supplierId },
    });

    return { bid, lines };
  }

  async scoreSupplierBid(
    actor: ActorContext,
    bidId: string,
    input: Omit<UpdateScmSupplierBidScoreInput, "bidId" | "updatedBy">,
  ): Promise<ScmSupplierBid> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.manage");
    const existing = await this.repo.findSupplierBidById(actor.tenantId, bidId);
    if (!existing) {
      throw new NotFoundError("ScmSupplierBid", bidId);
    }
    const rfq = await this.repo.findRfqById(actor.tenantId, existing.bid.rfqId);
    if (rfq) {
      await this.assertOrganizationUnitInScope(actor, rfq.rfq.organizationUnitId);
    }

    const tech = input.technicalScore !== undefined ? input.technicalScore : existing.bid.technicalScore;
    const comm = input.commercialScore !== undefined ? input.commercialScore : existing.bid.commercialScore;
    let finalScore = input.finalScore;
    if (finalScore === undefined && (tech !== null || comm !== null)) {
      const validScores: number[] = [];
      if (tech !== null && tech !== undefined) validScores.push(tech);
      if (comm !== null && comm !== undefined) validScores.push(comm);
      if (validScores.length > 0) {
        finalScore = validScores.reduce((a, b) => a + b, 0) / validScores.length;
      }
    }

    const updated = await this.repo.updateSupplierBidScore(actor.tenantId, {
      ...input,
      finalScore,
      bidId,
      updatedBy: actor.userId,
    });
    if (!updated) {
      throw new NotFoundError("ScmSupplierBid", bidId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.supplier_bid.scored",
      entityType: "scm_supplier_bid",
      entityId: bidId,
      metadata: { finalScore: updated.finalScore, rank: updated.rank },
    });

    return updated;
  }

  async awardSupplierBid(
    actor: ActorContext,
    bidId: string,
    resultingPurchaseOrderId?: string,
  ): Promise<ScmSupplierBid> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.manage");
    const existing = await this.repo.findSupplierBidById(actor.tenantId, bidId);
    if (!existing) {
      throw new NotFoundError("ScmSupplierBid", bidId);
    }
    const rfq = await this.repo.findRfqById(actor.tenantId, existing.bid.rfqId);
    if (rfq) {
      await this.assertOrganizationUnitInScope(actor, rfq.rfq.organizationUnitId);
    }

    const rejectAward = async (reason: string): Promise<never> => {
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "scm_advanced.supplier_bid.award_rejected",
        entityType: "scm_supplier_bid",
        entityId: bidId,
        metadata: {
          reason,
          supplierId: existing.bid.supplierId,
          bidStatus: existing.bid.status,
          rfqId: existing.bid.rfqId,
          rfqStatus: rfq?.rfq.status ?? null,
        },
      });
      throw new ValidationError(reason);
    };

    // WP-PRO-04 pre-award eligibility gate (DEC-005). A bid may only be awarded
    // while the supplier is still active, the bid is in a decided-but-unsettled
    // state, and the RFQ is still open for award. Each rejection names the rule
    // and is persisted to audit so the refusal is traceable for appeal.
    if (!SUPPLIER_BID_AWARDABLE_STATUSES.has(existing.bid.status)) {
      await rejectAward(
        `Bid status is '${existing.bid.status}', cannot award (eligible: ${[...SUPPLIER_BID_AWARDABLE_STATUSES].join(", ")})`,
      );
    }

    if (rfq && !RFQ_AWARDABLE_STATUSES.has(rfq.rfq.status)) {
      await rejectAward(
        `RFQ status is '${rfq.rfq.status}', cannot award (eligible: ${[...RFQ_AWARDABLE_STATUSES].join(", ")})`,
      );
    }

    const supplierActive = await this.repo.findSupplierActive(actor.tenantId, existing.bid.supplierId);
    if (supplierActive === null) {
      await rejectAward(`Supplier ${existing.bid.supplierId} not found, cannot award`);
    }
    if (!supplierActive) {
      await rejectAward(`Supplier is inactive, cannot award bid ${bidId}`);
    }

    const awarded = await this.repo.awardSupplierBid(actor.tenantId, {
      bidId,
      resultingPurchaseOrderId,
      updatedBy: actor.userId,
    });
    if (!awarded) {
      throw new ConflictError("Supplier bid could not be awarded; status changed concurrently");
    }

    // Update RFQ status to awarded
    if (rfq) {
      await this.repo.updateRfqProjection(actor.tenantId, {
        rfqId: rfq.rfq.id,
        status: "awarded",
        awardedAt: new Date(),
        updatedBy: actor.userId,
      });
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.supplier_bid.awarded",
      entityType: "scm_supplier_bid",
      entityId: bidId,
      metadata: { resultingPurchaseOrderId },
    });

    return awarded;
  }

  async getSupplierBid(actor: ActorContext, bidId: string): Promise<SupplierBidDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.read");
    const result = await this.repo.findSupplierBidById(actor.tenantId, bidId);
    if (!result) {
      throw new NotFoundError("ScmSupplierBid", bidId);
    }
    const rfq = await this.repo.findRfqById(actor.tenantId, result.bid.rfqId);
    if (rfq) {
      await this.assertOrganizationUnitInScope(actor, rfq.rfq.organizationUnitId);
    }
    return result;
  }

  async listSupplierBids(
    actor: ActorContext,
    filter: ScmSupplierBidFilter = {},
  ): Promise<ScmSupplierBid[]> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.read");
    if (filter.rfqId) {
      const rfq = await this.repo.findRfqById(actor.tenantId, filter.rfqId);
      if (rfq) {
        await this.assertOrganizationUnitInScope(actor, rfq.rfq.organizationUnitId);
      }
    }
    return this.repo.listSupplierBids(actor.tenantId, filter);
  }

  // =========================================================================
  // 8. Supplier Evaluations & Contracts (SCM-ADV-007)
  // =========================================================================

  async createSupplierEvaluation(
    actor: ActorContext,
    input: Omit<CreateScmSupplierEvaluationInput, "createdBy" | "evaluationNumber"> & {
      evaluationNumber?: string;
    },
  ): Promise<SupplierEvaluationDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.manage");
    await this.assertTenantLevelScope(actor, "Supplier evaluations");

    const evaluationNumber =
      (input.evaluationNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_SUPPLIER_EVALUATION_NUMBERING_CODE,
        actor.userId,
      )).number);

    // Deterministic overall score calculation: weights (Quality 35%, Delivery 30%, Pricing 20%, Service 15%)
    const q = input.qualityScore ?? 0;
    const d = input.deliveryScore ?? 0;
    const p = input.pricingScore ?? 0;
    const s = input.serviceScore ?? 0;
    const overallScore = Math.round((q * 0.35 + d * 0.3 + p * 0.2 + s * 0.15) * 100) / 100;

    let ratingGrade = input.ratingGrade;
    if (!ratingGrade) {
      if (overallScore >= 90) ratingGrade = "A";
      else if (overallScore >= 75) ratingGrade = "B";
      else if (overallScore >= 60) ratingGrade = "C";
      else ratingGrade = "D";
    }

    const evaluation = await this.repo.createSupplierEvaluation(actor.tenantId, {
      ...input,
      evaluationNumber,
      overallScore,
      ratingGrade,
      evaluatedBy: actor.userId,
      evaluatedAt: new Date(),
      createdBy: actor.userId,
    });

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: SCM_SUPPLIER_EVALUATION_WORKFLOW_DEFINITION_CODE,
        entityId: evaluation.id,
        contextData: {
          // Tenant-level entity (assertTenantLevelScope): no owning unit to stamp.
          // Visible to tenant-scoped actors, starter and eligible assignees only (ADR-0007 amendment).
          evaluationNumber,
          supplierId: input.supplierId,
          overallScore,
          ratingGrade,
        },
      });
      workflowInstanceId = instance.id;
      await this.repo.updateSupplierEvaluationProjection(actor.tenantId, {
        evaluationId: evaluation.id,
        status: "submitted",
        workflowInstanceId,
        updatedBy: actor.userId,
      });
      evaluation.status = "submitted";
      evaluation.workflowInstanceId = workflowInstanceId;
    } catch (err) {
      await this.repo.deleteSupplierEvaluationWithoutWorkflow(actor.tenantId, evaluation.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.supplier_evaluation.created",
      entityType: "scm_supplier_evaluation",
      entityId: evaluation.id,
      metadata: { evaluationNumber, supplierId: input.supplierId, overallScore, ratingGrade },
    });

    const status = workflowInstanceId ? await this.workflow.getEntityStatus(actor, workflowInstanceId) : null;
    const availableActions = workflowInstanceId
      ? (await this.workflow.getEntityWorkflowView(actor, workflowInstanceId)).availableActions
      : [];

    return { evaluation, status, availableActions };
  }

  async getSupplierEvaluation(
    actor: ActorContext,
    evaluationId: string,
  ): Promise<SupplierEvaluationDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.read");
    await this.assertTenantLevelScope(actor, "Supplier evaluations");
    const evaluation = await this.repo.findSupplierEvaluationById(actor.tenantId, evaluationId);
    if (!evaluation) {
      throw new NotFoundError("ScmSupplierEvaluation", evaluationId);
    }

    const instanceId = evaluation.workflowInstanceId;
    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (instanceId) {
      try {
        status = await this.workflow.getEntityStatus(actor, instanceId);
        const view = await this.workflow.getEntityWorkflowView(actor, instanceId);
        availableActions = view.availableActions;
      } catch {
        // Stale or unassigned instance
      }
    }

    return { evaluation, status, availableActions };
  }

  async listSupplierEvaluations(
    actor: ActorContext,
    filter: ScmSupplierEvaluationFilter = {},
  ): Promise<Array<{ evaluation: ScmSupplierEvaluation; status: EntityWorkflowStatus | null }>> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.read");
    await this.assertTenantLevelScope(actor, "Supplier evaluations");
    const evaluations = await this.repo.listSupplierEvaluations(actor.tenantId, filter);

    return this.withWorkflowStatus(
      actor,
      evaluations,
      (e) => e.workflowInstanceId,
      (evaluation, status) => ({ evaluation, status }),
    );
  }

  async actOnSupplierEvaluation(
    actor: ActorContext,
    evaluationId: string,
    action: string,
    comment?: string,
  ): Promise<SupplierEvaluationDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.manage");
    await this.assertTenantLevelScope(actor, "Supplier evaluations");
    const evaluation = await this.repo.findSupplierEvaluationById(actor.tenantId, evaluationId);
    if (!evaluation) {
      throw new NotFoundError("ScmSupplierEvaluation", evaluationId);
    }

    if (!evaluation.workflowInstanceId) {
      throw new ValidationError(`Evaluation ${evaluationId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      evaluation.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending action exists on this evaluation");
    }

    await this.workflow.actOnAssignment(actor, pending.id, action, comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, evaluation.workflowInstanceId);

    let projectedStatus = evaluation.status;
    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "approved";
    } else if (workflowStatus.instanceStatus === "cancelled" || workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "rejected";
    }

    await this.repo.updateSupplierEvaluationProjection(actor.tenantId, {
      evaluationId,
      status: projectedStatus,
      updatedBy: actor.userId,
    });

    return this.getSupplierEvaluation(actor, evaluationId);
  }

  async createSupplierContract(
    actor: ActorContext,
    input: Omit<CreateScmSupplierContractInput, "createdBy" | "contractNumber"> & {
      contractNumber?: string;
    },
  ): Promise<SupplierContractDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.manage");
    await this.assertTenantLevelScope(actor, "Supplier contracts");

    const contractNumber =
      (input.contractNumber ?? (await this.configuration.generateNumberForTenant(
        actor.tenantId,
        SCM_SUPPLIER_CONTRACT_NUMBERING_CODE,
        actor.userId,
      )).number);

    const { contract, items } = await this.repo.createSupplierContract(actor.tenantId, {
      ...input,
      contractNumber,
      createdBy: actor.userId,
    });

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: SCM_SUPPLIER_CONTRACT_WORKFLOW_DEFINITION_CODE,
        entityId: contract.id,
        contextData: {
          // Tenant-level entity (assertTenantLevelScope): no owning unit to stamp.
          // Visible to tenant-scoped actors, starter and eligible assignees only (ADR-0007 amendment).
          contractNumber,
          title: contract.title,
          supplierId: input.supplierId,
          committedAmount: input.committedAmount,
        },
      });
      workflowInstanceId = instance.id;
      await this.repo.updateSupplierContractProjection(actor.tenantId, {
        contractId: contract.id,
        status: "pending_approval",
        workflowInstanceId,
        updatedBy: actor.userId,
      });
      contract.status = "pending_approval";
      contract.workflowInstanceId = workflowInstanceId;
    } catch (err) {
      await this.repo.deleteSupplierContractWithoutWorkflow(actor.tenantId, contract.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.supplier_contract.created",
      entityType: "scm_supplier_contract",
      entityId: contract.id,
      metadata: { contractNumber, supplierId: input.supplierId, committedAmount: input.committedAmount },
    });

    const status = workflowInstanceId ? await this.workflow.getEntityStatus(actor, workflowInstanceId) : null;
    const availableActions = workflowInstanceId
      ? (await this.workflow.getEntityWorkflowView(actor, workflowInstanceId)).availableActions
      : [];

    return { contract, items, status, availableActions };
  }

  async recordContractSpend(
    actor: ActorContext,
    contractId: string,
    additionalSpentAmount: number,
  ): Promise<SupplierContractDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.manage");
    await this.assertTenantLevelScope(actor, "Supplier contracts");
    const existing = await this.repo.findSupplierContractById(actor.tenantId, contractId);
    if (!existing) {
      throw new NotFoundError("ScmSupplierContract", contractId);
    }

    await this.repo.recordSupplierContractSpend(actor.tenantId, {
      contractId,
      additionalSpentAmount,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.supplier_contract.spend_recorded",
      entityType: "scm_supplier_contract",
      entityId: contractId,
      metadata: { additionalSpentAmount },
    });

    return this.getSupplierContract(actor, contractId);
  }

  async getSupplierContract(
    actor: ActorContext,
    contractId: string,
  ): Promise<SupplierContractDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.read");
    await this.assertTenantLevelScope(actor, "Supplier contracts");
    const result = await this.repo.findSupplierContractById(actor.tenantId, contractId);
    if (!result) {
      throw new NotFoundError("ScmSupplierContract", contractId);
    }

    const instanceId = result.contract.workflowInstanceId;
    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (instanceId) {
      try {
        status = await this.workflow.getEntityStatus(actor, instanceId);
        const view = await this.workflow.getEntityWorkflowView(actor, instanceId);
        availableActions = view.availableActions;
      } catch {
        // Stale or unassigned instance
      }
    }

    return {
      contract: result.contract,
      items: result.items,
      status,
      availableActions,
    };
  }

  async listSupplierContracts(
    actor: ActorContext,
    filter: ScmSupplierContractFilter = {},
  ): Promise<Array<{ contract: ScmSupplierContract; status: EntityWorkflowStatus | null }>> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.read");
    await this.assertTenantLevelScope(actor, "Supplier contracts");
    const contracts = await this.repo.listSupplierContracts(actor.tenantId, filter);

    return this.withWorkflowStatus(
      actor,
      contracts,
      (c) => c.workflowInstanceId,
      (contract, status) => ({ contract, status }),
    );
  }

  async actOnSupplierContract(
    actor: ActorContext,
    contractId: string,
    action: string,
    comment?: string,
  ): Promise<SupplierContractDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.contract.manage");
    await this.assertTenantLevelScope(actor, "Supplier contracts");
    const result = await this.repo.findSupplierContractById(actor.tenantId, contractId);
    if (!result) {
      throw new NotFoundError("ScmSupplierContract", contractId);
    }

    if (!result.contract.workflowInstanceId) {
      throw new ValidationError(`Contract ${contractId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.contract.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending action exists on this contract");
    }

    await this.workflow.actOnAssignment(actor, pending.id, action, comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, result.contract.workflowInstanceId);

    let projectedStatus = result.contract.status;
    let closedAt: Date | undefined;
    let approvedAt: Date | undefined;

    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "active";
      approvedAt = new Date();
    } else if (workflowStatus.instanceStatus === "cancelled" || workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "terminated";
      closedAt = new Date();
    }

    await this.repo.updateSupplierContractProjection(actor.tenantId, {
      contractId,
      status: projectedStatus,
      approvedAt,
      closedAt,
      updatedBy: actor.userId,
    });

    return this.getSupplierContract(actor, contractId);
  }

  // =========================================================================
  // 9. Spend Analytics (SCM-ADV-008)
  // =========================================================================

  async computeSpendSnapshot(
    actor: ActorContext,
    input: {
      periodType: "monthly" | "quarterly" | "yearly";
      periodStart: string;
      periodEnd: string;
      organizationUnitId?: string;
    },
  ): Promise<ScmSpendAnalyticsSnapshot> {
    await this.rbac.requirePermission(actor, "supply_chain.analytics.read");
    await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);

    const snapshot = await this.repo.computeSpendAnalyticsSnapshot(actor.tenantId, {
      periodType: input.periodType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      organizationUnitId: input.organizationUnitId,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.spend_analytics.computed",
      entityType: "scm_spend_snapshot",
      entityId: snapshot.id,
      metadata: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        totalSpend: snapshot.totalSpend,
      },
    });

    return snapshot;
  }

  async getSpendSnapshot(
    actor: ActorContext,
    snapshotId: string,
  ): Promise<ScmSpendAnalyticsSnapshot> {
    await this.rbac.requirePermission(actor, "supply_chain.analytics.read");
    const snapshot = await this.repo.findSpendAnalyticsSnapshotById(actor.tenantId, snapshotId);
    if (!snapshot) {
      throw new NotFoundError("ScmSpendAnalyticsSnapshot", snapshotId);
    }
    await this.assertOrganizationUnitInScope(actor, snapshot.organizationUnitId);
    return snapshot;
  }

  async listSpendSnapshots(
    actor: ActorContext,
    filter: ScmSpendAnalyticsSnapshotFilter = {},
  ): Promise<ScmSpendAnalyticsSnapshot[]> {
    await this.rbac.requirePermission(actor, "supply_chain.analytics.read");
    const scopedOrgUnitIds = await this.resolveScopedOrganizationUnitIds(
      actor,
      filter.organizationUnitIds && filter.organizationUnitIds.length > 0
        ? filter.organizationUnitIds[0]
        : undefined,
    );

    return this.repo.listSpendAnalyticsSnapshots(actor.tenantId, {
      ...filter,
      organizationUnitIds: scopedOrgUnitIds ?? undefined,
    });
  }

  // =========================================================================
  // 10. Wave A5.1 Stage 1: Account Assignment, Receiving, Inspection,
  //     Discrepancies, Returns, Reversals & Accounting-Ready Events
  // =========================================================================

  // --- Account Assignment Governance ---

  async listAccountAssignmentConfigs(actor: ActorContext): Promise<ScmAccountAssignmentConfig[]> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.read");
    await this.assertTenantLevelScope(actor, "Account assignment configuration");
    return this.repo.listAccountAssignmentConfigs(actor.tenantId);
  }

  async getAccountAssignmentConfig(
    actor: ActorContext,
    assignmentType: ScmAccountAssignmentType,
  ): Promise<ScmAccountAssignmentConfig> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.read");
    await this.assertTenantLevelScope(actor, "Account assignment configuration");
    const cfg = await this.repo.findAccountAssignmentConfig(actor.tenantId, assignmentType);
    if (!cfg) {
      throw new NotFoundError("ScmAccountAssignmentConfig", assignmentType);
    }
    return cfg;
  }

  async updateAccountAssignmentConfig(
    actor: ActorContext,
    input: UpdateScmAccountAssignmentConfigInput,
  ): Promise<ScmAccountAssignmentConfig> {
    await this.rbac.requirePermission(actor, "supply_chain.procurement.manage");
    const hasTenant = await this.rbac.hasTenantScope(actor);
    if (!hasTenant) {
      throw new ForbiddenError("Tenant-wide scope required to update account assignment configuration");
    }

    const updated = await this.repo.updateAccountAssignmentConfig(actor.tenantId, {
      ...input,
      updatedBy: actor.userId,
    });
    if (!updated) {
      throw new NotFoundError("ScmAccountAssignmentConfig", input.assignmentType);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.account_assignment_config.updated",
      entityType: "scm_account_assignment_config",
      entityId: updated.id,
      metadata: { assignmentType: input.assignmentType, input },
    });

    return updated;
  }

  // --- Receiving & Receiving Lines ---

  async createReceivingRecord(
    actor: ActorContext,
    input: Omit<CreateScmReceivingRecordInput, "receiptNumber" | "createdBy"> & { receiptNumber?: string },
  ): Promise<{ receiving: ScmReceivingRecord; lines: ScmReceivingLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    // Idempotent replay (ADR-0023): a retried receipt must not book a second
    // stock movement. The pre-check runs before number generation so a replay
    // does not burn a sequence number either.
    const replayed = await this.repo.findReceivingRecordByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const receiptNumber =
      input.receiptNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_RECEIVING_RECORD_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createReceivingRecord(actor.tenantId, {
          ...input,
          receiptNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findReceivingRecordByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Receiving record with idempotency key ${input.idempotencyKey} already exists`,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.receiving.created",
      entityType: "scm_receiving_record",
      entityId: result.receiving.id,
      metadata: {
        receiptNumber: result.receiving.receiptNumber,
        purchaseOrderId: input.purchaseOrderId,
        lineCount: result.lines.length,
      },
    });

    return result;
  }

  async getReceivingRecord(
    actor: ActorContext,
    receivingRecordId: string,
  ): Promise<{ receiving: ScmReceivingRecord; lines: ScmReceivingLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const result = await this.repo.findReceivingRecordById(actor.tenantId, receivingRecordId);
    if (!result) {
      throw new NotFoundError("ScmReceivingRecord", receivingRecordId);
    }
    await this.assertWarehouseInScope(actor, result.receiving.warehouseId);
    return result;
  }

  async listReceivingRecords(
    actor: ActorContext,
    filter: ScmReceivingRecordFilter = {},
  ): Promise<ScmReceivingRecord[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listReceivingRecords(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // --- Quality Inspections ---

  async createInspection(
    actor: ActorContext,
    input: Omit<CreateScmInspectionInput, "inspectionNumber" | "createdBy"> & { inspectionNumber?: string },
  ): Promise<ScmInspection> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertInventoryLineInScope(actor, { receivingLineId: input.receivingLineId });

    // Idempotent replay (ADR-0023).
    const replayed = await this.repo.findInspectionByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const inspectionNumber =
      input.inspectionNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_INSPECTION_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createInspection(actor.tenantId, {
          ...input,
          inspectionNumber,
          inspectedBy: input.inspectedBy ?? actor.userId,
          createdBy: actor.userId,
        }),
      async () => {
        const inspection = await this.repo.findInspectionByIdempotencyKey(actor.tenantId, input.idempotencyKey);
        return inspection ? { inspection, movements: [], valuationLayerId: null } : null;
      },
      `Inspection with idempotency key ${input.idempotencyKey} already exists`,
    );
    const inspection = result.inspection;

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.inspection.created",
      entityType: "scm_inspection",
      entityId: inspection.id,
      metadata: {
        inspectionNumber,
        receivingLineId: input.receivingLineId,
        result: input.result,
        quantityAccepted: input.quantityAccepted,
      },
    });

    return inspection;
  }

  async getInspectionByReceivingLine(
    actor: ActorContext,
    receivingLineId: string,
  ): Promise<ScmInspection | null> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    await this.assertInventoryLineInScope(actor, { receivingLineId });
    return this.repo.findInspectionByReceivingLineId(actor.tenantId, receivingLineId);
  }

  // --- Discrepancies ---

  async createDiscrepancyRecord(
    actor: ActorContext,
    input: Omit<CreateScmDiscrepancyRecordInput, "createdBy">,
  ): Promise<ScmDiscrepancyRecord> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertInventoryLineInScope(actor, { receivingLineId: input.receivingLineId });

    const discrepancy = await this.repo.createDiscrepancyRecord(actor.tenantId, {
      ...input,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.discrepancy.created",
      entityType: "scm_discrepancy_record",
      entityId: discrepancy.id,
      metadata: {
        receivingLineId: input.receivingLineId,
        discrepancyType: input.discrepancyType,
        quantity: input.quantity,
      },
    });

    return discrepancy;
  }

  async resolveDiscrepancyRecord(
    actor: ActorContext,
    input: Omit<ResolveScmDiscrepancyRecordInput, "resolvedBy"> & { resolvedBy?: string | null },
  ): Promise<ScmDiscrepancyRecord> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertInventoryLineInScope(actor, { discrepancyId: input.discrepancyId });

    const resolved = await this.repo.resolveDiscrepancyRecord(actor.tenantId, {
      ...input,
      resolvedBy: input.resolvedBy ?? actor.userId,
    });
    if (!resolved) {
      throw new NotFoundError("ScmDiscrepancyRecord", input.discrepancyId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.discrepancy.resolved",
      entityType: "scm_discrepancy_record",
      entityId: input.discrepancyId,
      metadata: { status: input.status, notes: input.resolutionNotes },
    });

    return resolved;
  }

  async listDiscrepancyRecords(
    actor: ActorContext,
    filter: ScmDiscrepancyRecordFilter = {},
  ): Promise<ScmDiscrepancyRecord[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    // Epic 5 G3 enforcement batch — a discrepancy record is anchored to a
    // receiving line, and therefore to that line's warehouse. The requested
    // receiving line is asserted directly; a free list is narrowed to the
    // warehouses the ACTIVE assignment's Data Scope covers (the warehouse-tier
    // rule `listReceivingRecords` and friends already apply).
    if (filter.receivingLineId) {
      await this.assertInventoryLineInScope(actor, { receivingLineId: filter.receivingLineId });
      return this.repo.listDiscrepancyRecords(actor.tenantId, filter);
    }
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, null);
    return this.repo.listDiscrepancyRecords(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // --- Return To Vendor ---

  async createReturnToVendor(
    actor: ActorContext,
    input: Omit<CreateScmReturnToVendorInput, "returnNumber" | "createdBy"> & { returnNumber?: string },
  ): Promise<{ returnToVendor: ScmReturnToVendor; lines: ScmReturnToVendorLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    // Idempotent replay (ADR-0023).
    const replayed = await this.repo.findReturnToVendorByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const returnNumber =
      input.returnNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_RETURN_TO_VENDOR_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createReturnToVendor(actor.tenantId, {
          ...input,
          returnNumber,
          returnedBy: input.returnedBy ?? actor.userId,
          createdBy: actor.userId,
        }),
      () => this.repo.findReturnToVendorByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Return to vendor with idempotency key ${input.idempotencyKey} already exists`,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.return_to_vendor.created",
      entityType: "scm_return_to_vendor",
      entityId: result.returnToVendor.id,
      metadata: {
        returnNumber: result.returnToVendor.returnNumber,
        supplierId: input.supplierId,
        reason: input.reason,
        lineCount: result.lines.length,
      },
    });

    return result;
  }

  async getReturnToVendor(
    actor: ActorContext,
    returnToVendorId: string,
  ): Promise<{ returnToVendor: ScmReturnToVendor; lines: ScmReturnToVendorLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const result = await this.repo.findReturnToVendorById(actor.tenantId, returnToVendorId);
    if (!result) {
      throw new NotFoundError("ScmReturnToVendor", returnToVendorId);
    }
    await this.assertWarehouseInScope(actor, result.returnToVendor.warehouseId);
    return result;
  }

  async listReturnToVendors(
    actor: ActorContext,
    filter: ScmReturnToVendorFilter = {},
  ): Promise<ScmReturnToVendor[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listReturnToVendors(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // --- Receipt Reversal ---

  async createReceiptReversal(
    actor: ActorContext,
    input: Omit<CreateScmReceiptReversalInput, "reversalNumber" | "createdBy"> & { reversalNumber?: string },
  ): Promise<{ reversal: ScmReceiptReversal; lines: ScmReceiptReversalLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");

    const recResult = await this.repo.findReceivingRecordById(actor.tenantId, input.receivingRecordId);
    if (!recResult) {
      throw new NotFoundError("ScmReceivingRecord", input.receivingRecordId);
    }
    await this.assertWarehouseInScope(actor, recResult.receiving.warehouseId);

    // Idempotent replay (ADR-0023): a retried reversal must return the
    // original compensating reversal, not raise a conflict and not book a
    // second compensating movement.
    const replayed = await this.repo.findReceiptReversalByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const existingReversal = await this.repo.findReceiptReversalByReceivingRecordId(
      actor.tenantId,
      input.receivingRecordId,
    );
    if (existingReversal) {
      throw new ConflictError(`Receiving record ${input.receivingRecordId} is already reversed`);
    }

    const reversalNumber =
      input.reversalNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_RECEIPT_REVERSAL_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createReceiptReversal(actor.tenantId, {
          ...input,
          reversalNumber,
          reversedBy: input.reversedBy ?? actor.userId,
          createdBy: actor.userId,
        }),
      () => this.repo.findReceiptReversalByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Receipt reversal with idempotency key ${input.idempotencyKey} already exists`,
    );

    // NOTE: `createReceiptReversal` sets the receiving record status to
    // `reversed` inside the same transaction that creates the reversal, the
    // compensating movements, and the reversal lines. A second `update`
    // call here would run in a separate transaction and could race the
    // reverse/status invariant, so it is intentionally not issued.

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.receipt_reversal.created",
      entityType: "scm_receipt_reversal",
      entityId: result.reversal.id,
      metadata: {
        reversalNumber: result.reversal.reversalNumber,
        receivingRecordId: input.receivingRecordId,
        reason: input.reason,
      },
    });

    return result;
  }

  async getReceiptReversalByReceivingRecord(
    actor: ActorContext,
    receivingRecordId: string,
  ): Promise<{ reversal: ScmReceiptReversal; lines: ScmReceiptReversalLine[] } | null> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const recResult = await this.repo.findReceivingRecordById(actor.tenantId, receivingRecordId);
    if (recResult) {
      await this.assertWarehouseInScope(actor, recResult.receiving.warehouseId);
    }
    return this.repo.findReceiptReversalByReceivingRecordId(actor.tenantId, receivingRecordId);
  }

  // --- Accounting-Ready Events ---

  async createAccountingReadyEvent(
    actor: ActorContext,
    input: Omit<CreateScmAccountingReadyEventInput, "createdBy">,
  ): Promise<ScmAccountingReadyEvent> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertTenantLevelScope(actor, "Accounting-ready events");

    // Idempotent replay (ADR-0023): "re-delivering an event must not create a
    // second accounting effect downstream".
    const replayed = await this.repo.findAccountingReadyEventByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const event = await this.runIdempotent(
      () =>
        this.repo.createAccountingReadyEvent(actor.tenantId, {
          ...input,
          createdBy: actor.userId,
        }),
      () => this.repo.findAccountingReadyEventByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Accounting-ready event with idempotency key ${input.idempotencyKey} already exists`,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.accounting_ready_event.created",
      entityType: "scm_accounting_ready_event",
      entityId: event.id,
      metadata: {
        eventType: event.eventType,
        sourceDocumentType: event.sourceDocumentType,
        sourceDocumentId: event.sourceDocumentId,
        amount: event.amount,
        currency: event.currency,
      },
    });

    return event;
  }

  async getAccountingReadyEvent(
    actor: ActorContext,
    eventId: string,
  ): Promise<ScmAccountingReadyEvent> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    await this.assertTenantLevelScope(actor, "Accounting-ready events");
    const event = await this.repo.findAccountingReadyEventById(actor.tenantId, eventId);
    if (!event) {
      throw new NotFoundError("ScmAccountingReadyEvent", eventId);
    }
    return event;
  }

  async listAccountingReadyEvents(
    actor: ActorContext,
    filter: ScmAccountingReadyEventFilter = {},
  ): Promise<ScmAccountingReadyEvent[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    await this.assertTenantLevelScope(actor, "Accounting-ready events");
    return this.repo.listAccountingReadyEvents(actor.tenantId, filter);
  }

  async updateAccountingReadyEventState(
    actor: ActorContext,
    input: Omit<UpdateScmAccountingReadyEventStateInput, "occurredBy">,
  ): Promise<{ event: ScmAccountingReadyEvent; transition: ScmAccountingReadyEventStateTransition }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertTenantLevelScope(actor, "Accounting-ready events");

    const result = await this.repo.updateAccountingReadyEventState(actor.tenantId, {
      ...input,
      occurredBy: actor.userId,
    });
    if (!result) {
      throw new NotFoundError("ScmAccountingReadyEvent", input.accountingEventId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.accounting_ready_event.state_updated",
      entityType: "scm_accounting_ready_event",
      entityId: input.accountingEventId,
      metadata: {
        stateKind: input.stateKind,
        toState: input.toState,
        reason: input.reason,
      },
    });

    return result;
  }

  // =========================================================================
  // Stage 2: Replacement Deliveries (RTV Follow-On)
  // =========================================================================

  async createReplacementDelivery(
    actor: ActorContext,
    input: Omit<CreateScmReplacementDeliveryInput, "replacementNumber" | "createdBy"> & { replacementNumber?: string },
  ): Promise<{ replacement: ScmReplacementDelivery; lines: ScmReplacementDeliveryLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    const replayed = await this.repo.findReplacementDeliveryByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const replacementNumber =
      input.replacementNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_REPLACEMENT_DELIVERY_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createReplacementDelivery(actor.tenantId, {
          ...input,
          replacementNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findReplacementDeliveryByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Replacement delivery with idempotency key ${input.idempotencyKey} already exists`,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.replacement_delivery.created",
      entityType: "scm_replacement_delivery",
      entityId: result.replacement.id,
      metadata: {
        replacementNumber: result.replacement.replacementNumber,
        returnToVendorId: input.returnToVendorId,
        supplierId: input.supplierId,
        lineCount: result.lines.length,
      },
    });

    return result;
  }

  async getReplacementDelivery(
    actor: ActorContext,
    replacementDeliveryId: string,
  ): Promise<{ replacement: ScmReplacementDelivery; lines: ScmReplacementDeliveryLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const result = await this.repo.findReplacementDeliveryById(actor.tenantId, replacementDeliveryId);
    if (!result) {
      throw new NotFoundError("ScmReplacementDelivery", replacementDeliveryId);
    }
    await this.assertWarehouseInScope(actor, result.replacement.warehouseId);
    return result;
  }

  async listReplacementDeliveries(
    actor: ActorContext,
    filter: ScmReplacementDeliveryFilter = {},
  ): Promise<ScmReplacementDelivery[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listReplacementDeliveries(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // =========================================================================
  // Stage 2: Service Acceptance (Service Entry Sheets with Workflow)
  // =========================================================================

  async createServiceAcceptance(
    actor: ActorContext,
    input: Omit<CreateScmServiceAcceptanceInput, "acceptanceNumber" | "createdBy"> & { acceptanceNumber?: string },
  ): Promise<{ serviceAcceptance: ScmServiceAcceptance; lines: ScmServiceAcceptanceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.service_acceptance.manage");
    if (input.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);
    }

    const replayed = await this.repo.findServiceAcceptanceByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const acceptanceNumber =
      input.acceptanceNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_SERVICE_ACCEPTANCE_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createServiceAcceptance(actor.tenantId, {
          ...input,
          acceptanceNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findServiceAcceptanceByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Service acceptance with idempotency key ${input.idempotencyKey} already exists`,
    );

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: "scm_service_acceptance",
        entityId: result.serviceAcceptance.id,
        contextData: {
          acceptanceNumber: result.serviceAcceptance.acceptanceNumber,
          purchaseOrderId: input.purchaseOrderId,
          supplierId: input.supplierId,
          organizationUnitId: input.organizationUnitId ?? null,
        },
      });
      workflowInstanceId = instance.id;
      const updated = await this.repo.updateServiceAcceptanceStatus(actor.tenantId, {
        serviceAcceptanceId: result.serviceAcceptance.id,
        status: "draft",
        workflowInstanceId,
        updatedBy: actor.userId,
      });
      if (updated) {
        result.serviceAcceptance = updated;
      }
    } catch (err) {
      await this.repo.deleteServiceAcceptanceWithoutWorkflow(actor.tenantId, result.serviceAcceptance.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.service_acceptance.created",
      entityType: "scm_service_acceptance",
      entityId: result.serviceAcceptance.id,
      metadata: {
        acceptanceNumber: result.serviceAcceptance.acceptanceNumber,
        purchaseOrderId: input.purchaseOrderId,
        lineCount: result.lines.length,
      },
    });

    return result;
  }

  async getServiceAcceptance(
    actor: ActorContext,
    serviceAcceptanceId: string,
  ): Promise<{ serviceAcceptance: ScmServiceAcceptance; lines: ScmServiceAcceptanceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.service_acceptance.read");
    const result = await this.repo.findServiceAcceptanceById(actor.tenantId, serviceAcceptanceId);
    if (!result) {
      throw new NotFoundError("ScmServiceAcceptance", serviceAcceptanceId);
    }
    if (result.serviceAcceptance.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, result.serviceAcceptance.organizationUnitId);
    }
    return result;
  }

  async listServiceAcceptances(
    actor: ActorContext,
    filter: ScmServiceAcceptanceFilter = {},
  ): Promise<Array<{ serviceAcceptance: ScmServiceAcceptance; status: EntityWorkflowStatus | null }>> {
    await this.rbac.requirePermission(actor, "supply_chain.service_acceptance.read");
    const scopedOrgUnitIds = await this.resolveScopedOrganizationUnitIds(actor, filter.organizationUnitIds?.[0]);

    const acceptances = await this.repo.listServiceAcceptances(actor.tenantId, {
      ...filter,
      organizationUnitIds: scopedOrgUnitIds ?? undefined,
    });

    return this.withWorkflowStatus(
      actor,
      acceptances,
      (a) => a.workflowInstanceId,
      (serviceAcceptance, status) => ({ serviceAcceptance, status }),
    );
  }

  async submitServiceAcceptance(
    actor: ActorContext,
    serviceAcceptanceId: string,
    comment?: string,
  ): Promise<{ serviceAcceptance: ScmServiceAcceptance; lines: ScmServiceAcceptanceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.service_acceptance.approve");
    const result = await this.repo.findServiceAcceptanceById(actor.tenantId, serviceAcceptanceId);
    if (!result) {
      throw new NotFoundError("ScmServiceAcceptance", serviceAcceptanceId);
    }
    if (result.serviceAcceptance.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, result.serviceAcceptance.organizationUnitId);
    }

    if (result.serviceAcceptance.status !== "draft") {
      throw new ConflictError(`Service acceptance must be in draft status to submit (current: ${result.serviceAcceptance.status})`);
    }

    if (!result.serviceAcceptance.workflowInstanceId) {
      throw new ValidationError(`Service acceptance ${serviceAcceptanceId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.serviceAcceptance.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending submit action exists on this service acceptance");
    }

    // Keep the workflow assignment pending until the explicit approve action.
    // This preserves the governed two-step SES lifecycle even when a tenant's
    // workflow definition exposes a direct submit transition.

    await this.repo.updateServiceAcceptanceStatus(actor.tenantId, {
      serviceAcceptanceId,
      status: "submitted",
      submittedAt: new Date(),
      submittedBy: actor.userId,
      updatedBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.service_acceptance.submitted",
      entityType: "scm_service_acceptance",
      entityId: serviceAcceptanceId,
      metadata: { comment },
    });

    return this.getServiceAcceptance(actor, serviceAcceptanceId);
  }

  async approveServiceAcceptance(
    actor: ActorContext,
    serviceAcceptanceId: string,
    comment?: string,
  ): Promise<{ serviceAcceptance: ScmServiceAcceptance; lines: ScmServiceAcceptanceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.service_acceptance.approve");
    const result = await this.repo.findServiceAcceptanceById(actor.tenantId, serviceAcceptanceId);
    if (!result) {
      throw new NotFoundError("ScmServiceAcceptance", serviceAcceptanceId);
    }
    if (result.serviceAcceptance.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, result.serviceAcceptance.organizationUnitId);
    }

    if (result.serviceAcceptance.status !== "submitted") {
      throw new ConflictError(`Service acceptance must be in submitted status to approve (current: ${result.serviceAcceptance.status})`);
    }

    if (!result.serviceAcceptance.workflowInstanceId) {
      throw new ValidationError(`Service acceptance ${serviceAcceptanceId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.serviceAcceptance.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending approve action exists on this service acceptance");
    }

    await this.workflow.actOnAssignment(actor, pending.id, "approve", comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, result.serviceAcceptance.workflowInstanceId);

    let projectedStatus: ScmServiceAcceptanceStatus = result.serviceAcceptance.status;
    let approvedAt: Date | undefined;
    let approvedBy: string | undefined;
    let rejectedAt: Date | undefined;
    let rejectedBy: string | undefined;
    let rejectionReason: string | undefined;

    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "approved";
      approvedAt = new Date();
      approvedBy = actor.userId;
    } else if (workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "rejected";
      rejectedAt = new Date();
      rejectedBy = actor.userId;
      rejectionReason = comment;
    } else if (workflowStatus.instanceStatus === "cancelled") {
      projectedStatus = "cancelled";
    }

    await this.repo.updateServiceAcceptanceStatus(actor.tenantId, {
      serviceAcceptanceId,
      status: projectedStatus,
      approvedAt,
      approvedBy,
      rejectedAt,
      rejectedBy,
      rejectionReason,
      updatedBy: actor.userId,
    });

    if (projectedStatus === "approved" && approvedAt) {
      for (let idx = 0; idx < result.lines.length; idx++) {
        const line = result.lines[idx]!;
        const event = await this.repo.createAccountingReadyEvent(actor.tenantId, {
          eventType: "service.accepted",
          sourceDocumentType: "scm_service_acceptance",
          sourceDocumentId: serviceAcceptanceId,
          sourceDocumentLineId: line.id,
          effectiveAt: approvedAt,
          currency: line.currency,
          amount: line.amount,
          quantity: line.quantity,
          unitCost: line.unitPrice,
          accountAssignmentType: line.accountAssignmentType,
          accountAssignmentDimensions: line.accountAssignmentDimensions,
          idempotencyKey: `${result.serviceAcceptance.idempotencyKey}:line:${line.sortOrder ?? idx}`,
          payload: {
            acceptanceNumber: result.serviceAcceptance.acceptanceNumber,
            purchaseOrderId: result.serviceAcceptance.purchaseOrderId,
            purchaseOrderLineId: line.purchaseOrderLineId,
            supplierId: result.serviceAcceptance.supplierId,
          },
          createdBy: actor.userId,
        });

        await this.repo.freezeServiceAcceptanceLineAssignment(
          actor.tenantId,
          line.id,
          approvedAt,
          event.id,
        );
      }
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.service_acceptance.approved",
      entityType: "scm_service_acceptance",
      entityId: serviceAcceptanceId,
      metadata: { status: projectedStatus, comment },
    });

    return this.getServiceAcceptance(actor, serviceAcceptanceId);
  }

  // =========================================================================
  // Phase 2 WP-PRO-01: Vendor Invoices (AP Invoice, PO-based)
  // =========================================================================

  async createVendorInvoice(
    actor: ActorContext,
    input: Omit<CreateScmVendorInvoiceInput, "invoiceNumber" | "createdBy"> & { invoiceNumber?: string },
  ): Promise<{ vendorInvoice: ScmVendorInvoice; lines: ScmVendorInvoiceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.vendor_invoice.manage");

    // Validate GR exists and is linked to this PO
    const grResult = await this.repo.findReceivingRecordById(actor.tenantId, input.receivingRecordId);
    if (!grResult || grResult.receiving.purchaseOrderId !== input.purchaseOrderId) {
      throw new ValidationError(`Receiving record must be linked to PO ${input.purchaseOrderId}`);
    }

    const replayed = await this.repo.findVendorInvoiceByIdempotencyKey(actor.tenantId, input.idempotencyKey);
    if (replayed) return replayed;

    const invoiceNumber =
      input.invoiceNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_VENDOR_INVOICE_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createVendorInvoice(actor.tenantId, {
          ...input,
          invoiceNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findVendorInvoiceByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Vendor invoice with idempotency key ${input.idempotencyKey} already exists`,
    );

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: "scm_vendor_invoice",
        entityId: result.vendorInvoice.id,
        contextData: {
          // ADR-0012: follows the receiving warehouse's owning unit (null = tenant-level warehouse).
          organizationUnitId:
            (await this.repo.findWarehouseById(actor.tenantId, grResult.receiving.warehouseId))
              ?.organizationUnitId ?? null,
          invoiceNumber: result.vendorInvoice.invoiceNumber,
          purchaseOrderId: input.purchaseOrderId,
          supplierId: input.supplierId,
          invoiceAmount: input.invoiceAmount,
        },
      });
      workflowInstanceId = instance.id;

      // After the 23505 idempotency race both losers replay the winner's row
      // and reach here; only ONE of them may attach its workflow instance, or
      // the second COALESCE-write would orphan the first (a pending approval
      // task nobody can act on). The atomic claim makes exactly one winner;
      // losers cancel their surplus instance instead of linking it.
      const claimed = await this.repo.claimVendorInvoiceWorkflowInstance(
        actor.tenantId,
        result.vendorInvoice.id,
        workflowInstanceId,
      );
      if (claimed) {
        result.vendorInvoice = { ...result.vendorInvoice, workflowInstanceId };
      }
    } catch (err) {
      await this.repo.deleteVendorInvoiceWithoutWorkflow(actor.tenantId, result.vendorInvoice.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.vendor_invoice.created",
      entityType: "scm_vendor_invoice",
      entityId: result.vendorInvoice.id,
      metadata: {
        invoiceNumber: result.vendorInvoice.invoiceNumber,
        purchaseOrderId: input.purchaseOrderId,
        invoiceAmount: input.invoiceAmount,
        lineCount: result.lines.length,
      },
    });

    return result;
  }

  async getVendorInvoice(
    actor: ActorContext,
    vendorInvoiceId: string,
  ): Promise<{ vendorInvoice: ScmVendorInvoice; lines: ScmVendorInvoiceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.vendor_invoice.read");
    const result = await this.repo.findVendorInvoiceById(actor.tenantId, vendorInvoiceId);
    if (!result) {
      throw new NotFoundError("ScmVendorInvoice", vendorInvoiceId);
    }
    return result;
  }

  async listVendorInvoices(
    actor: ActorContext,
    filter: ScmVendorInvoiceFilter = {},
  ): Promise<ScmVendorInvoice[]> {
    await this.rbac.requirePermission(actor, "supply_chain.vendor_invoice.read");
    return this.repo.listVendorInvoices(actor.tenantId, filter);
  }

  async submitVendorInvoice(
    actor: ActorContext,
    vendorInvoiceId: string,
    comment?: string,
  ): Promise<{ vendorInvoice: ScmVendorInvoice; lines: ScmVendorInvoiceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.vendor_invoice.approve");
    const result = await this.repo.findVendorInvoiceById(actor.tenantId, vendorInvoiceId);
    if (!result) {
      throw new NotFoundError("ScmVendorInvoice", vendorInvoiceId);
    }

    if (result.vendorInvoice.status !== "draft") {
      throw new ConflictError(`Vendor invoice must be in draft status to submit (current: ${result.vendorInvoice.status})`);
    }

    if (!result.vendorInvoice.workflowInstanceId) {
      throw new ValidationError(`Vendor invoice ${vendorInvoiceId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.vendorInvoice.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending submit action exists on this vendor invoice");
    }

    await this.workflow.actOnAssignment(actor, pending.id, "submit", comment ?? null);

    await this.repo.updateVendorInvoiceStatus(actor.tenantId, {
      vendorInvoiceId,
      status: "submitted",
      submittedAt: new Date(),
      submittedBy: actor.userId,
      updatedBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.vendor_invoice.submitted",
      entityType: "scm_vendor_invoice",
      entityId: vendorInvoiceId,
      metadata: { comment },
    });

    return this.getVendorInvoice(actor, vendorInvoiceId);
  }

  async approveVendorInvoice(
    actor: ActorContext,
    vendorInvoiceId: string,
    comment?: string,
  ): Promise<{ vendorInvoice: ScmVendorInvoice; lines: ScmVendorInvoiceLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.vendor_invoice.approve");
    const result = await this.repo.findVendorInvoiceById(actor.tenantId, vendorInvoiceId);
    if (!result) {
      throw new NotFoundError("ScmVendorInvoice", vendorInvoiceId);
    }

    if (result.vendorInvoice.status !== "submitted") {
      throw new ConflictError(`Vendor invoice must be in submitted status to approve (current: ${result.vendorInvoice.status})`);
    }

    if (!result.vendorInvoice.workflowInstanceId) {
      throw new ValidationError(`Vendor invoice ${vendorInvoiceId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.vendorInvoice.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending approve action exists on this vendor invoice");
    }

    await this.workflow.actOnAssignment(actor, pending.id, "approve", comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, result.vendorInvoice.workflowInstanceId);

    let projectedStatus: ScmVendorInvoiceStatus = result.vendorInvoice.status;
    let approvedAt: Date | undefined;
    let approvedBy: string | undefined;
    let rejectedAt: Date | undefined;
    let rejectedBy: string | undefined;
    let rejectionReason: string | undefined;

    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "approved";
      approvedAt = new Date();
      approvedBy = actor.userId;
    } else if (workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "rejected";
      rejectedAt = new Date();
      rejectedBy = actor.userId;
      rejectionReason = comment;
    } else if (workflowStatus.instanceStatus === "cancelled") {
      projectedStatus = "cancelled";
    }

    // Approval is atomic: the terminal status and every per-line accounting
    // event + freeze commit together, so a crash mid-way can never leave an
    // "approved" invoice with missing AP postings (the status guard would
    // block re-entry). Event idempotency keys make the whole call replay-safe.
    const lineEvents =
      projectedStatus === "approved" && approvedAt
        ? result.lines.map((line, idx) => ({
            lineId: line.id,
            event: {
              eventType: "vendor.invoice.approved" as const,
              sourceDocumentType: "scm_vendor_invoice",
              sourceDocumentId: vendorInvoiceId,
              sourceDocumentLineId: line.id,
              effectiveAt: approvedAt,
              currency: line.currency,
              amount: line.lineAmount,
              quantity: line.quantityInvoiced,
              unitCost: line.unitPrice,
              accountAssignmentType: line.accountAssignmentType,
              accountAssignmentDimensions: line.accountAssignmentDimensions,
              idempotencyKey: `${result.vendorInvoice.idempotencyKey}:line:${line.sortOrder ?? idx}`,
              payload: {
                invoiceNumber: result.vendorInvoice.invoiceNumber,
                purchaseOrderId: result.vendorInvoice.purchaseOrderId,
                purchaseOrderLineId: line.purchaseOrderLineId,
                supplierId: result.vendorInvoice.supplierId,
              },
              createdBy: actor.userId,
            },
          }))
        : [];

    await this.repo.approveVendorInvoiceWithEvents(actor.tenantId, {
      vendorInvoiceId,
      status: projectedStatus,
      approvedAt,
      approvedBy,
      rejectedAt,
      rejectedBy,
      rejectionReason,
      updatedBy: actor.userId,
    }, lineEvents);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.vendor_invoice.approved",
      entityType: "scm_vendor_invoice",
      entityId: vendorInvoiceId,
      metadata: { status: projectedStatus, comment },
    });

    return this.getVendorInvoice(actor, vendorInvoiceId);
  }

  // =========================================================================
  // Phase 2 WP-PRO-03: AP Payment Batch (Approved Invoice Payment)
  // =========================================================================

  async createPaymentBatch(
    actor: ActorContext,
    input: Omit<CreateScmPaymentBatchInput, "batchNumber" | "createdBy"> & { batchNumber?: string },
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.payment.manage");

    // Validate organization unit in scope
    await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);

    // The repo layer validates each invoice status='approved', rejects duplicate
    // lines (within the batch and across non-cancelled batches), and calculates
    // approvedAmount atomically inside one transaction. The idempotency replay
    // check happens before that to short-circuit retries.

    const replayed = await this.repo.findPaymentBatchByIdempotencyKey(actor.tenantId, input.idempotencyKey);
    if (replayed) return replayed;

    const batchNumber =
      input.batchNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_PAYMENT_BATCH_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createPaymentBatch(actor.tenantId, {
          ...input,
          batchNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findPaymentBatchByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Payment batch with idempotency key ${input.idempotencyKey} already exists`,
    );

    // Start workflow
    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: "scm_payment_batch",
        entityId: result.paymentBatch.id,
        contextData: {
          // ADR-0012: the batch's owning Organization Unit (scope-checked above).
          organizationUnitId: result.paymentBatch.organizationUnitId,
          batchNumber: result.paymentBatch.batchNumber,
          approvedAmount: result.paymentBatch.approvedAmount,
          currency: result.paymentBatch.currency,
          lineCount: result.lines.length,
        },
      });
      workflowInstanceId = instance.id;

      const claimed = await this.repo.claimPaymentBatchWorkflowInstance(
        actor.tenantId,
        result.paymentBatch.id,
        workflowInstanceId,
      );
      if (claimed) {
        result.paymentBatch = { ...result.paymentBatch, workflowInstanceId };
      }
    } catch (err) {
      await this.repo.deletePaymentBatchWithoutWorkflow(actor.tenantId, result.paymentBatch.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.payment_batch.created",
      entityType: "scm_payment_batch",
      entityId: result.paymentBatch.id,
      metadata: {
        batchNumber: result.paymentBatch.batchNumber,
        approvedAmount: result.paymentBatch.approvedAmount,
        currency: result.paymentBatch.currency,
        lineCount: result.lines.length,
      },
    });

    return result;
  }

  async getPaymentBatch(
    actor: ActorContext,
    batchId: string,
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.payment.read");
    const result = await this.repo.findPaymentBatchById(actor.tenantId, batchId);
    if (!result) {
      throw new NotFoundError("ScmPaymentBatch", batchId);
    }
    await this.assertOrganizationUnitInScope(actor, result.paymentBatch.organizationUnitId);
    return result;
  }

  async listPaymentBatches(
    actor: ActorContext,
    filter?: ScmPaymentBatchFilter,
  ): Promise<ScmPaymentBatch[]> {
    await this.rbac.requirePermission(actor, "supply_chain.payment.read");
    const scopedOrgUnitIds = await this.resolveScopedOrganizationUnitIds(actor, filter?.organizationUnitId);
    return this.repo.listPaymentBatches(actor.tenantId, { ...filter, organizationUnitIds: scopedOrgUnitIds ?? undefined });
  }

  async submitPaymentBatch(
    actor: ActorContext,
    batchId: string,
    comment?: string,
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.payment.manage");
    const result = await this.repo.findPaymentBatchById(actor.tenantId, batchId);
    if (!result) {
      throw new NotFoundError("ScmPaymentBatch", batchId);
    }

    await this.assertOrganizationUnitInScope(actor, result.paymentBatch.organizationUnitId);

    if (result.paymentBatch.status !== "draft") {
      throw new ConflictError(`Payment batch must be in draft status to submit (current: ${result.paymentBatch.status})`);
    }

    if (!result.paymentBatch.workflowInstanceId) {
      throw new ValidationError(`Payment batch ${batchId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.paymentBatch.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending submit action exists on this payment batch");
    }

    await this.workflow.actOnAssignment(actor, pending.id, "submit", comment ?? null);

    const submitted = await this.repo.updatePaymentBatchStatus(actor.tenantId, batchId, "submitted", {
      userId: actor.userId,
      at: new Date(),
    });

    if (!submitted) {
      throw new ConflictError("Payment batch could not be submitted; concurrent state change");
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.payment_batch.submitted",
      entityType: "scm_payment_batch",
      entityId: batchId,
      metadata: { comment },
    });

    return this.getPaymentBatch(actor, batchId);
  }

  async approvePaymentBatch(
    actor: ActorContext,
    batchId: string,
    comment?: string,
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.payment.approve");
    const result = await this.repo.findPaymentBatchById(actor.tenantId, batchId);
    if (!result) {
      throw new NotFoundError("ScmPaymentBatch", batchId);
    }

    await this.assertOrganizationUnitInScope(actor, result.paymentBatch.organizationUnitId);

    if (result.paymentBatch.status !== "submitted") {
      throw new ConflictError(
        `Payment batch must be in submitted status to approve (current: ${result.paymentBatch.status})`,
      );
    }

    if (!result.paymentBatch.workflowInstanceId) {
      throw new ValidationError(`Payment batch ${batchId} has no associated workflow instance`);
    }

    // Enforce nominal-limit gate (DEC-004-FU): a line above the approver's
    // configured nominal limit needs BOTH a documented override reason AND a
    // different person than the submitter (person separation). A NULL limit
    // means the mechanism is dormant (value deferred to Phase 4 G1).
    const limits = await this.repo.findPaymentApprovalLimits(actor.tenantId, [actor.roleCode ?? ""]);
    const effectiveLimit = this.resolvePaymentApprovalLimit(limits);

    if (effectiveLimit !== null) {
      for (const line of result.lines) {
        if (Number(line.amount) <= effectiveLimit) continue;

        if (!line.approvalOverrideReason) {
          throw new ValidationError(
            `Line amount ${line.amount} exceeds approval limit ${effectiveLimit}; approval_override_reason required`,
          );
        }
        if (result.paymentBatch.submittedBy === actor.userId) {
          throw new ValidationError(
            `Line amount ${line.amount} exceeds approval limit ${effectiveLimit}; approver must differ from submitter`,
          );
        }
      }
    }

    // Get workflow assignment and act on it
    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.paymentBatch.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending approve action exists on this payment batch");
    }

    await this.workflow.actOnAssignment(actor, pending.id, "approve", comment ?? null);

    // Resolve legalEntityId from organizationUnitId (for GL posting)
    const legalEntityId = await this.repo.findLegalEntityIdForOrganizationUnit(
      actor.tenantId,
      result.paymentBatch.organizationUnitId,
    );
    if (!legalEntityId) {
      throw new ValidationError(
        `Organization unit ${result.paymentBatch.organizationUnitId} has no associated legal entity`,
      );
    }

    // Resolve periodId from approval date (today) — GL posting needs open period
    const approvedAt = new Date();
    const periodId = await this.resolveOpenPeriodForDate(actor.tenantId, legalEntityId, approvedAt);
    if (!periodId) {
      throw new ConflictError(
        `No open accounting period for date ${approvedAt.toISOString().split("T")[0]} in legal entity ${legalEntityId}`,
      );
    }

    // Build the per-line accounting events; the repo writes them in the SAME
    // transaction as the batch status update (approvePaymentBatch), so the batch
    // goes to 'approved' and all GL outbox rows commit together — or neither does.
    const lineEvents = result.lines.map((line, idx) => ({
      lineId: line.id,
      event: {
        eventType: "vendor.invoice.payment_approved" as const,
        sourceDocumentType: "scm_payment_batch",
        sourceDocumentId: batchId,
        sourceDocumentLineId: line.id,
        effectiveAt: approvedAt,
        currency: line.currency,
        amount: line.amount,
        idempotencyKey: `${result.paymentBatch.idempotencyKey}:line:${idx}`,
        payload: {
          legalEntityId,
          periodId,
          batchNumber: result.paymentBatch.batchNumber,
          vendorInvoiceId: line.vendorInvoiceId,
        },
        createdBy: actor.userId,
      },
    }));

    const approved = await this.repo.approvePaymentBatch(
      actor.tenantId,
      {
        paymentBatchId: batchId,
        approvedBy: actor.userId,
        approvedAt,
        financeTransactionId: null,
      },
      lineEvents.map(({ lineId, event }) => ({
        lineId,
        event: { ...event, sourceDocumentLineId: lineId },
      })),
    );

    if (!approved) {
      throw new ConflictError("Payment batch could not be approved; concurrent state change");
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.payment_batch.approved",
      entityType: "scm_payment_batch",
      entityId: batchId,
      metadata: {
        approvedAmount: result.paymentBatch.approvedAmount,
        lineCount: result.lines.length,
        nominalLimitEnforced: effectiveLimit !== null,
      },
    });

    return this.getPaymentBatch(actor, batchId);
  }

  async cancelPaymentBatch(
    actor: ActorContext,
    batchId: string,
    reason?: string,
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.payment.manage");
    const result = await this.repo.findPaymentBatchById(actor.tenantId, batchId);
    if (!result) {
      throw new NotFoundError("ScmPaymentBatch", batchId);
    }

    await this.assertOrganizationUnitInScope(actor, result.paymentBatch.organizationUnitId);

    if (!["draft", "submitted"].includes(result.paymentBatch.status)) {
      throw new ConflictError(
        `Payment batch can only be cancelled from draft or submitted status (current: ${result.paymentBatch.status})`,
      );
    }

    // No workflow-cancel API exists on WorkflowService (same as cancelPurchaseOrder /
    // cancelStockReservation elsewhere in this service): the batch status moves to
    // 'cancelled' directly; any pending workflow assignment is simply never acted on.
    const cancelled = await this.repo.updatePaymentBatchStatus(actor.tenantId, batchId, "cancelled", {
      userId: actor.userId,
      at: new Date(),
    });

    if (!cancelled) {
      throw new ConflictError("Payment batch could not be cancelled; concurrent state change");
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.payment_batch.cancelled",
      entityType: "scm_payment_batch",
      entityId: batchId,
      metadata: { reason },
    });

    return this.getPaymentBatch(actor, batchId);
  }

  /** Resolve nominal limit for single active roleCode (actor.roleCode). NULL = unbounded. */
  private resolvePaymentApprovalLimit(
    limits: Array<{ roleCode: string; nominalLimit: number | null }>,
  ): number | null {
    if (limits.length === 0) return null;
    // Return the max of all matching role limits; if any is NULL (unbounded), return NULL
    let max: number | null = 0;
    for (const { nominalLimit } of limits) {
      if (nominalLimit === null) return null;
      max = Math.max(max, nominalLimit);
    }
    return max;
  }

  /** Resolve open period that contains the approval date. */
  private async resolveOpenPeriodForDate(
    tenantId: string,
    legalEntityId: string,
    approvedAt: Date,
  ): Promise<string | null> {
    const periods = await this.repo.listOpenPeriods(tenantId, legalEntityId);
    const matching = periods.find((p) => {
      const from = new Date(p.dateFrom);
      const to = new Date(p.dateTo);
      return approvedAt >= from && approvedAt <= to;
    });
    return matching?.id ?? null;
  }

  // =========================================================================
  // Stage 2: Consignment Stock Consumption & Settlement
  // =========================================================================

  async createConsignmentSettlement(
    actor: ActorContext,
    input: Omit<CreateScmConsignmentSettlementInput, "settlementNumber" | "createdBy"> & { settlementNumber?: string },
  ): Promise<{ settlement: ScmConsignmentSettlement; lines: ScmConsignmentSettlementLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.consignment.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    const replayed = await this.repo.findConsignmentSettlementByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const settlementNumber =
      input.settlementNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_CONSIGNMENT_SETTLEMENT_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createConsignmentSettlement(actor.tenantId, {
          ...input,
          settlementNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findConsignmentSettlementByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Consignment settlement with idempotency key ${input.idempotencyKey} already exists`,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.consignment_settlement.created",
      entityType: "scm_consignment_settlement",
      entityId: result.settlement.id,
      metadata: {
        settlementNumber: result.settlement.settlementNumber,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        lineCount: result.lines.length,
      },
    });

    return result;
  }

  async getConsignmentSettlement(
    actor: ActorContext,
    settlementId: string,
  ): Promise<{ settlement: ScmConsignmentSettlement; lines: ScmConsignmentSettlementLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.consignment.read");
    const result = await this.repo.findConsignmentSettlementById(actor.tenantId, settlementId);
    if (!result) {
      throw new NotFoundError("ScmConsignmentSettlement", settlementId);
    }
    await this.assertWarehouseInScope(actor, result.settlement.warehouseId);
    return result;
  }

  async listConsignmentSettlements(
    actor: ActorContext,
    filter: ScmConsignmentSettlementFilter = {},
  ): Promise<ScmConsignmentSettlement[]> {
    await this.rbac.requirePermission(actor, "supply_chain.consignment.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listConsignmentSettlements(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // =========================================================================
  // Stage 2: Inventory Aging Report
  // =========================================================================

  async getInventoryAgingReport(
    actor: ActorContext,
    filter: ScmInventoryAgingFilter = {},
  ): Promise<ScmInventoryAgingBucket[]> {
    await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.getInventoryAgingBuckets(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  // =========================================================================
  // Stage 2: Inventory Disposal (Workflow-Governed Write-Off)
  // =========================================================================

  async createInventoryDisposal(
    actor: ActorContext,
    input: Omit<CreateScmInventoryDisposalInput, "disposalNumber" | "createdBy"> & { disposalNumber?: string },
  ): Promise<{ disposal: ScmInventoryDisposal; lines: ScmInventoryDisposalLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.disposal.manage");
    const disposalWarehouse = await this.assertWarehouseInScope(actor, input.warehouseId);
    if (input.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);
    }

    const replayed = await this.repo.findInventoryDisposalByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const disposalNumber =
      input.disposalNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_INVENTORY_DISPOSAL_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const { disposal, lines } = await this.runIdempotent(
      () =>
        this.repo.createInventoryDisposal(actor.tenantId, {
          ...input,
          disposalNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findInventoryDisposalByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Inventory disposal with idempotency key ${input.idempotencyKey} already exists`,
    );

    let workflowInstanceId: string | null = null;
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: "scm_inventory_disposal",
        entityId: disposal.id,
        contextData: {
          // ADR-0012: explicit unit if given (scope-checked), else the warehouse's owning unit.
          organizationUnitId: input.organizationUnitId ?? disposalWarehouse.organizationUnitId,
          disposalNumber,
          warehouseId: input.warehouseId,
          disposalType: input.disposalType ?? "write_off",
        },
      });
      workflowInstanceId = instance.id;
      await this.repo.updateInventoryDisposalStatus(actor.tenantId, {
        disposalId: disposal.id,
        status: "draft",
        workflowInstanceId,
        updatedBy: actor.userId,
      });
    } catch (err) {
      await this.repo.deleteInventoryDisposalWithoutWorkflow(actor.tenantId, disposal.id);
      throw err;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.inventory_disposal.created",
      entityType: "scm_inventory_disposal",
      entityId: disposal.id,
      metadata: {
        disposalNumber: disposal.disposalNumber,
        warehouseId: input.warehouseId,
        disposalType: input.disposalType ?? "write_off",
        reason: input.reason,
        lineCount: lines.length,
      },
    });

    return { disposal, lines };
  }

  async getInventoryDisposal(
    actor: ActorContext,
    disposalId: string,
  ): Promise<{ disposal: ScmInventoryDisposal; lines: ScmInventoryDisposalLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.disposal.read");
    const result = await this.repo.findInventoryDisposalById(actor.tenantId, disposalId);
    if (!result) {
      throw new NotFoundError("ScmInventoryDisposal", disposalId);
    }
    await this.assertWarehouseInScope(actor, result.disposal.warehouseId);
    if (result.disposal.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, result.disposal.organizationUnitId);
    }
    return result;
  }

  async listInventoryDisposals(
    actor: ActorContext,
    filter: ScmInventoryDisposalFilter = {},
  ): Promise<Array<{ disposal: ScmInventoryDisposal; status: EntityWorkflowStatus | null }>> {
    await this.rbac.requirePermission(actor, "supply_chain.disposal.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);
    const scopedOrgUnitIds = await this.resolveScopedOrganizationUnitIds(actor, filter.organizationUnitIds?.[0]);

    const disposals = await this.repo.listInventoryDisposals(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
      organizationUnitIds: scopedOrgUnitIds ?? undefined,
    });

    return this.withWorkflowStatus(
      actor,
      disposals,
      (d) => d.workflowInstanceId,
      (disposal, status) => ({ disposal, status }),
    );
  }

  async submitInventoryDisposal(
    actor: ActorContext,
    disposalId: string,
    comment?: string,
  ): Promise<{ disposal: ScmInventoryDisposal; lines: ScmInventoryDisposalLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.disposal.approve");
    const result = await this.repo.findInventoryDisposalById(actor.tenantId, disposalId);
    if (!result) {
      throw new NotFoundError("ScmInventoryDisposal", disposalId);
    }
    await this.assertWarehouseInScope(actor, result.disposal.warehouseId);
    if (result.disposal.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, result.disposal.organizationUnitId);
    }

    if (result.disposal.status !== "draft") {
      throw new ConflictError(`Disposal must be in draft status to submit (current: ${result.disposal.status})`);
    }

    if (!result.disposal.workflowInstanceId) {
      throw new ValidationError(`Disposal ${disposalId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.disposal.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending submit action exists on this disposal");
    }

    await this.workflow.actOnAssignment(actor, pending.id, "submit", comment ?? null);

    await this.repo.updateInventoryDisposalStatus(actor.tenantId, {
      disposalId,
      status: "submitted",
      submittedAt: new Date(),
      submittedBy: actor.userId,
      updatedBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.inventory_disposal.submitted",
      entityType: "scm_inventory_disposal",
      entityId: disposalId,
      metadata: { comment },
    });

    return this.getInventoryDisposal(actor, disposalId);
  }

  async approveInventoryDisposal(
    actor: ActorContext,
    disposalId: string,
    comment?: string,
  ): Promise<{ disposal: ScmInventoryDisposal; lines: ScmInventoryDisposalLine[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.disposal.approve");
    const result = await this.repo.findInventoryDisposalById(actor.tenantId, disposalId);
    if (!result) {
      throw new NotFoundError("ScmInventoryDisposal", disposalId);
    }
    await this.assertWarehouseInScope(actor, result.disposal.warehouseId);
    if (result.disposal.organizationUnitId) {
      await this.assertOrganizationUnitInScope(actor, result.disposal.organizationUnitId);
    }

    if (result.disposal.status !== "submitted" && result.disposal.status !== "draft") {
      throw new ConflictError(
        `Disposal must be in draft or submitted status to approve (current: ${result.disposal.status})`,
      );
    }

    if (!result.disposal.workflowInstanceId) {
      throw new ValidationError(`Disposal ${disposalId} has no associated workflow instance`);
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      result.disposal.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending approve action exists on this disposal");
    }

    // A draft disposal has the initial submit assignment; the workflow definition
    // may transition submit directly to its terminal approval step.
    const workflowAction = result.disposal.status === "draft" ? "submit" : "approve";
    await this.workflow.actOnAssignment(actor, pending.id, workflowAction, comment ?? null);
    const workflowStatus = await this.workflow.getEntityStatus(actor, result.disposal.workflowInstanceId);

    let projectedStatus: ScmDisposalStatus = result.disposal.status;
    let approvedAt: Date | undefined;
    let approvedBy: string | undefined;
    let executedAt: Date | undefined;
    let executedBy: string | undefined;
    let rejectedAt: Date | undefined;
    let rejectedBy: string | undefined;
    let rejectionReason: string | undefined;

    if (workflowStatus.instanceStatus === "approved") {
      projectedStatus = "approved";
      approvedAt = new Date();
      approvedBy = actor.userId;
      executedAt = approvedAt;
      executedBy = actor.userId;

      for (const line of result.lines) {
        const lineUnitCost = line.unitCost ?? 0;
        const lineAmount = line.amount ?? (line.quantity * lineUnitCost);

        const movResult = await this.repo.recordAdvancedStockMovement(actor.tenantId, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          locationId: line.locationId ?? undefined,
          batchId: line.batchId ?? undefined,
          serialId: line.serialId ?? undefined,
          stockCondition: line.stockCondition ?? "unrestricted",
          ownerType: line.ownerType ?? "own",
          ownerPartyId: line.ownerPartyId ?? undefined,
          movementType: "disposal_out",
          quantity: line.quantity,
          unitCost: line.unitCost ?? undefined,
          totalCost: lineAmount,
          referenceType: "scm_inventory_disposal",
          referenceId: disposalId,
          referenceNumber: result.disposal.disposalNumber,
          notes: line.notes ?? undefined,
          createdBy: actor.userId,
        });

        let eventId: string | null = null;
        if (line.ownerType === "own" || !line.ownerType) {
          const event = await this.repo.createAccountingReadyEvent(actor.tenantId, {
            eventType: "inventory.disposed",
            sourceDocumentType: "scm_inventory_disposal",
            sourceDocumentId: disposalId,
            sourceDocumentLineId: line.id,
            sourceMovementId: movResult.movement.id,
            effectiveAt: approvedAt,
            currency: line.currency ?? "IDR",
            amount: lineAmount,
            quantity: line.quantity,
            unitCost: line.unitCost ?? undefined,
            accountAssignmentType: "expense",
            accountAssignmentDimensions: {},
            idempotencyKey: `${result.disposal.idempotencyKey}:line:${line.sortOrder ?? 0}:${line.id}`,
            payload: {
              disposalNumber: result.disposal.disposalNumber,
              disposalType: result.disposal.disposalType,
              reason: result.disposal.reason,
            },
          });
          eventId = event.id;
        }

        await this.repo.updateInventoryDisposalLineExecution(
          actor.tenantId,
          line.id,
          movResult.movement.id,
          null,
          eventId,
          line.unitCost ?? null,
          lineAmount,
        );
      }
    } else if (workflowStatus.instanceStatus === "rejected") {
      projectedStatus = "rejected";
      rejectedAt = new Date();
      rejectedBy = actor.userId;
      rejectionReason = comment;
    } else if (workflowStatus.instanceStatus === "cancelled") {
      projectedStatus = "cancelled";
    }

    await this.repo.updateInventoryDisposalStatus(actor.tenantId, {
      disposalId,
      status: projectedStatus,
      approvedAt,
      approvedBy,
      executedAt,
      executedBy,
      rejectedAt,
      rejectedBy,
      rejectionReason,
      updatedBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.inventory_disposal.approved",
      entityType: "scm_inventory_disposal",
      entityId: disposalId,
      metadata: { status: projectedStatus, comment },
    });

    return this.getInventoryDisposal(actor, disposalId);
  }

  // =========================================================================
  // Stage 2: Warehouse Tasks (Putaway, Pick, Pack, Cycle Count)
  // =========================================================================

  async createWarehouseTask(
    actor: ActorContext,
    input: Omit<CreateScmWarehouseTaskInput, "taskNumber" | "createdBy"> & { taskNumber?: string },
  ): Promise<{ task: ScmWarehouseTask; items: ScmWarehouseTaskItem[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse_task.manage");
    await this.assertWarehouseInScope(actor, input.warehouseId);

    const replayed = await this.repo.findWarehouseTaskByIdempotencyKey(
      actor.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayed;

    const taskNumber =
      input.taskNumber ??
      (
        await this.configuration.generateNumberForTenant(
          actor.tenantId,
          SCM_WAREHOUSE_TASK_NUMBERING_CODE,
          actor.userId,
        )
      ).number;

    const result = await this.runIdempotent(
      () =>
        this.repo.createWarehouseTask(actor.tenantId, {
          ...input,
          taskNumber,
          createdBy: actor.userId,
        }),
      () => this.repo.findWarehouseTaskByIdempotencyKey(actor.tenantId, input.idempotencyKey),
      `Warehouse task with idempotency key ${input.idempotencyKey} already exists`,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.warehouse_task.created",
      entityType: "scm_warehouse_task",
      entityId: result.task.id,
      metadata: {
        taskNumber: result.task.taskNumber,
        warehouseId: input.warehouseId,
        taskType: input.taskType,
        priority: input.priority ?? "normal",
        itemCount: result.items.length,
      },
    });

    return result;
  }

  async getWarehouseTask(
    actor: ActorContext,
    taskId: string,
  ): Promise<{ task: ScmWarehouseTask; items: ScmWarehouseTaskItem[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse_task.read");
    const result = await this.repo.findWarehouseTaskById(actor.tenantId, taskId);
    if (!result) {
      throw new NotFoundError("ScmWarehouseTask", taskId);
    }
    await this.assertWarehouseInScope(actor, result.task.warehouseId);
    return result;
  }

  async listWarehouseTasks(
    actor: ActorContext,
    filter: ScmWarehouseTaskFilter = {},
  ): Promise<ScmWarehouseTask[]> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse_task.read");
    const scopedWarehouseIds = await this.resolveScopedWarehouseIds(actor, filter.warehouseId);

    return this.repo.listWarehouseTasks(actor.tenantId, {
      ...filter,
      warehouseIds: scopedWarehouseIds ?? undefined,
    });
  }

  async assignWarehouseTask(
    actor: ActorContext,
    taskId: string,
    assignedTo: string,
  ): Promise<{ task: ScmWarehouseTask; items: ScmWarehouseTaskItem[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse_task.manage");
    const result = await this.repo.findWarehouseTaskById(actor.tenantId, taskId);
    if (!result) {
      throw new NotFoundError("ScmWarehouseTask", taskId);
    }
    await this.assertWarehouseInScope(actor, result.task.warehouseId);

    if (result.task.status !== "open") {
      throw new ConflictError(`Task must be in open status to assign (current: ${result.task.status})`);
    }

    const updated = await this.repo.updateWarehouseTaskStatus(actor.tenantId, {
      warehouseTaskId: taskId,
      status: "assigned",
      assignedTo,
      assignedAt: new Date(),
      updatedBy: actor.userId,
    });
    if (!updated) {
      throw new NotFoundError("ScmWarehouseTask", taskId);
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.warehouse_task.assigned",
      entityType: "scm_warehouse_task",
      entityId: taskId,
      metadata: { assignedTo, taskNumber: result.task.taskNumber },
    });

    return this.getWarehouseTask(actor, taskId);
  }

  async completeWarehouseTask(
    actor: ActorContext,
    taskId: string,
  ): Promise<{ task: ScmWarehouseTask; items: ScmWarehouseTaskItem[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.warehouse_task.execute");
    const result = await this.repo.findWarehouseTaskById(actor.tenantId, taskId);
    if (!result) {
      throw new NotFoundError("ScmWarehouseTask", taskId);
    }
    await this.assertWarehouseInScope(actor, result.task.warehouseId);

    if (result.task.status !== "in_progress" && result.task.status !== "assigned") {
      throw new ConflictError(`Task must be assigned or in progress to complete (current: ${result.task.status})`);
    }

    await this.repo.updateWarehouseTaskStatus(actor.tenantId, {
      warehouseTaskId: taskId,
      status: "completed",
      completedAt: new Date(),
      completedBy: actor.userId,
      updatedBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "scm_advanced.warehouse_task.completed",
      entityType: "scm_warehouse_task",
      entityId: taskId,
      metadata: { taskNumber: result.task.taskNumber },
    });

    return this.getWarehouseTask(actor, taskId);
  }

  // =========================================================================
  // Data Scope & Hierarchy Authorization Helpers
  // =========================================================================

  /**
   * Epic 5 G3 enforcement batch — the Data Scope rule for a line-level
   * inventory record. Inspections, discrepancy records and stock-opname counts
   * are keyed by a LINE id, and no line is readable by id in this repository,
   * so the warehouse the line belongs to is resolved through its parent record
   * and asserted. An unresolvable ref is a `NotFoundError`, never a silent
   * pass: fail closed.
   */
  private async assertInventoryLineInScope(
    actor: ActorContext,
    ref: {
      receivingLineId?: string | null;
      discrepancyId?: string | null;
      opnameLineId?: string | null;
    },
  ): Promise<void> {
    const warehouseId = await this.repo.findInventoryLinePlacementWarehouseId(
      actor.tenantId,
      ref,
    );
    if (!warehouseId) {
      throw new NotFoundError(
        "InventoryLine",
        ref.receivingLineId ?? ref.discrepancyId ?? ref.opnameLineId ?? "unknown",
      );
    }
    await this.assertWarehouseInScope(actor, warehouseId);
  }

  /**
   * Epic 5 G3 enforcement batch — the Data Scope rule for a TENANT-LEVEL
   * family: landed-cost documents, supplier evaluations and contracts, contract
   * spend, account-assignment configuration and accounting-ready events carry
   * no Organization Unit and no Legal Entity column, so there is no placement to
   * narrow by. Their authority is therefore the tenant-wide scope, which is the
   * same rule the module already applies to their documents
   * (`canAccessLandedCostForDocument`, `canAccessSupplierContractForDocument`).
   * Before this, any internal caller holding the family's capability could read
   * and change it at ANY scope, because only the permission was checked.
   */
  private async assertTenantLevelScope(actor: ActorContext, entity: string): Promise<void> {
    if (!(await this.rbac.hasTenantScope(actor))) {
      throw new ForbiddenError(
        `${entity} are tenant-level: the active Role's Data Scope must be tenant-wide`,
      );
    }
  }

  private async assertWarehouseInScope(
    actor: ActorContext,
    warehouseId: string,
  ): Promise<ScmWarehouse> {
    const warehouse = await this.repo.findWarehouseById(actor.tenantId, warehouseId);
    if (!warehouse) {
      throw new NotFoundError("ScmWarehouse", warehouseId);
    }
    await this.assertOrganizationUnitInScope(actor, warehouse.organizationUnitId);
    return warehouse;
  }

  private async assertOrganizationUnitInScope(
    actor: ActorContext,
    organizationUnitId: string | null | undefined,
  ): Promise<void> {
    if (organizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, organizationUnitId);
    } else {
      const hasTenant = await this.rbac.hasTenantScope(actor);
      if (!hasTenant) {
        throw new ForbiddenError("Tenant-wide scope required for tenant-level entities");
      }
    }
  }

  private async resolveScopedOrganizationUnitIds(
    actor: ActorContext,
    requestedOrgUnitId?: string | null,
  ): Promise<string[] | null> {
    if (requestedOrgUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, requestedOrgUnitId);
      const descendantIds = await this.repo.listOrganizationUnitDescendantIds(actor.tenantId, [requestedOrgUnitId]);
      return descendantIds.length > 0 ? descendantIds : [requestedOrgUnitId];
    }
    // Epic 5 G3 enforcement batch — the narrowing comes from the ACTIVE
    // assignment's Data Scope, computed in one place (`RbacService`), so the
    // warehouse/procurement tiers inherit the tenant → Legal Entity →
    // Organization Unit chain instead of hand-rolling an Organization-Unit-only
    // walk:
    // - tenant-wide       → `null` (no narrowing),
    // - legal_entity      → every active unit inside that Legal Entity (§4.5
    //                       Putaran 4). The previous walk read
    //                       `getAssignments(actor.userId)` and filtered
    //                       `scopeType === 'organization_unit'`, so an
    //                       Legal-Entity-scoped supervisor matched NOTHING and
    //                       every warehouse list answered empty,
    // - organization_unit → the scope unit and its active descendants,
    // - anything else     → `[]` (fail closed).
    //
    // Using `getAssignments(userId)` — the UNION of every Role the user holds —
    // was also an Epic 1 §4.1 C violation: a user holding a wide Role they had
    // not switched into still widened the list they saw.
    return this.rbac.listScopedOrganizationUnitIds(actor);
  }

  private async resolveScopedWarehouseIds(
    actor: ActorContext,
    requestedWarehouseId?: string | null,
  ): Promise<string[] | null> {
    if (requestedWarehouseId) {
      await this.assertWarehouseInScope(actor, requestedWarehouseId);
      return [requestedWarehouseId];
    }
    const hasTenant = await this.rbac.hasTenantScope(actor);
    if (hasTenant) {
      return null;
    }
    const scopedOrgUnitIds = await this.resolveScopedOrganizationUnitIds(actor);
    const warehouses = await this.repo.listWarehouses(actor.tenantId, {
      organizationUnitIds: scopedOrgUnitIds ?? undefined,
    });
    return warehouses.map((w) => w.id);
  }

  /**
   * Race-safe idempotent write. The caller has already re-read by idempotency
   * key, but two concurrent retries can both pass that check before either
   * inserts; the `UNIQUE (tenant_id, idempotency_key)` constraint then rejects
   * the loser with Postgres error code 23505. That is not a server fault, so it
   * must not surface as a 500 — return the row that won, or, if the conflict
   * came from a different unique constraint (e.g. a duplicate document number),
   * raise a deterministic `ConflictError`.
   */
  private async runIdempotent<T>(
    write: () => Promise<T>,
    reread: () => Promise<T | null>,
    conflictMessage: string,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        const winner = await reread();
        if (winner) return winner;
        throw new ConflictError(conflictMessage);
      }
      throw error;
    }
  }

  private async withWorkflowStatus<T, R>(
    actor: ActorContext,
    items: T[],
    getWorkflowInstanceId: (item: T) => string | null,
    combine: (item: T, status: EntityWorkflowStatus | null) => R,
  ): Promise<R[]> {
    const instanceIds = items
      .map(getWorkflowInstanceId)
      .filter((id): id is string => id !== null);
    const statusRows = await this.workflow.getEntityStatuses(actor, instanceIds);
    const statusByInstanceId = new Map(statusRows.map((s) => [s.instanceId, s]));
    return items.map((item) => {
      const id = getWorkflowInstanceId(item);
      const status = id ? statusByInstanceId.get(id) ?? null : null;
      return combine(item, status);
    });
  }

  // =========================================================================
  // ADR-0012 Entity Document Authorization Resolvers
  // =========================================================================

  async canAccessStockTransferForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const transferResult = await this.repo.findStockTransferById(actor.tenantId, entityId);
    if (!transferResult) return false;
    try {
      await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
      await this.assertWarehouseInScope(actor, transferResult.transfer.fromWarehouseId);
      return true;
    } catch {
      return false;
    }
  }

  async canAccessStockOpnameForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const opnameResult = await this.repo.findStockOpnameById(actor.tenantId, entityId);
    if (!opnameResult) return false;
    try {
      await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
      await this.assertWarehouseInScope(actor, opnameResult.opname.warehouseId);
      return true;
    } catch {
      return false;
    }
  }

  async canAccessRfqForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const rfqResult = await this.repo.findRfqById(actor.tenantId, entityId);
    if (!rfqResult) return false;
    try {
      await this.rbac.requirePermission(actor, "supply_chain.procurement.read");
      await this.assertOrganizationUnitInScope(actor, rfqResult.rfq.organizationUnitId);
      return true;
    } catch {
      return false;
    }
  }

  async canAccessSupplierContractForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const contractResult = await this.repo.findSupplierContractById(actor.tenantId, entityId);
    if (!contractResult) return false;
    try {
      await this.rbac.requirePermission(actor, "supply_chain.contract.read");
      const hasTenant = await this.rbac.hasTenantScope(actor);
      return hasTenant;
    } catch {
      return false;
    }
  }

  async canAccessLandedCostForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const lcResult = await this.repo.findLandedCostById(actor.tenantId, entityId);
    if (!lcResult) return false;
    try {
      await this.rbac.requirePermission(actor, "supply_chain.valuation.read");
      const hasTenant = await this.rbac.hasTenantScope(actor);
      return hasTenant;
    } catch {
      return false;
    }
  }

  async canAccessReceivingRecordForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const recResult = await this.repo.findReceivingRecordById(actor.tenantId, entityId);
    if (!recResult) return false;
    try {
      await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
      await this.assertWarehouseInScope(actor, recResult.receiving.warehouseId);
      return true;
    } catch {
      return false;
    }
  }

  async canAccessReturnToVendorForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const retResult = await this.repo.findReturnToVendorById(actor.tenantId, entityId);
    if (!retResult) return false;
    try {
      await this.rbac.requirePermission(actor, "supply_chain.inventory.read");
      await this.assertWarehouseInScope(actor, retResult.returnToVendor.warehouseId);
      return true;
    } catch {
      return false;
    }
  }
}
