/**
 * ItemStockExposurePort — Anti-Corruption Layer (ACL).
 *
 * Lets Supply Chain Core (Item master) ask the WMS stock ledger whether an
 * item holds on-hand stock in a warehouse whose grade would conflict with a
 * proposed item grade, WITHOUT Core reading `scm_advanced_stock_balances`
 * itself. Core owns the item write; WMS owns the balances. The caller passes
 * the transaction client that already holds the item row lock, so the check
 * and the regrade serialise against `recordMovementTx` (which takes
 * `FOR SHARE` on the item row).
 */
import type { PoolClient } from "pg";

export type ExposureGrade = "food" | "non_food";

export interface ConflictingWarehouseStock {
  warehouseCode: string;
  warehouseGrade: ExposureGrade;
}

export interface ItemStockExposurePort {
  /** Warehouses with a non-null grade different from `newGrade` that hold quantity > 0 of the item. */
  listConflictingWarehouses(
    db: Pick<PoolClient, "query">,
    tenantId: string,
    itemId: string,
    newGrade: ExposureGrade,
  ): Promise<ConflictingWarehouseStock[]>;
}

export class PgItemStockExposurePort implements ItemStockExposurePort {
  async listConflictingWarehouses(
    db: Pick<PoolClient, "query">,
    tenantId: string,
    itemId: string,
    newGrade: ExposureGrade,
  ): Promise<ConflictingWarehouseStock[]> {
    const r = await db.query(
      `SELECT DISTINCT w.code AS warehouse_code, w.grade AS warehouse_grade
         FROM scm_advanced_stock_balances b
         JOIN scm_warehouses w ON w.id = b.warehouse_id AND w.tenant_id = b.tenant_id
        WHERE b.tenant_id = $1 AND b.item_id = $2 AND b.quantity > 0
          AND w.grade IS NOT NULL AND w.grade <> $3
        ORDER BY w.code`,
      [tenantId, itemId, newGrade],
    );
    return r.rows.map((row) => ({
      warehouseCode: row.warehouse_code as string,
      warehouseGrade: row.warehouse_grade as ExposureGrade,
    }));
  }
}
