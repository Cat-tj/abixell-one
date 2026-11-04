import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../../domain/shared-kernel/errors.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import {
  OPEN_ITEM_SOURCE_TABLES,
  type AgingResult,
  type CreateOpenItemInput,
  type OpenItem,
  type OpenItemAllocation,
  type OpenItemSide,
  type OpenItemWithRemaining,
} from "../domain/open-item.entity.js";
import { PgOpenItemRepository, SettlementError } from "../infrastructure/open-item.repository.pg.js";

/**
 * WP-FIN-A6-02 — AP/AR open-item settlement (ADR-0017).
 *
 * Remaining balances are projections, never columns: every write goes through
 * the repository's transaction+lock path so the eligibility checks and the
 * remaining check happen under the row lock (ADR-0017 §3).
 */
export class OpenItemService {
  constructor(
    private readonly repo: PgOpenItemRepository,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  private unwrap(fn: () => Promise<unknown>): Promise<unknown> {
    // SettlementError carries a closed invariant; map it to the API's
    // conflict shape rather than a 500 so a concurrent over-allocation
    // reads as a refusal, not a crash.
    return fn().catch((err: unknown) => {
      if (err instanceof SettlementError) throw new ConflictError(err.message);
      throw err;
    });
  }

  async createOpenItem(actor: ActorContext, input: Omit<CreateOpenItemInput, "tenantId" | "createdBy">): Promise<OpenItem> {
    await this.rbac.requirePermission(actor, "finance.accounting.configure");
    if (!OPEN_ITEM_SOURCE_TABLES.includes(input.sourceRefTable as never)) {
      throw new ValidationError("sourceRefTable is not an authorized open-item source");
    }
    // AR is owed by a customer, AP is owed to a supplier. Fail closed on a
    // mismatch rather than letting a payment sit on the wrong side.
    const expectedSide = input.partyType === "customer" ? "AR" : "AP";
    if (input.side !== expectedSide) {
      throw new ValidationError(`side must be "${expectedSide}" for a ${input.partyType} party`);
    }
    if (input.direction !== (input.sourceKind === "invoice" || input.sourceKind === "debit_note" ? "debit" : "credit")) {
      throw new ValidationError(
        "direction must be debit for invoice/debit_note and credit for payment/credit_note/down_payment/withholding/unapplied",
      );
    }

    const item = await this.unwrap(() =>
      this.repo.createOpenItem({ ...input, tenantId: actor.tenantId, createdBy: actor.userId }),
    ) as OpenItem;

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.open_item.created",
      entityType: "finance_open_item",
      entityId: item.id,
      metadata: { side: item.side, direction: item.direction, sourceKind: item.sourceKind, originalAmount: item.originalAmount },
    });
    return item;
  }

  async listOpenItems(
    actor: ActorContext,
    filter: { side?: OpenItemSide; partyType?: string; partyId?: string; legalEntityId?: string },
  ): Promise<OpenItemWithRemaining[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listOpenItems(actor.tenantId, filter);
  }

  async getOpenItem(actor: ActorContext, id: string): Promise<OpenItemWithRemaining> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    const item = await this.repo.findOpenItemById(actor.tenantId, id);
    if (!item) throw new NotFoundError("OpenItem", id);
    const remainingAmount = await this.repo.remainingOf(actor.tenantId, id);
    return { ...item, allocatedAmount: "0.0000", remainingAmount };
  }

  async allocate(
    actor: ActorContext,
    input: {
      legalEntityId: string;
      sourceOpenItemId: string;
      targetOpenItemId: string;
      amount: string;
      allocationDate: string;
      idempotencyKey: string;
    },
  ): Promise<OpenItemAllocation> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const allocation = await this.unwrap(() =>
      this.repo.allocate({ ...input, tenantId: actor.tenantId, createdBy: actor.userId }),
    ) as OpenItemAllocation;

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.open_item.allocated",
      entityType: "finance_open_item_allocation",
      entityId: allocation.id,
      metadata: {
        sourceOpenItemId: allocation.sourceOpenItemId,
        targetOpenItemId: allocation.targetOpenItemId,
        amount: allocation.amount,
      },
    });
    return allocation;
  }

  /**
   * AR settlement for a Customer Invoice (Tahap B8): flips the invoice's
   * ar_status to 'settled' once its open item is fully allocated. The check
   * reads the same allocation ledger allocate() writes, so a partially
   * allocated invoice stays 'open' and an over-settle is impossible.
   */
  async settleInvoice(
    actor: ActorContext,
    invoiceId: string,
  ): Promise<{ invoiceId: string; arStatus: string }> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const result = await this.repo.settleInvoice({
      tenantId: actor.tenantId,
      invoiceId,
      actorUserId: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.invoice.settled",
      entityType: "customer_invoice",
      entityId: invoiceId,
      metadata: {},
    });
    return result;
  }

  async reverseAllocation(
    actor: ActorContext,
    allocationId: string,
    input: { reversalReason: string },
  ): Promise<OpenItemAllocation> {
    await this.rbac.requirePermission(actor, "finance.accounting.approve");
    const reason = (input.reversalReason ?? "").trim();
    if (!reason) throw new ValidationError("Reversal reason is required and cannot be empty");

    const allocation = await this.unwrap(() =>
      this.repo.reverseAllocation({
        tenantId: actor.tenantId,
        allocationId,
        reversalReason: reason,
        createdBy: actor.userId,
      }),
    ) as OpenItemAllocation;

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "accounting.open_item.allocation_reversed",
      entityType: "finance_open_item_allocation",
      entityId: allocation.id,
      metadata: { reversesId: allocation.reversesId, reversalReason: allocation.reversalReason },
    });
    return allocation;
  }

  async listAllocations(actor: ActorContext, openItemId: string): Promise<OpenItemAllocation[]> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.listAllocations(actor.tenantId, openItemId);
  }

  /**
   * Historical aging (ADR-0017 §2). Buckets are presentation policy; the
   * underlying projection is the same one settlement uses.
   */
  async aging(
    actor: ActorContext,
    input: { side: OpenItemSide; asOfDate: string; currency: string },
  ): Promise<AgingResult & { unapplied: string }> {
    await this.rbac.requirePermission(actor, "finance.accounting.read");
    return this.repo.aging(actor.tenantId, input.side, input.asOfDate, input.currency);
  }
}
