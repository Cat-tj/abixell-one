import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  CreateItemInput,
  CreatePurchaseOrderInput,
  CreatePurchaseRequestInput,
  CreateSupplierInput,
  Item,
  MovementType,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseRequest,
  PurchaseRequestLine,
  RecordMovementInput,
  ScmGrade,
  StockBalance,
  StockMovement,
  Supplier,
  SupplyChainRepository,
} from "../domain/supply-chain.entity.js";

export class PgSupplyChainRepository implements SupplyChainRepository {
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

  // --- Item master ------------------------------------------------------

  async createItem(input: CreateItemInput): Promise<Item> {
    const r = await this.pool.query(
      `INSERT INTO items (tenant_id, code, name, description, category, unit_of_measure, grade, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [
        input.tenantId,
        input.code,
        input.name,
        input.description ?? null,
        input.category ?? null,
        input.unitOfMeasure,
        input.grade ?? null,
        input.createdBy,
      ],
    );
    return toItem(r.rows[0]);
  }

  async findItemById(id: string): Promise<Item | null> {
    const r = await this.pool.query(`SELECT * FROM items WHERE id = $1`, [id]);
    return r.rows[0] ? toItem(r.rows[0]) : null;
  }

  async findItemByCode(tenantId: string, code: string): Promise<Item | null> {
    const r = await this.pool.query(`SELECT * FROM items WHERE tenant_id = $1 AND code = $2`, [tenantId, code]);
    return r.rows[0] ? toItem(r.rows[0]) : null;
  }

  async listItems(tenantId: string, filter: { search?: string; isActive?: boolean }): Promise<Item[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter.search) {
      params.push(`%${filter.search}%`);
      conditions.push(`(name ILIKE $${params.length} OR code ILIKE $${params.length})`);
    }
    if (filter.isActive !== undefined) {
      params.push(filter.isActive);
      conditions.push(`is_active = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM items WHERE ${conditions.join(" AND ")} ORDER BY code`,
      params,
    );
    return r.rows.map(toItem);
  }

  async updateItem(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      category?: string | null;
      grade?: ScmGrade | null;
      isActive?: boolean;
    },
    updatedBy: string | null,
    guard?: (db: Pick<PoolClient, "query">) => Promise<void>,
  ): Promise<Item | null> {
    // Lock the item row so a concurrent WMS movement (FOR SHARE on the item in
    // recordMovementTx) and this regrade serialise; the guard sees committed stock.
    return this.inTransaction(async (client) => {
      const locked = await client.query(`SELECT id FROM items WHERE id = $1 FOR UPDATE`, [id]);
      if (!locked.rows[0]) return null;
      if (guard) await guard(client);
      return this.updateItemRow(client, id, input, updatedBy);
    });
  }

  private async updateItemRow(
    db: Pick<PoolClient, "query">,
    id: string,
    input: {
      name?: string;
      description?: string | null;
      category?: string | null;
      grade?: ScmGrade | null;
      isActive?: boolean;
    },
    updatedBy: string | null,
  ): Promise<Item | null> {
    const r = await db.query(
      `UPDATE items
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              category = CASE WHEN $5::boolean THEN $6 ELSE category END,
              is_active = COALESCE($7, is_active),
              grade = CASE WHEN $9::boolean THEN $10 ELSE grade END,
              updated_by = $8, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        id,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        input.category !== undefined,
        input.category ?? null,
        input.isActive ?? null,
        updatedBy,
        input.grade !== undefined,
        input.grade ?? null,
      ],
    );
    return r.rows[0] ? toItem(r.rows[0]) : null;
  }

  // --- Supplier master --------------------------------------------------

  async createSupplier(input: CreateSupplierInput): Promise<Supplier> {
    const r = await this.pool.query(
      `INSERT INTO suppliers (tenant_id, code, name, category, contact_name, email, phone, address, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [
        input.tenantId,
        input.code,
        input.name,
        input.category ?? null,
        input.contactName ?? null,
        input.email ?? null,
        input.phone ?? null,
        input.address ?? null,
        input.createdBy,
      ],
    );
    return toSupplier(r.rows[0]);
  }

  async findSupplierById(id: string): Promise<Supplier | null> {
    const r = await this.pool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
    return r.rows[0] ? toSupplier(r.rows[0]) : null;
  }

  async findSupplierByCode(tenantId: string, code: string): Promise<Supplier | null> {
    const r = await this.pool.query(`SELECT * FROM suppliers WHERE tenant_id = $1 AND code = $2`, [tenantId, code]);
    return r.rows[0] ? toSupplier(r.rows[0]) : null;
  }

  async listSuppliers(tenantId: string, filter: { search?: string }): Promise<Supplier[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter.search) {
      params.push(`%${filter.search}%`);
      conditions.push(`(name ILIKE $${params.length} OR code ILIKE $${params.length})`);
    }
    const r = await this.pool.query(
      `SELECT * FROM suppliers WHERE ${conditions.join(" AND ")} ORDER BY code`,
      params,
    );
    return r.rows.map(toSupplier);
  }

  async updateSupplier(
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
  ): Promise<Supplier | null> {
    const r = await this.pool.query(
      `UPDATE suppliers
          SET name = COALESCE($2, name),
              category = CASE WHEN $3::boolean THEN $4 ELSE category END,
              contact_name = CASE WHEN $5::boolean THEN $6 ELSE contact_name END,
              email = CASE WHEN $7::boolean THEN $8 ELSE email END,
              phone = CASE WHEN $9::boolean THEN $10 ELSE phone END,
              address = CASE WHEN $11::boolean THEN $12 ELSE address END,
              is_active = COALESCE($13, is_active),
              updated_by = $14, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        id,
        input.name ?? null,
        input.category !== undefined,
        input.category ?? null,
        input.contactName !== undefined,
        input.contactName ?? null,
        input.email !== undefined,
        input.email ?? null,
        input.phone !== undefined,
        input.phone ?? null,
        input.address !== undefined,
        input.address ?? null,
        input.isActive ?? null,
        updatedBy,
      ],
    );
    return r.rows[0] ? toSupplier(r.rows[0]) : null;
  }

  // --- Stock ------------------------------------------------------------

  /** Increment (or create) the balance row. The ON CONFLICT target must match
   * one of the two PARTIAL unique indexes, so the null-site case is handled
   * separately. */
  private async applyIncrease(
    client: PoolClient,
    tenantId: string,
    itemId: string,
    siteId: string | null,
    quantity: number,
  ): Promise<StockBalance> {
    const sql = siteId
      ? `INSERT INTO stock_balances (tenant_id, item_id, site_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, item_id, site_id) WHERE site_id IS NOT NULL
         DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
         RETURNING *`
      : `INSERT INTO stock_balances (tenant_id, item_id, site_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, item_id) WHERE site_id IS NULL
         DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now()
         RETURNING *`;
    const r = await client.query(sql, [tenantId, itemId, siteId, quantity]);
    return toBalance(r.rows[0]);
  }

  /** Atomic guarded decrement: the sufficiency check lives INSIDE the UPDATE,
   * so two concurrent issues cannot both pass a stale read and overspend.
   * Returns null when there is not enough stock. */
  private async applyDecrease(
    client: PoolClient,
    tenantId: string,
    itemId: string,
    siteId: string | null,
    quantity: number,
  ): Promise<StockBalance | null> {
    const r = await client.query(
      `UPDATE stock_balances
          SET quantity = quantity - $4, updated_at = now()
        WHERE tenant_id = $1 AND item_id = $2
          AND site_id IS NOT DISTINCT FROM $3::uuid
          AND quantity >= $4
        RETURNING *`,
      [tenantId, itemId, siteId, quantity],
    );
    return r.rows[0] ? toBalance(r.rows[0]) : null;
  }

  async recordMovement(
    input: RecordMovementInput,
  ): Promise<{ movement: StockMovement; balance: StockBalance } | null> {
    return this.inTransaction(async (client) => {
      const balance =
        input.movementType === "in"
          ? await this.applyIncrease(client, input.tenantId, input.itemId, input.siteId, input.quantity)
          : await this.applyDecrease(client, input.tenantId, input.itemId, input.siteId, input.quantity);
      // Insufficient stock: nothing is written, the whole transaction rolls back.
      if (!balance) return null;

      const m = await client.query(
        `INSERT INTO stock_movements
           (tenant_id, item_id, site_id, movement_type, quantity, reference, note,
            purchase_order_id, purchase_order_line_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          input.tenantId,
          input.itemId,
          input.siteId,
          input.movementType,
          input.quantity,
          input.reference,
          input.note,
          input.purchaseOrderId ?? null,
          input.purchaseOrderLineId ?? null,
          input.createdBy,
        ],
      );
      return { movement: toMovement(m.rows[0]), balance };
    });
  }

  async listBalances(tenantId: string, filter: { itemId?: string; siteId?: string }): Promise<StockBalance[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (filter.siteId) {
      params.push(filter.siteId);
      conditions.push(`site_id = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM stock_balances WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`,
      params,
    );
    return r.rows.map(toBalance);
  }

  async findBalance(tenantId: string, itemId: string, siteId: string | null): Promise<StockBalance | null> {
    const r = await this.pool.query(
      `SELECT * FROM stock_balances
        WHERE tenant_id = $1 AND item_id = $2 AND site_id IS NOT DISTINCT FROM $3::uuid`,
      [tenantId, itemId, siteId],
    );
    return r.rows[0] ? toBalance(r.rows[0]) : null;
  }

  async listMovements(tenantId: string, filter: { itemId?: string; limit?: number }): Promise<StockMovement[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    params.push(filter.limit ?? 200);
    const r = await this.pool.query(
      `SELECT * FROM stock_movements WHERE ${conditions.join(" AND ")}
        ORDER BY occurred_at DESC, created_at DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toMovement);
  }

  // --- Purchase Request -------------------------------------------------

  async createPurchaseRequest(input: CreatePurchaseRequestInput): Promise<PurchaseRequest> {
    return this.inTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO purchase_requests
           (tenant_id, request_number, organization_unit_id, project_id, site_id,
            justification, required_date, requested_by_user_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [
          input.tenantId,
          input.requestNumber,
          input.organizationUnitId,
          input.projectId,
          input.siteId,
          input.justification,
          input.requiredDate,
          input.requestedByUserId,
          input.createdBy,
        ],
      );
      const request = toRequest(r.rows[0]);
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO purchase_request_lines (purchase_request_id, item_id, quantity, note, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [request.id, line.itemId, line.quantity, line.note, line.sortOrder],
        );
      }
      return request;
    });
  }

  async findPurchaseRequestById(id: string): Promise<PurchaseRequest | null> {
    const r = await this.pool.query(`SELECT * FROM purchase_requests WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return r.rows[0] ? toRequest(r.rows[0]) : null;
  }

  async listPurchaseRequests(
    tenantId: string,
    filter: { organizationUnitIds?: string[] },
  ): Promise<PurchaseRequest[]> {
    const conditions = [`tenant_id = $1`, `deleted_at IS NULL`];
    const params: unknown[] = [tenantId];
    if (filter.organizationUnitIds) {
      params.push(filter.organizationUnitIds);
      conditions.push(`(organization_unit_id IS NULL OR organization_unit_id = ANY($${params.length}))`);
    }
    const r = await this.pool.query(
      `SELECT * FROM purchase_requests WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toRequest);
  }

  async listPurchaseRequestLines(purchaseRequestId: string): Promise<PurchaseRequestLine[]> {
    const r = await this.pool.query(
      `SELECT * FROM purchase_request_lines WHERE purchase_request_id = $1 ORDER BY sort_order, id`,
      [purchaseRequestId],
    );
    return r.rows.map(toRequestLine);
  }

  async setPurchaseRequestWorkflowInstance(id: string, workflowInstanceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE purchase_requests SET workflow_instance_id = $2, updated_at = now() WHERE id = $1`,
      [id, workflowInstanceId],
    );
  }

  async markPurchaseRequestConverted(
    id: string,
    purchaseOrderId: string,
    updatedBy: string | null,
  ): Promise<PurchaseRequest | null> {
    const r = await this.pool.query(
      `UPDATE purchase_requests
          SET converted_purchase_order_id = $2, converted_at = now(), updated_by = $3, updated_at = now()
        WHERE id = $1 AND converted_purchase_order_id IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [id, purchaseOrderId, updatedBy],
    );
    return r.rows[0] ? toRequest(r.rows[0]) : null;
  }

  // --- Purchase Order ---------------------------------------------------

  async createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
    return this.inTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO purchase_orders
           (tenant_id, order_number, supplier_id, purchase_request_id, site_id,
            currency, order_date, expected_date, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [
          input.tenantId,
          input.orderNumber,
          input.supplierId,
          input.purchaseRequestId,
          input.siteId,
          input.currency,
          input.orderDate,
          input.expectedDate,
          input.createdBy,
        ],
      );
      const order = toOrder(r.rows[0]);
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO purchase_order_lines (
             tenant_id, purchase_order_id, item_id, quantity_ordered, unit_price, sort_order
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.tenantId, order.id, line.itemId, line.quantityOrdered, line.unitPrice, line.sortOrder],
        );
      }
      return order;
    });
  }

  async findPurchaseOrderById(id: string): Promise<PurchaseOrder | null> {
    const r = await this.pool.query(`SELECT * FROM purchase_orders WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return r.rows[0] ? toOrder(r.rows[0]) : null;
  }

  async listPurchaseOrders(tenantId: string, filter: { supplierId?: string }): Promise<PurchaseOrder[]> {
    const conditions = [`tenant_id = $1`, `deleted_at IS NULL`];
    const params: unknown[] = [tenantId];
    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM purchase_orders WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toOrder);
  }

  async listPurchaseOrderLines(purchaseOrderId: string): Promise<PurchaseOrderLine[]> {
    const r = await this.pool.query(
      `SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY sort_order, id`,
      [purchaseOrderId],
    );
    return r.rows.map(toOrderLine);
  }

  async findPurchaseOrderLine(id: string): Promise<PurchaseOrderLine | null> {
    const r = await this.pool.query(`SELECT * FROM purchase_order_lines WHERE id = $1`, [id]);
    return r.rows[0] ? toOrderLine(r.rows[0]) : null;
  }

  async issuePurchaseOrder(id: string, userId: string): Promise<PurchaseOrder | null> {
    const r = await this.pool.query(
      `UPDATE purchase_orders
          SET issued_at = now(), issued_by_user_id = $2, updated_by = $2, updated_at = now()
        WHERE id = $1 AND issued_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [id, userId],
    );
    return r.rows[0] ? toOrder(r.rows[0]) : null;
  }

  async cancelPurchaseOrder(
    id: string,
    reason: string | null,
    updatedBy: string | null,
  ): Promise<PurchaseOrder | null> {
    const r = await this.pool.query(
      `UPDATE purchase_orders
          SET cancelled_at = now(), cancellation_reason = $2, updated_by = $3, updated_at = now()
        WHERE id = $1 AND cancelled_at IS NULL AND deleted_at IS NULL
        RETURNING *`,
      [id, reason, updatedBy],
    );
    return r.rows[0] ? toOrder(r.rows[0]) : null;
  }

  async receiveAgainstPurchaseOrderLine(input: {
    tenantId: string;
    purchaseOrderId: string;
    purchaseOrderLineId: string;
    itemId: string;
    siteId: string | null;
    quantity: number;
    reference: string | null;
    note: string | null;
    createdBy: string | null;
  }): Promise<{ movement: StockMovement; balance: StockBalance; line: PurchaseOrderLine } | null> {
    return this.inTransaction(async (client) => {
      // Over-receipt guard lives INSIDE the UPDATE, so concurrent receipts
      // cannot jointly exceed the ordered quantity.
      const lineResult = await client.query(
        `UPDATE purchase_order_lines
            SET quantity_received = quantity_received + $2
          WHERE id = $1 AND quantity_received + $2 <= quantity_ordered
          RETURNING *`,
        [input.purchaseOrderLineId, input.quantity],
      );
      if (!lineResult.rows[0]) return null;

      const balance = await this.applyIncrease(
        client,
        input.tenantId,
        input.itemId,
        input.siteId,
        input.quantity,
      );
      const m = await client.query(
        `INSERT INTO stock_movements
           (tenant_id, item_id, site_id, movement_type, quantity, reference, note,
            purchase_order_id, purchase_order_line_id, created_by)
         VALUES ($1,$2,$3,'in',$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          input.tenantId,
          input.itemId,
          input.siteId,
          input.quantity,
          input.reference,
          input.note,
          input.purchaseOrderId,
          input.purchaseOrderLineId,
          input.createdBy,
        ],
      );
      return { movement: toMovement(m.rows[0]), balance, line: toOrderLine(lineResult.rows[0]) };
    });
  }

  // --- Cross-domain reads ------------------------------------------------

  async siteExists(tenantId: string, siteId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM sites s JOIN customers c ON c.id = s.customer_id
        WHERE s.id = $1 AND c.tenant_id = $2`,
      [siteId, tenantId],
    );
    return r.rows.length > 0;
  }

  async organizationUnitExists(tenantId: string, organizationUnitId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM organization_units WHERE id = $1 AND tenant_id = $2`, [
      organizationUnitId,
      tenantId,
    ]);
    return r.rows.length > 0;
  }

  async projectExists(tenantId: string, projectId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM projects p JOIN customers c ON c.id = p.customer_id
        WHERE p.id = $1 AND c.tenant_id = $2`,
      [projectId, tenantId],
    );
    return r.rows.length > 0;
  }
}

