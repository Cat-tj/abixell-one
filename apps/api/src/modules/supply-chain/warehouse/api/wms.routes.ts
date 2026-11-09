import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  AccountingEventService,
  ConsignmentService,
  DisposalService,
  ItemTrackingService,
  ReceivingInspectionService,
  ReorderReservationService,
  ReturnsReversalsService,
  StockLedgerService,
  TransferOpnameService,
  ValuationService,
  WarehouseTaskService,
  WarehouseTopologyService,
} from "../application/index.js";
import type {
  CreateScmAccountingReadyEventInput,
  CreateScmConsignmentSettlementInput,
  CreateScmInspectionInput,
  CreateScmInventoryDisposalInput,
  CreateScmReceivingRecordInput,
  CreateScmReceiptReversalInput,
  CreateScmReplacementDeliveryInput,
  CreateScmReturnToVendorInput,
  CreateScmWarehouseTaskInput,
  ScmAccountingOutboxState,
  ScmAccountingReadyEventType,
  ScmAccountingReconciliationState,
  ScmAdvancedStockMovementType,
  ScmConsignmentSettlementStatus,
  ScmDiscrepancyStatus,
  ScmDiscrepancyType,
  ScmDisposalStatus,
  ScmDisposalType,
  ScmLandedCostStatus,
  ScmOpnameStatus,
  ScmReceivingStatus,
  ScmReplacementDeliveryStatus,
  ScmReservationStatus,
  ScmReturnToVendorStatus,
  ScmSerialStatus,
  ScmStockCondition,
  ScmStockOwnerType,
  ScmTransferStatus,
  ScmWarehouseTaskPriority,
  ScmWarehouseTaskStatus,
  ScmWarehouseTaskType,
} from "../../advanced/domain/supply-chain-advanced.entity.js";

export interface WmsRouteDeps {
  wms: {
    topology: WarehouseTopologyService;
    tracking: ItemTrackingService;
    ledger: StockLedgerService;
    reorder: ReorderReservationService;
    transferOpname: TransferOpnameService;
    valuation: ValuationService;
    receiving: ReceivingInspectionService;
    returns: ReturnsReversalsService;
    consignment: ConsignmentService;
    disposal: DisposalService;
    task: WarehouseTaskService;
    accountingEvent: AccountingEventService;
  };
}

const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;

const idParamSchema = z.object({ id: z.string().uuid() });
const actionSchema = z.object({
  actionCode: z.string().min(1),
  comment: z.string().nullable().optional(),
});

const createWarehouseSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  siteId: z.string().uuid().nullable().optional(),
  organizationUnitId: z.string().uuid().nullable().optional(),
  address: z.string().nullable().optional(),
  grade: z.enum(["food", "non_food"]).nullable().optional(),
  isActive: z.boolean().optional(),
});
const updateWarehouseSchema = z.object({
  name: z.string().min(1).optional(),
  siteId: z.string().uuid().nullable().optional(),
  organizationUnitId: z.string().uuid().nullable().optional(),
  address: z.string().nullable().optional(),
  grade: z.enum(["food", "non_food"]).nullable().optional(),
  isActive: z.boolean().optional(),
});
const createWarehouseLocationSchema = z.object({
  warehouseId: z.string().uuid(),
  code: z.string().min(1),
  zone: z.string().nullable().optional(),
  aisle: z.string().nullable().optional(),
  rack: z.string().nullable().optional(),
  shelf: z.string().nullable().optional(),
  bin: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
const updateWarehouseLocationSchema = z.object({
  zone: z.string().nullable().optional(),
  aisle: z.string().nullable().optional(),
  rack: z.string().nullable().optional(),
  shelf: z.string().nullable().optional(),
  bin: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

const createItemBatchSchema = z.object({
  itemId: z.string().uuid(),
  batchNumber: z.string().optional(),
  manufacturedDate: z.string().regex(dateOnlyRegex).nullable().optional(),
  expiryDate: z.string().regex(dateOnlyRegex).nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
const createItemSerialSchema = z.object({
  itemId: z.string().uuid(),
  serialNumber: z.string().min(1),
  batchId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  status: z.enum(["in_stock", "reserved", "issued", "in_transit", "disposed", "maintenance"]).optional(),
  warrantyExpiryDate: z.string().regex(dateOnlyRegex).nullable().optional(),
  notes: z.string().nullable().optional(),
});
const updateItemSerialSchema = z.object({
  batchId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  status: z.enum(["in_stock", "reserved", "issued", "in_transit", "disposed", "maintenance"]).optional(),
  warrantyExpiryDate: z.string().regex(dateOnlyRegex).nullable().optional(),
  notes: z.string().nullable().optional(),
});

const stockConditionSchema = z.enum(["unrestricted", "quality_hold", "rejected", "quarantined", "blocked", "in_transit", "in_repair"]);
const ownerTypeSchema = z.enum(["own", "supplier", "customer"]);
const accountAssignmentTypeSchema = z.enum(["stock", "expense", "asset", "project", "work_order", "service"]);

const recordAdvancedMovementSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  serialId: z.string().uuid().nullable().optional(),
  stockCondition: stockConditionSchema.optional(),
  ownerType: ownerTypeSchema.optional(),
  ownerPartyId: z.string().uuid().nullable().optional(),
  movementType: z.enum([
    "in", "out", "transfer_in", "transfer_out", "adjustment_in", "adjustment_out", "opname_in", "opname_out",
    "inspection_hold_in", "inspection_hold_out", "inspection_release_in", "inspection_release_out", "return_to_vendor_out",
    "receipt_reversal_out", "receipt_reversal_in", "consignment_in", "consignment_out", "replacement_in", "disposal_out",
  ]),
  quantity: z.number().refine((n) => n !== 0, { message: "quantity cannot be zero" }),
  unitCost: z.number().nonnegative().optional(),
  totalCost: z.number().nonnegative().optional(),
  referenceType: z.string().nullable().optional(),
  referenceId: z.string().uuid().nullable().optional(),
  referenceNumber: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  occurredAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
});

const upsertReorderPolicySchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid().nullable().optional(),
  minQuantity: z.number().nonnegative(),
  reorderPoint: z.number().nonnegative(),
  reorderQuantity: z.number().positive(),
  safetyStock: z.number().nonnegative().optional(),
  leadTimeDays: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
});
const createStockReservationSchema = z.object({
  reservationNumber: z.string().min(1),
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  quantity: z.number().positive(),
  reservedForType: z.string().min(1),
  reservedForId: z.string().uuid().nullable().optional(),
  reservedForNumber: z.string().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional().transform((d) => (d ? new Date(d) : null)),
  notes: z.string().nullable().optional(),
});

const createStockTransferSchema = z.object({
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  transferNumber: z.string().optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    quantityRequested: z.number().positive(),
    batchId: z.string().uuid().nullable().optional(),
    fromLocationId: z.string().uuid().nullable().optional(),
    toLocationId: z.string().uuid().nullable().optional(),
    notes: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })).min(1),
});
const recordTransferShipmentSchema = z.object({
  transferId: z.string().uuid(),
  lineShipments: z.array(z.object({ lineId: z.string().uuid(), quantityShipped: z.number().positive() })).min(1),
});
const recordTransferReceiptSchema = z.object({
  transferId: z.string().uuid(),
  lineReceipts: z.array(z.object({ lineId: z.string().uuid(), quantityReceived: z.number().positive() })).min(1),
});
const createStockOpnameSchema = z.object({
  warehouseId: z.string().uuid(),
  opnameDate: z.string().regex(dateOnlyRegex),
  opnameNumber: z.string().optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    locationId: z.string().uuid().nullable().optional(),
    batchId: z.string().uuid().nullable().optional(),
    systemQuantity: z.number().nonnegative(),
    physicalQuantity: z.number().nonnegative().nullable().optional(),
    notes: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })).min(1),
});
const recordOpnameCountSchema = z.object({ lineId: z.string().uuid(), physicalQuantity: z.number().nonnegative() });

const createValuationLayerSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid().nullable().optional(),
  receiptMovementId: z.string().uuid().nullable().optional(),
  receivedDate: z.string().regex(dateOnlyRegex),
  originalQuantity: z.number().positive(),
  remainingQuantity: z.number().positive().optional(),
  unitCost: z.number().nonnegative(),
  landedCostAdded: z.number().nonnegative().optional(),
  effectiveUnitCost: z.number().nonnegative().optional(),
  totalValue: z.number().nonnegative().optional(),
});
const consumeValuationLayerSchema = z.object({ layerId: z.string().uuid(), remainingQuantity: z.number().nonnegative() });
const createLandedCostSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  costType: z.string().min(1),
  currency: z.string().optional(),
  amount: z.number().positive(),
  allocationMethod: z.enum(["by_value", "by_quantity", "by_weight", "equal"]),
  voucherNumber: z.string().optional(),
  notes: z.string().nullable().optional(),
  allocations: z.array(z.object({
    itemId: z.string().uuid(),
    valuationLayerId: z.string().uuid().nullable().optional(),
    allocatedAmount: z.number().nonnegative(),
    costPerUnitAdded: z.number().nonnegative(),
  })).min(1),
});

