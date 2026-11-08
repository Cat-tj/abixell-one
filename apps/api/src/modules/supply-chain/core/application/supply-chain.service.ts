import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../../domain/shared-kernel/errors.js";
import type { PoolClient } from "pg";
import type { ItemStockExposurePort } from "../../ports/item-stock-exposure-port.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { EventBus } from "../../../../application/event/event-bus.js";
import type { ConfigurationService } from "../../../../application/configuration/configuration.service.js";
import type { WorkflowService } from "../../../../application/workflow/workflow.service.js";
import type {
  Item,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseRequest,
  PurchaseRequestLine,
  StockBalance,
  StockMovement,
  Supplier,
  SupplyChainRepository,
} from "../domain/supply-chain.entity.js";
import { purchaseOrderState } from "../domain/supply-chain.entity.js";
import type { ScmGrade } from "../domain/supply-chain.entity.js";

/** Tenant Configuration codes this module expects. */
export const PURCHASE_REQUEST_NUMBERING_CODE = "purchase_request";
export const PURCHASE_ORDER_NUMBERING_CODE = "purchase_order";
export const PURCHASE_REQUEST_WORKFLOW_DEFINITION_CODE = "purchase_request_approval";

/** Workflow action code → domain event name. The Step graph is Tenant
 * Configuration; this only names the events the chosen action codes publish. */
const ACTION_EVENT_MAP: Record<string, string> = {
  submit: "supply_chain.purchase_request.submitted",
  approve: "supply_chain.purchase_request.approved",
  reject: "supply_chain.purchase_request.rejected",
  cancel: "supply_chain.purchase_request.cancelled",
};

export interface PurchaseRequestDetailView {
  request: PurchaseRequest;
  lines: PurchaseRequestLine[];
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
}

export interface PurchaseOrderDetailView {
  order: PurchaseOrder;
  lines: PurchaseOrderLine[];
  supplier: Supplier | null;
  state: string;
}

/**
 * Supply Chain Core (Phase 4, SCM-CORE-001…013).
 *
 * Answers: what item exists, how much of it, what moved in and out, what was
 * requested, what was ordered, and from which supplier.
 *
 * Architectural constraints honoured here:
 * - **Operational quantity, not accounting inventory.** No valuation, cost
 *   layers, AP, or GL posting. Purchase order price is procurement data only.
 * - **Movements are authoritative.** Every quantity change writes an
 *   immutable movement AND applies the balance effect in one transaction;
 *   corrections are compensating movements, never edits (SCM-CORE-006).
 * - **Concurrency safety.** Sufficiency and over-receipt checks live inside
 *   the mutating SQL statement, so concurrent operations cannot overspend
 *   stock or over-receive an order.
 * - **Workflow owns PR approval** (SCM-CORE-008); a Purchase Order uses a
 *   one-way issued transition with line immutability rather than a second
 *   state machine.
 * - **No Advanced SCM.** No warehouse/bin topology, batch/lot/serial,
 *   reservation, reorder planning, opname, RFQ/tender, supplier scoring, or
 *   spend analytics.
 */
export class SupplyChainService {
  constructor(
    private readonly repo: SupplyChainRepository,
    private readonly workflow: WorkflowService,
    private readonly configuration: ConfigurationService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly eventBus: EventBus,
    /** WMS stock exposure ACL (optional so unit tests may omit it). */
    private readonly itemStockExposure?: ItemStockExposurePort,
  ) {}

  // ===================================================================
  // Item master — SCM-CORE-001
  // ===================================================================