// --- Row mappers -------------------------------------------------------

/** pg returns `numeric` as string to preserve precision — coerce at the
 * boundary so the domain works with numbers. */
function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toDateString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function toItem(r: QueryResultRow): Item {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    description: r.description,
    category: r.category,
    unitOfMeasure: r.unit_of_measure,
    grade: r.grade ?? null,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSupplier(r: QueryResultRow): Supplier {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    category: r.category,
    contactName: r.contact_name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toBalance(r: QueryResultRow): StockBalance {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    siteId: r.site_id,
    quantity: num(r.quantity),
    updatedAt: r.updated_at,
  };
}

function toMovement(r: QueryResultRow): StockMovement {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    siteId: r.site_id,
    movementType: r.movement_type as MovementType,
    quantity: num(r.quantity),
    reference: r.reference,
    note: r.note,
    purchaseOrderId: r.purchase_order_id,
    purchaseOrderLineId: r.purchase_order_line_id,
    occurredAt: r.occurred_at,
    createdBy: r.created_by,
  };
}

function toRequest(r: QueryResultRow): PurchaseRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    requestNumber: r.request_number,
    organizationUnitId: r.organization_unit_id,
    projectId: r.project_id,
    siteId: r.site_id,
    justification: r.justification,
    requiredDate: toDateString(r.required_date),
    requestedByUserId: r.requested_by_user_id,
    workflowInstanceId: r.workflow_instance_id,
    convertedPurchaseOrderId: r.converted_purchase_order_id,
    convertedAt: r.converted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRequestLine(r: QueryResultRow): PurchaseRequestLine {
  return {
    id: r.id,
    purchaseRequestId: r.purchase_request_id,
    itemId: r.item_id,
    quantity: num(r.quantity),
    note: r.note,
    sortOrder: r.sort_order,
  };
}

function toOrder(r: QueryResultRow): PurchaseOrder {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    orderNumber: r.order_number,
    supplierId: r.supplier_id,
    purchaseRequestId: r.purchase_request_id,
    siteId: r.site_id,
    currency: r.currency,
    orderDate: toDateString(r.order_date),
    expectedDate: toDateString(r.expected_date),
    issuedAt: r.issued_at,
    issuedByUserId: r.issued_by_user_id,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toOrderLine(r: QueryResultRow): PurchaseOrderLine {
  return {
    id: r.id,
    purchaseOrderId: r.purchase_order_id,
    itemId: r.item_id,
    quantityOrdered: num(r.quantity_ordered),
    quantityReceived: num(r.quantity_received),
    unitPrice: numOrNull(r.unit_price),
    sortOrder: r.sort_order,
  };
}