const createReceivingLineSchema = z.object({
  purchaseOrderLineId: z.string().uuid(),
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  stockCondition: stockConditionSchema.optional(),
  ownerType: ownerTypeSchema.optional(),
  ownerPartyId: z.string().uuid().nullable().optional(),
  quantityReceived: z.number().positive(),
  unitCost: z.number().nonnegative().nullable().optional(),
  currency: z.string().optional(),
  accountAssignmentType: accountAssignmentTypeSchema,
  accountAssignmentDimensions: z.record(z.string(), z.unknown()).optional(),
  inspectionRequired: z.boolean().optional(),
  holdMovementId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const createReceivingRecordSchema = z.object({
  idempotencyKey: z.string().min(1),
  purchaseOrderId: z.string().uuid(),
  supplierId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  receiptNumber: z.string().optional(),
  receivedAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  receivedBy: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(createReceivingLineSchema).min(1),
});
const createInspectionSchema = z.object({
  receivingLineId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  inspectionNumber: z.string().optional(),
  inspectedAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  inspectedBy: z.string().uuid().nullable().optional(),
  quantityAccepted: z.number().nonnegative().optional(),
  quantityRejected: z.number().nonnegative().optional(),
  quantityQuarantined: z.number().nonnegative().optional(),
  result: z.enum(["accepted", "rejected", "mixed", "quarantined"]),
  reason: z.string().nullable().optional(),
});
const createDiscrepancyRecordSchema = z.object({
  receivingLineId: z.string().uuid(),
  discrepancyType: z.enum(["shortage", "overage", "damage", "quality", "document"]),
  quantity: z.number().nonnegative().nullable().optional(),
  description: z.string().min(1),
});
const resolveDiscrepancyRecordSchema = z.object({
  status: z.enum(["resolved", "cancelled"]),
  resolvedAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  resolvedBy: z.string().uuid().nullable().optional(),
  resolutionNotes: z.string().nullable().optional(),
});

const createReturnToVendorLineSchema = z.object({
  receivingLineId: z.string().uuid().nullable().optional(),
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  stockCondition: stockConditionSchema,
  ownerType: ownerTypeSchema,
  ownerPartyId: z.string().uuid().nullable().optional(),
  quantity: z.number().positive(),
  movementId: z.string().uuid().nullable().optional(),
  accountingReadyEventId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const createReturnToVendorSchema = z.object({
  idempotencyKey: z.string().min(1),
  returnNumber: z.string().optional(),
  supplierId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  warehouseId: z.string().uuid(),
  returnedAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  returnedBy: z.string().uuid().nullable().optional(),
  reason: z.string().min(1),
  notes: z.string().nullable().optional(),
  lines: z.array(createReturnToVendorLineSchema).min(1),
});
const createReceiptReversalSchema = z.object({
  idempotencyKey: z.string().min(1),
  reversalNumber: z.string().optional(),
  receivingRecordId: z.string().uuid(),
  reason: z.string().min(1),
  reversedAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  reversedBy: z.string().uuid().nullable().optional(),
});
const createAccountingReadyEventSchema = z.object({
  eventType: z.enum([
    "inventory.goods_received", "inventory.goods_issued", "inventory.transferred", "inventory.adjusted",
    "inventory.returned_to_vendor", "inventory.receipt_reversed", "inventory.landed_cost_applied",
    "inventory.consignment_consumed", "service.accepted", "inventory.disposed",
  ]),
  sourceDocumentType: z.string().min(1),
  sourceDocumentId: z.string().uuid(),
  sourceDocumentLineId: z.string().uuid().nullable().optional(),
  sourceMovementId: z.string().uuid().nullable().optional(),
  sourceDocumentRevision: z.number().int().optional(),
  effectiveAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  currency: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  quantity: z.number().nullable().optional(),
  unitCost: z.number().nullable().optional(),
  accountAssignmentType: accountAssignmentTypeSchema.nullable().optional(),
  accountAssignmentDimensions: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1),
  reversalOfEventId: z.string().uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
const updateAccountingReadyEventStateSchema = z.object({
  stateKind: z.enum(["outbox", "reconciliation"]),
  toState: z.string().min(1),
  reason: z.string().nullable().optional(),
  occurredAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
});

const createReplacementDeliveryLineSchema = z.object({
  returnToVendorLineId: z.string().uuid().nullable().optional(),
  purchaseOrderLineId: z.string().uuid().nullable().optional(),
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  stockCondition: stockConditionSchema.optional(),
  ownerType: ownerTypeSchema.optional(),
  ownerPartyId: z.string().uuid().nullable().optional(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative().nullable().optional(),
  currency: z.string().optional(),
  accountAssignmentType: accountAssignmentTypeSchema.optional(),
  accountAssignmentDimensions: z.record(z.string(), z.unknown()).optional(),
  movementId: z.string().uuid().nullable().optional(),
  accountingReadyEventId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const createReplacementDeliverySchema = z.object({
  idempotencyKey: z.string().min(1),
  replacementNumber: z.string().optional(),
  returnToVendorId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  supplierId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  receivedAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  receivedBy: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(createReplacementDeliveryLineSchema).min(1),
});

const createConsignmentSettlementLineSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative(),
  currency: z.string().optional(),
  amount: z.number().nonnegative(),
  supplierOutMovementId: z.string().uuid().nullable().optional(),
  ownInMovementId: z.string().uuid().nullable().optional(),
  valuationLayerId: z.string().uuid().nullable().optional(),
  accountingReadyEventId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const createConsignmentSettlementSchema = z.object({
  idempotencyKey: z.string().min(1),
  settlementNumber: z.string().optional(),
  supplierId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  settledAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  settledBy: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z.array(createConsignmentSettlementLineSchema).min(1),
});

const createInventoryDisposalLineSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  serialId: z.string().uuid().nullable().optional(),
  stockCondition: stockConditionSchema.optional(),
  ownerType: ownerTypeSchema.optional(),
  ownerPartyId: z.string().uuid().nullable().optional(),
  quantity: z.number().positive(),
  unitCost: z.number().nonnegative().nullable().optional(),
  currency: z.string().optional(),
  notes: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const createInventoryDisposalSchema = z.object({
  idempotencyKey: z.string().min(1),
  disposalNumber: z.string().optional(),
  warehouseId: z.string().uuid(),
  organizationUnitId: z.string().uuid().nullable().optional(),
  disposalType: z.enum(["write_off", "scrap", "donation", "destruction", "expired"]).optional(),
  reason: z.string().min(1),
  notes: z.string().nullable().optional(),
  lines: z.array(createInventoryDisposalLineSchema).min(1),
});
const createWarehouseTaskItemSchema = z.object({
  itemId: z.string().uuid(),
  fromLocationId: z.string().uuid().nullable().optional(),
  toLocationId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  serialId: z.string().uuid().nullable().optional(),
  expectedQuantity: z.number().positive(),
  notes: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
const createWarehouseTaskSchema = z.object({
  idempotencyKey: z.string().min(1),
  taskNumber: z.string().optional(),
  warehouseId: z.string().uuid(),
  taskType: z.enum(["putaway", "pick", "pack", "cycle_count", "replenishment", "relocation"]),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  sourceDocumentType: z.string().nullable().optional(),
  sourceDocumentId: z.string().uuid().nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().optional().transform((d) => (d ? new Date(d) : undefined)),
  notes: z.string().nullable().optional(),
  items: z.array(createWarehouseTaskItemSchema).min(1),
});
const assignWarehouseTaskSchema = z.object({ assignedTo: z.string().uuid() });
const commentBodySchema = z.object({ comment: z.string().optional() });

function query(q: unknown): Record<string, string | undefined> {
  return (q ?? {}) as Record<string, string | undefined>;
}

const route = (prefix: string, path: string): string => `${prefix}${path}`;

/**
 * Registers Warehouse Management routes. The default `/wms/*` namespace is the
 * canonical API; the legacy shim reuses the same handlers with
 * `/supply-chain/advanced` as the prefix during the deprecation window.
 */
export function registerWmsRoutes(app: FastifyInstance, deps: WmsRouteDeps, prefix = "/wms"): void {
  // 1. Multi-Warehouse & Storage Locations
  app.post(route(prefix, "/warehouses"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createWarehouseSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.topology.createWarehouse(req.actor!, body));
  });
  app.patch(route(prefix, "/warehouses/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateWarehouseSchema.parse(req.body);
    return reply.send(await deps.wms.topology.updateWarehouse(req.actor!, id, body));
  });
  app.get(route(prefix, "/warehouses/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.topology.getWarehouse(req.actor!, id));
  });
  app.get(route(prefix, "/warehouses"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.topology.listWarehouses(req.actor!, {
      siteId: q.siteId,
      organizationUnitIds: q.organizationUnitId ? [q.organizationUnitId] : undefined,
      activeOnly: q.activeOnly === "true",
    }));
  });
  app.post(route(prefix, "/warehouse-locations"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createWarehouseLocationSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.topology.createWarehouseLocation(req.actor!, body));
  });
  app.patch(route(prefix, "/warehouse-locations/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateWarehouseLocationSchema.parse(req.body);
    return reply.send(await deps.wms.topology.updateWarehouseLocation(req.actor!, id, body));
  });
  app.get(route(prefix, "/warehouse-locations/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.topology.getWarehouseLocation(req.actor!, id));
  });
  app.get(route(prefix, "/warehouse-locations"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.topology.listWarehouseLocations(req.actor!, {
      warehouseId: q.warehouseId,
      activeOnly: q.activeOnly === "true",
    }));
  });

  // 2. Batch/Lot & Serial Tracking
  app.post(route(prefix, "/batches"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createItemBatchSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.tracking.createBatch(req.actor!, body));
  });
  app.get(route(prefix, "/batches/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.tracking.getBatch(req.actor!, id));
  });
  app.get(route(prefix, "/batches"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.tracking.listBatches(req.actor!, {
      itemId: q.itemId,
      includeExpired: q.includeExpired === "true",
    }));
  });
  app.post(route(prefix, "/serials"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createItemSerialSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.tracking.createSerial(req.actor!, body));
  });
  app.patch(route(prefix, "/serials/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateItemSerialSchema.parse(req.body);
    return reply.send(await deps.wms.tracking.updateSerial(req.actor!, id, body));
  });
  app.get(route(prefix, "/serials/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.tracking.getSerial(req.actor!, id));
  });
  app.get(route(prefix, "/serials"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.tracking.listSerials(req.actor!, {
      itemId: q.itemId,
      warehouseId: q.warehouseId,
      locationId: q.locationId,
      batchId: q.batchId,
      status: q.status as ScmSerialStatus | undefined,
    }));
  });

  // 3. Stock Balances & Immutable Ledger Movements
  app.get(route(prefix, "/balances"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.ledger.listStockBalances(req.actor!, {
      itemId: q.itemId,
      warehouseId: q.warehouseId,
      locationId: q.locationId,
      batchId: q.batchId,
    }));
  });
  app.post(route(prefix, "/movements"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = recordAdvancedMovementSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.ledger.recordStockMovement(req.actor!, body));
  });
  app.get(route(prefix, "/movements"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.ledger.listStockMovements(req.actor!, {
      itemId: q.itemId,
      warehouseId: q.warehouseId,
      movementType: q.movementType as ScmAdvancedStockMovementType | undefined,
      referenceType: q.referenceType,
      referenceId: q.referenceId,
      limit: q.limit ? Number(q.limit) : undefined,
    }));
  });

  // 4. Reorder Policies & Stock Reservations
  app.put(route(prefix, "/reorder-policies"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = upsertReorderPolicySchema.parse(req.body);
    return reply.send(await deps.wms.reorder.upsertReorderPolicy(req.actor!, body));
  });
  app.get(route(prefix, "/reorder-policies"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.reorder.listReorderPolicies(req.actor!, {
      itemId: q.itemId,
      warehouseId: q.warehouseId,
      activeOnly: q.activeOnly === "true",
    }));
  });
  app.get(route(prefix, "/reorder-alerts"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.reorder.computeReorderAlerts(req.actor!, q.warehouseId));
  });
  app.post(route(prefix, "/reservations"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createStockReservationSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.reorder.createStockReservation(req.actor!, body));
  });
  app.post(route(prefix, "/reservations/:id/fulfill"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.reorder.fulfillStockReservation(req.actor!, id));
  });
  app.post(route(prefix, "/reservations/:id/cancel"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.reorder.cancelStockReservation(req.actor!, id));
  });
  app.get(route(prefix, "/reservations"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.reorder.listStockReservations(req.actor!, {
      itemId: q.itemId,
      warehouseId: q.warehouseId,
      status: q.status as ScmReservationStatus | undefined,
      reservedForType: q.reservedForType,
    }));
  });

  // 5. Stock Transfers & Opnames
  app.post(route(prefix, "/transfers"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createStockTransferSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.transferOpname.createStockTransfer(req.actor!, body));
  });
  app.get(route(prefix, "/transfers/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.transferOpname.getStockTransfer(req.actor!, id));
  });
  app.get(route(prefix, "/transfers"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.transferOpname.listStockTransfers(req.actor!, {
      fromWarehouseId: q.fromWarehouseId,
      toWarehouseId: q.toWarehouseId,
      status: q.status as ScmTransferStatus | undefined,
    }));
  });
  app.post(route(prefix, "/transfers/:id/act"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = actionSchema.parse(req.body);
    return reply.send(await deps.wms.transferOpname.actOnStockTransfer(req.actor!, id, body.actionCode, body.comment ?? undefined));
  });
  app.post(route(prefix, "/transfers/shipments"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = recordTransferShipmentSchema.parse(req.body);
    return reply.send(await deps.wms.transferOpname.recordStockTransferShipment(req.actor!, body));
  });
  app.post(route(prefix, "/transfers/receipts"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = recordTransferReceiptSchema.parse(req.body);
    return reply.send(await deps.wms.transferOpname.recordStockTransferReceipt(req.actor!, body));
  });
  app.post(route(prefix, "/transfers/:id/return-to-draft"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = actionSchema.partial().parse(req.body ?? {});
    return reply.send(await deps.wms.transferOpname.returnStockTransferToDraft(req.actor!, id, body.comment ?? undefined));
  });
  app.post(route(prefix, "/opnames"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createStockOpnameSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.transferOpname.createStockOpname(req.actor!, body));
  });
  app.get(route(prefix, "/opnames/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.transferOpname.getStockOpname(req.actor!, id));
  });
  app.get(route(prefix, "/opnames"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.transferOpname.listStockOpnames(req.actor!, {
      warehouseId: q.warehouseId,
      status: q.status as ScmOpnameStatus | undefined,
    }));
  });
  app.post(route(prefix, "/opnames/counts"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = recordOpnameCountSchema.parse(req.body);
    return reply.send(await deps.wms.transferOpname.recordStockOpnameCount(req.actor!, body));
  });
  app.post(route(prefix, "/opnames/:id/act"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = actionSchema.parse(req.body);
    return reply.send(await deps.wms.transferOpname.actOnStockOpname(req.actor!, id, body.actionCode, body.comment ?? undefined));
  });

  // 6. Valuation & Landed Cost
  app.post(route(prefix, "/valuation-layers"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createValuationLayerSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.valuation.createValuationLayer(req.actor!, body));
  });
  app.post(route(prefix, "/valuation-layers/consume"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = consumeValuationLayerSchema.parse(req.body);
    return reply.send(await deps.wms.valuation.consumeValuationLayer(req.actor!, body));
  });
  app.get(route(prefix, "/valuation-layers"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.valuation.listValuationLayers(req.actor!, {
      itemId: q.itemId,
      warehouseId: q.warehouseId,
    }));
  });
  app.post(route(prefix, "/landed-costs"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createLandedCostSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.valuation.createLandedCost(req.actor!, body));
  });
  app.post(route(prefix, "/landed-costs/:id/apply"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.valuation.applyLandedCost(req.actor!, id));
  });
  app.get(route(prefix, "/landed-costs/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.valuation.getLandedCost(req.actor!, id));
  });
  app.get(route(prefix, "/landed-costs"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.valuation.listLandedCosts(req.actor!, {
      purchaseOrderId: q.purchaseOrderId,
      status: q.status as ScmLandedCostStatus | undefined,
    }));
  });

  // 7. Receiving Records, QC Inspections & Discrepancies
  app.post(route(prefix, "/receiving-records"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createReceivingRecordSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.receiving.createReceivingRecord(req.actor!, body as unknown as CreateScmReceivingRecordInput));
  });
  app.get(route(prefix, "/receiving-records/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.receiving.getReceivingRecord(req.actor!, id));
  });
  app.get(route(prefix, "/receiving-records"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.receiving.listReceivingRecords(req.actor!, {
      purchaseOrderId: q.purchaseOrderId,
      supplierId: q.supplierId,
      warehouseId: q.warehouseId,
      status: q.status as ScmReceivingStatus | undefined,
    }));
  });
  app.post(route(prefix, "/inspections"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createInspectionSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.receiving.createInspection(req.actor!, body as unknown as CreateScmInspectionInput));
  });
  app.get(route(prefix, "/inspections/by-receiving-line/:receivingLineId"), { preHandler: app.authenticate }, async (req, reply) => {
    const { receivingLineId } = z.object({ receivingLineId: z.string().uuid() }).parse(req.params);
    const result = await deps.wms.receiving.getInspectionByReceivingLine(req.actor!, receivingLineId);
    if (!result) {
      return reply.status(404).send({ statusCode: 404, message: "Inspection not found for line" });
    }
    return reply.send(result);
  });
  app.post(route(prefix, "/discrepancies"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createDiscrepancyRecordSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.receiving.createDiscrepancyRecord(req.actor!, body));
  });
  app.patch(route(prefix, "/discrepancies/:id/resolve"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = resolveDiscrepancyRecordSchema.parse(req.body);
    return reply.send(await deps.wms.receiving.resolveDiscrepancyRecord(req.actor!, { discrepancyId: id, ...body }));
  });
  app.get(route(prefix, "/discrepancies"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.receiving.listDiscrepancyRecords(req.actor!, {
      receivingLineId: q.receivingLineId,
      discrepancyType: q.discrepancyType as ScmDiscrepancyType | undefined,
      status: q.status as ScmDiscrepancyStatus | undefined,
    }));
  });

  // 8. Returns, Reversals & Replacement Deliveries
  app.post(route(prefix, "/returns-to-vendor"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createReturnToVendorSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.returns.createReturnToVendor(req.actor!, body as unknown as CreateScmReturnToVendorInput));
  });
  app.get(route(prefix, "/returns-to-vendor/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.returns.getReturnToVendor(req.actor!, id));
  });
  app.get(route(prefix, "/returns-to-vendor"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.returns.listReturnToVendors(req.actor!, {
      supplierId: q.supplierId,
      purchaseOrderId: q.purchaseOrderId,
      warehouseId: q.warehouseId,
      status: q.status as ScmReturnToVendorStatus | undefined,
    }));
  });
  app.post(route(prefix, "/receipt-reversals"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createReceiptReversalSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.returns.createReceiptReversal(req.actor!, body as unknown as CreateScmReceiptReversalInput));
  });
  app.get(route(prefix, "/receipt-reversals/by-receiving-record/:receivingRecordId"), { preHandler: app.authenticate }, async (req, reply) => {
    const { receivingRecordId } = z.object({ receivingRecordId: z.string().uuid() }).parse(req.params);
    const result = await deps.wms.returns.getReceiptReversalByReceivingRecord(req.actor!, receivingRecordId);
    if (!result) {
      return reply.status(404).send({ statusCode: 404, message: "Receipt reversal not found for receiving record" });
    }
    return reply.send(result);
  });
  app.post(route(prefix, "/replacements"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createReplacementDeliverySchema.parse(req.body);
    return reply.status(201).send(await deps.wms.returns.createReplacementDelivery(req.actor!, body as unknown as CreateScmReplacementDeliveryInput));
  });
  app.get(route(prefix, "/replacements/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.returns.getReplacementDelivery(req.actor!, id));
  });
  app.get(route(prefix, "/replacements"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.returns.listReplacementDeliveries(req.actor!, {
      returnToVendorId: q.returnToVendorId,
      supplierId: q.supplierId,
      warehouseId: q.warehouseId,
      status: q.status as ScmReplacementDeliveryStatus | undefined,
    }));
  });

  // 9. Accounting-Ready Events (ADR-0023 outbox)
  app.post(route(prefix, "/accounting-ready-events"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createAccountingReadyEventSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.accountingEvent.createAccountingReadyEvent(req.actor!, body as unknown as CreateScmAccountingReadyEventInput));
  });
  app.get(route(prefix, "/accounting-ready-events/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const event = await deps.wms.accountingEvent.getAccountingReadyEvent(req.actor!, id);
    return reply.send({ event, ...event });
  });
  app.get(route(prefix, "/accounting-ready-events"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.accountingEvent.listAccountingReadyEvents(req.actor!, {
      eventType: q.eventType as ScmAccountingReadyEventType | undefined,
      sourceDocumentType: q.sourceDocumentType,
      sourceDocumentId: q.sourceDocumentId,
      outboxState: q.outboxState as ScmAccountingOutboxState | undefined,
      reconciliationState: q.reconciliationState as ScmAccountingReconciliationState | undefined,
    }));
  });
  app.patch(route(prefix, "/accounting-ready-events/:id/state"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateAccountingReadyEventStateSchema.parse(req.body);
    return reply.send(await deps.wms.accountingEvent.updateAccountingReadyEventState(req.actor!, {
      accountingEventId: id,
      stateKind: body.stateKind,
      toState: body.toState as ScmAccountingOutboxState | ScmAccountingReconciliationState,
      reason: body.reason,
      occurredAt: body.occurredAt,
    }));
  });
  // Preserve the Phase 4 canonical alias while clients migrate to the full name.
  if (prefix === "/wms") {
    app.get("/wms/accounting-events", { preHandler: app.authenticate }, async (req, reply) => {
      const q = query(req.query);
      return reply.send(await deps.wms.accountingEvent.listAccountingReadyEvents(req.actor!, {
        eventType: q.eventType as ScmAccountingReadyEventType | undefined,
        sourceDocumentType: q.sourceDocumentType,
        sourceDocumentId: q.sourceDocumentId,
        outboxState: q.outboxState as ScmAccountingOutboxState | undefined,
        reconciliationState: q.reconciliationState as ScmAccountingReconciliationState | undefined,
      }));
    });
  }

  // 10. Consignment Settlements & Balances
  app.post(route(prefix, "/consignment/consume"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createConsignmentSettlementSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.consignment.createConsignmentSettlement(req.actor!, body as unknown as CreateScmConsignmentSettlementInput));
  });
  app.post(route(prefix, "/consignment/settlements"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createConsignmentSettlementSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.consignment.createConsignmentSettlement(req.actor!, body as unknown as CreateScmConsignmentSettlementInput));
  });
  app.get(route(prefix, "/consignment/settlements/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.consignment.getConsignmentSettlement(req.actor!, id));
  });
  app.get(route(prefix, "/consignment/settlements"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.consignment.listConsignmentSettlements(req.actor!, {
      supplierId: q.supplierId,
      warehouseId: q.warehouseId,
      status: q.status as ScmConsignmentSettlementStatus | undefined,
    }));
  });
  app.get(route(prefix, "/consignment/balances"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.ledger.listStockBalances(req.actor!, {
      warehouseId: q.warehouseId,
      itemId: q.itemId,
      ownerType: "supplier",
      ownerPartyId: q.supplierId,
    }));
  });
  app.get(route(prefix, "/inventory/aging"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.ledger.getInventoryAgingReport(req.actor!, {
      warehouseId: q.warehouseId,
      itemId: q.itemId,
      stockCondition: q.stockCondition as ScmStockCondition | undefined,
      ownerType: q.ownerType as ScmStockOwnerType | undefined,
    }));
  });

  // 11. Governed Inventory Disposal
  app.post(route(prefix, "/disposals"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createInventoryDisposalSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.disposal.createInventoryDisposal(req.actor!, body as unknown as CreateScmInventoryDisposalInput));
  });
  app.get(route(prefix, "/disposals/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.disposal.getInventoryDisposal(req.actor!, id));
  });
  app.get(route(prefix, "/disposals"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.disposal.listInventoryDisposals(req.actor!, {
      warehouseId: q.warehouseId,
      organizationUnitIds: q.organizationUnitId ? [q.organizationUnitId] : undefined,
      disposalType: q.disposalType as ScmDisposalType | undefined,
      status: q.status as ScmDisposalStatus | undefined,
    }));
  });
  app.post(route(prefix, "/disposals/:id/submit"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = commentBodySchema.parse(req.body ?? {});
    return reply.send(await deps.wms.disposal.submitInventoryDisposal(req.actor!, id, body.comment));
  });
  app.post(route(prefix, "/disposals/:id/approve"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = commentBodySchema.parse(req.body ?? {});
    return reply.send(await deps.wms.disposal.approveInventoryDisposal(req.actor!, id, body.comment));
  });

  // 12. Warehouse Execution Tasks
  app.post(route(prefix, "/warehouse-tasks"), { preHandler: app.authenticate }, async (req, reply) => {
    const body = createWarehouseTaskSchema.parse(req.body);
    return reply.status(201).send(await deps.wms.task.createWarehouseTask(req.actor!, body as unknown as CreateScmWarehouseTaskInput));
  });
  app.get(route(prefix, "/warehouse-tasks/:id"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.task.getWarehouseTask(req.actor!, id));
  });
  app.get(route(prefix, "/warehouse-tasks"), { preHandler: app.authenticate }, async (req, reply) => {
    const q = query(req.query);
    return reply.send(await deps.wms.task.listWarehouseTasks(req.actor!, {
      warehouseId: q.warehouseId,
      taskType: q.taskType as ScmWarehouseTaskType | undefined,
      priority: q.priority as ScmWarehouseTaskPriority | undefined,
      status: q.status as ScmWarehouseTaskStatus | undefined,
      assignedTo: q.assignedTo,
      sourceDocumentType: q.sourceDocumentType,
      sourceDocumentId: q.sourceDocumentId,
    }));
  });
  app.patch(route(prefix, "/warehouse-tasks/:id/assign"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const body = assignWarehouseTaskSchema.parse(req.body);
    return reply.send(await deps.wms.task.assignWarehouseTask(req.actor!, id, body.assignedTo));
  });
  app.post(route(prefix, "/warehouse-tasks/:id/complete"), { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    return reply.send(await deps.wms.task.completeWarehouseTask(req.actor!, id));
  });
}