  async createItem(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      description?: string | null;
      category?: string | null;
      unitOfMeasure: string;
      grade?: ScmGrade | null;
    },
  ): Promise<Item> {
    await this.rbac.requirePermission(actor, "supply_chain.configure");
    const existing = await this.repo.findItemByCode(actor.tenantId, input.code);
    if (existing) throw new ConflictError("Item code already exists: " + input.code);

    const item = await this.repo.createItem({
      tenantId: actor.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      unitOfMeasure: input.unitOfMeasure,
      grade: input.grade ?? null,
      createdBy: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.item.created",
      entityType: "item",
      entityId: item.id,
      metadata: { code: item.code, unitOfMeasure: item.unitOfMeasure },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "supply_chain.item.created",
      entityType: "item",
      entityId: item.id,
      payload: { code: item.code, targetUserId: actor.userId },
      createdBy: actor.userId,
    });
    return item;
  }

  async listItems(actor: ActorContext, filter: { search?: string; activeOnly?: boolean } = {}): Promise<Item[]> {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    return this.repo.listItems(actor.tenantId, {
      search: filter.search,
      isActive: filter.activeOnly ? true : undefined,
    });
  }

  async getItem(actor: ActorContext, code: string): Promise<{ item: Item; balances: StockBalance[] }> {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    const item = await this.getItemByCodeOrThrow(actor, code);
    return { item, balances: await this.repo.listBalances(actor.tenantId, { itemId: item.id }) };
  }

  async updateItem(
    actor: ActorContext,
    code: string,
    input: {
      name?: string;
      description?: string | null;
      category?: string | null;
      grade?: ScmGrade | null;
      isActive?: boolean;
    },
  ): Promise<Item> {
    await this.rbac.requirePermission(actor, "supply_chain.configure");
    const item = await this.getItemByCodeOrThrow(actor, code);
    // Re-grading must not strand on-hand stock inside a warehouse of the other
    // grade (every movement out of it would then fail GRADE_MISMATCH). The check
    // runs under the item row lock, via the WMS ACL port.
    const newGrade = input.grade;
    const guard =
      newGrade && newGrade !== item.grade && this.itemStockExposure
        ? async (db: Pick<PoolClient, "query">) => {
            const conflicts = await this.itemStockExposure!.listConflictingWarehouses(
              db,
              actor.tenantId,
              item.id,
              newGrade,
            );
            if (conflicts.length > 0) {
              throw new ConflictError(
                `Cannot set item ${item.code} to ${newGrade}: it has stock in ${conflicts[0]!.warehouseGrade} warehouse ${conflicts[0]!.warehouseCode}`,
                "GRADE_MISMATCH",
              );
            }
          }
        : undefined;
    const updated = await this.repo.updateItem(item.id, input, actor.userId, guard);
    if (!updated) throw new NotFoundError("Item", code);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.item.updated",
      entityType: "item",
      entityId: item.id,
      metadata: { fields: Object.keys(input) },
    });
    return updated!;
  }

  // ===================================================================
  // Supplier master — SCM-CORE-002
  // ===================================================================

  async createSupplier(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      category?: string | null;
      contactName?: string | null;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
    },
  ): Promise<Supplier> {
    await this.rbac.requirePermission(actor, "supply_chain.configure");
    const existing = await this.repo.findSupplierByCode(actor.tenantId, input.code);
    if (existing) throw new ConflictError("Supplier code already exists: " + input.code);

    const supplier = await this.repo.createSupplier({ tenantId: actor.tenantId, ...input, createdBy: actor.userId });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.supplier.created",
      entityType: "supplier",
      entityId: supplier.id,
      metadata: { code: supplier.code },
    });
    return supplier;
  }

  async listSuppliers(actor: ActorContext, filter: { search?: string } = {}): Promise<Supplier[]> {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    return this.repo.listSuppliers(actor.tenantId, filter);
  }

  async updateSupplier(
    actor: ActorContext,
    code: string,
    input: {
      name?: string;
      category?: string | null;
      contactName?: string | null;
      email?: string | null;
      phone?: string | null;
      address?: string | null;
      isActive?: boolean;
    },
  ): Promise<Supplier> {
    await this.rbac.requirePermission(actor, "supply_chain.configure");
    const supplier = await this.repo.findSupplierByCode(actor.tenantId, code);
    if (!supplier) throw new NotFoundError("Supplier", code);
    const updated = await this.repo.updateSupplier(supplier.id, input, actor.userId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.supplier.updated",
      entityType: "supplier",
      entityId: supplier.id,
      metadata: { fields: Object.keys(input) },
    });
    return updated!;
  }

  // ===================================================================
  // Stock — SCM-CORE-003/004/005/006
  // ===================================================================

  /** Goods received without a purchase order (e.g. opening balance, direct
   * receipt). Receiving AGAINST an order goes through `receiveAgainstOrder`. */
  async recordGoodsIn(
    actor: ActorContext,
    input: { itemCode: string; siteId?: string | null; quantity: number; reference?: string | null; note?: string | null },
  ): Promise<{ movement: StockMovement; balance: StockBalance }> {
    await this.rbac.requirePermission(actor, "supply_chain.stock.manage");
    const item = await this.getActiveItemOrThrow(actor, input.itemCode);
    const siteId = await this.resolveSite(actor, input.siteId ?? null);
    const quantity = this.parseQuantity(input.quantity);

    const result = await this.repo.recordMovement({
      tenantId: actor.tenantId,
      itemId: item.id,
      siteId,
      movementType: "in",
      quantity,
      reference: input.reference ?? null,
      note: input.note ?? null,
      createdBy: actor.userId,
    });
    if (!result) throw new ConflictError("Could not apply the stock movement");

    await this.auditMovement(actor, "supply_chain.stock.received", item, result, siteId);
    return result;
  }

  /**
   * Goods issued/consumed. The Core rule is that stock may not go negative:
   * the sufficiency check is part of the atomic decrement, so a concurrent
   * pair of issues can never jointly overspend the balance.
   */
  async recordGoodsOut(
    actor: ActorContext,
    input: { itemCode: string; siteId?: string | null; quantity: number; reference?: string | null; note?: string | null },
  ): Promise<{ movement: StockMovement; balance: StockBalance }> {
    await this.rbac.requirePermission(actor, "supply_chain.stock.manage");
    const item = await this.getActiveItemOrThrow(actor, input.itemCode);
    const siteId = await this.resolveSite(actor, input.siteId ?? null);
    const quantity = this.parseQuantity(input.quantity);

    const result = await this.repo.recordMovement({
      tenantId: actor.tenantId,
      itemId: item.id,
      siteId,
      movementType: "out",
      quantity,
      reference: input.reference ?? null,
      note: input.note ?? null,
      createdBy: actor.userId,
    });
    if (!result) {
      const current = await this.repo.findBalance(actor.tenantId, item.id, siteId);
      throw new ConflictError(
        "Insufficient stock: available " + (current?.quantity ?? 0) + ", requested " + quantity,
      );
    }

    await this.auditMovement(actor, "supply_chain.stock.issued", item, result, siteId);
    return result;
  }

  async listBalances(actor: ActorContext, filter: { itemCode?: string; siteId?: string } = {}) {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    let itemId: string | undefined;
    if (filter.itemCode) itemId = (await this.getItemByCodeOrThrow(actor, filter.itemCode)).id;
    return this.repo.listBalances(actor.tenantId, { itemId, siteId: filter.siteId });
  }

  async listMovements(actor: ActorContext, filter: { itemCode?: string; limit?: number } = {}) {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    let itemId: string | undefined;
    if (filter.itemCode) itemId = (await this.getItemByCodeOrThrow(actor, filter.itemCode)).id;
    return this.repo.listMovements(actor.tenantId, { itemId, limit: filter.limit });
  }

  // ===================================================================
  // Purchase Request — SCM-CORE-007/008/011
  // ===================================================================

  async createPurchaseRequest(
    actor: ActorContext,
    input: {
      organizationUnitId?: string | null;
      projectId?: string | null;
      siteId?: string | null;
      justification: string;
      requiredDate?: string | null;
      lines: { itemCode: string; quantity: number; note?: string | null }[];
    },
  ): Promise<PurchaseRequestDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.manage");
    if (!input.lines || input.lines.length === 0) {
      throw new ValidationError("A purchase request needs at least one line");
    }

    const organizationUnitId = await this.resolveOrganizationUnit(actor, input.organizationUnitId ?? null);
    const projectId = await this.resolveProject(actor, input.projectId ?? null);
    const siteId = await this.resolveSite(actor, input.siteId ?? null);

    const lines = [];
    let sortOrder = 0;
    for (const line of input.lines) {
      const item = await this.getActiveItemOrThrow(actor, line.itemCode);
      lines.push({
        itemId: item.id,
        quantity: this.parseQuantity(line.quantity),
        note: line.note ?? null,
        sortOrder: sortOrder++,
      });
    }

    const { number } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      PURCHASE_REQUEST_NUMBERING_CODE,
      actor.userId,
    );

    const request = await this.repo.createPurchaseRequest({
      tenantId: actor.tenantId,
      requestNumber: number,
      organizationUnitId,
      projectId,
      siteId,
      justification: input.justification,
      requiredDate: this.parseDate(input.requiredDate, "requiredDate"),
      requestedByUserId: actor.userId,
      createdBy: actor.userId,
      lines,
    });

    // Lifecycle belongs to the configured Workflow Definition (SCM-CORE-008).
    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: PURCHASE_REQUEST_WORKFLOW_DEFINITION_CODE,
      entityId: request.id,
      contextData: { organizationUnitId, projectId, siteId, lineCount: lines.length },
    });
    await this.repo.setPurchaseRequestWorkflowInstance(request.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.purchase_request.created",
      entityType: "purchase_request",
      entityId: request.id,
      metadata: { requestNumber: number, lineCount: lines.length, organizationUnitId },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "supply_chain.purchase_request.created",
      entityType: "purchase_request",
      entityId: request.id,
      payload: { requestNumber: number, targetUserId: actor.userId },
      createdBy: actor.userId,
    });

    return this.getPurchaseRequest(actor, request.id);
  }

  async listPurchaseRequests(actor: ActorContext): Promise<PurchaseRequest[]> {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    const requests = await this.repo.listPurchaseRequests(actor.tenantId, {});
    return this.filterByOrganizationScope(actor, requests);
  }

  async getPurchaseRequest(actor: ActorContext, id: string): Promise<PurchaseRequestDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    const request = await this.getAuthorizedRequest(actor, id);
    const lines = await this.repo.listPurchaseRequestLines(request.id);

    let status: PurchaseRequestDetailView["status"] = null;
    let availableActions: PurchaseRequestDetailView["availableActions"] = [];
    if (request.workflowInstanceId) {
      const s = await this.workflow.getEntityStatus(actor, request.workflowInstanceId);
      status = { stepCode: s.stepCode, stepName: s.stepName, instanceStatus: s.instanceStatus };
      const view = await this.workflow.getEntityWorkflowView(actor, request.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }
    return { request, lines, status, availableActions };
  }

  /** Generic lifecycle dispatch: this service never encodes the Step graph —
   * it forwards the action code and lets the Workflow Engine validate it. */
  async actOnPurchaseRequest(actor: ActorContext, id: string, actionCode: string, comment: string | null) {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    const request = await this.getAuthorizedRequest(actor, id);
    if (!request.workflowInstanceId) throw new ConflictError("This request has no active Workflow Instance");

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      request.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this request");

    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    const eventType = ACTION_EVENT_MAP[actionCode] ?? "supply_chain.purchase_request.status_changed";
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: eventType,
      entityType: "purchase_request",
      entityId: request.id,
      metadata: { actionCode, comment },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType,
      entityType: "purchase_request",
      entityId: request.id,
      payload: { requestNumber: request.requestNumber, actionCode, targetUserId: request.requestedByUserId },
      createdBy: actor.userId,
    });
    return { request: (await this.repo.findPurchaseRequestById(request.id))!, workflowResult: result };
  }

  // ===================================================================
  // Purchase Order — SCM-CORE-009/010/011
  // ===================================================================

  /** Create an order, optionally from an APPROVED purchase request
   * (SCM-CORE-009). A request converts exactly once. */
  async createPurchaseOrder(
    actor: ActorContext,
    input: {
      supplierCode: string;
      purchaseRequestId?: string | null;
      siteId?: string | null;
      currency?: string | null;
      orderDate?: string | null;
      expectedDate?: string | null;
      lines?: { itemCode: string; quantity: number; unitPrice?: number | null }[];
    },
  ): Promise<PurchaseOrderDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.manage");
    const supplier = await this.repo.findSupplierByCode(actor.tenantId, input.supplierCode);
    if (!supplier) throw new NotFoundError("Supplier", input.supplierCode);
    if (!supplier.isActive) throw new ConflictError("Supplier is not active: " + input.supplierCode);

    let request: PurchaseRequest | null = null;
    let lines: { itemId: string; quantityOrdered: number; unitPrice: number | null; sortOrder: number }[] = [];

    if (input.purchaseRequestId) {
      request = await this.getAuthorizedRequest(actor, input.purchaseRequestId);
      if (request.convertedPurchaseOrderId) {
        throw new ConflictError("This purchase request has already produced a purchase order");
      }
      await this.assertRequestApproved(actor, request);
      const requestLines = await this.repo.listPurchaseRequestLines(request.id);
      const priceByItem = new Map<string, number | null>();
      for (const line of input.lines ?? []) {
        const item = await this.getActiveItemOrThrow(actor, line.itemCode);
        priceByItem.set(item.id, line.unitPrice ?? null);
      }
      lines = requestLines.map((line, index) => ({
        itemId: line.itemId,
        quantityOrdered: line.quantity,
        unitPrice: priceByItem.get(line.itemId) ?? null,
        sortOrder: index,
      }));
    } else {
      if (!input.lines || input.lines.length === 0) {
        throw new ValidationError("A purchase order needs at least one line");
      }
      let sortOrder = 0;
      for (const line of input.lines) {
        const item = await this.getActiveItemOrThrow(actor, line.itemCode);
        lines.push({
          itemId: item.id,
          quantityOrdered: this.parseQuantity(line.quantity),
          unitPrice: line.unitPrice ?? null,
          sortOrder: sortOrder++,
        });
      }
    }

    const siteId = await this.resolveSite(actor, input.siteId ?? request?.siteId ?? null);
    const { number } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      PURCHASE_ORDER_NUMBERING_CODE,
      actor.userId,
    );

    const order = await this.repo.createPurchaseOrder({
      tenantId: actor.tenantId,
      orderNumber: number,
      supplierId: supplier.id,
      purchaseRequestId: request?.id ?? null,
      siteId,
      currency: input.currency ?? null,
      orderDate: this.parseDate(input.orderDate, "orderDate"),
      expectedDate: this.parseDate(input.expectedDate, "expectedDate"),
      createdBy: actor.userId,
      lines,
    });

    if (request) {
      const converted = await this.repo.markPurchaseRequestConverted(request.id, order.id, actor.userId);
      if (!converted) throw new ConflictError("This purchase request has already produced a purchase order");
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.purchase_order.created",
      entityType: "purchase_order",
      entityId: order.id,
      metadata: { orderNumber: number, supplierId: supplier.id, purchaseRequestId: request?.id ?? null },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "supply_chain.purchase_order.created",
      entityType: "purchase_order",
      entityId: order.id,
      payload: { orderNumber: number, supplierId: supplier.id, targetUserId: actor.userId },
      createdBy: actor.userId,
    });

    return this.getPurchaseOrder(actor, order.id);
  }

  async listPurchaseOrders(actor: ActorContext): Promise<PurchaseOrder[]> {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    return this.repo.listPurchaseOrders(actor.tenantId, {});
  }

  async getPurchaseOrder(actor: ActorContext, id: string): Promise<PurchaseOrderDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.read");
    const order = await this.getAuthorizedOrder(actor, id);
    const [lines, supplier] = await Promise.all([
      this.repo.listPurchaseOrderLines(order.id),
      this.repo.findSupplierById(order.supplierId),
    ]);
    return { order, lines, supplier, state: purchaseOrderState(order) };
  }

  /** One-way commitment. After issue the order's lines are immutable and it
   * can be received against (SCM-CORE-010). */
  async issuePurchaseOrder(actor: ActorContext, id: string): Promise<PurchaseOrderDetailView> {
    await this.rbac.requirePermission(actor, "supply_chain.manage");
    const order = await this.getAuthorizedOrder(actor, id);
    const issued = await this.repo.issuePurchaseOrder(order.id, actor.userId);
    if (!issued) throw new ConflictError("Only a draft purchase order can be issued");

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.purchase_order.issued",
      entityType: "purchase_order",
      entityId: order.id,
      metadata: { orderNumber: order.orderNumber },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "supply_chain.purchase_order.issued",
      entityType: "purchase_order",
      entityId: order.id,
      payload: { orderNumber: order.orderNumber, supplierId: order.supplierId, targetUserId: actor.userId },
      createdBy: actor.userId,
    });
    return this.getPurchaseOrder(actor, order.id);
  }

  async cancelPurchaseOrder(actor: ActorContext, id: string, reason: string | null): Promise<PurchaseOrder> {
    await this.rbac.requirePermission(actor, "supply_chain.manage");
    const order = await this.getAuthorizedOrder(actor, id);
    const lines = await this.repo.listPurchaseOrderLines(order.id);
    if (lines.some((l) => l.quantityReceived > 0)) {
      throw new ConflictError("A purchase order with received quantity cannot be cancelled");
    }
    const cancelled = await this.repo.cancelPurchaseOrder(order.id, reason, actor.userId);
    if (!cancelled) throw new ConflictError("This purchase order is already cancelled");

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.purchase_order.cancelled",
      entityType: "purchase_order",
      entityId: order.id,
      metadata: { reason },
    });
    return cancelled;
  }

  /**
   * Receive against a purchase order line (SCM-CORE-010). Writes the
   * goods-in movement, advances the received quantity, and updates the
   * balance atomically. Over-receipt is rejected by the same statement that
   * advances the quantity, so concurrent receipts cannot jointly exceed the
   * ordered amount.
   */
  async receiveAgainstOrder(
    actor: ActorContext,
    orderId: string,
    input: { lineId: string; quantity: number; note?: string | null },
  ): Promise<{ movement: StockMovement; balance: StockBalance; line: PurchaseOrderLine }> {
    await this.rbac.requirePermission(actor, "supply_chain.stock.manage");
    const order = await this.getAuthorizedOrder(actor, orderId);
    if (!order.issuedAt) throw new ConflictError("Only an issued purchase order can be received against");
    if (order.cancelledAt) throw new ConflictError("This purchase order is cancelled");

    const line = await this.repo.findPurchaseOrderLine(input.lineId);
    if (!line || line.purchaseOrderId !== order.id) {
      throw new NotFoundError("PurchaseOrderLine", input.lineId);
    }
    const quantity = this.parseQuantity(input.quantity);

    const result = await this.repo.receiveAgainstPurchaseOrderLine({
      tenantId: actor.tenantId,
      purchaseOrderId: order.id,
      purchaseOrderLineId: line.id,
      itemId: line.itemId,
      siteId: order.siteId,
      quantity,
      reference: order.orderNumber,
      note: input.note ?? null,
      createdBy: actor.userId,
    });
    if (!result) {
      const outstanding = line.quantityOrdered - line.quantityReceived;
      throw new ConflictError(
        "Receipt exceeds the ordered quantity: outstanding " + outstanding + ", received " + quantity,
      );
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "supply_chain.stock.received",
      entityType: "stock_movement",
      entityId: result.movement.id,
      metadata: {
        orderNumber: order.orderNumber,
        purchaseOrderLineId: line.id,
        quantity,
        balance: result.balance.quantity,
      },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "supply_chain.stock.received",
      entityType: "stock_movement",
      entityId: result.movement.id,
      payload: { orderNumber: order.orderNumber, quantity, targetUserId: actor.userId },
      createdBy: actor.userId,
    });
    return result;
  }

  /** Document Core authorization hook — purchase documents inherit the
   * order's own tenant-scoped authorization (ADR-0012). */
  async canAccessOrderForDocument(actor: ActorContext, orderId: string): Promise<boolean> {
    const order = await this.repo.findPurchaseOrderById(orderId);
    if (!order || order.tenantId !== actor.tenantId) return false;
    const permissions = await this.rbac.getActivePermissions(actor);
    return permissions.has("supply_chain.read");
  }

  async canAccessRequestForDocument(actor: ActorContext, requestId: string): Promise<boolean> {
    const request = await this.repo.findPurchaseRequestById(requestId);
    if (!request || request.tenantId !== actor.tenantId) return false;
    const permissions = await this.rbac.getActivePermissions(actor);
    if (!permissions.has("supply_chain.read")) return false;
    return this.isWithinOrganizationScope(actor, request.organizationUnitId);
  }

  // ===================================================================
  // Internals
  // ===================================================================

  private async auditMovement(
    actor: ActorContext,
    action: string,
    item: Item,
    result: { movement: StockMovement; balance: StockBalance },
    siteId: string | null,
  ): Promise<void> {
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action,
      entityType: "stock_movement",
      entityId: result.movement.id,
      metadata: { itemCode: item.code, quantity: result.movement.quantity, siteId, balance: result.balance.quantity },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: action,
      entityType: "stock_movement",
      entityId: result.movement.id,
      payload: { itemCode: item.code, quantity: result.movement.quantity, targetUserId: actor.userId },
      createdBy: actor.userId,
    });
  }

  private parseQuantity(value: number): number {
    if (typeof value !== "number" || Number.isNaN(value)) throw new ValidationError("quantity must be a number");
    if (value <= 0) throw new ValidationError("quantity must be greater than zero");
    return value;
  }

  private parseDate(value: string | null | undefined, field: string): string | null {
    if (value === null || value === undefined || value === "") return null;
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      if (Number.isNaN(new Date(trimmed + "T00:00:00Z").getTime())) {
        throw new ValidationError(field + " is not a valid date");
      }
      return trimmed;
    }
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) throw new ValidationError(field + " is not a valid date");
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private async getItemByCodeOrThrow(actor: ActorContext, code: string): Promise<Item> {
    const item = await this.repo.findItemByCode(actor.tenantId, code);
    if (!item) throw new NotFoundError("Item", code);
    return item;
  }

  private async getActiveItemOrThrow(actor: ActorContext, code: string): Promise<Item> {
    const item = await this.getItemByCodeOrThrow(actor, code);
    if (!item.isActive) throw new ConflictError("Item is not active: " + code);
    return item;
  }

  private async resolveSite(actor: ActorContext, siteId: string | null): Promise<string | null> {
    if (!siteId) return null;
    if (!(await this.repo.siteExists(actor.tenantId, siteId))) throw new NotFoundError("Site", siteId);
    return siteId;
  }

  private async resolveOrganizationUnit(actor: ActorContext, unitId: string | null): Promise<string | null> {
    if (!unitId) return null;
    if (!(await this.repo.organizationUnitExists(actor.tenantId, unitId))) {
      throw new NotFoundError("OrganizationUnit", unitId);
    }
    await this.rbac.requireOrganizationUnitScopeForActor(actor, unitId);
    return unitId;
  }

  private async resolveProject(actor: ActorContext, projectId: string | null): Promise<string | null> {
    if (!projectId) return null;
    if (!(await this.repo.projectExists(actor.tenantId, projectId))) throw new NotFoundError("Project", projectId);
    return projectId;
  }

  private async assertRequestApproved(actor: ActorContext, request: PurchaseRequest): Promise<void> {
    if (!request.workflowInstanceId) {
      throw new ConflictError("This purchase request has no workflow instance");
    }
    const status = await this.workflow.getEntityStatus(actor, request.workflowInstanceId);
    if (status.instanceStatus !== "approved") {
      throw new ConflictError(
        "Only an approved purchase request can produce a purchase order (is '" + status.instanceStatus + "')",
      );
    }
  }

  private async getAuthorizedRequest(actor: ActorContext, id: string): Promise<PurchaseRequest> {
    const request = await this.repo.findPurchaseRequestById(id);
    if (!request || request.tenantId !== actor.tenantId) throw new NotFoundError("PurchaseRequest", id);
    if (!(await this.isWithinOrganizationScope(actor, request.organizationUnitId))) {
      throw new ForbiddenError("Your assigned Data Scope does not cover this purchase request");
    }
    return request;
  }

  private async getAuthorizedOrder(actor: ActorContext, id: string): Promise<PurchaseOrder> {
    const order = await this.repo.findPurchaseOrderById(id);
    if (!order || order.tenantId !== actor.tenantId) throw new NotFoundError("PurchaseOrder", id);
    return order;
  }

  /** A record with no Organization Unit is tenant-level; one placed in a unit
   * is visible only within that unit's hierarchical scope (SCM-CORE-012). */
  private async isWithinOrganizationScope(actor: ActorContext, unitId: string | null): Promise<boolean> {
    if (!unitId) return true;
    return this.rbac.isActiveOrganizationUnitScopeCovered(actor, unitId);
  }

  private async filterByOrganizationScope(
    actor: ActorContext,
    requests: PurchaseRequest[],
  ): Promise<PurchaseRequest[]> {
    if (await this.rbac.hasTenantScope(actor)) return requests;
    const decisions = new Map<string, boolean>();
    const allowed: PurchaseRequest[] = [];
    for (const request of requests) {
      if (!request.organizationUnitId) {
        allowed.push(request);
        continue;
      }
      let ok = decisions.get(request.organizationUnitId);
      if (ok === undefined) {
        ok = await this.rbac.isActiveOrganizationUnitScopeCovered(actor, request.organizationUnitId);
        decisions.set(request.organizationUnitId, ok);
      }
      if (ok) allowed.push(request);
    }
    return allowed;
  }
}
