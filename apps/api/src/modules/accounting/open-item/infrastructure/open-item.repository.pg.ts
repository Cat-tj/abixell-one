import type { Pool, PoolClient } from "pg";
import { ConflictError, NotFoundError } from "../../../../domain/shared-kernel/errors.js";
import {
  type AllocateInput,
  type AgingBucket,
  type AgingResult,
  type CreateOpenItemInput,
  type OpenItem,
  type OpenItemAllocation,
  type OpenItemDirection,
  type OpenItemSide,
  type OpenItemWithRemaining,
  type ReverseAllocationInput,
  addAmounts,
  daysOverdue,
  DEFAULT_AGING_BUCKETS,
  fromUnits,
  projectRemaining,
  toUnits,
} from "../domain/open-item.entity.js";

type Row = Record<string, unknown>;

/**
 * Postgres `date` columns arrive as Date objects, not strings. Reformat to
 * YYYY-MM-DD without a timezone shift (the value is already a calendar date).
 */
function toDateStr(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/**
 * Allocated total for one open item, signed so a reversal cancels the row it
 * reverses (ADR-0017 §3: reversal is compensating history, never a delete).
 * A reversal keeps the same source/target pair as its original and carries
 * `reverses_id`, so the sum nets back to zero and the derived remaining
 * returns to its pre-settlement value.
 */
const ALLOCATED_EXPR = `
  COALESCE(SUM(CASE WHEN al.reverses_id IS NULL THEN al.amount ELSE -al.amount END), 0)::text`;

function toOpenItem(row: Row): OpenItem {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    legalEntityId: row.legal_entity_id as string,
    side: row.side as OpenItemSide,
    direction: row.direction as OpenItemDirection,
    sourceKind: row.source_kind as OpenItem["sourceKind"],
    sourceRefTable: row.source_ref_table as string,
    sourceRefId: row.source_ref_id as string,
    partyType: row.party_type as OpenItem["partyType"],
    partyId: row.party_id as string,
    documentNo: row.document_no as string,
    documentDate: toDateStr(row.document_date),
    dueDate: row.due_date ? toDateStr(row.due_date) : null,
    currency: row.currency as string,
    originalAmount: String(row.original_amount),
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function toAllocation(row: Row): OpenItemAllocation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    sourceOpenItemId: row.source_open_item_id as string,
    targetOpenItemId: row.target_open_item_id as string,
    amount: String(row.amount),
    currency: row.currency as string,
    allocationDate: toDateStr(row.allocation_date),
    idempotencyKey: row.idempotency_key as string,
    reversesId: (row.reverses_id as string | null) ?? null,
    reversalReason: (row.reversal_reason as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

/** Thrown when a settlement write violates a closed invariant. */
export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

export class PgOpenItemRepository {
  constructor(private readonly pool: Pool) {}

  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async allocatedOf(client: PoolClient | Pool, tenantId: string, itemId: string): Promise<bigint> {
    const r = await client.query(
      `SELECT ${ALLOCATED_EXPR} AS allocated
         FROM finance_open_item_allocations al
        WHERE al.tenant_id = $1
          AND (al.source_open_item_id = $2 OR al.target_open_item_id = $2)`,
      [tenantId, itemId],
    );
    return toUnits(String(r.rows[0].allocated)) ?? 0n;
  }

  /**
   * Settle a Customer Invoice (Tahap B8). 'Settled' means the invoice's
   * AR open item is fully allocated (no remaining amount). Runs inside one
   * transaction with the open-item row locked, mirroring allocate()'s
   * concurrency posture.
   */
  async settleInvoice(input: {
    tenantId: string;
    invoiceId: string;
    actorUserId: string;
  }): Promise<{ invoiceId: string; arStatus: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inv = await client.query(
        `SELECT id, ar_status FROM customer_invoices
          WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.invoiceId, input.tenantId],
      );
      if (!inv.rows[0]) {
        await client.query("ROLLBACK");
        throw new NotFoundError("CustomerInvoice", input.invoiceId);
      }
      if (inv.rows[0].ar_status === "settled") {
        await client.query("COMMIT");
        return { invoiceId: input.invoiceId, arStatus: "settled" };
      }
      if (inv.rows[0].ar_status !== "open") {
        await client.query("ROLLBACK");
        throw new ConflictError("Only an open invoice can be settled");
      }
      const oi = await client.query(
        `SELECT oi.id, oi.original_amount,
                (SELECT COALESCE(SUM(CASE WHEN al.reverses_id IS NULL THEN al.amount ELSE -al.amount END), 0)::text
                   FROM finance_open_item_allocations al
                  WHERE al.tenant_id = oi.tenant_id
                    AND (al.source_open_item_id = oi.id OR al.target_open_item_id = oi.id)) AS allocated
           FROM finance_open_items oi
          WHERE oi.tenant_id = $1 AND oi.source_ref_table = 'customer_invoices'
            AND oi.source_ref_id = $2
          FOR UPDATE OF oi`,
        [input.tenantId, input.invoiceId],
      );
      if (!oi.rows[0]) {
        await client.query("ROLLBACK");
        throw new ConflictError("No AR open item exists for this invoice");
      }
      const original = toUnits(String(oi.rows[0].original_amount)) ?? 0n;
      const allocated = toUnits(String(oi.rows[0].allocated)) ?? 0n;
      if (allocated < original) {
        await client.query("ROLLBACK");
        throw new ConflictError("Invoice is not fully allocated yet — allocate payments first");
      }
      const upd = await client.query(
        `UPDATE customer_invoices SET ar_status = 'settled', updated_at = now()
          WHERE id = $1 AND tenant_id = $2 RETURNING ar_status`,
        [input.invoiceId, input.tenantId],
      );
      await client.query("COMMIT");
      return { invoiceId: input.invoiceId, arStatus: upd.rows[0].ar_status };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Idempotent intake: a replayed document returns the original row. */
  async createOpenItem(input: CreateOpenItemInput): Promise<OpenItem> {
    const existing = await this.pool.query(
      `SELECT * FROM finance_open_items
        WHERE tenant_id = $1 AND source_ref_table = $2 AND source_ref_id = $3`,
      [input.tenantId, input.sourceRefTable, input.sourceRefId],
    );
    if (existing.rows.length > 0) return toOpenItem(existing.rows[0]);

    const r = await this.pool.query(
      `INSERT INTO finance_open_items
         (tenant_id, legal_entity_id, side, direction, source_kind,
          source_ref_table, source_ref_id, party_type, party_id,
          document_no, document_date, due_date, currency, original_amount,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13,$14::numeric,$15)
       ON CONFLICT (tenant_id, source_ref_table, source_ref_id) DO NOTHING
       RETURNING *`,
      [
        input.tenantId,
        input.legalEntityId,
        input.side,
        input.direction,
        input.sourceKind,
        input.sourceRefTable,
        input.sourceRefId,
        input.partyType,
        input.partyId,
        input.documentNo,
        input.documentDate,
        input.dueDate,
        input.currency,
        input.originalAmount,
        input.createdBy,
      ],
    );
    if (r.rows.length > 0) return toOpenItem(r.rows[0]);
    const again = await this.pool.query(
      `SELECT * FROM finance_open_items
        WHERE tenant_id = $1 AND source_ref_table = $2 AND source_ref_id = $3`,
      [input.tenantId, input.sourceRefTable, input.sourceRefId],
    );
    return toOpenItem(again.rows[0]);
  }

  async findOpenItemById(tenantId: string, id: string): Promise<OpenItem | null> {
    const r = await this.pool.query(
      `SELECT * FROM finance_open_items WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return r.rows.length > 0 ? toOpenItem(r.rows[0]) : null;
  }

  async listOpenItems(
    tenantId: string,
    filter: { side?: OpenItemSide; partyType?: string; partyId?: string; legalEntityId?: string },
  ): Promise<OpenItemWithRemaining[]> {
    const clauses = ["oi.tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (filter.side) {
      params.push(filter.side);
      clauses.push(`oi.side = $${params.length}`);
    }
    if (filter.partyType) {
      params.push(filter.partyType);
      clauses.push(`oi.party_type = $${params.length}`);
    }
    if (filter.partyId) {
      params.push(filter.partyId);
      clauses.push(`oi.party_id = $${params.length}`);
    }
    if (filter.legalEntityId) {
      params.push(filter.legalEntityId);
      clauses.push(`oi.legal_entity_id = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT oi.*, (${ALLOCATED_EXPR}) AS allocated
         FROM finance_open_items oi
         LEFT JOIN finance_open_item_allocations al
           ON al.tenant_id = oi.tenant_id
          AND (al.source_open_item_id = oi.id OR al.target_open_item_id = oi.id)
        WHERE ${clauses.join(" AND ")}
        GROUP BY oi.id
        ORDER BY oi.document_date, oi.document_no`,
      params,
    );
    return r.rows.map((row: Row) => {
      const item = toOpenItem(row);
      const allocated = String(row.allocated);
      const remaining = projectRemaining(item.originalAmount, allocated) ?? "0.0000";
      return { ...item, allocatedAmount: allocated, remainingAmount: remaining };
    });
  }

  /**
   * Settlement write (ADR-0017 §3). Row locks on both open items are taken
   * first, then every invariant is re-checked inside the transaction: Legal
   * Entity, side, currency, direction, and non-negative remaining. A
   * concurrent over-allocation loses the race at the remaining check and
   * fails closed.
   */
  async allocate(input: AllocateInput): Promise<OpenItemAllocation> {
    return this.inTransaction(async (client) => {
      const idem = await client.query(
        `SELECT * FROM finance_open_item_allocations
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (idem.rows.length > 0) return toAllocation(idem.rows[0]);

      const lock = await client.query(
        `SELECT * FROM finance_open_items
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [input.tenantId, [input.sourceOpenItemId, input.targetOpenItemId]],
      );
      const byId = new Map<string, Row>(lock.rows.map((row: Row) => [row.id as string, row]));
      const source = byId.get(input.sourceOpenItemId);
      const target = byId.get(input.targetOpenItemId);
      if (!source || !target) throw new SettlementError("Open item not found in this tenant");

      if (source.legal_entity_id !== target.legal_entity_id) {
        throw new SettlementError("Open items belong to different legal entities");
      }
      if (source.legal_entity_id !== input.legalEntityId) {
        throw new SettlementError("Allocation legal entity does not match the open items");
      }
      if (source.side !== target.side) {
        throw new SettlementError("Cannot allocate across AP and AR");
      }
      if (source.currency !== target.currency) {
        throw new SettlementError("Cannot allocate across currencies");
      }
      if (source.direction !== "credit") {
        throw new SettlementError("The source of an allocation must be a credit-direction instrument");
      }
      if (target.direction !== "debit") {
        throw new SettlementError("The target of an allocation must be a debit-direction instrument");
      }

      const amountUnits = toUnits(input.amount);
      if (amountUnits === null || amountUnits <= 0n) {
        throw new SettlementError("Allocation amount must be positive with at most 4 decimals");
      }

      const sourceRemaining = (toUnits(String(source.original_amount)) ?? 0n) - (await this.allocatedOf(client, input.tenantId, String(source.id)));
      const targetRemaining = (toUnits(String(target.original_amount)) ?? 0n) - (await this.allocatedOf(client, input.tenantId, String(target.id)));
      if (amountUnits > sourceRemaining) {
        throw new SettlementError("Allocation exceeds the remaining amount of the source instrument");
      }
      if (amountUnits > targetRemaining) {
        throw new SettlementError("Allocation exceeds the remaining amount of the target instrument");
      }

      const r = await client.query(
        `INSERT INTO finance_open_item_allocations
           (tenant_id, source_open_item_id, target_open_item_id, amount, currency,
            allocation_date, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4::numeric,$5,$6::date,$7,$8)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.tenantId,
          input.sourceOpenItemId,
          input.targetOpenItemId,
          input.amount,
          source.currency,
          input.allocationDate,
          input.idempotencyKey,
          input.createdBy,
        ],
      );
      if (r.rows.length > 0) return toAllocation(r.rows[0]);
      const again = await client.query(
        `SELECT * FROM finance_open_item_allocations
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      return toAllocation(again.rows[0]);
    });
  }

  /**
   * Reversal (ADR-0017 §3): a compensating allocation row that restores the
   * derived open amount. The original is never edited or deleted. Reversing a
   * reversal is refused — the history stays a simple append-only pair.
   */
  async reverseAllocation(input: ReverseAllocationInput): Promise<OpenItemAllocation> {
    return this.inTransaction(async (client) => {
      const original = await client.query(
        `SELECT * FROM finance_open_item_allocations
          WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.allocationId, input.tenantId],
      );
      if (original.rows.length === 0) {
        throw new SettlementError("Allocation not found in this tenant");
      }
      const orig = original.rows[0] as Row;
      if (orig.reverses_id) {
        throw new SettlementError("A reversal cannot itself be reversed");
      }

      const already = await client.query(
        `SELECT * FROM finance_open_item_allocations
          WHERE tenant_id = $1 AND reverses_id = $2`,
        [input.tenantId, input.allocationId],
      );
      if (already.rows.length > 0) return toAllocation(already.rows[0]);

      // Same source/target pair as the original. The signed sum in
      // `ALLOCATED_EXPR` is what makes this cancel out.
      const r = await client.query(
        `INSERT INTO finance_open_item_allocations
           (tenant_id, source_open_item_id, target_open_item_id, amount, currency,
            allocation_date, idempotency_key, reverses_id, reversal_reason, created_by)
         VALUES ($1,$2,$3,$4::numeric,$5,$6::date,$7,$8,$9,$10)
         RETURNING *`,
        [
          input.tenantId,
          orig.source_open_item_id,
          orig.target_open_item_id,
          String(orig.amount),
          orig.currency,
          new Date().toISOString().slice(0, 10),
          `rev-${input.allocationId}`,
          input.allocationId,
          input.reversalReason,
          input.createdBy,
        ],
      );
      return toAllocation(r.rows[0]);
    });
  }

  /**
   * Aging at `asOfDate` (ADR-0017 §2): projected from document dates and
   * allocation history effective on or before that date, never from today's
   * balance. Only debit-direction items are bucketed — what is still owed.
   * Unapplied credit instruments (payments not yet allocated) are reported
   * separately so they are not netted against the buckets twice.
   */
  async aging(
    tenantId: string,
    side: OpenItemSide,
    asOfDate: string,
    currency: string,
  ): Promise<AgingResult & { unapplied: string }> {
    const items = await this.pool.query(
      `SELECT oi.*, (${ALLOCATED_EXPR}) AS allocated
         FROM finance_open_items oi
         LEFT JOIN finance_open_item_allocations al
           ON al.tenant_id = oi.tenant_id
          AND al.allocation_date::date <= $3::date
          AND (al.source_open_item_id = oi.id OR al.target_open_item_id = oi.id)
        WHERE oi.tenant_id = $1
          AND oi.side = $2
          AND oi.currency = $4
          AND oi.document_date::date <= $3::date
        GROUP BY oi.id
        ORDER BY oi.document_date, oi.document_no`,
      [tenantId, side, asOfDate, currency],
    );

    const buckets = new Map<string, AgingBucket>(
      DEFAULT_AGING_BUCKETS.map((b) => [
        b.label,
        { label: b.label, fromDays: b.fromDays, toDays: b.toDays, amount: "0.0000", itemCount: 0 },
      ]),
    );
    let totalUnits = 0n;
    let unappliedUnits = 0n;

    for (const row of items.rows as Row[]) {
      const item = toOpenItem(row);
      const remaining = projectRemaining(item.originalAmount, String(row.allocated));
      const units = remaining ? toUnits(remaining) : null;
      if (units === null || units === 0n) continue;

      if (item.direction === "credit") {
        if (units > 0n) unappliedUnits += units;
        continue;
      }
      if (units < 0n) continue; // fail closed on any projection below zero
      totalUnits += units;

      const overdue = (item.dueDate ? daysOverdue(item.dueDate, asOfDate) : null) ?? 0;
      const bucket = [...buckets.values()].find(
        (b) => overdue >= b.fromDays && (b.toDays === null || overdue <= b.toDays),
      );
      const chosen = bucket ?? buckets.get("1-30")!;
      chosen.amount = addAmounts(chosen.amount, fromUnits(units)) ?? chosen.amount;
      chosen.itemCount += 1;
    }

    return {
      asOfDate,
      side,
      currency,
      totalOpen: fromUnits(totalUnits),
      unapplied: fromUnits(unappliedUnits),
      buckets: [...buckets.values()],
    };
  }

  async listAllocations(tenantId: string, openItemId: string): Promise<OpenItemAllocation[]> {
    const r = await this.pool.query(
      `SELECT * FROM finance_open_item_allocations
        WHERE tenant_id = $1
          AND (source_open_item_id = $2 OR target_open_item_id = $2)
        ORDER BY allocation_date, created_at`,
      [tenantId, openItemId],
    );
    return r.rows.map(toAllocation);
  }

  async remainingOf(tenantId: string, openItemId: string): Promise<string> {
    const item = await this.findOpenItemById(tenantId, openItemId);
    if (!item) throw new SettlementError("Open item not found in this tenant");
    const allocated = await this.allocatedOf(this.pool, tenantId, openItemId);
    return projectRemaining(item.originalAmount, fromUnits(allocated)) ?? "0.0000";
  }
}
