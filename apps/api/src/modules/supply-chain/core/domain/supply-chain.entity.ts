import type { PoolClient } from "pg";
/**
 * Supply Chain Core — domain types (Phase 4).
 *
 * Built under the frozen target repository architecture
 * (`modules/<module>/core/{domain,application,infrastructure,api}`).
 *
 * Scope discipline: Core answers *what item exists, how much of it, what
 * moved, what was requested/ordered, and from whom*. It contains no
 * warehouse topology, bin/batch/lot/serial, reservation, reorder planning,
 * opname, valuation, RFQ/tender, supplier scoring, or spend analytics —
 * those are Advanced Supply Chain capabilities.
 */

export type MovementType = "in" | "out";

/** Food-grade classification shared by items and warehouses. NULL on either
 * side means unclassified (legacy / unrestricted). See
 * advanced/domain/grade-policy.ts for the matching rules. */
export type ScmGrade = "food" | "non_food";

/** Derived from `convertedPurchaseOrderId` — deliberately not a stored
 * status, so intake bookkeeping never becomes a second lifecycle beside the
 * Workflow Engine (which owns the PR approval lifecycle). */
export type PurchaseOrderState = "draft" | "issued" | "cancelled";

export interface Item {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  unitOfMeasure: string;
  grade: ScmGrade | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Supplier {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  category: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockBalance {
  id: string;
  tenantId: string;
  itemId: string;
  siteId: string | null;
  quantity: number;
  updatedAt: Date;
}

/** Immutable ledger row. Quantity is always positive; direction is the
 * type. A correction is a new compensating movement (SCM-CORE-006). */
export interface StockMovement {
  id: string;
  tenantId: string;
  itemId: string;
  siteId: string | null;
  movementType: MovementType;
  quantity: number;
  reference: string | null;
  note: string | null;
  purchaseOrderId: string | null;
  purchaseOrderLineId: string | null;
  occurredAt: Date;
  createdBy: string | null;
}

export interface PurchaseRequest {
  id: string;
  tenantId: string;
  requestNumber: string;
  organizationUnitId: string | null;
  projectId: string | null;
  siteId: string | null;
  justification: string;
  requiredDate: string | null;
  requestedByUserId: string;
  /** The ONE link to the generic Workflow Engine (SCM-CORE-008). */
  workflowInstanceId: string | null;
  convertedPurchaseOrderId: string | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseRequestLine {
  id: string;
  purchaseRequestId: string;
  itemId: string;
  quantity: number;
  note: string | null;
  sortOrder: number;
}

export interface PurchaseOrder {
  id: string;
  tenantId: string;
  orderNumber: string;
  supplierId: string;
  purchaseRequestId: string | null;
  siteId: string | null;
  currency: string | null;
  orderDate: string | null;
  expectedDate: string | null;
  issuedAt: Date | null;
  issuedByUserId: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseOrderLine {
  id: string;
  purchaseOrderId: string;
  itemId: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitPrice: number | null;
  sortOrder: number;
}

export function purchaseOrderState(order: PurchaseOrder): PurchaseOrderState {
  if (order.cancelledAt) return "cancelled";
  if (order.issuedAt) return "issued";
  return "draft";
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateItemInput {
  tenantId: string;
  code: string;
  name: string;
  description?: string | null;
  category?: string | null;
  unitOfMeasure: string;
  grade?: ScmGrade | null;
  createdBy: string | null;
}

export interface CreateSupplierInput {
  tenantId: string;
  code: string;
  name: string;
  category?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  createdBy: string | null;
}

export interface RecordMovementInput {
  tenantId: string;
  itemId: string;
  siteId: string | null;
  movementType: MovementType;
  quantity: number;
  reference: string | null;
  note: string | null;
  purchaseOrderId?: string | null;
  purchaseOrderLineId?: string | null;
  createdBy: string | null;
}

export interface CreatePurchaseRequestInput {
  tenantId: string;
  requestNumber: string;
  organizationUnitId: string | null;
  projectId: string | null;
  siteId: string | null;
  justification: string;
  requiredDate: string | null;
  requestedByUserId: string;
  createdBy: string | null;
  lines: { itemId: string; quantity: number; note: string | null; sortOrder: number }[];
}

export interface CreatePurchaseOrderInput {
  tenantId: string;
  orderNumber: string;
  supplierId: string;
  purchaseRequestId: string | null;
  siteId: string | null;
  currency: string | null;
  orderDate: string | null;
  expectedDate: string | null;
  createdBy: string | null;
  lines: { itemId: string; quantityOrdered: number; unitPrice: number | null; sortOrder: number }[];
}

// ---------------------------------------------------------------------------
// Repository port
// ---------------------------------------------------------------------------

export interface SupplyChainRepository {
  // --- Item master (SCM-CORE-001) ------------------------------------
  createItem(input: CreateItemInput): Promise<Item>;
  findItemById(id: string): Promise<Item | null>;
  findItemByCode(tenantId: string, code: string): Promise<Item | null>;
  listItems(tenantId: string, filter: { search?: string; isActive?: boolean }): Promise<Item[]>;
  updateItem(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      category?: string | null;
      grade?: ScmGrade | null;
      isActive?: boolean;
    },
    updatedBy: string | null,
    /** Runs inside the transaction that holds `FOR UPDATE` on the item row, before the UPDATE (regrade guard). */
    guard?: (db: Pick<PoolClient, "query">) => Promise<void>,
  ): Promise<Item | null>;

  // --- Supplier master (SCM-CORE-002) --------------------------------
  createSupplier(input: CreateSupplierInput): Promise<Supplier>;
  findSupplierById(id: string): Promise<Supplier | null>;
  findSupplierByCode(tenantId: string, code: string): Promise<Supplier | null>;
  listSuppliers(tenantId: string, filter: { search?: string }): Promise<Supplier[]>;
  updateSupplier(
    id: string,
    input: {
      name?: string;
      category?: string | null;
      contactName?: string | null;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
      isActive?: boolean;
    },
    updatedBy: string | null,
  ): Promise<Supplier | null>;

  // --- Stock (SCM-CORE-003…006) ---------------------------------------
  /**
   * Records the movement AND applies the balance effect inside ONE database
   * transaction. Returns null when an outbound movement would take the
   * balance below zero — the check and the decrement happen in a single
   * atomic statement, so two concurrent issues can never overspend.
   */
  recordMovement(input: RecordMovementInput): Promise<{ movement: StockMovement; balance: StockBalance } | null>;
  listBalances(tenantId: string, filter: { itemId?: string; siteId?: string }): Promise<StockBalance[]>;
  findBalance(tenantId: string, itemId: string, siteId: string | null): Promise<StockBalance | null>;
  listMovements(tenantId: string, filter: { itemId?: string; limit?: number }): Promise<StockMovement[]>;

  // --- Purchase Request (SCM-CORE-007/008/011) ------------------------
  createPurchaseRequest(input: CreatePurchaseRequestInput): Promise<PurchaseRequest>;
  findPurchaseRequestById(id: string): Promise<PurchaseRequest | null>;
  listPurchaseRequests(tenantId: string, filter: { organizationUnitIds?: string[] }): Promise<PurchaseRequest[]>;
  listPurchaseRequestLines(purchaseRequestId: string): Promise<PurchaseRequestLine[]>;
  setPurchaseRequestWorkflowInstance(id: string, workflowInstanceId: string): Promise<void>;
  /** Guarded: a request can convert to an order exactly once. */
  markPurchaseRequestConverted(
    id: string,
    purchaseOrderId: string,
    updatedBy: string | null,
  ): Promise<PurchaseRequest | null>;

  // --- Purchase Order (SCM-CORE-009/010/011) --------------------------
  createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder>;
  findPurchaseOrderById(id: string): Promise<PurchaseOrder | null>;
  listPurchaseOrders(tenantId: string, filter: { supplierId?: string }): Promise<PurchaseOrder[]>;
  listPurchaseOrderLines(purchaseOrderId: string): Promise<PurchaseOrderLine[]>;
  findPurchaseOrderLine(id: string): Promise<PurchaseOrderLine | null>;
  /** Guarded one-way transition: only a draft order can be issued. */
  issuePurchaseOrder(id: string, userId: string): Promise<PurchaseOrder | null>;
  cancelPurchaseOrder(id: string, reason: string | null, updatedBy: string | null): Promise<PurchaseOrder | null>;
  /**
   * Receipt against a purchase order line: writes the goods-in movement,
   * advances quantity_received, and updates the balance in ONE transaction.
   * Returns null when the receipt would exceed the ordered quantity — the
   * over-receipt check is part of the same atomic statement, so concurrent
   * receipts cannot jointly exceed it.
   */
  receiveAgainstPurchaseOrderLine(input: {
    tenantId: string;
    purchaseOrderId: string;
    purchaseOrderLineId: string;
    itemId: string;
    siteId: string | null;
    quantity: number;
    reference: string | null;
    note: string | null;
    createdBy: string | null;
  }): Promise<{ movement: StockMovement; balance: StockBalance; line: PurchaseOrderLine } | null>;

  // --- Cross-domain reads kept behind this port -----------------------
  siteExists(tenantId: string, siteId: string): Promise<boolean>;
  organizationUnitExists(tenantId: string, organizationUnitId: string): Promise<boolean>;
  projectExists(tenantId: string, projectId: string): Promise<boolean>;
}
