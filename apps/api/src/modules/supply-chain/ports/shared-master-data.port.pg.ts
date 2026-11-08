import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  Item,
  Supplier,
  PurchaseRequest,
  PurchaseRequestLine,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderState,
} from "../core/domain/supply-chain.entity.js";
import { purchaseOrderState } from "../core/domain/supply-chain.entity.js";
import type {
  SharedMasterDataReadPort,
  PurchaseOrderWithLines,
  AccountAssignmentConfigView,
} from "./shared-master-data-read-port.js";

function toItem(row: QueryResultRow): Item {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    unitOfMeasure: row.unit_of_measure,
    grade: row.grade ?? null,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSupplier(row: QueryResultRow): Supplier {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    category: row.category,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPurchaseRequest(row: QueryResultRow): PurchaseRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestNumber: row.request_number,
    organizationUnitId: row.organization_unit_id,
    projectId: row.project_id,
    siteId: row.site_id,
    justification: row.justification,
    requiredDate: row.required_date,
    requestedByUserId: row.requested_by_user_id,
    workflowInstanceId: row.workflow_instance_id,
    convertedPurchaseOrderId: row.converted_purchase_order_id,
    convertedAt: row.converted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPurchaseRequestLine(row: QueryResultRow): PurchaseRequestLine {
  return {
    id: row.id,
    purchaseRequestId: row.purchase_request_id,
    itemId: row.item_id,
    quantity: Number(row.quantity),
    note: row.note,
    sortOrder: Number(row.sort_order),
  };
}

function toPurchaseOrder(row: QueryResultRow): PurchaseOrder {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderNumber: row.order_number,
    supplierId: row.supplier_id,
    purchaseRequestId: row.purchase_request_id,
    siteId: row.site_id,
    currency: row.currency,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    issuedAt: row.issued_at,
    issuedByUserId: row.issued_by_user_id,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPurchaseOrderLine(row: QueryResultRow): PurchaseOrderLine {
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    itemId: row.item_id,
    quantityOrdered: Number(row.quantity_ordered),
    quantityReceived: Number(row.quantity_received),
    unitPrice: row.unit_price !== null && row.unit_price !== undefined ? Number(row.unit_price) : null,
    sortOrder: Number(row.sort_order),
  };
}

function toAccountAssignmentConfigView(row: QueryResultRow): AccountAssignmentConfigView {
  const rawReq = row.required_dimensions;
  const rawOpt = row.optional_dimensions;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assignmentType: row.assignment_type,
    requiredDimensions: Array.isArray(rawReq)
      ? rawReq
      : typeof rawReq === "string"
        ? JSON.parse(rawReq)
        : [],
    optionalDimensions: Array.isArray(rawOpt)
      ? rawOpt
      : typeof rawOpt === "string"
        ? JSON.parse(rawOpt)
        : [],
    isActive: Boolean(row.is_active),
  };
}

export class PgSharedMasterDataReadPort implements SharedMasterDataReadPort {
  constructor(private readonly pool: Pool) {}

  async getItem(tenantId: string, itemId: string): Promise<Item | null> {
    const r = await this.pool.query(
      `SELECT * FROM items WHERE tenant_id = $1 AND id = $2`,
      [tenantId, itemId],
    );
    return r.rows[0] ? toItem(r.rows[0]) : null;
  }

  async getItemByCode(tenantId: string, code: string): Promise<Item | null> {
    const r = await this.pool.query(
      `SELECT * FROM items WHERE tenant_id = $1 AND code = $2`,
      [tenantId, code],
    );
    return r.rows[0] ? toItem(r.rows[0]) : null;
  }

  async listItems(
    tenantId: string,
    filter?: { isActive?: boolean; category?: string | null },
  ): Promise<Item[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter?.isActive !== undefined) {
      params.push(filter.isActive);
      conditions.push(`is_active = $${params.length}`);
    }
    if (filter?.category !== undefined) {
      params.push(filter.category);
      conditions.push(`category = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM items WHERE ${conditions.join(" AND ")} ORDER BY code ASC`,
      params,
    );
    return r.rows.map(toItem);
  }

  async getSupplier(tenantId: string, supplierId: string): Promise<Supplier | null> {
    const r = await this.pool.query(
      `SELECT * FROM suppliers WHERE tenant_id = $1 AND id = $2`,
      [tenantId, supplierId],
    );
    return r.rows[0] ? toSupplier(r.rows[0]) : null;
  }

  async getSupplierByCode(tenantId: string, code: string): Promise<Supplier | null> {
    const r = await this.pool.query(
      `SELECT * FROM suppliers WHERE tenant_id = $1 AND code = $2`,
      [tenantId, code],
    );
    return r.rows[0] ? toSupplier(r.rows[0]) : null;
  }

  async listSuppliers(
    tenantId: string,
    filter?: { isActive?: boolean; category?: string | null },
  ): Promise<Supplier[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter?.isActive !== undefined) {
      params.push(filter.isActive);
      conditions.push(`is_active = $${params.length}`);
    }
    if (filter?.category !== undefined) {
      params.push(filter.category);
      conditions.push(`category = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM suppliers WHERE ${conditions.join(" AND ")} ORDER BY name ASC`,
      params,
    );
    return r.rows.map(toSupplier);
  }

  async getPurchaseRequest(
    tenantId: string,
    purchaseRequestId: string,
  ): Promise<{ request: PurchaseRequest; lines: PurchaseRequestLine[] } | null> {
    const r = await this.pool.query(
      `SELECT * FROM purchase_requests WHERE tenant_id = $1 AND id = $2`,
      [tenantId, purchaseRequestId],
    );
    if (!r.rows[0]) return null;
    const request = toPurchaseRequest(r.rows[0]);
    const l = await this.pool.query(
      `SELECT * FROM purchase_request_lines WHERE purchase_request_id = $1 ORDER BY sort_order ASC, id ASC`,
      [purchaseRequestId],
    );
    return { request, lines: l.rows.map(toPurchaseRequestLine) };
  }

  async getPurchaseOrder(
    tenantId: string,
    purchaseOrderId: string,
  ): Promise<PurchaseOrderWithLines | null> {
    const r = await this.pool.query(
      `SELECT * FROM purchase_orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId, purchaseOrderId],
    );
    if (!r.rows[0]) return null;
    const order = toPurchaseOrder(r.rows[0]);
    const l = await this.pool.query(
      `SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY sort_order ASC, id ASC`,
      [purchaseOrderId],
    );
    const lines = l.rows.map(toPurchaseOrderLine);
    return { order, lines, state: purchaseOrderState(order) };
  }

  async listPurchaseOrders(
    tenantId: string,
    filter?: {
      supplierId?: string;
      state?: PurchaseOrderState;
    },
  ): Promise<PurchaseOrderWithLines[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];
    if (filter?.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter?.state === "cancelled") {
      conditions.push(`cancelled_at IS NOT NULL`);
    } else if (filter?.state === "issued") {
      conditions.push(`issued_at IS NOT NULL AND cancelled_at IS NULL`);
    } else if (filter?.state === "draft") {
      conditions.push(`issued_at IS NULL AND cancelled_at IS NULL`);
    }

    const r = await this.pool.query(
      `SELECT * FROM purchase_orders WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    if (r.rows.length === 0) return [];

    const poIds = r.rows.map((row) => row.id);
    const linesRes = await this.pool.query(
      `SELECT * FROM purchase_order_lines WHERE purchase_order_id = ANY($1::uuid[]) ORDER BY sort_order ASC, id ASC`,
      [poIds],
    );
    const linesByPo = new Map<string, PurchaseOrderLine[]>();
    for (const lRow of linesRes.rows) {
      const line = toPurchaseOrderLine(lRow);
      const arr = linesByPo.get(line.purchaseOrderId) ?? [];
      arr.push(line);
      linesByPo.set(line.purchaseOrderId, arr);
    }

    return r.rows.map((row) => {
      const order = toPurchaseOrder(row);
      return {
        order,
        lines: linesByPo.get(order.id) ?? [],
        state: purchaseOrderState(order),
      };
    });
  }

  async incrementPurchaseOrderLineReceived(
    client: PoolClient,
    tenantId: string,
    purchaseOrderLineId: string,
    deltaReceived: number,
  ): Promise<PurchaseOrderLine> {
    const r = await client.query(
      `UPDATE purchase_order_lines pol
          SET quantity_received = pol.quantity_received + $3
         FROM purchase_orders po
        WHERE pol.id = $1
          AND pol.purchase_order_id = po.id
          AND po.tenant_id = $2
        RETURNING pol.*`,
      [purchaseOrderLineId, tenantId, deltaReceived],
    );
    if (!r.rows[0]) {
      throw new Error(`Purchase order line not found: ${purchaseOrderLineId}`);
    }
    return toPurchaseOrderLine(r.rows[0]);
  }

  async getAccountAssignmentConfig(
    tenantId: string,
    assignmentType: string,
  ): Promise<AccountAssignmentConfigView | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_account_assignment_configs WHERE tenant_id = $1 AND assignment_type = $2`,
      [tenantId, assignmentType],
    );
    return r.rows[0] ? toAccountAssignmentConfigView(r.rows[0]) : null;
  }
}
