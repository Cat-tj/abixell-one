import crypto from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { ConflictError, NotFoundError, ValidationError } from "../../../../domain/shared-kernel/errors.js";
import { assertGradeCompatible } from "../domain/grade-policy.js";
import { fromExactUnits, multiplyQuantityCost, toExactUnits } from "../domain/valuation-policy.js";
import type {
  ScmGrade,
  ApplyScmLandedCostInput,
  AwardScmSupplierBidInput,
  ConsumeScmValuationLayerInput,
  CreateScmAccountingReadyEventInput,
  CreateScmConsignmentSettlementInput,
  CreateScmDiscrepancyRecordInput,
  CreateScmInspectionInput,
  CreateScmInspectionResult,
  CreateScmInventoryDisposalInput,
  CreateScmItemBatchInput,
  CreateScmItemSerialInput,
  CreateScmLandedCostInput,
  CreateScmPaymentBatchInput,
  CreateScmReceiptReversalInput,
  CreateScmReceivingRecordInput,
  CreateScmReplacementDeliveryInput,
  CreateScmRfqInput,
  CreateScmReturnToVendorInput,
  CreateScmServiceAcceptanceInput,
  CreateScmSpendAnalyticsSnapshotInput,
  CreateScmVendorInvoiceInput,
  CreateScmStockOpnameInput,
  CreateScmStockReservationInput,
  CreateScmStockTransferInput,
  CreateScmSupplierBidInput,
  CreateScmSupplierContractInput,
  CreateScmSupplierEvaluationInput,
  CreateScmValuationLayerAllocationInput,
  CreateScmWarehouseInput,
  CreateScmWarehouseLocationInput,
  CreateScmWarehouseTaskInput,
  CreateScmValuationLayerInput,
  RecordScmAdvancedStockMovementInput,
  RecordScmStockOpnameCountInput,
  RecordScmStockTransferReceiptInput,
  RecordScmStockTransferShipmentInput,
  RecordScmSupplierContractSpendInput,
  ResolveScmDiscrepancyRecordInput,
  ScmAccountAssignmentConfig,
  ScmAccountAssignmentDimensions,
  ScmAccountAssignmentType,
  ScmAccountingOutboxState,
  ScmAccountingReadyEvent,
  ScmAccountingReadyEventFilter,
  ScmAccountingReadyEventStateTransition,
  ScmAccountingReconciliationState,
  ScmAdvancedStockBalance,
  ScmAdvancedStockBalanceFilter,
  ScmAdvancedStockMovement,
  ScmAdvancedStockMovementFilter,
  ScmConsignmentSettlement,
  ScmConsignmentSettlementFilter,
  ScmConsignmentSettlementLine,
  ScmConsignmentSettlementStatus,
  ScmDiscrepancyRecord,
  ScmDiscrepancyRecordFilter,
  ScmDisposalStatus,
  ScmDisposalType,
  ScmInspection,
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
  ScmPaymentBatch,
  ScmPaymentBatchFilter,
  ScmPaymentBatchStatus,
  ScmPaymentLine,
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
  ScmReservationStatus,
  ScmReturnToVendor,
  ScmReturnToVendorFilter,
  ScmReturnToVendorLine,
  ScmRfq,
  ScmRfqFilter,
  ScmRfqInvitedSupplier,
  ScmRfqItem,
  ScmServiceAcceptance,
  ScmServiceAcceptanceFilter,
  ScmServiceAcceptanceLine,
  ScmServiceAcceptanceStatus,
  ScmVendorInvoice,
  ScmVendorInvoiceFilter,
  ScmVendorInvoiceLine,
  ScmVendorInvoiceStatus,
  ScmSpendAnalyticsPeriodType,
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
  ScmSupplierContract,
  ScmSupplierContractFilter,
  ScmSupplierContractItem,
  ScmSupplierEvaluation,
  ScmSupplierEvaluationFilter,
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

export class PgSupplyChainAdvancedRepository implements SupplyChainAdvancedRepository {
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

  // =========================================================================
  // 1. Warehouses & Storage Locations
  // =========================================================================

  async listOrganizationUnitDescendantIds(tenantId: string, rootIds: string[]): Promise<string[]> {
    if (rootIds.length === 0) return [];
    const r = await this.pool.query(
      `WITH RECURSIVE descendants AS (
         SELECT id
           FROM organization_units
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])
            AND deleted_at IS NULL
         UNION
         SELECT ou.id
           FROM organization_units ou
           JOIN descendants d ON ou.parent_id = d.id
          WHERE ou.tenant_id = $1
            AND ou.deleted_at IS NULL
       )
       SELECT id FROM descendants`,
      [tenantId, rootIds],
    );
    return r.rows.map((row) => row.id as string);
  }

  async createWarehouse(tenantId: string, input: CreateScmWarehouseInput): Promise<ScmWarehouse> {
    const r = await this.pool.query(
      `INSERT INTO scm_warehouses (
         tenant_id, code, name, site_id, organization_unit_id, address, is_active, created_by, updated_by, grade
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
       RETURNING *`,
      [
        tenantId,
        input.code,
        input.name,
        input.siteId ?? null,
        input.organizationUnitId ?? null,
        input.address ?? null,
        input.isActive ?? true,
        input.createdBy ?? null,
        input.grade ?? null,
      ],
    );
    return toWarehouse(r.rows[0]!);
  }

  async updateWarehouse(
    tenantId: string,
    warehouseId: string,
    input: UpdateScmWarehouseInput,
    guard?: (current: ScmWarehouse, heldItemGrades: ScmGrade[]) => void,
  ): Promise<ScmWarehouse | null> {
    if (guard && input.grade !== undefined) {
      // Lock the warehouse row, check held stock and update atomically. Movements
      // take FOR SHARE on this row (queryGradeContext), so they serialise with us.
      return this.inTransaction(async (client) => {
        const cur = await client.query(
          `SELECT * FROM scm_warehouses WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenantId, warehouseId],
        );
        if (!cur.rows[0]) return null;
        const current = toWarehouse(cur.rows[0]);
        if (input.grade !== current.grade) {
          guard(current, await this.queryHeldItemGrades(client, tenantId, warehouseId));
        }
        return this.updateWarehouseRow(client, tenantId, warehouseId, input);
      });
    }
    return this.updateWarehouseRow(this.pool, tenantId, warehouseId, input);
  }

  private async updateWarehouseRow(
    db: Pick<Pool, "query">,
    tenantId: string,
    warehouseId: string,
    input: UpdateScmWarehouseInput,
  ): Promise<ScmWarehouse | null> {
    const r = await db.query(
      `UPDATE scm_warehouses
          SET name = COALESCE($3, name),
              site_id = CASE WHEN $4::boolean THEN $5 ELSE site_id END,
              organization_unit_id = CASE WHEN $6::boolean THEN $7 ELSE organization_unit_id END,
              address = CASE WHEN $8::boolean THEN $9 ELSE address END,
              is_active = COALESCE($10, is_active),
              updated_by = $11,
              grade = CASE WHEN $12::boolean THEN $13 ELSE grade END,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        warehouseId,
        input.name ?? null,
        input.siteId !== undefined,
        input.siteId ?? null,
        input.organizationUnitId !== undefined,
        input.organizationUnitId ?? null,
        input.address !== undefined,
        input.address ?? null,
        input.isActive ?? null,
        input.updatedBy ?? null,
        input.grade !== undefined,
        input.grade ?? null,
      ],
    );
    return r.rows[0] ? toWarehouse(r.rows[0]) : null;
  }

  async findWarehouseById(tenantId: string, warehouseId: string): Promise<ScmWarehouse | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_warehouses WHERE tenant_id = $1 AND id = $2`,
      [tenantId, warehouseId],
    );
    return r.rows[0] ? toWarehouse(r.rows[0]) : null;
  }

  async findWarehouseByCode(tenantId: string, code: string): Promise<ScmWarehouse | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_warehouses WHERE tenant_id = $1 AND code = $2`,
      [tenantId, code],
    );
    return r.rows[0] ? toWarehouse(r.rows[0]) : null;
  }

  async listWarehouses(tenantId: string, filter: ScmWarehouseListFilter = {}): Promise<ScmWarehouse[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.organizationUnitIds !== undefined) {
      if (filter.organizationUnitIds === null) {
        // tenant wide, no filter
      } else if (filter.organizationUnitIds.length === 0) {
        conditions.push(`organization_unit_id IS NULL`);
      } else {
        params.push(filter.organizationUnitIds);
        conditions.push(`(organization_unit_id IS NULL OR organization_unit_id = ANY($${params.length}))`);
      }
    }
    if (filter.siteId) {
      params.push(filter.siteId);
      conditions.push(`site_id = $${params.length}`);
    }
    if (filter.activeOnly) {
      conditions.push(`is_active = true`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_warehouses WHERE ${conditions.join(" AND ")} ORDER BY code`,
      params,
    );
    return r.rows.map(toWarehouse);
  }

  async createWarehouseLocation(
    tenantId: string,
    input: CreateScmWarehouseLocationInput,
  ): Promise<ScmWarehouseLocation> {
    const r = await this.pool.query(
      `INSERT INTO scm_warehouse_locations (
         tenant_id, warehouse_id, code, zone, aisle, rack, shelf, bin, is_active, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        tenantId,
        input.warehouseId,
        input.code,
        input.zone ?? null,
        input.aisle ?? null,
        input.rack ?? null,
        input.shelf ?? null,
        input.bin ?? null,
        input.isActive ?? true,
        input.createdBy ?? null,
      ],
    );
    return toWarehouseLocation(r.rows[0]!);
  }

  async updateWarehouseLocation(
    tenantId: string,
    locationId: string,
    input: UpdateScmWarehouseLocationInput,
  ): Promise<ScmWarehouseLocation | null> {
    const r = await this.pool.query(
      `UPDATE scm_warehouse_locations
          SET zone = CASE WHEN $3::boolean THEN $4 ELSE zone END,
              aisle = CASE WHEN $5::boolean THEN $6 ELSE aisle END,
              rack = CASE WHEN $7::boolean THEN $8 ELSE rack END,
              shelf = CASE WHEN $9::boolean THEN $10 ELSE shelf END,
              bin = CASE WHEN $11::boolean THEN $12 ELSE bin END,
              is_active = COALESCE($13, is_active),
              updated_by = $14,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        locationId,
        input.zone !== undefined,
        input.zone ?? null,
        input.aisle !== undefined,
        input.aisle ?? null,
        input.rack !== undefined,
        input.rack ?? null,
        input.shelf !== undefined,
        input.shelf ?? null,
        input.bin !== undefined,
        input.bin ?? null,
        input.isActive ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toWarehouseLocation(r.rows[0]) : null;
  }

  async findWarehouseLocationById(tenantId: string, locationId: string): Promise<ScmWarehouseLocation | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_warehouse_locations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, locationId],
    );
    return r.rows[0] ? toWarehouseLocation(r.rows[0]) : null;
  }

  async listWarehouseLocations(
    tenantId: string,
    filter: ScmWarehouseLocationListFilter = {},
  ): Promise<ScmWarehouseLocation[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.activeOnly) {
      conditions.push(`is_active = true`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_warehouse_locations WHERE ${conditions.join(" AND ")} ORDER BY code`,
      params,
    );
    return r.rows.map(toWarehouseLocation);
  }

  // =========================================================================
  // Batches & Serials
  // =========================================================================

  async createItemBatch(tenantId: string, input: CreateScmItemBatchInput): Promise<ScmItemBatch> {
    const r = await this.pool.query(
      `INSERT INTO scm_item_batches (
         tenant_id, item_id, batch_number, manufactured_date, expiry_date, supplier_id, notes, is_active, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING *`,
      [
        tenantId,
        input.itemId,
        input.batchNumber,
        input.manufacturedDate ?? null,
        input.expiryDate ?? null,
        input.supplierId ?? null,
        input.notes ?? null,
        input.isActive ?? true,
        input.createdBy ?? null,
      ],
    );
    return toItemBatch(r.rows[0]!);
  }

  async findItemBatchById(tenantId: string, batchId: string): Promise<ScmItemBatch | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_item_batches WHERE tenant_id = $1 AND id = $2`,
      [tenantId, batchId],
    );
    return r.rows[0] ? toItemBatch(r.rows[0]) : null;
  }

  async listItemBatches(tenantId: string, filter: ScmItemBatchListFilter = {}): Promise<ScmItemBatch[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (!filter.includeExpired) {
      conditions.push(`(expiry_date IS NULL OR expiry_date >= CURRENT_DATE)`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_item_batches WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toItemBatch);
  }

  async createItemSerial(tenantId: string, input: CreateScmItemSerialInput): Promise<ScmItemSerial> {
    try {
      const r = await this.pool.query(
        `INSERT INTO scm_item_serials (
           tenant_id, item_id, serial_number, batch_id, warehouse_id, location_id, status, warranty_expiry_date, notes, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING *`,
        [
          tenantId,
          input.itemId,
          input.serialNumber,
          input.batchId ?? null,
          input.warehouseId ?? null,
          input.locationId ?? null,
          input.status ?? "in_stock",
          input.warrantyExpiryDate ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      return toItemSerial(r.rows[0]!);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw new ConflictError(`Serial number ${input.serialNumber} already exists for this item`);
      }
      throw error;
    }
  }

  async updateItemSerial(
    tenantId: string,
    serialId: string,
    input: UpdateScmItemSerialInput,
  ): Promise<ScmItemSerial | null> {
    const r = await this.pool.query(
      `UPDATE scm_item_serials
          SET batch_id = CASE WHEN $3::boolean THEN $4 ELSE batch_id END,
              warehouse_id = CASE WHEN $5::boolean THEN $6 ELSE warehouse_id END,
              location_id = CASE WHEN $7::boolean THEN $8 ELSE location_id END,
              status = COALESCE($9, status),
              warranty_expiry_date = CASE WHEN $10::boolean THEN $11 ELSE warranty_expiry_date END,
              notes = CASE WHEN $12::boolean THEN $13 ELSE notes END,
              updated_by = $14,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        serialId,
        input.batchId !== undefined,
        input.batchId ?? null,
        input.warehouseId !== undefined,
        input.warehouseId ?? null,
        input.locationId !== undefined,
        input.locationId ?? null,
        input.status ?? null,
        input.warrantyExpiryDate !== undefined,
        input.warrantyExpiryDate ?? null,
        input.notes !== undefined,
        input.notes ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toItemSerial(r.rows[0]) : null;
  }

  async findItemSerialById(tenantId: string, serialId: string): Promise<ScmItemSerial | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_item_serials WHERE tenant_id = $1 AND id = $2`,
      [tenantId, serialId],
    );
    return r.rows[0] ? toItemSerial(r.rows[0]) : null;
  }

  async listItemSerials(tenantId: string, filter: ScmItemSerialListFilter = {}): Promise<ScmItemSerial[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds !== undefined) {
      if (filter.warehouseIds === null) {
        // tenant wide
      } else if (filter.warehouseIds.length === 0) {
        conditions.push("1 = 0");
      } else {
        params.push(filter.warehouseIds);
        conditions.push(`warehouse_id = ANY($${params.length})`);
      }
    }
    if (filter.locationId !== undefined) {
      params.push(filter.locationId);
      conditions.push(`location_id = $${params.length}`);
    }
    if (filter.batchId !== undefined) {
      params.push(filter.batchId);
      conditions.push(`batch_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_item_serials WHERE ${conditions.join(" AND ")} ORDER BY serial_number`,
      params,
    );
    return r.rows.map(toItemSerial);
  }

  // =========================================================================
  // Advanced Stock Balances & Immutable Ledger
  // =========================================================================

  async findAdvancedStockBalance(
    tenantId: string,
    itemId: string,
    warehouseId: string,
    locationId: string | null = null,
    batchId: string | null = null,
    stockCondition: ScmStockCondition = "unrestricted",
    ownerType: ScmStockOwnerType = "own",
    ownerPartyId: string | null = null,
  ): Promise<ScmAdvancedStockBalance | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_advanced_stock_balances
        WHERE tenant_id = $1
          AND item_id = $2
          AND warehouse_id = $3
          AND (location_id IS NOT DISTINCT FROM $4)
          AND (batch_id IS NOT DISTINCT FROM $5)
          AND stock_condition = $6
          AND owner_type = $7
          AND (owner_party_id IS NOT DISTINCT FROM $8)`,
      [tenantId, itemId, warehouseId, locationId, batchId, stockCondition, ownerType, ownerPartyId],
    );
    return r.rows[0] ? toStockBalance(r.rows[0]) : null;
  }

  async listAdvancedStockBalances(
    tenantId: string,
    filter: ScmAdvancedStockBalanceFilter = {},
  ): Promise<ScmAdvancedStockBalance[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.locationId !== undefined) {
      params.push(filter.locationId);
      conditions.push(`location_id IS NOT DISTINCT FROM $${params.length}`);
    }
    if (filter.batchId !== undefined) {
      params.push(filter.batchId);
      conditions.push(`batch_id IS NOT DISTINCT FROM $${params.length}`);
    }
    if (filter.stockCondition) {
      params.push(filter.stockCondition);
      conditions.push(`stock_condition = $${params.length}`);
    }
    if (filter.ownerType) {
      params.push(filter.ownerType);
      conditions.push(`owner_type = $${params.length}`);
    }
    if (filter.ownerPartyId !== undefined) {
      params.push(filter.ownerPartyId);
      conditions.push(`owner_party_id IS NOT DISTINCT FROM $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_advanced_stock_balances
        WHERE ${conditions.join(" AND ")}
        ORDER BY item_id, warehouse_id, stock_condition, owner_type, condition_since ASC`,
      params,
    );
    return r.rows.map(toStockBalance);
  }

  async recordAdvancedStockMovement(
    tenantId: string,
    input: RecordScmAdvancedStockMovementInput,
  ): Promise<{ movement: ScmAdvancedStockMovement; balance: ScmAdvancedStockBalance }> {
    return this.inTransaction((client) => this.recordMovementTx(client, tenantId, input));
  }

  /**
   * Movement + balance mutation bound to a caller-supplied transaction.
   *
   * Receiving, inspection and reversal must mutate the stock ledger inside the
   * same transaction as their own documents, so the ledger write cannot be a
   * standalone `inTransaction` call.
   */
  private async recordMovementTx(
    client: PoolClient,
    tenantId: string,
    input: RecordScmAdvancedStockMovementInput,
  ): Promise<{ movement: ScmAdvancedStockMovement; balance: ScmAdvancedStockBalance }> {
    {
      // Food-grade separation: every ledger write (receipt, issue, transfer
      // legs, adjustment, opname, disposal, ...) funnels through here, so this
      // is the one place the rule cannot be bypassed. NULL grade = unrestricted.
      const gradeCtx = await this.queryGradeContext(client, tenantId, input.itemId, input.warehouseId, true);
      if (gradeCtx) assertGradeCompatible(gradeCtx);

      const stockCondition = input.stockCondition ?? "unrestricted";
      const ownerType = input.ownerType ?? "own";
      const ownerPartyId = input.ownerPartyId ?? null;

      const movRes = await client.query(
        `INSERT INTO scm_advanced_stock_movements (
           tenant_id, item_id, warehouse_id, location_id, batch_id, serial_id,
           stock_condition, owner_type, owner_party_id,
           movement_type, quantity, unit_cost, total_cost, reference_type,
           reference_id, reference_number, reversed_movement_id, accounting_ready_event_id,
           notes, occurred_at, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12, $13, $14,
           $15, $16, $17, $18,
           $19, COALESCE($20, now()), $21
         )
         RETURNING *`,
        [
          tenantId,
          input.itemId,
          input.warehouseId,
          input.locationId ?? null,
          input.batchId ?? null,
          input.serialId ?? null,
          stockCondition,
          ownerType,
          ownerPartyId,
          input.movementType,
          input.quantity,
          input.unitCost ?? null,
          input.totalCost ?? null,
          input.referenceType ?? null,
          input.referenceId ?? null,
          input.referenceNumber ?? null,
          input.reversedMovementId ?? null,
          input.accountingReadyEventId ?? null,
          input.notes ?? null,
          input.occurredAt ?? null,
          input.createdBy ?? null,
        ],
      );
      const movement = toStockMovement(movRes.rows[0]!);

      const isPositive =
        input.movementType === "in" ||
        input.movementType === "transfer_in" ||
        input.movementType === "adjustment_in" ||
        input.movementType === "opname_in" ||
        input.movementType === "inspection_hold_in" ||
        input.movementType === "inspection_release_in" ||
        input.movementType === "receipt_reversal_in" ||
        input.movementType === "consignment_in" ||
        input.movementType === "replacement_in";
      const delta = isPositive ? input.quantity : -input.quantity;

      const balRes = await client.query(
        `SELECT * FROM scm_advanced_stock_balances
          WHERE tenant_id = $1
            AND item_id = $2
            AND warehouse_id = $3
            AND (location_id IS NOT DISTINCT FROM $4)
            AND (batch_id IS NOT DISTINCT FROM $5)
            AND stock_condition = $6
            AND owner_type = $7
            AND (owner_party_id IS NOT DISTINCT FROM $8)
          FOR UPDATE`,
        [
          tenantId,
          input.itemId,
          input.warehouseId,
          input.locationId ?? null,
          input.batchId ?? null,
          stockCondition,
          ownerType,
          ownerPartyId,
        ],
      );

      let balance: ScmAdvancedStockBalance;

      if (balRes.rows.length > 0) {
        const existing = balRes.rows[0]!;
        const currentQty = num(existing.quantity);
        const currentReserved = num(existing.reserved_qty);
        const newQty = currentQty + delta;

        if (newQty < 0) {
          throw new ConflictError(
            `Insufficient stock: current balance is ${currentQty}, requested reduction is ${input.quantity}`,
          );
        }
        if (newQty < currentReserved) {
          throw new ConflictError(
            `Stock reduction exceeds unreserved balance: remaining ${newQty} would drop below reserved ${currentReserved}`,
          );
        }

        const upRes = await client.query(
          `UPDATE scm_advanced_stock_balances
              SET quantity = $1, updated_at = now()
            WHERE id = $2
            RETURNING *`,
          [newQty, existing.id],
        );
        balance = toStockBalance(upRes.rows[0]!);
      } else {
        if (delta < 0) {
          throw new ConflictError(
            `Insufficient stock: no balance exists in warehouse for item ${input.itemId}`,
          );
        }
        const insRes = await client.query(
          `INSERT INTO scm_advanced_stock_balances (
             tenant_id, item_id, warehouse_id, location_id, batch_id,
             stock_condition, owner_type, owner_party_id, condition_since,
             quantity, reserved_qty, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10, 0, now())
           RETURNING *`,
          [
            tenantId,
            input.itemId,
            input.warehouseId,
            input.locationId ?? null,
            input.batchId ?? null,
            stockCondition,
            ownerType,
            ownerPartyId,
            input.occurredAt ?? null,
            input.quantity,
          ],
        );
        balance = toStockBalance(insRes.rows[0]!);
      }

      if (input.serialId) {
        let newStatus = "in_stock";
        if (input.movementType === "out" || input.movementType === "adjustment_out") {
          newStatus = "issued";
        } else if (input.movementType === "transfer_out") {
          newStatus = "in_transit";
        } else if (input.movementType === "disposal_out") {
          newStatus = "disposed";
        } else if (input.movementType === "transfer_in" || input.movementType === "in") {
          newStatus = "in_stock";
        }
        await client.query(
          `UPDATE scm_item_serials
              SET status = $1,
                  warehouse_id = $2,
                  location_id = $3,
                  batch_id = COALESCE($4, batch_id),
                  updated_at = now()
            WHERE tenant_id = $5 AND id = $6`,
          [newStatus, input.warehouseId, input.locationId ?? null, input.batchId ?? null, tenantId, input.serialId],
        );
      }

      return { movement, balance };
    }
  }

  async listAdvancedStockMovements(
    tenantId: string,
    filter: ScmAdvancedStockMovementFilter = {},
  ): Promise<ScmAdvancedStockMovement[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.locationId !== undefined) {
      params.push(filter.locationId);
      conditions.push(`location_id IS NOT DISTINCT FROM $${params.length}`);
    }
    if (filter.batchId !== undefined) {
      params.push(filter.batchId);
      conditions.push(`batch_id IS NOT DISTINCT FROM $${params.length}`);
    }
    if (filter.stockCondition) {
      params.push(filter.stockCondition);
      conditions.push(`stock_condition = $${params.length}`);
    }
    if (filter.ownerType) {
      params.push(filter.ownerType);
      conditions.push(`owner_type = $${params.length}`);
    }
    if (filter.ownerPartyId !== undefined) {
      params.push(filter.ownerPartyId);
      conditions.push(`owner_party_id IS NOT DISTINCT FROM $${params.length}`);
    }
    if (filter.referenceType) {
      params.push(filter.referenceType);
      conditions.push(`reference_type = $${params.length}`);
    }
    if (filter.referenceId) {
      params.push(filter.referenceId);
      conditions.push(`reference_id = $${params.length}`);
    }
    if (filter.movementType) {
      params.push(filter.movementType);
      conditions.push(`movement_type = $${params.length}`);
    }
    if (filter.occurredFrom) {
      params.push(filter.occurredFrom);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (filter.occurredTo) {
      params.push(filter.occurredTo);
      conditions.push(`occurred_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_advanced_stock_movements
        WHERE ${conditions.join(" AND ")}
        ORDER BY occurred_at DESC, created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toStockMovement);
  }

  // =========================================================================
  // 2. Reorder Policies
  // =========================================================================

  async upsertReorderPolicy(tenantId: string, input: UpsertScmReorderPolicyInput): Promise<ScmReorderPolicy> {
    const r = await this.pool.query(
      `INSERT INTO scm_reorder_policies (
         tenant_id, item_id, warehouse_id, min_quantity, reorder_point,
         reorder_quantity, safety_stock, lead_time_days, is_active, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (tenant_id, item_id, warehouse_id) WHERE warehouse_id IS NOT NULL
       DO UPDATE SET
         min_quantity = EXCLUDED.min_quantity,
         reorder_point = EXCLUDED.reorder_point,
         reorder_quantity = EXCLUDED.reorder_quantity,
         safety_stock = EXCLUDED.safety_stock,
         lead_time_days = EXCLUDED.lead_time_days,
         is_active = EXCLUDED.is_active,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        tenantId,
        input.itemId,
        input.warehouseId ?? null,
        input.minQuantity,
        input.reorderPoint,
        input.reorderQuantity,
        input.safetyStock ?? 0,
        input.leadTimeDays ?? 0,
        input.isActive ?? true,
        input.createdBy ?? input.updatedBy ?? null,
      ],
    );
    return toReorderPolicy(r.rows[0]!);
  }

  async listReorderPolicies(tenantId: string, filter: ScmReorderPolicyFilter = {}): Promise<ScmReorderPolicy[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (filter.warehouseId !== undefined) {
      if (filter.warehouseId === null) {
        conditions.push(`warehouse_id IS NULL`);
      } else {
        params.push(filter.warehouseId);
        conditions.push(`warehouse_id = $${params.length}`);
      }
    }
    if (filter.activeOnly) {
      conditions.push(`is_active = true`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_reorder_policies WHERE ${conditions.join(" AND ")} ORDER BY item_id`,
      params,
    );
    return r.rows.map(toReorderPolicy);
  }

  // =========================================================================
  // Stock Reservations
  // =========================================================================

  async createStockReservation(
    tenantId: string,
    input: CreateScmStockReservationInput,
  ): Promise<ScmStockReservation> {
    return this.inTransaction(async (client) => {
      // 1. Lock and increment reserved_qty on balance
      const balRes = await client.query(
        `SELECT * FROM scm_advanced_stock_balances
          WHERE tenant_id = $1
            AND item_id = $2
            AND warehouse_id = $3
            AND (location_id IS NOT DISTINCT FROM $4)
            AND (batch_id IS NOT DISTINCT FROM $5)
          FOR UPDATE`,
        [tenantId, input.itemId, input.warehouseId, input.locationId ?? null, input.batchId ?? null],
      );

      if (balRes.rows.length === 0) {
        throw new ConflictError("Cannot reserve stock: no balance exists for this item in warehouse");
      }

      const bal = balRes.rows[0]!;
      const available = num(bal.quantity) - num(bal.reserved_qty);
      if (available < input.quantity) {
        throw new ConflictError(
          `Insufficient available stock for reservation: requested ${input.quantity}, available ${available}`,
        );
      }

      await client.query(
        `UPDATE scm_advanced_stock_balances
            SET reserved_qty = reserved_qty + $1, updated_at = now()
          WHERE id = $2`,
        [input.quantity, bal.id],
      );

      // 2. Insert reservation record
      const resRes = await client.query(
        `INSERT INTO scm_stock_reservations (
           tenant_id, reservation_number, item_id, warehouse_id, location_id, batch_id,
           quantity, reserved_for_type, reserved_for_id, reserved_for_number,
           status, valid_until, notes, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12, $13, $13)
         RETURNING *`,
        [
          tenantId,
          input.reservationNumber,
          input.itemId,
          input.warehouseId,
          input.locationId ?? null,
          input.batchId ?? null,
          input.quantity,
          input.reservedForType,
          input.reservedForId ?? null,
          input.reservedForNumber ?? null,
          input.validUntil ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );

      return toStockReservation(resRes.rows[0]!);
    });
  }

  async updateStockReservationStatus(
    tenantId: string,
    reservationId: string,
    status: ScmReservationStatus,
    timestamp: Date,
    createdBy: string | null = null,
  ): Promise<ScmStockReservation | null> {
    return this.inTransaction(async (client) => {
      const resRes = await client.query(
        `SELECT * FROM scm_stock_reservations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, reservationId],
      );
      if (resRes.rows.length === 0) return null;
      const reservation = toStockReservation(resRes.rows[0]!);

      if (reservation.status === "active" && (status === "cancelled" || status === "expired" || status === "fulfilled")) {
        // Release reserved_qty on balance FIRST: fulfilling issues the goods,
        // and the ledger refuses any reduction that would drop the balance
        // below what is still reserved.
        await client.query(
          `UPDATE scm_advanced_stock_balances
              SET reserved_qty = GREATEST(0, reserved_qty - $1), updated_at = now()
            WHERE tenant_id = $2
              AND item_id = $3
              AND warehouse_id = $4
              AND (location_id IS NOT DISTINCT FROM $5)
              AND (batch_id IS NOT DISTINCT FROM $6)`,
          [
            reservation.quantity,
            tenantId,
            reservation.itemId,
            reservation.warehouseId,
            reservation.locationId,
            reservation.batchId,
          ],
        );
      }

      // Fulfilling a reservation issues the goods for real: the stock leaves
      // the warehouse, not just the reserved bucket.
      if (reservation.status === "active" && status === "fulfilled") {
        const context = await this.resolveAccountingContextTx(
          client,
          tenantId,
          reservation.warehouseId,
          timestamp,
        );
        const unitCost = await this.resolveUnitCostTx(
          client,
          tenantId,
          reservation.itemId,
          reservation.warehouseId,
        );
        const preallocatedEventId = crypto.randomUUID();

        const issued = await this.recordMovementTx(client, tenantId, {
          itemId: reservation.itemId,
          warehouseId: reservation.warehouseId,
          locationId: reservation.locationId,
          batchId: reservation.batchId,
          stockCondition: "unrestricted",
          ownerType: "own",
          ownerPartyId: null,
          movementType: "out",
          quantity: reservation.quantity,
          unitCost,
          totalCost: multiplyQuantityCost(reservation.quantity, unitCost),
          referenceType: "scm_stock_reservation",
          referenceId: reservation.id,
          referenceNumber: reservation.reservationNumber,
          accountingReadyEventId: preallocatedEventId,
          notes: `Issued for reservation ${reservation.reservationNumber} (${reservation.reservedForType})`,
          occurredAt: timestamp,
          createdBy,
        });

        await this.createAccountingReadyEventTx(
          client,
          tenantId,
          {
            eventType: "inventory.goods_issued",
            sourceDocumentType: "scm_stock_reservation",
            sourceDocumentId: reservation.id,
            sourceMovementId: issued.movement.id,
            effectiveAt: timestamp,
            amount: multiplyQuantityCost(reservation.quantity, unitCost),
            quantity: reservation.quantity,
            unitCost,
            accountAssignmentType: "expense",
            accountAssignmentDimensions: { legalEntityId: context.legalEntityId },
            idempotencyKey: `reservation-fulfil:${reservation.id}`,
            payload: {
              legalEntityId: context.legalEntityId,
              periodId: context.periodId,
              reservationNumber: reservation.reservationNumber,
              reservedForType: reservation.reservedForType,
              reservedForId: reservation.reservedForId,
              warehouseId: reservation.warehouseId,
            },
            createdBy,
          },
          preallocatedEventId,
        );
      }

      const fulfilledAt = status === "fulfilled" ? timestamp : reservation.fulfilledAt;
      const cancelledAt = (status === "cancelled" || status === "expired") ? timestamp : reservation.cancelledAt;

      const upRes = await client.query(
        `UPDATE scm_stock_reservations
            SET status = $1,
                fulfilled_at = $2,
                cancelled_at = $3,
                updated_at = now()
          WHERE tenant_id = $4 AND id = $5
          RETURNING *`,
        [status, fulfilledAt, cancelledAt, tenantId, reservationId],
      );
      return toStockReservation(upRes.rows[0]!);
    });
  }

  async findStockReservationById(tenantId: string, reservationId: string): Promise<ScmStockReservation | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_stock_reservations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, reservationId],
    );
    return r.rows[0] ? toStockReservation(r.rows[0]) : null;
  }

  async listStockReservations(
    tenantId: string,
    filter: ScmStockReservationFilter = {},
  ): Promise<ScmStockReservation[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.reservedForType) {
      params.push(filter.reservedForType);
      conditions.push(`reserved_for_type = $${params.length}`);
    }
    if (filter.reservedForId) {
      params.push(filter.reservedForId);
      conditions.push(`reserved_for_id = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_stock_reservations WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toStockReservation);
  }

  // =========================================================================
  // Stock Transfers
  // =========================================================================

  async createStockTransfer(
    tenantId: string,
    input: CreateScmStockTransferInput,
  ): Promise<{ transfer: ScmStockTransfer; lines: ScmStockTransferLine[] }> {
    return this.inTransaction(async (client) => {
      const trRes = await client.query(
        `INSERT INTO scm_stock_transfers (
           tenant_id, transfer_number, from_warehouse_id, to_warehouse_id,
           status, notes, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $6)
         RETURNING *`,
        [
          tenantId,
          input.transferNumber,
          input.fromWarehouseId,
          input.toWarehouseId,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const transfer = toStockTransfer(trRes.rows[0]!);

      const lines: ScmStockTransferLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const lRes = await client.query(
          `INSERT INTO scm_stock_transfer_lines (
             tenant_id, transfer_id, item_id, from_location_id, to_location_id,
             batch_id, quantity_requested, quantity_shipped, quantity_received, notes, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)
           RETURNING *`,
          [
            tenantId,
            transfer.id,
            line.itemId,
            line.fromLocationId ?? null,
            line.toLocationId ?? null,
            line.batchId ?? null,
            line.quantityRequested,
            line.notes ?? null,
            line.sortOrder ?? sort++,
          ],
        );
        lines.push(toStockTransferLine(lRes.rows[0]!));
      }

      return { transfer, lines };
    });
  }

  async updateStockTransferProjection(
    tenantId: string,
    input: UpdateScmStockTransferProjectionInput,
  ): Promise<ScmStockTransfer | null> {
    const r = await this.pool.query(
      `UPDATE scm_stock_transfers
          SET status = $3,
              workflow_instance_id = CASE WHEN $4::boolean THEN $5 ELSE workflow_instance_id END,
              shipped_at = CASE WHEN $6::boolean THEN $7 ELSE shipped_at END,
              received_at = CASE WHEN $8::boolean THEN $9 ELSE received_at END,
              cancelled_at = CASE WHEN $10::boolean THEN $11 ELSE cancelled_at END,
              notes = CASE WHEN $12::boolean THEN $13 ELSE notes END,
              updated_by = $14,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.transferId,
        input.status,
        input.workflowInstanceId !== undefined,
        input.workflowInstanceId ?? null,
        input.shippedAt !== undefined,
        input.shippedAt ?? null,
        input.receivedAt !== undefined,
        input.receivedAt ?? null,
        input.cancelledAt !== undefined,
        input.cancelledAt ?? null,
        input.notes !== undefined,
        input.notes ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toStockTransfer(r.rows[0]) : null;
  }

  async deleteStockTransferWithoutWorkflow(tenantId: string, transferId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_stock_transfers
        WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, transferId],
    );
  }

  async recordStockTransferShipment(
    tenantId: string,
    input: RecordScmStockTransferShipmentInput,
  ): Promise<ScmStockTransferLine[]> {
    return this.inTransaction(async (client) => {
      const trRes = await client.query(
        `SELECT * FROM scm_stock_transfers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, input.transferId],
      );
      if (!trRes.rows[0]) throw new NotFoundError("ScmStockTransfer", input.transferId);
      const transfer = toStockTransfer(trRes.rows[0]);

      const updatedLines: ScmStockTransferLine[] = [];
      for (const item of input.lineShipments) {
        if (item.quantityShipped <= 0) continue;
        const r = await client.query(
          `UPDATE scm_stock_transfer_lines
              SET quantity_shipped = quantity_shipped + $3
            WHERE tenant_id = $1 AND id = $2 AND transfer_id = $4
              AND quantity_shipped + $3 <= quantity_requested
            RETURNING *`,
          [tenantId, item.lineId, item.quantityShipped, input.transferId],
        );
        if (!r.rows[0]) {
          throw new ConflictError(
            `Transfer line ${item.lineId} cannot ship ${item.quantityShipped}: it would exceed the requested quantity, or the line does not belong to this transfer`,
          );
        }
        const line = toStockTransferLine(r.rows[0]);

        // Goods leave the source warehouse's unrestricted stock.
        await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: transfer.fromWarehouseId,
          locationId: line.fromLocationId,
          batchId: line.batchId,
          stockCondition: "unrestricted",
          ownerType: "own",
          ownerPartyId: null,
          movementType: "transfer_out",
          quantity: item.quantityShipped,
          referenceType: "scm_stock_transfer",
          referenceId: transfer.id,
          referenceNumber: transfer.transferNumber,
          notes: `Shipped on transfer ${transfer.transferNumber}`,
          createdBy: input.createdBy ?? null,
        });

        // They land in an in-transit position at the destination warehouse with
        // NO bin/locator: the receiver has not acknowledged them yet, so they
        // must not be pickable from any location.
        await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: transfer.toWarehouseId,
          locationId: null,
          batchId: line.batchId,
          stockCondition: "in_transit",
          ownerType: "own",
          ownerPartyId: null,
          movementType: "transfer_in",
          quantity: item.quantityShipped,
          referenceType: "scm_stock_transfer",
          referenceId: transfer.id,
          referenceNumber: transfer.transferNumber,
          notes: `In transit on transfer ${transfer.transferNumber}`,
          createdBy: input.createdBy ?? null,
        });

        updatedLines.push(line);
      }

      await client.query(
        `UPDATE scm_stock_transfers
            SET status = 'in_transit', shipped_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, input.transferId],
      );

      return updatedLines;
    });
  }

  async recordStockTransferReceipt(
    tenantId: string,
    input: RecordScmStockTransferReceiptInput,
  ): Promise<ScmStockTransferLine[]> {
    return this.inTransaction(async (client) => {
      const trRes = await client.query(
        `SELECT * FROM scm_stock_transfers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, input.transferId],
      );
      if (!trRes.rows[0]) throw new NotFoundError("ScmStockTransfer", input.transferId);
      const transfer = toStockTransfer(trRes.rows[0]);

      const updatedLines: ScmStockTransferLine[] = [];
      for (const item of input.lineReceipts) {
        if (item.quantityReceived <= 0) continue;
        // Partial receipt is allowed per line; a line can never receive more
        // than was actually shipped.
        const r = await client.query(
          `UPDATE scm_stock_transfer_lines
              SET quantity_received = quantity_received + $3
            WHERE tenant_id = $1 AND id = $2 AND transfer_id = $4
              AND quantity_received + $3 <= quantity_shipped
            RETURNING *`,
          [tenantId, item.lineId, item.quantityReceived, input.transferId],
        );
        if (!r.rows[0]) {
          throw new ConflictError(
            `Transfer line ${item.lineId} cannot receive ${item.quantityReceived}: it would exceed the shipped quantity, or the line does not belong to this transfer`,
          );
        }
        const line = toStockTransferLine(r.rows[0]);

        // Goods leave the in-transit position...
        await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: transfer.toWarehouseId,
          locationId: null,
          batchId: line.batchId,
          stockCondition: "in_transit",
          ownerType: "own",
          ownerPartyId: null,
          movementType: "transfer_out",
          quantity: item.quantityReceived,
          referenceType: "scm_stock_transfer",
          referenceId: transfer.id,
          referenceNumber: transfer.transferNumber,
          notes: `Received from transit on transfer ${transfer.transferNumber}`,
          createdBy: input.createdBy ?? null,
        });

        // ...and become pickable unrestricted stock in the destination bin.
        await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: transfer.toWarehouseId,
          locationId: line.toLocationId,
          batchId: line.batchId,
          stockCondition: "unrestricted",
          ownerType: "own",
          ownerPartyId: null,
          movementType: "transfer_in",
          quantity: item.quantityReceived,
          referenceType: "scm_stock_transfer",
          referenceId: transfer.id,
          referenceNumber: transfer.transferNumber,
          notes: `Received on transfer ${transfer.transferNumber}`,
          createdBy: input.createdBy ?? null,
        });

        updatedLines.push(line);
      }

      // Only close the transfer when every shipped quantity has been received.
      const pendingRes = await client.query(
        `SELECT COUNT(*)::int AS pending
           FROM scm_stock_transfer_lines
          WHERE tenant_id = $1 AND transfer_id = $2 AND quantity_received < quantity_shipped`,
        [tenantId, input.transferId],
      );
      const stillPending = num(pendingRes.rows[0]?.pending) > 0;

      await client.query(
        `UPDATE scm_stock_transfers
            SET status = $3, received_at = CASE WHEN $3 = 'received' THEN now() ELSE received_at END,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, input.transferId, stillPending ? "in_transit" : "received"],
      );

      return updatedLines;
    });
  }

  /**
   * Returns an in-transit transfer to draft so the sender can revise it.
   *
   * Only the portion that is still in transit is pulled back to the source
   * warehouse; anything the receiver already accepted stays acknowledged in
   * the destination bin. The doc's shipped quantity is reset to the received
   * quantity, so a later re-shipment starts from what has not been accepted.
   */
  async revertStockTransferToDraft(
    tenantId: string,
    transferId: string,
    createdBy: string | null,
  ): Promise<ScmStockTransferLine[]> {
    return this.inTransaction(async (client) => {
      const trRes = await client.query(
        `SELECT * FROM scm_stock_transfers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, transferId],
      );
      if (!trRes.rows[0]) throw new NotFoundError("ScmStockTransfer", transferId);
      const transfer = toStockTransfer(trRes.rows[0]);
      if (transfer.status !== "in_transit") {
        throw new ConflictError(
          `Only an in-transit transfer can be returned to draft; current status is ${transfer.status}`,
        );
      }

      const linesRes = await client.query(
        `SELECT * FROM scm_stock_transfer_lines WHERE tenant_id = $1 AND transfer_id = $2 ORDER BY sort_order`,
        [tenantId, transferId],
      );

      const updatedLines: ScmStockTransferLine[] = [];
      for (const row of linesRes.rows) {
        const line = toStockTransferLine(row);
        const inTransit = line.quantityShipped - line.quantityReceived;

        if (inTransit > 0) {
          await this.recordMovementTx(client, tenantId, {
            itemId: line.itemId,
            warehouseId: transfer.toWarehouseId,
            locationId: null,
            batchId: line.batchId,
            stockCondition: "in_transit",
            ownerType: "own",
            ownerPartyId: null,
            movementType: "transfer_out",
            quantity: inTransit,
            referenceType: "scm_stock_transfer",
            referenceId: transfer.id,
            referenceNumber: transfer.transferNumber,
            notes: `Pulled back from transit for revision on transfer ${transfer.transferNumber}`,
            createdBy,
          });

          await this.recordMovementTx(client, tenantId, {
            itemId: line.itemId,
            warehouseId: transfer.fromWarehouseId,
            locationId: line.fromLocationId,
            batchId: line.batchId,
            stockCondition: "unrestricted",
            ownerType: "own",
            ownerPartyId: null,
            movementType: "transfer_in",
            quantity: inTransit,
            referenceType: "scm_stock_transfer",
            referenceId: transfer.id,
            referenceNumber: transfer.transferNumber,
            notes: `Returned to source for revision on transfer ${transfer.transferNumber}`,
            createdBy,
          });
        }

        const upRes = await client.query(
          `UPDATE scm_stock_transfer_lines
              SET quantity_shipped = quantity_received
            WHERE tenant_id = $1 AND id = $2
            RETURNING *`,
          [tenantId, line.id],
        );
        updatedLines.push(toStockTransferLine(upRes.rows[0]!));
      }

      await client.query(
        `UPDATE scm_stock_transfers
            SET status = 'draft', shipped_at = NULL, updated_at = now(), updated_by = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, transferId, createdBy],
      );

      return updatedLines;
    });
  }

  async findStockTransferById(
    tenantId: string,
    transferId: string,
  ): Promise<{ transfer: ScmStockTransfer; lines: ScmStockTransferLine[] } | null> {
    const trRes = await this.pool.query(
      `SELECT * FROM scm_stock_transfers WHERE tenant_id = $1 AND id = $2`,
      [tenantId, transferId],
    );
    if (!trRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_stock_transfer_lines WHERE tenant_id = $1 AND transfer_id = $2 ORDER BY sort_order`,
      [tenantId, transferId],
    );
    return {
      transfer: toStockTransfer(trRes.rows[0]),
      lines: linesRes.rows.map(toStockTransferLine),
    };
  }

  async listStockTransfers(tenantId: string, filter: ScmStockTransferFilter = {}): Promise<ScmStockTransfer[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.fromWarehouseId) {
      params.push(filter.fromWarehouseId);
      conditions.push(`from_warehouse_id = $${params.length}`);
    }
    if (filter.toWarehouseId) {
      params.push(filter.toWarehouseId);
      conditions.push(`to_warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`(from_warehouse_id = ANY($${params.length}) OR to_warehouse_id = ANY($${params.length}))`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_stock_transfers WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toStockTransfer);
  }

  // =========================================================================
  // Stock Opname
  // =========================================================================

  async createStockOpname(
    tenantId: string,
    input: CreateScmStockOpnameInput,
  ): Promise<{ opname: ScmStockOpname; lines: ScmStockOpnameLine[] }> {
    return this.inTransaction(async (client) => {
      const opRes = await client.query(
        `INSERT INTO scm_stock_opnames (
           tenant_id, opname_number, warehouse_id, opname_date, status, notes, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $6)
         RETURNING *`,
        [
          tenantId,
          input.opnameNumber,
          input.warehouseId,
          input.opnameDate,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const opname = toStockOpname(opRes.rows[0]!);

      const lines: ScmStockOpnameLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const physical = line.physicalQuantity ?? null;
        const variance = physical !== null ? physical - line.systemQuantity : null;
        const lRes = await client.query(
          `INSERT INTO scm_stock_opname_lines (
             tenant_id, opname_id, item_id, location_id, batch_id,
             system_quantity, physical_quantity, variance_quantity, notes, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            tenantId,
            opname.id,
            line.itemId,
            line.locationId ?? null,
            line.batchId ?? null,
            line.systemQuantity,
            physical,
            variance,
            line.notes ?? null,
            line.sortOrder ?? sort++,
          ],
        );
        lines.push(toStockOpnameLine(lRes.rows[0]!));
      }

      return { opname, lines };
    });
  }

  async updateStockOpnameProjection(
    tenantId: string,
    input: UpdateScmStockOpnameProjectionInput,
  ): Promise<ScmStockOpname | null> {
    const r = await this.pool.query(
      `UPDATE scm_stock_opnames
          SET status = $3,
              workflow_instance_id = CASE WHEN $4::boolean THEN $5 ELSE workflow_instance_id END,
              completed_at = CASE WHEN $6::boolean THEN $7 ELSE completed_at END,
              completed_by = CASE WHEN $8::boolean THEN $9 ELSE completed_by END,
              notes = CASE WHEN $10::boolean THEN $11 ELSE notes END,
              updated_by = $12,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.opnameId,
        input.status,
        input.workflowInstanceId !== undefined,
        input.workflowInstanceId ?? null,
        input.completedAt !== undefined,
        input.completedAt ?? null,
        input.completedBy !== undefined,
        input.completedBy ?? null,
        input.notes !== undefined,
        input.notes ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toStockOpname(r.rows[0]) : null;
  }

  async deleteStockOpnameWithoutWorkflow(tenantId: string, opnameId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_stock_opnames
        WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, opnameId],
    );
  }

  async recordStockOpnameCount(
    tenantId: string,
    input: RecordScmStockOpnameCountInput,
  ): Promise<ScmStockOpnameLine | null> {
    const r = await this.pool.query(
      `UPDATE scm_stock_opname_lines
          SET physical_quantity = $3,
              variance_quantity = $3 - system_quantity
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, input.lineId, input.physicalQuantity],
    );
    return r.rows[0] ? toStockOpnameLine(r.rows[0]) : null;
  }

  async linkOpnameLineAdjustmentMovement(
    tenantId: string,
    lineId: string,
    adjustmentMovementId: string,
  ): Promise<ScmStockOpnameLine | null> {
    const r = await this.pool.query(
      `UPDATE scm_stock_opname_lines
          SET adjustment_movement_id = $3
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, lineId, adjustmentMovementId],
    );
    return r.rows[0] ? toStockOpnameLine(r.rows[0]) : null;
  }

  /**
   * Posts every counted variance as a real stock adjustment and marks the
   * opname `adjusted` — one transaction, so the ledger and the document can
   * never disagree about whether the count was applied.
   *
   * Idempotent by construction: a line that already has an
   * `adjustment_movement_id` is skipped, so re-running never double-counts.
   * Lines with no physical count, or no variance, are left alone.
   */
  async applyStockOpnameAdjustments(
    tenantId: string,
    opnameId: string,
    createdBy: string | null,
  ): Promise<ScmStockOpnameLine[]> {
    return this.inTransaction(async (client) => {
      const opRes = await client.query(
        `SELECT * FROM scm_stock_opnames WHERE tenant_id = $1 AND id = $2`,
        [tenantId, opnameId],
      );
      if (!opRes.rows[0]) throw new NotFoundError("ScmStockOpname", opnameId);
      const opname = toStockOpname(opRes.rows[0]);

      const linesRes = await client.query(
        `SELECT * FROM scm_stock_opname_lines
          WHERE tenant_id = $1 AND opname_id = $2
          ORDER BY sort_order
          FOR UPDATE`,
        [tenantId, opnameId],
      );

      const updated: ScmStockOpnameLine[] = [];
      for (const row of linesRes.rows) {
        const line = toStockOpnameLine(row);
        if (line.adjustmentMovementId || line.physicalQuantity === null) continue;

        const variance = num(line.physicalQuantity) - num(line.systemQuantity);
        if (variance === 0) continue;

        // A line counted at warehouse level carries no bin. Posting it against a
        // null-location bucket would miss the stock that actually sits in a bin,
        // so resolve the one position holding it. Ambiguous counts are refused
        // rather than guessed.
        let locationId = line.locationId;
        let batchId = line.batchId;
        if (!locationId) {
          const posRes = await client.query(
            `SELECT location_id, batch_id FROM scm_advanced_stock_balances
              WHERE tenant_id = $1 AND item_id = $2 AND warehouse_id = $3
                AND quantity > 0
                AND stock_condition = 'unrestricted' AND owner_type = 'own'
                AND owner_party_id IS NULL
                AND (location_id IS NOT NULL OR batch_id IS NOT NULL)`,
            [tenantId, line.itemId, opname.warehouseId],
          );
          if (posRes.rows.length === 1) {
            locationId = posRes.rows[0]!.location_id;
            batchId = posRes.rows[0]!.batch_id;
          } else if (posRes.rows.length > 1) {
            throw new ValidationError(
              `Opname line ${line.id} has no storage location but item ${line.itemId} is held in ${posRes.rows.length} positions; count per bin instead`,
            );
          }
        }

        const context = await this.resolveAccountingContextTx(
          client,
          tenantId,
          opname.warehouseId,
          opname.completedAt ?? new Date(),
        );
        const unitCost = await this.resolveUnitCostTx(
          client,
          tenantId,
          line.itemId,
          opname.warehouseId,
        );
        const varianceQty = Math.abs(variance);
        const amount = multiplyQuantityCost(varianceQty, unitCost);
        const preallocatedEventId = crypto.randomUUID();

        const movement = await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: opname.warehouseId,
          locationId,
          batchId,
          stockCondition: "unrestricted",
          ownerType: "own",
          ownerPartyId: null,
          movementType: variance > 0 ? "opname_in" : "opname_out",
          quantity: varianceQty,
          unitCost,
          totalCost: amount,
          referenceType: "scm_stock_opname",
          referenceId: opname.id,
          referenceNumber: opname.opnameNumber,
          accountingReadyEventId: preallocatedEventId,
          notes: `Opname adjustment on ${opname.opnameNumber}: system ${line.systemQuantity}, physical ${line.physicalQuantity}`,
          createdBy,
        });

        // Surplus and shrinkage need opposite journal sides, and a posting rule
        // is chosen by event type alone (amountExpression only knows a positive
        // AMOUNT). They therefore emit different event types.
        await this.createAccountingReadyEventTx(
          client,
          tenantId,
          {
            eventType: variance > 0 ? "inventory.goods_received" : "inventory.adjusted",
            sourceDocumentType: "scm_stock_opname",
            sourceDocumentId: opname.id,
            sourceDocumentLineId: line.id,
            sourceMovementId: movement.movement.id,
            effectiveAt: opname.completedAt ?? new Date(),
            amount,
            quantity: varianceQty,
            unitCost,
            accountAssignmentType: "stock",
            accountAssignmentDimensions: { legalEntityId: context.legalEntityId },
            idempotencyKey: `opname-adjust:${line.id}`,
            payload: {
              legalEntityId: context.legalEntityId,
              periodId: context.periodId,
              opnameNumber: opname.opnameNumber,
              warehouseId: opname.warehouseId,
              systemQuantity: num(line.systemQuantity),
              physicalQuantity: num(line.physicalQuantity),
              variance,
            },
            createdBy,
          },
          preallocatedEventId,
        );

        const linkRes = await client.query(
          `UPDATE scm_stock_opname_lines
              SET adjustment_movement_id = $3
            WHERE tenant_id = $1 AND id = $2
            RETURNING *`,
          [tenantId, line.id, movement.movement.id],
        );
        updated.push(toStockOpnameLine(linkRes.rows[0]!));
      }

      await client.query(
        `UPDATE scm_stock_opnames
            SET status = 'adjusted', completed_at = COALESCE(completed_at, now()),
                completed_by = COALESCE(completed_by, $3), updated_at = now(), updated_by = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, opnameId, createdBy],
      );

      return updated;
    });
  }

  async findStockOpnameById(
    tenantId: string,
    opnameId: string,
  ): Promise<{ opname: ScmStockOpname; lines: ScmStockOpnameLine[] } | null> {
    const opRes = await this.pool.query(
      `SELECT * FROM scm_stock_opnames WHERE tenant_id = $1 AND id = $2`,
      [tenantId, opnameId],
    );
    if (!opRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_stock_opname_lines WHERE tenant_id = $1 AND opname_id = $2 ORDER BY sort_order`,
      [tenantId, opnameId],
    );
    return {
      opname: toStockOpname(opRes.rows[0]),
      lines: linesRes.rows.map(toStockOpnameLine),
    };
  }

  async listStockOpnames(tenantId: string, filter: ScmStockOpnameFilter = {}): Promise<ScmStockOpname[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_stock_opnames WHERE ${conditions.join(" AND ")} ORDER BY opname_date DESC`,
      params,
    );
    return r.rows.map(toStockOpname);
  }

  // =========================================================================
  // 3. Valuation & Landed Cost
  // =========================================================================

  async createValuationLayer(tenantId: string, input: CreateScmValuationLayerInput): Promise<ScmValuationLayer> {
    return this.inTransaction((client) => this.createValuationLayerTx(client, tenantId, input));
  }

  private async createValuationLayerTx(
    client: PoolClient,
    tenantId: string,
    input: CreateScmValuationLayerInput,
  ): Promise<ScmValuationLayer> {
    const originalQty = input.originalQuantity;
    const remainingQty = input.remainingQuantity ?? originalQty;
    const landedCostAdded = input.landedCostAdded ?? 0;
    const effectiveUnitCost = input.effectiveUnitCost ?? (input.unitCost + (originalQty > 0 ? landedCostAdded / originalQty : 0));
    const totalValue = input.totalValue ?? (remainingQty * effectiveUnitCost);
    const stockCondition = input.stockCondition ?? "unrestricted";
    const ownerType = input.ownerType ?? "own";
    const ownerPartyId = input.ownerPartyId ?? null;
    const layerStatus = input.layerStatus ?? (remainingQty > 0 ? "open" : "consumed");

    const r = await client.query(
      `INSERT INTO scm_valuation_layers (
         tenant_id, item_id, warehouse_id, receipt_movement_id, receiving_line_id, source_inspection_id,
         stock_condition, owner_type, owner_party_id, layer_status, received_date,
         original_quantity, remaining_quantity, unit_cost, landed_cost_added,
         effective_unit_cost, total_value
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        tenantId,
        input.itemId,
        input.warehouseId ?? null,
        input.receiptMovementId ?? null,
        input.receivingLineId ?? null,
        input.sourceInspectionId ?? null,
        stockCondition,
        ownerType,
        ownerPartyId,
        layerStatus,
        input.receivedDate,
        originalQty,
        remainingQty,
        input.unitCost,
        landedCostAdded,
        effectiveUnitCost,
        totalValue,
      ],
    );
    return toValuationLayer(r.rows[0]!);
  }

  async updateValuationLayerRemainingQuantity(
    tenantId: string,
    input: ConsumeScmValuationLayerInput,
  ): Promise<ScmValuationLayer | null> {
    const r = await this.pool.query(
      `UPDATE scm_valuation_layers
          SET remaining_quantity = $3::numeric,
              layer_status = CASE
                WHEN layer_status IN ('reversed', 'closed') THEN layer_status
                WHEN $3::numeric <= 0 THEN 'consumed'
                ELSE 'open'
              END,
              total_value = $3::numeric * effective_unit_cost
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, input.layerId, input.remainingQuantity],
    );
    return r.rows[0] ? toValuationLayer(r.rows[0]) : null;
  }

  async findValuationLayerById(tenantId: string, layerId: string): Promise<ScmValuationLayer | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_valuation_layers WHERE tenant_id = $1 AND id = $2`,
      [tenantId, layerId],
    );
    return r.rows[0] ? toValuationLayer(r.rows[0]) : null;
  }

  async listValuationLayers(
    tenantId: string,
    filter: ScmValuationLayerFilter = {},
  ): Promise<ScmValuationLayer[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`item_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.onlyWithRemaining) {
      conditions.push(`remaining_quantity > 0`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_valuation_layers WHERE ${conditions.join(" AND ")} ORDER BY received_date ASC, created_at ASC`,
      params,
    );
    return r.rows.map(toValuationLayer);
  }

  async createLandedCost(
    tenantId: string,
    input: CreateScmLandedCostInput,
  ): Promise<{ landedCost: ScmLandedCost; allocations: ScmLandedCostAllocation[] }> {
    return this.inTransaction(async (client) => {
      const lcRes = await client.query(
        `INSERT INTO scm_landed_costs (
           tenant_id, voucher_number, purchase_order_id, cost_type, currency,
           amount, allocation_method, status, notes, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $9)
         RETURNING *`,
        [
          tenantId,
          input.voucherNumber,
          input.purchaseOrderId,
          input.costType,
          input.currency ?? "IDR",
          input.amount,
          input.allocationMethod,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const landedCost = toLandedCost(lcRes.rows[0]!);

      const allocations: ScmLandedCostAllocation[] = [];
      for (const item of input.allocations) {
        const aRes = await client.query(
          `INSERT INTO scm_landed_cost_allocations (
             tenant_id, landed_cost_id, item_id, valuation_layer_id,
             allocated_amount, cost_per_unit_added
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            tenantId,
            landedCost.id,
            item.itemId,
            item.valuationLayerId ?? null,
            item.allocatedAmount,
            item.costPerUnitAdded,
          ],
        );
        allocations.push(toLandedCostAllocation(aRes.rows[0]!));
      }

      return { landedCost, allocations };
    });
  }

  async applyLandedCost(tenantId: string, input: ApplyScmLandedCostInput): Promise<ScmLandedCost | null> {
    return this.inTransaction(async (client) => {
      const r = await client.query(
        `UPDATE scm_landed_costs
            SET status = 'applied', applied_at = COALESCE($3, now()), updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
          RETURNING *`,
        [tenantId, input.landedCostId, input.appliedAt ?? null],
      );
      if (!r.rows[0]) return null;
      const landedCost = toLandedCost(r.rows[0]);

      // Update valuation layers referenced in allocations.
      const allocs = await client.query(
        `SELECT * FROM scm_landed_cost_allocations WHERE tenant_id = $1 AND landed_cost_id = $2`,
        [tenantId, input.landedCostId],
      );

      const layerIds = allocs.rows
        .map((a) => a.valuation_layer_id as string | null)
        .filter((id): id is string => id !== null);
      if (layerIds.length === 0) {
        throw new ConflictError(`Landed cost ${input.landedCostId} has no valuation-layer allocation`);
      }

      const legalEntityRes = await client.query(
        `SELECT ou.legal_entity_id
           FROM scm_landed_cost_allocations lca
           JOIN scm_valuation_layers vl
             ON vl.tenant_id = lca.tenant_id AND vl.id = lca.valuation_layer_id
           JOIN scm_receiving_lines rl
             ON rl.tenant_id = vl.tenant_id AND rl.id = vl.receiving_line_id
           JOIN scm_warehouses w
             ON w.tenant_id = rl.tenant_id AND w.id = rl.warehouse_id
           JOIN organization_units ou
             ON ou.tenant_id = w.tenant_id AND ou.id = w.organization_unit_id
          WHERE lca.tenant_id = $1 AND lca.landed_cost_id = $2
          GROUP BY ou.legal_entity_id`,
        [tenantId, input.landedCostId],
      );
      const resolvedLegalEntities = legalEntityRes.rows
        .map((row) => row.legal_entity_id as string | null)
        .filter((id): id is string => id !== null);
      if (resolvedLegalEntities.length !== 1 || resolvedLegalEntities[0] !== input.legalEntityId) {
        throw new ConflictError(`Landed cost ${input.landedCostId} does not resolve to the supplied legal entity`);
      }

      for (const a of allocs.rows) {
        if (a.valuation_layer_id) {
          await client.query(
            `UPDATE scm_valuation_layers
                SET landed_cost_added = landed_cost_added + $1,
                    effective_unit_cost = effective_unit_cost + $2,
                    total_value = remaining_quantity * (effective_unit_cost + $2)
              WHERE tenant_id = $3 AND id = $4`,
            [a.allocated_amount, a.cost_per_unit_added, tenantId, a.valuation_layer_id],
          );
        }
      }

      const appliedAt = landedCost.appliedAt ?? input.appliedAt ?? new Date();
      await this.createAccountingReadyEventTx(client, tenantId, {
        eventType: "inventory.landed_cost_applied",
        sourceDocumentType: "scm_landed_cost",
        sourceDocumentId: landedCost.id,
        effectiveAt: appliedAt,
        currency: landedCost.currency,
        amount: landedCost.amount,
        accountAssignmentType: "stock",
        accountAssignmentDimensions: { legalEntityId: input.legalEntityId },
        idempotencyKey: `landed-cost:${landedCost.id}:apply`,
        payload: {
          legalEntityId: input.legalEntityId,
          periodId: input.periodId,
          voucherNumber: landedCost.voucherNumber,
          purchaseOrderId: landedCost.purchaseOrderId,
          costType: landedCost.costType,
          allocationMethod: landedCost.allocationMethod,
        },
        createdBy: null,
      });

      return landedCost;
    });
  }

  async findLandedCostById(
    tenantId: string,
    landedCostId: string,
  ): Promise<{ landedCost: ScmLandedCost; allocations: ScmLandedCostAllocation[] } | null> {
    const lcRes = await this.pool.query(
      `SELECT * FROM scm_landed_costs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, landedCostId],
    );
    if (!lcRes.rows[0]) return null;

    const allocRes = await this.pool.query(
      `SELECT * FROM scm_landed_cost_allocations WHERE tenant_id = $1 AND landed_cost_id = $2`,
      [tenantId, landedCostId],
    );
    return {
      landedCost: toLandedCost(lcRes.rows[0]),
      allocations: allocRes.rows.map(toLandedCostAllocation),
    };
  }

  async listLandedCosts(tenantId: string, filter: ScmLandedCostFilter = {}): Promise<ScmLandedCost[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.purchaseOrderId) {
      params.push(filter.purchaseOrderId);
      conditions.push(`purchase_order_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_landed_costs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toLandedCost);
  }

  // =========================================================================
  // 4. RFQ, Tender & Bids
  // =========================================================================

  async createRfq(
    tenantId: string,
    input: CreateScmRfqInput,
  ): Promise<{ rfq: ScmRfq; items: ScmRfqItem[]; invitedSuppliers: ScmRfqInvitedSupplier[] }> {
    return this.inTransaction(async (client) => {
      const rfqRes = await client.query(
        `INSERT INTO scm_rfqs (
           tenant_id, rfq_number, title, procurement_type, organization_unit_id,
           purchase_request_id, submission_deadline, status, notes, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $9)
         RETURNING *`,
        [
          tenantId,
          input.rfqNumber,
          input.title,
          input.procurementType,
          input.organizationUnitId ?? null,
          input.purchaseRequestId ?? null,
          input.submissionDeadline,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const rfq = toRfq(rfqRes.rows[0]!);

      const items: ScmRfqItem[] = [];
      let sort = 0;
      for (const item of input.items) {
        const itemRes = await client.query(
          `INSERT INTO scm_rfq_items (
             tenant_id, rfq_id, item_id, target_quantity, target_unit_price, specifications, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            tenantId,
            rfq.id,
            item.itemId,
            item.targetQuantity,
            item.targetUnitPrice ?? null,
            item.specifications ?? null,
            item.sortOrder ?? sort++,
          ],
        );
        items.push(toRfqItem(itemRes.rows[0]!));
      }

      const invitedSuppliers: ScmRfqInvitedSupplier[] = [];
      for (const inv of input.invitedSuppliers) {
        const invRes = await client.query(
          `INSERT INTO scm_rfq_invited_suppliers (
             tenant_id, rfq_id, supplier_id, invited_at, responded_at
           ) VALUES ($1, $2, $3, now(), $4)
           RETURNING *`,
          [tenantId, rfq.id, inv.supplierId, inv.respondedAt ?? null],
        );
        invitedSuppliers.push(toRfqInvitedSupplier(invRes.rows[0]!));
      }

      return { rfq, items, invitedSuppliers };
    });
  }

  async updateRfqProjection(tenantId: string, input: UpdateScmRfqProjectionInput): Promise<ScmRfq | null> {
    const r = await this.pool.query(
      `UPDATE scm_rfqs
          SET status = $3,
              workflow_instance_id = CASE WHEN $4::boolean THEN $5 ELSE workflow_instance_id END,
              awarded_at = CASE WHEN $6::boolean THEN $7 ELSE awarded_at END,
              cancelled_at = CASE WHEN $8::boolean THEN $9 ELSE cancelled_at END,
              notes = CASE WHEN $10::boolean THEN $11 ELSE notes END,
              updated_by = $12,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.rfqId,
        input.status,
        input.workflowInstanceId !== undefined,
        input.workflowInstanceId ?? null,
        input.awardedAt !== undefined,
        input.awardedAt ?? null,
        input.cancelledAt !== undefined,
        input.cancelledAt ?? null,
        input.notes !== undefined,
        input.notes ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toRfq(r.rows[0]) : null;
  }

  async deleteRfqWithoutWorkflow(tenantId: string, rfqId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_rfqs
        WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, rfqId],
    );
  }

  async findRfqById(
    tenantId: string,
    rfqId: string,
  ): Promise<{ rfq: ScmRfq; items: ScmRfqItem[]; invitedSuppliers: ScmRfqInvitedSupplier[] } | null> {
    const rfqRes = await this.pool.query(
      `SELECT * FROM scm_rfqs WHERE tenant_id = $1 AND id = $2`,
      [tenantId, rfqId],
    );
    if (!rfqRes.rows[0]) return null;

    const itemsRes = await this.pool.query(
      `SELECT * FROM scm_rfq_items WHERE tenant_id = $1 AND rfq_id = $2 ORDER BY sort_order`,
      [tenantId, rfqId],
    );
    const invRes = await this.pool.query(
      `SELECT * FROM scm_rfq_invited_suppliers WHERE tenant_id = $1 AND rfq_id = $2`,
      [tenantId, rfqId],
    );

    return {
      rfq: toRfq(rfqRes.rows[0]),
      items: itemsRes.rows.map(toRfqItem),
      invitedSuppliers: invRes.rows.map(toRfqInvitedSupplier),
    };
  }

  async listRfqs(tenantId: string, filter: ScmRfqFilter = {}): Promise<ScmRfq[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.organizationUnitIds !== undefined) {
      if (filter.organizationUnitIds === null) {
        // tenant wide
      } else if (filter.organizationUnitIds.length === 0) {
        conditions.push(`organization_unit_id IS NULL`);
      } else {
        params.push(filter.organizationUnitIds);
        conditions.push(`(organization_unit_id IS NULL OR organization_unit_id = ANY($${params.length}))`);
      }
    }
    if (filter.purchaseRequestId) {
      params.push(filter.purchaseRequestId);
      conditions.push(`purchase_request_id = $${params.length}`);
    }
    if (filter.procurementType) {
      params.push(filter.procurementType);
      conditions.push(`procurement_type = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_rfqs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toRfq);
  }

  async createSupplierBid(
    tenantId: string,
    input: CreateScmSupplierBidInput,
  ): Promise<{ bid: ScmSupplierBid; lines: ScmSupplierBidLine[] }> {
    return this.inTransaction(async (client) => {
      const bidRes = await client.query(
        `INSERT INTO scm_supplier_bids (
           tenant_id, bid_number, rfq_id, supplier_id, currency, total_amount,
           lead_time_days, valid_until, status, notes, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', $9, $10, $10)
         RETURNING *`,
        [
          tenantId,
          input.bidNumber,
          input.rfqId,
          input.supplierId,
          input.currency ?? "IDR",
          input.totalAmount ?? 0,
          input.leadTimeDays ?? 0,
          input.validUntil ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const bid = toSupplierBid(bidRes.rows[0]!);

      const lines: ScmSupplierBidLine[] = [];
      for (const line of input.lines) {
        const lRes = await client.query(
          `INSERT INTO scm_supplier_bid_lines (
             tenant_id, bid_id, rfq_item_id, offered_quantity, offered_unit_price,
             offered_total_price, remarks
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            tenantId,
            bid.id,
            line.rfqItemId,
            line.offeredQuantity,
            line.offeredUnitPrice,
            line.offeredTotalPrice,
            line.remarks ?? null,
          ],
        );
        lines.push(toSupplierBidLine(lRes.rows[0]!));
      }

      return { bid, lines };
    });
  }

  async updateSupplierBidScore(
    tenantId: string,
    input: UpdateScmSupplierBidScoreInput,
  ): Promise<ScmSupplierBid | null> {
    const r = await this.pool.query(
      `UPDATE scm_supplier_bids
          SET technical_score = CASE WHEN $3::boolean THEN $4 ELSE technical_score END,
              commercial_score = CASE WHEN $5::boolean THEN $6 ELSE commercial_score END,
              final_score = CASE WHEN $7::boolean THEN $8 ELSE final_score END,
              rank = CASE WHEN $9::boolean THEN $10 ELSE rank END,
              status = COALESCE($11, status),
              updated_by = $12,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.bidId,
        input.technicalScore !== undefined,
        input.technicalScore ?? null,
        input.commercialScore !== undefined,
        input.commercialScore ?? null,
        input.finalScore !== undefined,
        input.finalScore ?? null,
        input.rank !== undefined,
        input.rank ?? null,
        input.status ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toSupplierBid(r.rows[0]) : null;
  }

  async awardSupplierBid(tenantId: string, input: AwardScmSupplierBidInput): Promise<ScmSupplierBid | null> {
    const r = await this.pool.query(
      `UPDATE scm_supplier_bids
          SET is_winning_bid = true,
              status = 'awarded',
              resulting_po_id = $3,
              updated_by = $4,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
          AND status IN ('evaluated', 'shortlisted')
        RETURNING *`,
      [tenantId, input.bidId, input.resultingPurchaseOrderId ?? null, input.updatedBy ?? null],
    );
    return r.rows[0] ? toSupplierBid(r.rows[0]) : null;
  }

  async findSupplierBidById(
    tenantId: string,
    bidId: string,
  ): Promise<{ bid: ScmSupplierBid; lines: ScmSupplierBidLine[] } | null> {
    const bidRes = await this.pool.query(
      `SELECT * FROM scm_supplier_bids WHERE tenant_id = $1 AND id = $2`,
      [tenantId, bidId],
    );
    if (!bidRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_supplier_bid_lines WHERE tenant_id = $1 AND bid_id = $2`,
      [tenantId, bidId],
    );
    return {
      bid: toSupplierBid(bidRes.rows[0]),
      lines: linesRes.rows.map(toSupplierBidLine),
    };
  }

  async listSupplierBids(tenantId: string, filter: ScmSupplierBidFilter = {}): Promise<ScmSupplierBid[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.rfqId) {
      params.push(filter.rfqId);
      conditions.push(`rfq_id = $${params.length}`);
    }
    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.winningOnly) {
      conditions.push(`is_winning_bid = true`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_supplier_bids WHERE ${conditions.join(" AND ")} ORDER BY final_score DESC NULLS LAST, total_amount ASC`,
      params,
    );
    return r.rows.map(toSupplierBid);
  }

  // =========================================================================
  // 5. Supplier Evaluation & Contracts
  // =========================================================================

  async createSupplierEvaluation(
    tenantId: string,
    input: CreateScmSupplierEvaluationInput,
  ): Promise<ScmSupplierEvaluation> {
    const r = await this.pool.query(
      `INSERT INTO scm_supplier_evaluations (
         tenant_id, evaluation_number, supplier_id, evaluation_period,
         period_start_date, period_end_date, quality_score, delivery_score,
         pricing_score, service_score, overall_score, rating_grade, status,
         notes, evaluated_by, evaluated_at, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft', $13, $14, $15, $16, $16)
       RETURNING *`,
      [
        tenantId,
        input.evaluationNumber,
        input.supplierId,
        input.evaluationPeriod,
        input.periodStartDate,
        input.periodEndDate,
        input.qualityScore ?? 0,
        input.deliveryScore ?? 0,
        input.pricingScore ?? 0,
        input.serviceScore ?? 0,
        input.overallScore ?? 0,
        input.ratingGrade ?? "B",
        input.notes ?? null,
        input.evaluatedBy ?? null,
        input.evaluatedAt ?? null,
        input.createdBy ?? null,
      ],
    );
    return toSupplierEvaluation(r.rows[0]!);
  }

  async updateSupplierEvaluationProjection(
    tenantId: string,
    input: UpdateScmSupplierEvaluationProjectionInput,
  ): Promise<ScmSupplierEvaluation | null> {
    const r = await this.pool.query(
      `UPDATE scm_supplier_evaluations
          SET status = $3,
              workflow_instance_id = CASE WHEN $4::boolean THEN $5 ELSE workflow_instance_id END,
              notes = CASE WHEN $6::boolean THEN $7 ELSE notes END,
              updated_by = $8,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.evaluationId,
        input.status,
        input.workflowInstanceId !== undefined,
        input.workflowInstanceId ?? null,
        input.notes !== undefined,
        input.notes ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toSupplierEvaluation(r.rows[0]) : null;
  }

  async deleteSupplierEvaluationWithoutWorkflow(tenantId: string, evaluationId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_supplier_evaluations
        WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, evaluationId],
    );
  }

  async findSupplierEvaluationById(tenantId: string, evaluationId: string): Promise<ScmSupplierEvaluation | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_supplier_evaluations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, evaluationId],
    );
    return r.rows[0] ? toSupplierEvaluation(r.rows[0]) : null;
  }

  async listSupplierEvaluations(
    tenantId: string,
    filter: ScmSupplierEvaluationFilter = {},
  ): Promise<ScmSupplierEvaluation[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.ratingGrade) {
      params.push(filter.ratingGrade);
      conditions.push(`rating_grade = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_supplier_evaluations WHERE ${conditions.join(" AND ")} ORDER BY period_end_date DESC`,
      params,
    );
    return r.rows.map(toSupplierEvaluation);
  }

  async createSupplierContract(
    tenantId: string,
    input: CreateScmSupplierContractInput,
  ): Promise<{ contract: ScmSupplierContract; items: ScmSupplierContractItem[] }> {
    return this.inTransaction(async (client) => {
      const cRes = await client.query(
        `INSERT INTO scm_supplier_contracts (
           tenant_id, contract_number, supplier_id, title, contract_type,
           start_date, end_date, currency, committed_amount, spent_amount,
           status, terms_and_conditions, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'draft', $10, $11, $11)
         RETURNING *`,
        [
          tenantId,
          input.contractNumber,
          input.supplierId,
          input.title,
          input.contractType,
          input.startDate,
          input.endDate,
          input.currency ?? "IDR",
          input.committedAmount ?? 0,
          input.termsAndConditions ?? null,
          input.createdBy ?? null,
        ],
      );
      const contract = toSupplierContract(cRes.rows[0]!);

      const items: ScmSupplierContractItem[] = [];
      for (const item of input.items) {
        const itemRes = await client.query(
          `INSERT INTO scm_supplier_contract_items (
             tenant_id, contract_id, item_id, agreed_unit_price,
             min_order_quantity, max_order_quantity, lead_time_days, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            tenantId,
            contract.id,
            item.itemId,
            item.agreedUnitPrice,
            item.minOrderQuantity ?? 1,
            item.maxOrderQuantity ?? null,
            item.leadTimeDays ?? 0,
            item.notes ?? null,
          ],
        );
        items.push(toSupplierContractItem(itemRes.rows[0]!));
      }

      return { contract, items };
    });
  }

  async updateSupplierContractProjection(
    tenantId: string,
    input: UpdateScmSupplierContractProjectionInput,
  ): Promise<ScmSupplierContract | null> {
    const r = await this.pool.query(
      `UPDATE scm_supplier_contracts
          SET status = $3,
              workflow_instance_id = CASE WHEN $4::boolean THEN $5 ELSE workflow_instance_id END,
              approved_at = CASE WHEN $6::boolean THEN $7 ELSE approved_at END,
              closed_at = CASE WHEN $8::boolean THEN $9 ELSE closed_at END,
              updated_by = $10,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.contractId,
        input.status,
        input.workflowInstanceId !== undefined,
        input.workflowInstanceId ?? null,
        input.approvedAt !== undefined,
        input.approvedAt ?? null,
        input.closedAt !== undefined,
        input.closedAt ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toSupplierContract(r.rows[0]) : null;
  }

  async deleteSupplierContractWithoutWorkflow(tenantId: string, contractId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_supplier_contracts
        WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, contractId],
    );
  }

  async recordSupplierContractSpend(
    tenantId: string,
    input: RecordScmSupplierContractSpendInput,
  ): Promise<ScmSupplierContract | null> {
    const r = await this.pool.query(
      `UPDATE scm_supplier_contracts
          SET spent_amount = spent_amount + $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, input.contractId, input.additionalSpentAmount],
    );
    return r.rows[0] ? toSupplierContract(r.rows[0]) : null;
  }

  async findSupplierContractById(
    tenantId: string,
    contractId: string,
  ): Promise<{ contract: ScmSupplierContract; items: ScmSupplierContractItem[] } | null> {
    const cRes = await this.pool.query(
      `SELECT * FROM scm_supplier_contracts WHERE tenant_id = $1 AND id = $2`,
      [tenantId, contractId],
    );
    if (!cRes.rows[0]) return null;

    const itemsRes = await this.pool.query(
      `SELECT * FROM scm_supplier_contract_items WHERE tenant_id = $1 AND contract_id = $2`,
      [tenantId, contractId],
    );
    return {
      contract: toSupplierContract(cRes.rows[0]),
      items: itemsRes.rows.map(toSupplierContractItem),
    };
  }

  async listSupplierContracts(
    tenantId: string,
    filter: ScmSupplierContractFilter = {},
  ): Promise<ScmSupplierContract[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.contractType) {
      params.push(filter.contractType);
      conditions.push(`contract_type = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_supplier_contracts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toSupplierContract);
  }

  // =========================================================================
  // 6. Spend Analytics
  // =========================================================================

  async createSpendAnalyticsSnapshot(
    tenantId: string,
    input: CreateScmSpendAnalyticsSnapshotInput,
  ): Promise<ScmSpendAnalyticsSnapshot> {
    const r = await this.pool.query(
      `INSERT INTO scm_spend_analytics_snapshots (
         tenant_id, snapshot_date, period_type, period_key, organization_unit_id,
         supplier_id, item_category, total_spend, po_count, items_purchased_count,
         avg_po_value, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        tenantId,
        input.snapshotDate,
        input.periodType,
        input.periodKey,
        input.organizationUnitId ?? null,
        input.supplierId ?? null,
        input.itemCategory ?? null,
        input.totalSpend,
        input.poCount,
        input.itemsPurchasedCount,
        input.avgPoValue,
        input.createdBy ?? null,
      ],
    );
    return toSpendAnalyticsSnapshot(r.rows[0]!);
  }

  async listSpendAnalyticsSnapshots(
    tenantId: string,
    filter: ScmSpendAnalyticsSnapshotFilter = {},
  ): Promise<ScmSpendAnalyticsSnapshot[]> {
    const conditions = [`tenant_id = $1`];
    const params: unknown[] = [tenantId];

    if (filter.snapshotDateFrom) {
      params.push(filter.snapshotDateFrom);
      conditions.push(`snapshot_date >= $${params.length}`);
    }
    if (filter.snapshotDateTo) {
      params.push(filter.snapshotDateTo);
      conditions.push(`snapshot_date <= $${params.length}`);
    }
    if (filter.periodType) {
      params.push(filter.periodType);
      conditions.push(`period_type = $${params.length}`);
    }
    if (filter.organizationUnitIds !== undefined) {
      if (filter.organizationUnitIds === null) {
        // tenant wide
      } else if (filter.organizationUnitIds.length === 0) {
        conditions.push(`organization_unit_id IS NULL`);
      } else {
        params.push(filter.organizationUnitIds);
        conditions.push(`(organization_unit_id IS NULL OR organization_unit_id = ANY($${params.length}))`);
      }
    }
    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.itemCategory) {
      params.push(filter.itemCategory);
      conditions.push(`item_category = $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_spend_analytics_snapshots
        WHERE ${conditions.join(" AND ")}
        ORDER BY snapshot_date DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toSpendAnalyticsSnapshot);
  }

  async findSpendAnalyticsSnapshotById(
    tenantId: string,
    snapshotId: string,
  ): Promise<ScmSpendAnalyticsSnapshot | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_spend_analytics_snapshots WHERE tenant_id = $1 AND id = $2`,
      [tenantId, snapshotId],
    );
    return r.rows[0] ? toSpendAnalyticsSnapshot(r.rows[0]) : null;
  }

  async computeSpendAnalyticsSnapshot(
    tenantId: string,
    input: {
      periodType: ScmSpendAnalyticsPeriodType;
      periodStart: string;
      periodEnd: string;
      organizationUnitId?: string | null;
      createdBy?: string | null;
    },
  ): Promise<ScmSpendAnalyticsSnapshot> {
    return this.inTransaction(async (client) => {
      await client.query("SET LOCAL statement_timeout = '15000'");
      const conditions = [
        "po.tenant_id = $1",
        "po.deleted_at IS NULL",
        "po.cancelled_at IS NULL",
        "po.issued_at IS NOT NULL",
        "po.order_date >= $2::date",
        "po.order_date <= $3::date",
      ];
      const params: unknown[] = [tenantId, input.periodStart, input.periodEnd];
      if (input.organizationUnitId) {
        params.push(input.organizationUnitId);
        conditions.push(`pr.organization_unit_id = $${params.length}`);
      }
      const query = `
        SELECT
          COALESCE(SUM(pol.quantity_ordered * COALESCE(pol.unit_price, 0)), 0) AS total_spend,
          COUNT(DISTINCT po.id) AS po_count,
          COALESCE(SUM(pol.quantity_ordered), 0) AS items_purchased_count
        FROM purchase_orders po
        LEFT JOIN purchase_requests pr ON pr.id = po.purchase_request_id AND pr.tenant_id = po.tenant_id
        JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
        WHERE ${conditions.join(" AND ")}
      `;
      const res = await client.query(query, params);
      const row = res.rows[0]!;
      const totalSpend = num(row.total_spend);
      const poCount = parseInt(row.po_count, 10) || 0;
      const itemsCount = num(row.items_purchased_count);
      const avgPoValue = poCount > 0 ? Math.round((totalSpend / poCount) * 10000) / 10000 : 0;
      const periodKey = `${input.periodStart}_${input.periodEnd}`;

      const ins = await client.query(
        `INSERT INTO scm_spend_analytics_snapshots (
           tenant_id, snapshot_date, period_type, period_key, organization_unit_id,
           total_spend, po_count, items_purchased_count, avg_po_value, created_by
         ) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          tenantId,
          input.periodType,
          periodKey,
          input.organizationUnitId ?? null,
          totalSpend,
          poCount,
          itemsCount,
          avgPoValue,
          input.createdBy ?? null,
        ],
      );
      return toSpendAnalyticsSnapshot(ins.rows[0]!);
    });
  }

  // =========================================================================
  // Wave A5.1 Stage 1: Account Assignment, Receiving, Inspection, Events & Returns
  // =========================================================================

  async listAccountAssignmentConfigs(tenantId: string, activeOnly = false): Promise<ScmAccountAssignmentConfig[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (activeOnly) {
      conditions.push("is_active = true");
    }
    const r = await this.pool.query(
      `SELECT * FROM scm_account_assignment_configs WHERE ${conditions.join(" AND ")} ORDER BY assignment_type ASC`,
      params,
    );
    return r.rows.map(toAccountAssignmentConfig);
  }

  async findAccountAssignmentConfig(
    tenantId: string,
    assignmentType: ScmAccountAssignmentType,
  ): Promise<ScmAccountAssignmentConfig | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_account_assignment_configs WHERE tenant_id = $1 AND assignment_type = $2`,
      [tenantId, assignmentType],
    );
    return r.rows[0] ? toAccountAssignmentConfig(r.rows[0]) : null;
  }

  async updateAccountAssignmentConfig(
    tenantId: string,
    input: UpdateScmAccountAssignmentConfigInput,
  ): Promise<ScmAccountAssignmentConfig | null> {
    const r = await this.pool.query(
      `UPDATE scm_account_assignment_configs
          SET required_dimensions = CASE WHEN $3::boolean THEN $4::jsonb ELSE required_dimensions END,
              inventory_relevant = COALESCE($5, inventory_relevant),
              is_active = COALESCE($6, is_active),
              updated_by = $7,
              updated_at = now()
        WHERE tenant_id = $1 AND assignment_type = $2
        RETURNING *`,
      [
        tenantId,
        input.assignmentType,
        input.requiredDimensions !== undefined,
        input.requiredDimensions !== undefined ? JSON.stringify(input.requiredDimensions) : null,
        input.inventoryRelevant ?? null,
        input.isActive ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toAccountAssignmentConfig(r.rows[0]) : null;
  }

  async createReceivingRecord(
    tenantId: string,
    input: CreateScmReceivingRecordInput,
  ): Promise<{ receiving: ScmReceivingRecord; lines: ScmReceivingLine[] }> {
    return this.inTransaction(async (client) => {
      const recRes = await client.query(
        `INSERT INTO scm_receiving_records (
           tenant_id, receipt_number, idempotency_key, purchase_order_id, supplier_id,
           warehouse_id, location_id, received_at, received_by, status, notes,
           created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $9, 'received', $10, $11, $11)
         RETURNING *`,
        [
          tenantId,
          input.receiptNumber,
          input.idempotencyKey,
          input.purchaseOrderId,
          input.supplierId,
          input.warehouseId,
          input.locationId ?? null,
          input.receivedAt ?? null,
          input.receivedBy ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const receiving = toReceivingRecord(recRes.rows[0]!);

      const lines: ScmReceivingLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        // Receiving is a PO hand-off: only an issued, non-cancelled line may
        // advance, and the guard lives inside the locked UPDATE so concurrent
        // receipts cannot jointly exceed the ordered quantity.
        const poLineRes = await client.query(
          `UPDATE purchase_order_lines pol
              SET quantity_received = pol.quantity_received + $3
             FROM purchase_orders po
            WHERE pol.tenant_id = $1
              AND pol.id = $2
              AND pol.purchase_order_id = $4
              AND pol.item_id = $5
              AND po.id = pol.purchase_order_id
              AND po.tenant_id = pol.tenant_id
              AND po.issued_at IS NOT NULL
              AND po.cancelled_at IS NULL
              AND pol.quantity_received + $3 <= pol.quantity_ordered
            RETURNING pol.id`,
          [tenantId, line.purchaseOrderLineId, line.quantityReceived, input.purchaseOrderId, line.itemId],
        );
        if (!poLineRes.rows[0]) {
          throw new ConflictError(
            `Receiving line ${line.purchaseOrderLineId} is not issued, mismatched, cancelled, or exceeds the ordered quantity`,
          );
        }

        const lRes = await client.query(
          `INSERT INTO scm_receiving_lines (
             tenant_id, receiving_record_id, purchase_order_line_id, item_id,
             warehouse_id, location_id, batch_id, stock_condition, owner_type, owner_party_id,
             quantity_received, quantity_accepted, quantity_rejected, quantity_quarantined,
             quantity_returned, quantity_reversed, unit_cost, currency,
             account_assignment_type, account_assignment_dimensions, frozen_account_assignment_at,
             inspection_required, hold_movement_id, notes, sort_order
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8, $9, $10,
             $11, 0, 0, 0,
             0, 0, $12, $13,
             $14, $15::jsonb, now(),
             $16, $17, $18, $19
           )
           RETURNING *`,
          [
            tenantId,
            receiving.id,
            line.purchaseOrderLineId,
            line.itemId,
            line.warehouseId ?? input.warehouseId,
            line.locationId ?? input.locationId ?? null,
            line.batchId ?? null,
            line.stockCondition ?? "quality_hold",
            line.ownerType ?? "own",
            line.ownerPartyId ?? null,
            line.quantityReceived,
            line.unitCost ?? null,
            line.currency ?? "IDR",
            line.accountAssignmentType,
            JSON.stringify(line.accountAssignmentDimensions ?? {}),
            line.inspectionRequired ?? true,
            line.holdMovementId ?? null,
            line.notes ?? null,
            line.sortOrder ?? sort++,
          ],
        );
        const holdingLine = toReceivingLine(lRes.rows[0]!);
        const holdCondition = holdingLine.stockCondition;
        const holdOwnerType = holdingLine.ownerType;
        const holdOwnerPartyId = holdingLine.ownerPartyId;

        // Stage 1 keeps the stock ledger append-only. Every received quantity
        // enters as an inspection hold-in movement into the receiving line's
        // stock position, so a later receipt reversal can deterministically
        // compensate exactly that position.
        const hold = await this.recordMovementTx(client, tenantId, {
          itemId: holdingLine.itemId,
          warehouseId: holdingLine.warehouseId,
          locationId: holdingLine.locationId,
          batchId: holdingLine.batchId,
          stockCondition: holdCondition,
          ownerType: holdOwnerType,
          ownerPartyId: holdOwnerPartyId,
          movementType: "inspection_hold_in",
          quantity: holdingLine.quantityReceived,
          unitCost: holdingLine.unitCost,
          totalCost: num(holdingLine.quantityReceived) * (holdingLine.unitCost ?? 0),
          referenceType: "scm_receiving_record",
          referenceId: receiving.id,
          referenceNumber: input.receiptNumber,
          notes: `Goods received holding ${holdingLine.quantityReceived} for inspection`,
          occurredAt: input.receivedAt,
          createdBy: input.createdBy ?? null,
        });

        const updRes = await client.query(
          `UPDATE scm_receiving_lines
              SET hold_movement_id = $3
            WHERE tenant_id = $1 AND id = $2
            RETURNING *`,
          [tenantId, holdingLine.id, hold.movement.id],
        );
        lines.push(toReceivingLine(updRes.rows[0]!));
      }

      return { receiving, lines };
    });
  }

  async updateReceivingRecordStatus(
    tenantId: string,
    input: UpdateScmReceivingRecordStatusInput,
  ): Promise<ScmReceivingRecord | null> {
    const r = await this.pool.query(
      `UPDATE scm_receiving_records
          SET status = $3,
              updated_by = $4,
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [tenantId, input.receivingRecordId, input.status, input.updatedBy ?? null],
    );
    return r.rows[0] ? toReceivingRecord(r.rows[0]) : null;
  }

  async updateReceivingLineInspectionProjection(
    tenantId: string,
    input: UpdateScmReceivingLineInspectionProjectionInput,
  ): Promise<ScmReceivingLine | null> {
    const r = await this.pool.query(
      `UPDATE scm_receiving_lines
          SET quantity_accepted = COALESCE($3, quantity_accepted),
              quantity_rejected = COALESCE($4, quantity_rejected),
              quantity_quarantined = COALESCE($5, quantity_quarantined),
              stock_condition = COALESCE($6, stock_condition),
              acceptance_movement_id = CASE WHEN $7::boolean THEN $8 ELSE acceptance_movement_id END,
              valuation_layer_id = CASE WHEN $9::boolean THEN $10 ELSE valuation_layer_id END
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.receivingLineId,
        input.quantityAccepted ?? null,
        input.quantityRejected ?? null,
        input.quantityQuarantined ?? null,
        input.stockCondition ?? null,
        input.acceptanceMovementId !== undefined,
        input.acceptanceMovementId ?? null,
        input.valuationLayerId !== undefined,
        input.valuationLayerId ?? null,
      ],
    );
    return r.rows[0] ? toReceivingLine(r.rows[0]) : null;
  }

  async findReceivingRecordById(
    tenantId: string,
    receivingRecordId: string,
  ): Promise<{ receiving: ScmReceivingRecord; lines: ScmReceivingLine[] } | null> {
    const recRes = await this.pool.query(
      `SELECT * FROM scm_receiving_records WHERE tenant_id = $1 AND id = $2`,
      [tenantId, receivingRecordId],
    );
    if (!recRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_receiving_lines WHERE tenant_id = $1 AND receiving_record_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, receivingRecordId],
    );
    return {
      receiving: toReceivingRecord(recRes.rows[0]),
      lines: linesRes.rows.map(toReceivingLine),
    };
  }

  async findReceivingRecordByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ receiving: ScmReceivingRecord; lines: ScmReceivingLine[] } | null> {
    const recRes = await this.pool.query(
      `SELECT id FROM scm_receiving_records WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!recRes.rows[0]) return null;
    return this.findReceivingRecordById(tenantId, recRes.rows[0].id);
  }

  async listReceivingRecords(
    tenantId: string,
    filter: ScmReceivingRecordFilter = {},
  ): Promise<ScmReceivingRecord[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.purchaseOrderId) {
      params.push(filter.purchaseOrderId);
      conditions.push(`purchase_order_id = $${params.length}`);
    }
    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.receivedFrom) {
      params.push(filter.receivedFrom);
      conditions.push(`received_at >= $${params.length}`);
    }
    if (filter.receivedTo) {
      params.push(filter.receivedTo);
      conditions.push(`received_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_receiving_records
        WHERE ${conditions.join(" AND ")}
        ORDER BY received_at DESC, created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toReceivingRecord);
  }

  /**
   * WP-WMS-01 — an inspection is a ledger event, not a form submission.
   *
   * Receiving parks the whole received quantity in `quality_hold`. The
   * inspection is what releases it, so the inspection document, the release
   * movements, the receiving-line projection, the receiving status and the
   * accepted FIFO layer are all written in ONE transaction. Any failure rolls
   * every one of them back together — a released balance with no movement row
   * (or the reverse) can never be observed.
   */
  async createInspection(
    tenantId: string,
    input: CreateScmInspectionInput,
  ): Promise<CreateScmInspectionResult> {
    return this.inTransaction(async (client) => {
      const lineRes = await client.query(
        `SELECT * FROM scm_receiving_lines
          WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
        [tenantId, input.receivingLineId],
      );
      const lineRow = lineRes.rows[0];
      if (!lineRow) {
        throw new NotFoundError("ScmReceivingLine", input.receivingLineId);
      }

      const accepted = input.quantityAccepted ?? 0;
      const rejected = input.quantityRejected ?? 0;
      const quarantined = input.quantityQuarantined ?? 0;
      const inspectedTotal = accepted + rejected + quarantined;
      const received = num(lineRow.quantity_received);
      const alreadyInspected =
        num(lineRow.quantity_accepted) +
        num(lineRow.quantity_rejected) +
        num(lineRow.quantity_quarantined);

      if (inspectedTotal <= 0) {
        throw new ValidationError("Inspection must dispose of a positive quantity");
      }
      if (alreadyInspected + inspectedTotal > received) {
        throw new ConflictError(
          `Inspection disposes ${inspectedTotal} but only ${received - alreadyInspected} of ${received} received units remain uninspected`,
        );
      }

      // `UNIQUE (tenant_id, receiving_line_id)` makes the inspection the line's
      // single disposition event; a replay returns the recorded document and
      // writes no second set of movements.
      const existing = await client.query(
        `SELECT * FROM scm_inspections WHERE tenant_id = $1 AND receiving_line_id = $2`,
        [tenantId, input.receivingLineId],
      );
      if (existing.rows[0]) {
        const layerRes = await client.query(
          `SELECT id FROM scm_valuation_layers
            WHERE tenant_id = $1 AND source_inspection_id = $2`,
          [tenantId, existing.rows[0].id],
        );
        return {
          inspection: toInspection(existing.rows[0]),
          movements: [],
          valuationLayerId: layerRes.rows[0]?.id ?? null,
        };
      }

      const inspectionRes = await client.query(
        `INSERT INTO scm_inspections (
           tenant_id, receiving_line_id, inspection_number, idempotency_key,
           inspected_at, inspected_by, quantity_accepted, quantity_rejected,
           quantity_quarantined, result, reason, created_by
         ) VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          tenantId,
          input.receivingLineId,
          input.inspectionNumber,
          input.idempotencyKey,
          input.inspectedAt ?? null,
          input.inspectedBy ?? null,
          accepted,
          rejected,
          quarantined,
          input.result,
          input.reason ?? null,
          input.createdBy ?? null,
        ],
      );
      const inspection = toInspection(inspectionRes.rows[0]!);

      const itemId = lineRow.item_id as string;
      const warehouseId = lineRow.warehouse_id as string;
      const locationId = (lineRow.location_id as string | null) ?? null;
      const batchId = (lineRow.batch_id as string | null) ?? null;
      const ownerType = lineRow.owner_type as ScmStockOwnerType;
      const ownerPartyId = (lineRow.owner_party_id as string | null) ?? null;
      const holdCondition = lineRow.stock_condition as ScmStockCondition;
      const unitCost = lineRow.unit_cost === null ? null : num(lineRow.unit_cost);
      const occurredAt = inspection.inspectedAt;

      const reference = {
        referenceType: "scm_inspection",
        referenceId: inspection.id,
        referenceNumber: inspection.inspectionNumber,
        occurredAt,
        createdBy: input.createdBy ?? null,
      };

      const movements: ScmAdvancedStockMovement[] = [];

      const holdOut = await this.recordMovementTx(client, tenantId, {
        itemId,
        warehouseId,
        locationId,
        batchId,
        stockCondition: holdCondition,
        ownerType,
        ownerPartyId,
        movementType: "inspection_hold_out",
        quantity: inspectedTotal,
        unitCost,
        totalCost: unitCost === null ? null : inspectedTotal * unitCost,
        notes: `Inspection ${inspection.inspectionNumber} released ${inspectedTotal} from ${holdCondition}`,
        ...reference,
      });
      movements.push(holdOut.movement);

      const dispositions: Array<{ quantity: number; condition: ScmStockCondition; label: string }> = [
        { quantity: accepted, condition: "unrestricted", label: "accepted" },
        { quantity: rejected, condition: "rejected", label: "rejected" },
        { quantity: quarantined, condition: "quarantined", label: "quarantined" },
      ];

      let acceptanceMovementId: string | null = null;
      let valuationLayerId: string | null = null;

      for (const disposition of dispositions) {
        if (disposition.quantity <= 0) continue;

        const release = await this.recordMovementTx(client, tenantId, {
          itemId,
          warehouseId,
          locationId,
          batchId,
          stockCondition: disposition.condition,
          ownerType,
          ownerPartyId,
          movementType: "inspection_release_in",
          quantity: disposition.quantity,
          unitCost,
          totalCost: unitCost === null ? null : disposition.quantity * unitCost,
          notes: `Inspection ${inspection.inspectionNumber} released ${disposition.quantity} as ${disposition.label}`,
          ...reference,
        });
        movements.push(release.movement);

        if (disposition.condition === "unrestricted") {
          acceptanceMovementId = release.movement.id;
          const layer = await this.createValuationLayerTx(client, tenantId, {
            itemId,
            warehouseId,
            receiptMovementId: release.movement.id,
            receivingLineId: input.receivingLineId,
            sourceInspectionId: inspection.id,
            stockCondition: "unrestricted",
            ownerType,
            ownerPartyId,
            receivedDate: occurredAt.toISOString().slice(0, 10),
            originalQuantity: disposition.quantity,
            unitCost: unitCost ?? 0,
          });
          valuationLayerId = layer.id;
        }
      }

      await client.query(
        `UPDATE scm_receiving_lines
            SET quantity_accepted = quantity_accepted + $3,
                quantity_rejected = quantity_rejected + $4,
                quantity_quarantined = quantity_quarantined + $5,
                acceptance_movement_id = COALESCE($6, acceptance_movement_id),
                valuation_layer_id = COALESCE($7, valuation_layer_id)
          WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          input.receivingLineId,
          accepted,
          rejected,
          quarantined,
          acceptanceMovementId,
          valuationLayerId,
        ],
      );

      await this.refreshReceivingStatusTx(client, tenantId, lineRow.receiving_record_id as string, input.createdBy ?? null);

      return { inspection, movements, valuationLayerId };
    });
  }

  /**
   * Derives the receiving record's status from its lines: a record whose every
   * line is fully disposed is `accepted` (or `rejected` when nothing was
   * accepted), anything still holding uninspected stock is
   * `partially_inspected`.
   */
  private async refreshReceivingStatusTx(
    client: PoolClient,
    tenantId: string,
    receivingRecordId: string,
    updatedBy: string | null,
  ): Promise<void> {
    const linesRes = await client.query(
      `SELECT quantity_received, quantity_accepted, quantity_rejected, quantity_quarantined
         FROM scm_receiving_lines
        WHERE tenant_id = $1 AND receiving_record_id = $2`,
      [tenantId, receivingRecordId],
    );

    const lines = linesRes.rows;
    if (lines.length === 0) return;

    let anyRemaining = false;
    let anyAccepted = false;
    for (const line of lines) {
      const disposed = num(line.quantity_accepted) + num(line.quantity_rejected) + num(line.quantity_quarantined);
      if (disposed < num(line.quantity_received)) anyRemaining = true;
      if (num(line.quantity_accepted) > 0) anyAccepted = true;
    }

    const status = anyRemaining ? "partially_inspected" : anyAccepted ? "accepted" : "rejected";

    await client.query(
      `UPDATE scm_receiving_records
          SET status = $3, updated_by = $4, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, receivingRecordId, status, updatedBy],
    );
  }

  async findInspectionByReceivingLineId(tenantId: string, receivingLineId: string): Promise<ScmInspection | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_inspections WHERE tenant_id = $1 AND receiving_line_id = $2`,
      [tenantId, receivingLineId],
    );
    return r.rows[0] ? toInspection(r.rows[0]) : null;
  }

  async findInspectionByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<ScmInspection | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_inspections WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return r.rows[0] ? toInspection(r.rows[0]) : null;
  }

  async createDiscrepancyRecord(tenantId: string, input: CreateScmDiscrepancyRecordInput): Promise<ScmDiscrepancyRecord> {
    const r = await this.pool.query(
      `INSERT INTO scm_discrepancy_records (
         tenant_id, receiving_line_id, discrepancy_type, quantity, description, status, created_by
       ) VALUES ($1, $2, $3, $4, $5, 'open', $6)
       RETURNING *`,
      [
        tenantId,
        input.receivingLineId,
        input.discrepancyType,
        input.quantity ?? null,
        input.description,
        input.createdBy ?? null,
      ],
    );
    return toDiscrepancyRecord(r.rows[0]!);
  }

  async resolveDiscrepancyRecord(
    tenantId: string,
    input: ResolveScmDiscrepancyRecordInput,
  ): Promise<ScmDiscrepancyRecord | null> {
    const r = await this.pool.query(
      `UPDATE scm_discrepancy_records
          SET status = $3,
              resolved_at = COALESCE($4, now()),
              resolved_by = $5,
              resolution_notes = $6
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantId,
        input.discrepancyId,
        input.status,
        input.resolvedAt ?? null,
        input.resolvedBy ?? null,
        input.resolutionNotes ?? null,
      ],
    );
    return r.rows[0] ? toDiscrepancyRecord(r.rows[0]) : null;
  }

  /**
   * Epic 5 G3 enforcement batch — resolves the warehouse anchor of a
   * line-level inventory record for the Data Scope check. See the interface
   * comment for the fail-closed contract.
   */
  async findInventoryLinePlacementWarehouseId(
    tenantId: string,
    ref: {
      receivingLineId?: string | null;
      discrepancyId?: string | null;
      opnameLineId?: string | null;
    },
  ): Promise<string | null> {
    if (ref.receivingLineId) {
      const r = await this.pool.query(
        `SELECT warehouse_id
           FROM scm_receiving_lines
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, ref.receivingLineId],
      );
      return (r.rows[0]?.warehouse_id as string | undefined) ?? null;
    }
    if (ref.discrepancyId) {
      const r = await this.pool.query(
        `SELECT rl.warehouse_id
           FROM scm_discrepancy_records d
           JOIN scm_receiving_lines rl
             ON rl.id = d.receiving_line_id
            AND rl.tenant_id = d.tenant_id
          WHERE d.tenant_id = $1 AND d.id = $2`,
        [tenantId, ref.discrepancyId],
      );
      return (r.rows[0]?.warehouse_id as string | undefined) ?? null;
    }
    if (ref.opnameLineId) {
      const r = await this.pool.query(
        `SELECT o.warehouse_id
           FROM scm_stock_opname_lines l
           JOIN scm_stock_opnames o
             ON o.id = l.opname_id
            AND o.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1 AND l.id = $2`,
        [tenantId, ref.opnameLineId],
      );
      return (r.rows[0]?.warehouse_id as string | undefined) ?? null;
    }
    return null;
  }

  async listDiscrepancyRecords(
    tenantId: string,
    filter: ScmDiscrepancyRecordFilter = {},
  ): Promise<ScmDiscrepancyRecord[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.receivingLineId) {
      params.push(filter.receivingLineId);
      conditions.push(`receiving_line_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.discrepancyType) {
      params.push(filter.discrepancyType);
      conditions.push(`discrepancy_type = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(
        `EXISTS (
           SELECT 1
             FROM scm_receiving_lines rl
            WHERE rl.id = scm_discrepancy_records.receiving_line_id
              AND rl.tenant_id = scm_discrepancy_records.tenant_id
              AND rl.warehouse_id = ANY($${params.length})
         )`,
      );
    }

    const r = await this.pool.query(
      `SELECT * FROM scm_discrepancy_records WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params,
    );
    return r.rows.map(toDiscrepancyRecord);
  }

  async createAccountingReadyEvent(
    tenantId: string,
    input: CreateScmAccountingReadyEventInput,
  ): Promise<ScmAccountingReadyEvent> {
    return this.inTransaction((client) => this.createAccountingReadyEventTx(client, tenantId, input));
  }

  /**
   * Resolves the accounting context an event needs, or refuses the operation.
   *
   * The Accounting consumer posts every event into exactly one legal entity and
   * one open period, so a goods movement that cannot name both would post to
   * nowhere. Fail closed: the caller's whole transaction rolls back rather than
   * moving stock that Finance can never see.
   */
  private async resolveAccountingContextTx(
    client: PoolClient,
    tenantId: string,
    warehouseId: string,
    effectiveAt: Date,
  ): Promise<{ legalEntityId: string; periodId: string }> {
    const leRes = await client.query(
      `SELECT ou.legal_entity_id
         FROM scm_warehouses w
         JOIN organization_units ou
           ON ou.tenant_id = w.tenant_id AND ou.id = w.organization_unit_id
        WHERE w.tenant_id = $1 AND w.id = $2 AND ou.legal_entity_id IS NOT NULL`,
      [tenantId, warehouseId],
    );
    const legalEntityId: string | undefined = leRes.rows[0]?.legal_entity_id;
    if (!legalEntityId) {
      throw new ValidationError(
        `Warehouse ${warehouseId} has no legal entity through its organization unit; cannot emit an accounting event`,
      );
    }

    const periodRes = await client.query(
      `SELECT id FROM accounting_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'open'
          AND date_from <= $3::date AND date_to >= $3::date
        ORDER BY date_from DESC
        LIMIT 1`,
      [tenantId, legalEntityId, effectiveAt.toISOString().slice(0, 10)],
    );
    const periodId: string | undefined = periodRes.rows[0]?.id;
    if (!periodId) {
      throw new ConflictError(
        `No open accounting period for ${effectiveAt.toISOString().slice(0, 10)} in legal entity ${legalEntityId}`,
      );
    }
    return { legalEntityId, periodId };
  }

  /**
   * Weighted-average unit cost of the item in that warehouse.
   *
   * Layers are the authority. Stock can also arrive without one — a raw
   * `POST /movements` carries its own unit cost and mints no layer — so fall
   * back to the most recent inbound movement's cost rather than valuing the
   * issue at zero and posting a nil journal.
   *
   * ponytail: layers are keyed by (item, warehouse), not by bin/condition, so
   * every movement in a warehouse shares one cost. Add position-level costing
   * when tenants start needing it.
   */
  private async resolveUnitCostTx(
    client: PoolClient,
    tenantId: string,
    itemId: string,
    warehouseId: string,
  ): Promise<number> {
    const r = await client.query(
      `SELECT SUM(remaining_quantity * effective_unit_cost) / NULLIF(SUM(remaining_quantity), 0) AS avg_cost
         FROM scm_valuation_layers
        WHERE tenant_id = $1 AND item_id = $2 AND warehouse_id = $3 AND remaining_quantity > 0`,
      [tenantId, itemId, warehouseId],
    );
    const layerCost = numOrNull(r.rows[0]?.avg_cost);
    if (layerCost !== null && layerCost > 0) return layerCost;

    const lastIn = await client.query(
      `SELECT unit_cost
         FROM scm_advanced_stock_movements
        WHERE tenant_id = $1 AND item_id = $2 AND warehouse_id = $3
          AND movement_type IN ('in', 'transfer_in', 'adjustment_in', 'opname_in')
          AND unit_cost IS NOT NULL AND unit_cost > 0
        ORDER BY occurred_at DESC, created_at DESC
        LIMIT 1`,
      [tenantId, itemId, warehouseId],
    );
    return num(lastIn.rows[0]?.unit_cost);
  }

  private async createAccountingReadyEventTx(
    client: PoolClient,
    tenantId: string,
    input: CreateScmAccountingReadyEventInput,
    preallocatedId?: string,
  ): Promise<ScmAccountingReadyEvent> {
    const id = preallocatedId ?? crypto.randomUUID();
    const r = await client.query(
      `INSERT INTO scm_accounting_ready_events (
         id, tenant_id, event_type, source_document_type, source_document_id,
         source_document_line_id, source_movement_id, source_document_revision,
         effective_at, currency, amount, quantity, unit_cost,
         account_assignment_type, account_assignment_dimensions, idempotency_key,
         reversal_of_event_id, outbox_state, reconciliation_state, payload, created_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         COALESCE($9, now()), $10, $11, $12, $13,
         $14, $15::jsonb, $16,
         $17, 'pending', 'unmatched', $18::jsonb, $19
       )
       RETURNING *`,
      [
        id,
        tenantId,
        input.eventType,
        input.sourceDocumentType,
        input.sourceDocumentId,
        input.sourceDocumentLineId ?? null,
        input.sourceMovementId ?? null,
        input.sourceDocumentRevision ?? 1,
        input.effectiveAt ?? null,
        input.currency ?? "IDR",
        input.amount ?? 0,
        input.quantity ?? null,
        input.unitCost ?? null,
        input.accountAssignmentType ?? null,
        JSON.stringify(input.accountAssignmentDimensions ?? {}),
        input.idempotencyKey,
        input.reversalOfEventId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.createdBy ?? null,
      ],
    );
    return toAccountingReadyEvent(r.rows[0]!);
  }

  async updateAccountingReadyEventState(
    tenantId: string,
    input: UpdateScmAccountingReadyEventStateInput,
  ): Promise<{ event: ScmAccountingReadyEvent; transition: ScmAccountingReadyEventStateTransition } | null> {
    return this.inTransaction(async (client) => {
      const lockRes = await client.query(
        `SELECT * FROM scm_accounting_ready_events WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, input.accountingEventId],
      );
      if (!lockRes.rows[0]) return null;
      const current = lockRes.rows[0]!;
      const fromState = input.stateKind === "outbox" ? (current.outbox_state as string) : (current.reconciliation_state as string);

      let upSql = "";
      if (input.stateKind === "outbox") {
        upSql = `UPDATE scm_accounting_ready_events SET outbox_state = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`;
      } else {
        upSql = `UPDATE scm_accounting_ready_events SET reconciliation_state = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`;
      }

      const upRes = await client.query(upSql, [tenantId, input.accountingEventId, input.toState]);
      const event = toAccountingReadyEvent(upRes.rows[0]!);

      const trRes = await client.query(
        `INSERT INTO scm_accounting_ready_event_state_transitions (
           tenant_id, accounting_event_id, state_kind, from_state, to_state, reason, occurred_at, occurred_by
         ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8)
         RETURNING *`,
        [
          tenantId,
          input.accountingEventId,
          input.stateKind,
          fromState,
          input.toState,
          input.reason ?? null,
          input.occurredAt ?? null,
          input.occurredBy ?? null,
        ],
      );
      const transition = toAccountingReadyEventStateTransition(trRes.rows[0]!);

      return { event, transition };
    });
  }

  async findAccountingReadyEventById(tenantId: string, eventId: string): Promise<ScmAccountingReadyEvent | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_accounting_ready_events WHERE tenant_id = $1 AND id = $2`,
      [tenantId, eventId],
    );
    return r.rows[0] ? toAccountingReadyEvent(r.rows[0]) : null;
  }

  async findAccountingReadyEventByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ScmAccountingReadyEvent | null> {
    const r = await this.pool.query(
      `SELECT * FROM scm_accounting_ready_events WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return r.rows[0] ? toAccountingReadyEvent(r.rows[0]) : null;
  }

  async listAccountingReadyEvents(
    tenantId: string,
    filter: ScmAccountingReadyEventFilter = {},
  ): Promise<ScmAccountingReadyEvent[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.eventType) {
      params.push(filter.eventType);
      conditions.push(`event_type = $${params.length}`);
    }
    if (filter.sourceDocumentType) {
      params.push(filter.sourceDocumentType);
      conditions.push(`source_document_type = $${params.length}`);
    }
    if (filter.sourceDocumentId) {
      params.push(filter.sourceDocumentId);
      conditions.push(`source_document_id = $${params.length}`);
    }
    if (filter.outboxState) {
      params.push(filter.outboxState);
      conditions.push(`outbox_state = $${params.length}`);
    }
    if (filter.reconciliationState) {
      params.push(filter.reconciliationState);
      conditions.push(`reconciliation_state = $${params.length}`);
    }
    if (filter.createdFrom) {
      params.push(filter.createdFrom);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.createdTo) {
      params.push(filter.createdTo);
      conditions.push(`created_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_accounting_ready_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toAccountingReadyEvent);
  }

  async createReturnToVendor(
    tenantId: string,
    input: CreateScmReturnToVendorInput,
  ): Promise<{ returnToVendor: ScmReturnToVendor; lines: ScmReturnToVendorLine[] }> {
    return this.inTransaction(async (client) => {
      const rtvRes = await client.query(
        `INSERT INTO scm_return_to_vendors (
           tenant_id, return_number, idempotency_key, supplier_id, purchase_order_id,
           warehouse_id, returned_at, returned_by, reason, status, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8, $9, 'executed', $10, $11)
         RETURNING *`,
        [
          tenantId,
          input.returnNumber,
          input.idempotencyKey,
          input.supplierId,
          input.purchaseOrderId ?? null,
          input.warehouseId,
          input.returnedAt ?? null,
          input.returnedBy ?? null,
          input.reason,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const returnToVendor = toReturnToVendor(rtvRes.rows[0]!);

      const lines: ScmReturnToVendorLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const stockCondition = line.stockCondition ?? "unrestricted";
        const ownerType = line.ownerType ?? "own";
        const ownerPartyId = line.ownerPartyId ?? null;

        // A return against a receiving line consumes that line's returned
        // quantity, atomically. This is what makes the supply ineligible for
        // payment later: accepted-eligible qty is
        // quantity_accepted - quantity_returned - quantity_reversed, so a
        // return that is not recorded here would leave the vendor invoice
        // looking payable. The cap is the physically received quantity, not
        // the accepted one — rejected and quarantined goods are exactly what
        // gets sent back before any inspection outcome exists.
        if (line.receivingLineId) {
          const capRes = await client.query(
            `UPDATE scm_receiving_lines
                SET quantity_returned = quantity_returned + $3
              WHERE tenant_id = $1
                AND id = $2
                AND receiving_record_id IS NOT NULL
                AND quantity_received - quantity_returned - quantity_reversed >= $3
              RETURNING id`,
            [tenantId, line.receivingLineId, line.quantity],
          );
          if (!capRes.rows[0]) {
            throw new ConflictError(
              `Return quantity ${line.quantity} for receiving line ${line.receivingLineId} exceeds the still-returnable quantity`,
            );
          }
        }

        // Returning goods to the supplier is a real goods-out: the stock
        // leaves the exact position it was sitting in. The ledger refuses a
        // negative balance, so a return of stock that is not there fails here
        // rather than silently corrupting the position.
        const movement = await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          locationId: line.locationId ?? null,
          batchId: line.batchId ?? null,
          stockCondition,
          ownerType,
          ownerPartyId,
          movementType: "return_to_vendor_out",
          quantity: line.quantity,
          referenceType: "scm_return_to_vendor",
          referenceId: returnToVendor.id,
          referenceNumber: returnToVendor.returnNumber,
          notes: line.notes ?? `Returned to vendor on ${returnToVendor.returnNumber}`,
          occurredAt: input.returnedAt,
          createdBy: input.createdBy ?? null,
        });

        // ADR-0023: SCM never writes GL journals — it emits an accounting-ready
        // event and the Accounting consumer posts it.
        const event = await this.createAccountingReadyEventTx(client, tenantId, {
          eventType: "inventory.returned_to_vendor",
          sourceDocumentType: "scm_return_to_vendor",
          sourceDocumentId: returnToVendor.id,
          sourceDocumentLineId: line.receivingLineId ?? null,
          sourceMovementId: movement.movement.id,
          effectiveAt: input.returnedAt ?? new Date(),
          quantity: line.quantity,
          idempotencyKey: `${input.idempotencyKey}:line:${sort}`,
          payload: {
            returnNumber: returnToVendor.returnNumber,
            supplierId: input.supplierId,
            purchaseOrderId: input.purchaseOrderId ?? null,
            reason: input.reason,
            receivingLineId: line.receivingLineId ?? null,
          },
          createdBy: input.createdBy ?? null,
        });

        const lRes = await client.query(
          `INSERT INTO scm_return_to_vendor_lines (
             tenant_id, return_to_vendor_id, receiving_line_id, item_id,
             warehouse_id, location_id, batch_id, stock_condition, owner_type, owner_party_id,
             quantity, movement_id, accounting_ready_event_id, notes, sort_order
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15
           )
           RETURNING *`,
          [
            tenantId,
            returnToVendor.id,
            line.receivingLineId ?? null,
            line.itemId,
            line.warehouseId,
            line.locationId ?? null,
            line.batchId ?? null,
            stockCondition,
            ownerType,
            ownerPartyId,
            line.quantity,
            movement.movement.id,
            event.id,
            line.notes ?? null,
            line.sortOrder ?? sort++,
          ],
        );
        lines.push(toReturnToVendorLine(lRes.rows[0]!));
      }

      return { returnToVendor, lines };
    });
  }

  async findReturnToVendorById(
    tenantId: string,
    returnToVendorId: string,
  ): Promise<{ returnToVendor: ScmReturnToVendor; lines: ScmReturnToVendorLine[] } | null> {
    const rtvRes = await this.pool.query(
      `SELECT * FROM scm_return_to_vendors WHERE tenant_id = $1 AND id = $2`,
      [tenantId, returnToVendorId],
    );
    if (!rtvRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_return_to_vendor_lines WHERE tenant_id = $1 AND return_to_vendor_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, returnToVendorId],
    );
    return {
      returnToVendor: toReturnToVendor(rtvRes.rows[0]),
      lines: linesRes.rows.map(toReturnToVendorLine),
    };
  }

  async findReturnToVendorByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ returnToVendor: ScmReturnToVendor; lines: ScmReturnToVendorLine[] } | null> {
    const rtvRes = await this.pool.query(
      `SELECT id FROM scm_return_to_vendors WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!rtvRes.rows[0]) return null;
    return this.findReturnToVendorById(tenantId, rtvRes.rows[0].id);
  }

  async listReturnToVendors(tenantId: string, filter: ScmReturnToVendorFilter = {}): Promise<ScmReturnToVendor[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.purchaseOrderId) {
      params.push(filter.purchaseOrderId);
      conditions.push(`purchase_order_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.returnedFrom) {
      params.push(filter.returnedFrom);
      conditions.push(`returned_at >= $${params.length}`);
    }
    if (filter.returnedTo) {
      params.push(filter.returnedTo);
      conditions.push(`returned_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_return_to_vendors
        WHERE ${conditions.join(" AND ")}
        ORDER BY returned_at DESC, created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toReturnToVendor);
  }

  async createReceiptReversal(
    tenantId: string,
    input: CreateScmReceiptReversalInput,
  ): Promise<{ reversal: ScmReceiptReversal; lines: ScmReceiptReversalLine[] }> {
    return this.inTransaction(async (client) => {
      // Lock the receiving record header so two concurrent reversals of the
      // same receipt cannot both pass the "already reversed" check.
      const recRes = await client.query(
        `SELECT * FROM scm_receiving_records
          WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
        [tenantId, input.receivingRecordId],
      );
      if (!recRes.rows[0] || recRes.rows[0].status === "reversed") {
        throw new ConflictError(`Receiving record ${input.receivingRecordId} cannot be reversed`);
      }
      const receiving = toReceivingRecord(recRes.rows[0]!);

      const lineRes = await client.query(
        `SELECT * FROM scm_receiving_lines
          WHERE tenant_id = $1 AND receiving_record_id = $2
          ORDER BY sort_order ASC, id ASC`,
        [tenantId, input.receivingRecordId],
      );
      const receivingLines = lineRes.rows.map(toReceivingLine);

      // Compute the effective reversible quantity for each line. The original
      // receipt inserted the full quantity_received as an inspection hold-in
      // movement; a reversal removes exactly the still-unreversed remainder.
      const reversals: Array<{ line: ScmReceivingLine; quantity: number }> = [];
      for (const line of receivingLines) {
        const reversibleQty = num(line.quantityReceived) - num(line.quantityReversed);
        if (reversibleQty <= 0) {
          continue;
        }
        reversals.push({ line, quantity: reversibleQty });
      }
      if (reversals.length === 0) {
        throw new ConflictError(`Receiving record ${input.receivingRecordId} has nothing left to reverse`);
      }

      const revRes = await client.query(
        `INSERT INTO scm_receipt_reversals (
           tenant_id, reversal_number, idempotency_key, receiving_record_id,
           reason, reversed_at, reversed_by, created_by
         ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $8)
         RETURNING *`,
        [
          tenantId,
          input.reversalNumber,
          input.idempotencyKey,
          input.receivingRecordId,
          input.reason,
          input.reversedAt ?? null,
          input.reversedBy ?? null,
          input.createdBy ?? null,
        ],
      );
      const reversal = toReceiptReversal(revRes.rows[0]!);

      const lines: ScmReceiptReversalLine[] = [];
      let sort = 0;
      for (const { line, quantity } of reversals) {
        // Compensate the stock position that the receipt populated. The
        // movement is created from the receiving line's stock position so the
        // exact balance that holds the goods is depleted deterministically.
        const compRes = await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          locationId: line.locationId,
          batchId: line.batchId,
          stockCondition: line.stockCondition,
          ownerType: line.ownerType,
          ownerPartyId: line.ownerPartyId,
          movementType: "receipt_reversal_out",
          quantity,
          unitCost: line.unitCost,
          totalCost: quantity * (line.unitCost ?? 0),
          referenceType: "scm_receipt_reversal",
          referenceId: input.receivingRecordId,
          referenceNumber: input.reversalNumber,
          notes: `Reverse ${receiving.receiptNumber} line ${quantity}`,
          occurredAt: input.reversedAt,
          createdBy: input.createdBy ?? null,
        });

        await client.query(
          `UPDATE scm_receiving_lines
              SET quantity_reversed = quantity_reversed + $3
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, line.id, quantity],
        );

        const lRes = await client.query(
          `INSERT INTO scm_receipt_reversal_lines (
             tenant_id, reversal_id, receiving_line_id, quantity, movement_id, restored_layer_id, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            tenantId,
            reversal.id,
            line.id,
            quantity,
            compRes.movement.id,
            line.valuationLayerId ?? null,
            sort,
          ],
        );
        lines.push(toReceiptReversalLine(lRes.rows[0]!));
        sort++;
      }

      // The receiving record header moves to `reversed` once every line has
      // been fully compensated. `stock_condition` on the line stays within its
      // allowed CHECK values — the header carries the terminal state.
      await client.query(
        `UPDATE scm_receiving_records
            SET status = $3,
                updated_by = COALESCE($4, updated_by),
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, input.receivingRecordId, "reversed", input.reversedBy ?? null],
      );

      return { reversal, lines };
    });
  }

  async findReceiptReversalByReceivingRecordId(
    tenantId: string,
    receivingRecordId: string,
  ): Promise<{ reversal: ScmReceiptReversal; lines: ScmReceiptReversalLine[] } | null> {
    const revRes = await this.pool.query(
      `SELECT * FROM scm_receipt_reversals WHERE tenant_id = $1 AND receiving_record_id = $2`,
      [tenantId, receivingRecordId],
    );
    if (!revRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_receipt_reversal_lines WHERE tenant_id = $1 AND reversal_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, revRes.rows[0].id],
    );
    return {
      reversal: toReceiptReversal(revRes.rows[0]),
      lines: linesRes.rows.map(toReceiptReversalLine),
    };
  }

  async findReceiptReversalByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ reversal: ScmReceiptReversal; lines: ScmReceiptReversalLine[] } | null> {
    const revRes = await this.pool.query(
      `SELECT * FROM scm_receipt_reversals WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!revRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_receipt_reversal_lines WHERE tenant_id = $1 AND reversal_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, revRes.rows[0].id],
    );
    return {
      reversal: toReceiptReversal(revRes.rows[0]),
      lines: linesRes.rows.map(toReceiptReversalLine),
    };
  }

  async createValuationLayerAllocation(
    tenantId: string,
    input: CreateScmValuationLayerAllocationInput,
  ): Promise<ScmValuationLayerAllocation> {
    const r = await this.pool.query(
      `INSERT INTO scm_valuation_layer_allocations (
         tenant_id, valuation_layer_id, movement_id, allocation_type,
         quantity, unit_cost, amount, reverses_allocation_id, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        tenantId,
        input.valuationLayerId,
        input.movementId,
        input.allocationType,
        input.quantity,
        input.unitCost,
        input.amount,
        input.reversesAllocationId ?? null,
        input.createdBy ?? null,
      ],
    );
    return toValuationLayerAllocation(r.rows[0]!);
  }

  async listValuationLayerAllocations(
    tenantId: string,
    filter: ScmValuationLayerAllocationFilter = {},
  ): Promise<ScmValuationLayerAllocation[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.valuationLayerId) {
      params.push(filter.valuationLayerId);
      conditions.push(`valuation_layer_id = $${params.length}`);
    }
    if (filter.movementId) {
      params.push(filter.movementId);
      conditions.push(`movement_id = $${params.length}`);
    }
    if (filter.allocationType) {
      params.push(filter.allocationType);
      conditions.push(`allocation_type = $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_valuation_layer_allocations
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toValuationLayerAllocation);
  }

  // =========================================================================
  // Stage 2: Replacement Deliveries
  // =========================================================================

  async createReplacementDelivery(
    tenantId: string,
    input: CreateScmReplacementDeliveryInput,
  ): Promise<{ replacement: ScmReplacementDelivery; lines: ScmReplacementDeliveryLine[] }> {
    return this.inTransaction(async (client) => {
      const rdRes = await client.query(
        `INSERT INTO scm_replacement_deliveries (
           tenant_id, replacement_number, idempotency_key, return_to_vendor_id,
           purchase_order_id, supplier_id, warehouse_id, location_id,
           received_at, received_by, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10, $11, $12)
         RETURNING *`,
        [
          tenantId,
          input.replacementNumber,
          input.idempotencyKey,
          input.returnToVendorId,
          input.purchaseOrderId ?? null,
          input.supplierId,
          input.warehouseId,
          input.locationId ?? null,
          input.receivedAt ?? null,
          input.receivedBy ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const replacement = toReplacementDelivery(rdRes.rows[0]!);

      const lines: ScmReplacementDeliveryLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const stockCondition = line.stockCondition ?? "quality_hold";
        const ownerType = line.ownerType ?? "own";
        const ownerPartyId = line.ownerPartyId ?? null;
        const unitCost = line.unitCost ?? null;
        const currency = line.currency ?? "IDR";
        const assignmentType = line.accountAssignmentType ?? "stock";
        const assignmentDimensions = line.accountAssignmentDimensions ?? {};
        const amount = line.quantity * (unitCost ?? 0);

        const shouldEmitEvent = ownerType === "own";
        const preallocatedEventId = shouldEmitEvent ? crypto.randomUUID() : null;

        const movement = await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          locationId: line.locationId ?? null,
          batchId: line.batchId ?? null,
          stockCondition,
          ownerType,
          ownerPartyId,
          movementType: "replacement_in",
          quantity: line.quantity,
          unitCost,
          totalCost: amount,
          referenceType: "scm_replacement_delivery",
          referenceId: replacement.id,
          referenceNumber: replacement.replacementNumber,
          accountingReadyEventId: preallocatedEventId,
          notes: line.notes ?? "Replacement delivery received",
          occurredAt: input.receivedAt,
          createdBy: input.createdBy ?? null,
        });

        let eventId: string | null = null;
        if (shouldEmitEvent && preallocatedEventId) {
          const event = await this.createAccountingReadyEventTx(
            client,
            tenantId,
            {
              eventType: "inventory.goods_received",
              sourceDocumentType: "scm_replacement_delivery",
              sourceDocumentId: replacement.id,
              sourceMovementId: movement.movement.id,
              effectiveAt: replacement.receivedAt,
              currency,
              amount,
              quantity: line.quantity,
              unitCost,
              accountAssignmentType: assignmentType,
              accountAssignmentDimensions: assignmentDimensions,
              idempotencyKey: `${input.idempotencyKey}:line:${sort}`,
              payload: {
                replacementNumber: replacement.replacementNumber,
                returnToVendorId: input.returnToVendorId,
                returnToVendorLineId: line.returnToVendorLineId ?? null,
                supplierId: input.supplierId,
              },
              createdBy: input.createdBy ?? null,
            },
            preallocatedEventId,
          );
          eventId = event.id;
        }

        const lRes = await client.query(
          `INSERT INTO scm_replacement_delivery_lines (
             tenant_id, replacement_delivery_id, return_to_vendor_line_id, purchase_order_line_id,
             item_id, warehouse_id, location_id, batch_id,
             stock_condition, owner_type, owner_party_id,
             quantity, unit_cost, currency, account_assignment_type, account_assignment_dimensions,
             movement_id, accounting_ready_event_id, notes, sort_order
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8,
             $9, $10, $11,
             $12, $13, $14, $15, $16,
             $17, $18, $19, $20
           )
           RETURNING *`,
          [
            tenantId,
            replacement.id,
            line.returnToVendorLineId ?? null,
            line.purchaseOrderLineId ?? null,
            line.itemId,
            line.warehouseId,
            line.locationId ?? null,
            line.batchId ?? null,
            stockCondition,
            ownerType,
            ownerPartyId,
            line.quantity,
            unitCost,
            currency,
            assignmentType,
            JSON.stringify(assignmentDimensions),
            movement.movement.id,
            eventId,
            line.notes ?? null,
            line.sortOrder ?? sort,
          ],
        );
        lines.push(toReplacementDeliveryLine(lRes.rows[0]!));
        sort += 1;
      }

      return { replacement, lines };
    });
  }

  async findReplacementDeliveryById(
    tenantId: string,
    replacementDeliveryId: string,
  ): Promise<{ replacement: ScmReplacementDelivery; lines: ScmReplacementDeliveryLine[] } | null> {
    const rdRes = await this.pool.query(
      `SELECT * FROM scm_replacement_deliveries WHERE tenant_id = $1 AND id = $2`,
      [tenantId, replacementDeliveryId],
    );
    if (!rdRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_replacement_delivery_lines WHERE tenant_id = $1 AND replacement_delivery_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, replacementDeliveryId],
    );
    return {
      replacement: toReplacementDelivery(rdRes.rows[0]),
      lines: linesRes.rows.map(toReplacementDeliveryLine),
    };
  }

  async findReplacementDeliveryByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ replacement: ScmReplacementDelivery; lines: ScmReplacementDeliveryLine[] } | null> {
    const rdRes = await this.pool.query(
      `SELECT id FROM scm_replacement_deliveries WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!rdRes.rows[0]) return null;
    return this.findReplacementDeliveryById(tenantId, rdRes.rows[0].id);
  }

  async listReplacementDeliveries(
    tenantId: string,
    filter: ScmReplacementDeliveryFilter = {},
  ): Promise<ScmReplacementDelivery[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.returnToVendorId) {
      params.push(filter.returnToVendorId);
      conditions.push(`return_to_vendor_id = $${params.length}`);
    }
    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.receivedFrom) {
      params.push(filter.receivedFrom);
      conditions.push(`received_at >= $${params.length}`);
    }
    if (filter.receivedTo) {
      params.push(filter.receivedTo);
      conditions.push(`received_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_replacement_deliveries
        WHERE ${conditions.join(" AND ")}
        ORDER BY received_at DESC, created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toReplacementDelivery);
  }

  // =========================================================================
  // Stage 2: Service Acceptances (Service Entry Sheets)
  // =========================================================================

  async createServiceAcceptance(
    tenantId: string,
    input: CreateScmServiceAcceptanceInput,
  ): Promise<{ serviceAcceptance: ScmServiceAcceptance; lines: ScmServiceAcceptanceLine[] }> {
    return this.inTransaction(async (client) => {
      const saRes = await client.query(
        `INSERT INTO scm_service_acceptances (
           tenant_id, acceptance_number, idempotency_key, purchase_order_id,
           supplier_id, organization_unit_id, service_period_start, service_period_end,
           notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          tenantId,
          input.acceptanceNumber,
          input.idempotencyKey,
          input.purchaseOrderId,
          input.supplierId,
          input.organizationUnitId ?? null,
          input.servicePeriodStart ?? null,
          input.servicePeriodEnd ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const serviceAcceptance = toServiceAcceptance(saRes.rows[0]!);

      const lines: ScmServiceAcceptanceLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const lRes = await client.query(
          `INSERT INTO scm_service_acceptance_lines (
             tenant_id, service_acceptance_id, purchase_order_line_id,
             description, quantity, unit_price, currency, amount,
             account_assignment_type, account_assignment_dimensions,
             notes, sort_order
           ) VALUES (
             $1, $2, $3,
             $4, $5, $6, $7, $8,
             $9, $10,
             $11, $12
           )
           RETURNING *`,
          [
            tenantId,
            serviceAcceptance.id,
            line.purchaseOrderLineId,
            line.description,
            line.quantity,
            line.unitPrice,
            line.currency ?? "IDR",
            line.amount,
            line.accountAssignmentType ?? "service",
            JSON.stringify(line.accountAssignmentDimensions ?? {}),
            line.notes ?? null,
            line.sortOrder ?? sort++,
          ],
        );
        lines.push(toServiceAcceptanceLine(lRes.rows[0]!));
      }

      return { serviceAcceptance, lines };
    });
  }

  async deleteServiceAcceptanceWithoutWorkflow(
    tenantId: string,
    serviceAcceptanceId: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_service_acceptances WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, serviceAcceptanceId],
    );
  }

  async updateServiceAcceptanceStatus(
    tenantId: string,
    input: UpdateScmServiceAcceptanceStatusInput,
  ): Promise<ScmServiceAcceptance | null> {
    const r = await this.pool.query(
      `UPDATE scm_service_acceptances
         SET status = $3,
             workflow_instance_id = COALESCE($4, workflow_instance_id),
             submitted_at = COALESCE($5, submitted_at),
             submitted_by = COALESCE($6, submitted_by),
             approved_at = COALESCE($7, approved_at),
             approved_by = COALESCE($8, approved_by),
             rejected_at = COALESCE($9, rejected_at),
             rejected_by = COALESCE($10, rejected_by),
             rejection_reason = COALESCE($11, rejection_reason),
             updated_by = COALESCE($12, updated_by),
             updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        input.serviceAcceptanceId,
        input.status,
        input.workflowInstanceId ?? null,
        input.submittedAt ?? null,
        input.submittedBy ?? null,
        input.approvedAt ?? null,
        input.approvedBy ?? null,
        input.rejectedAt ?? null,
        input.rejectedBy ?? null,
        input.rejectionReason ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toServiceAcceptance(r.rows[0]) : null;
  }

  async freezeServiceAcceptanceLineAssignment(
    tenantId: string,
    lineId: string,
    frozenAt: Date,
    accountingReadyEventId?: string | null,
  ): Promise<ScmServiceAcceptanceLine | null> {
    const r = await this.pool.query(
      `UPDATE scm_service_acceptance_lines
         SET frozen_account_assignment_at = $3,
             accounting_ready_event_id = COALESCE($4, accounting_ready_event_id)
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, lineId, frozenAt, accountingReadyEventId ?? null],
    );
    return r.rows[0] ? toServiceAcceptanceLine(r.rows[0]) : null;
  }

  async findServiceAcceptanceById(
    tenantId: string,
    serviceAcceptanceId: string,
  ): Promise<{ serviceAcceptance: ScmServiceAcceptance; lines: ScmServiceAcceptanceLine[] } | null> {
    const saRes = await this.pool.query(
      `SELECT * FROM scm_service_acceptances WHERE tenant_id = $1 AND id = $2`,
      [tenantId, serviceAcceptanceId],
    );
    if (!saRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_service_acceptance_lines WHERE tenant_id = $1 AND service_acceptance_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, serviceAcceptanceId],
    );
    return {
      serviceAcceptance: toServiceAcceptance(saRes.rows[0]),
      lines: linesRes.rows.map(toServiceAcceptanceLine),
    };
  }

  async findServiceAcceptanceByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ serviceAcceptance: ScmServiceAcceptance; lines: ScmServiceAcceptanceLine[] } | null> {
    const saRes = await this.pool.query(
      `SELECT id FROM scm_service_acceptances WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!saRes.rows[0]) return null;
    return this.findServiceAcceptanceById(tenantId, saRes.rows[0].id);
  }

  async listServiceAcceptances(
    tenantId: string,
    filter: ScmServiceAcceptanceFilter = {},
  ): Promise<ScmServiceAcceptance[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.purchaseOrderId) {
      params.push(filter.purchaseOrderId);
      conditions.push(`purchase_order_id = $${params.length}`);
    }
    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.organizationUnitIds && filter.organizationUnitIds.length > 0) {
      params.push(filter.organizationUnitIds);
      conditions.push(`organization_unit_id = ANY($${params.length})`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.createdFrom) {
      params.push(filter.createdFrom);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.createdTo) {
      params.push(filter.createdTo);
      conditions.push(`created_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_service_acceptances
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toServiceAcceptance);
  }

  // =========================================================================
  // Phase 2 WP-PRO-01: Vendor Invoices (AP Invoice, PO-based)
  // =========================================================================

  /**
   * Validate (Rules 1-5 per ADR-0023) and create a vendor invoice atomically.
   * All validation reads and the INSERTs run in one transaction that takes a
   * FOR UPDATE lock on the PO lines, so two concurrent invoices for the same
   * PO line cannot both pass the cumulative-quantity rule (TOCTOU race).
   */
  async createVendorInvoice(
    tenantId: string,
    input: CreateScmVendorInvoiceInput,
  ): Promise<{ vendorInvoice: ScmVendorInvoice; lines: ScmVendorInvoiceLine[] }> {
    return this.inTransaction(async (client) => {
      // Lock PO lines for validation and inserts
      const poLineIds = input.lines.map((line) => line.purchaseOrderLineId);
      const poLinesResult = await client.query(
        `SELECT pol.id, pol.unit_price, po.currency
           FROM purchase_order_lines pol
           JOIN purchase_orders po ON po.id = pol.purchase_order_id AND po.tenant_id = pol.tenant_id
          WHERE pol.tenant_id = $1 AND pol.purchase_order_id = $2
          FOR UPDATE OF pol`,
        [tenantId, input.purchaseOrderId],
      );
      const poLines = poLinesResult.rows.map((row) => ({
        id: row.id as string,
        unitPrice: row.unit_price === null ? 0 : num(row.unit_price),
        currency: (row.currency as string | null) ?? "IDR",
      }));
      const poLinesById = new Map(poLines.map((pol) => [pol.id, pol]));

      // Read prior invoiced quantities (exclude rejected/cancelled)
      const invoicedQtyRes = await client.query(
        `SELECT vil.purchase_order_line_id, COALESCE(SUM(vil.quantity_invoiced), 0) AS qty
           FROM scm_vendor_invoice_lines vil
           JOIN scm_vendor_invoices vi ON vi.id = vil.vendor_invoice_id AND vi.tenant_id = vil.tenant_id
          WHERE vil.tenant_id = $1 AND vil.purchase_order_line_id = ANY($2) AND vi.status != ALL($3)
          GROUP BY vil.purchase_order_line_id`,
        [tenantId, poLineIds, ["rejected", "cancelled"]],
      );
      const invoicedQtyByPoLine = new Map<string, number>();
      for (const row of invoicedQtyRes.rows) {
        invoicedQtyByPoLine.set(row.purchase_order_line_id as string, num(row.qty));
      }

      // Read GR accepted-eligible quantities
      const acceptedQtyRes = await client.query(
        `SELECT sl.purchase_order_line_id,
                COALESCE(SUM(sl.quantity_accepted - sl.quantity_returned - sl.quantity_reversed), 0) AS qty
           FROM scm_receiving_lines sl
           JOIN scm_receiving_records sr ON sr.id = sl.receiving_record_id AND sr.tenant_id = sl.tenant_id
          WHERE sl.tenant_id = $1 AND sr.purchase_order_id = $2
          GROUP BY sl.purchase_order_line_id`,
        [tenantId, input.purchaseOrderId],
      );
      const acceptedQtyByPoLine = new Map<string, number>();
      for (const row of acceptedQtyRes.rows) {
        acceptedQtyByPoLine.set(row.purchase_order_line_id as string, num(row.qty));
      }

      // Validate Rules 1-5 (Rules 4-5 use exact BigInt arithmetic)
      const invoiceCurrency = input.currency ?? "IDR";
      let lineAmountSumUnits = 0n;
      const invoiceAmountUnits = toExactUnits(input.invoiceAmount);

      for (let i = 0; i < input.lines.length; i++) {
        const line = input.lines[i]!;
        const lineIndex = i + 1;

        // Rule 1: PO line belongs to the specified PO
        const poLine = poLinesById.get(line.purchaseOrderLineId);
        if (!poLine) {
          throw new ValidationError(
            `Line ${lineIndex}: PO line ${line.purchaseOrderLineId} not found in PO ${input.purchaseOrderId}`,
          );
        }

        // Rule 4: Amount consistency (server-side recomputation, exact decimal)
        const computedLineAmount = multiplyQuantityCost(line.quantityInvoiced, line.unitPrice);
        const computedLineAmountUnits = toExactUnits(computedLineAmount);
        const inputLineAmountUnits = toExactUnits(line.lineAmount);
        if (computedLineAmountUnits !== inputLineAmountUnits) {
          throw new ValidationError(
            `Line ${lineIndex}: lineAmount ${line.lineAmount} does not match qty ${line.quantityInvoiced} × unitPrice ${line.unitPrice} (computed: ${computedLineAmount})`,
          );
        }

        // Rule 3: Price within 0.5% tolerance of PO unit_price
        const priceTolerance = poLine.unitPrice * 0.005;
        if (Math.abs(line.unitPrice - poLine.unitPrice) > priceTolerance) {
          throw new ValidationError(
            `Line ${lineIndex}: unitPrice ${line.unitPrice} differs from PO ${poLine.unitPrice} by more than 0.5%`,
          );
        }

        // Rule 2: Cumulative invoiced qty (within locked transaction, no race)
        const priorInvoiced = invoicedQtyByPoLine.get(line.purchaseOrderLineId) ?? 0;
        const cumulativeInvoiced = priorInvoiced + line.quantityInvoiced;
        const acceptedEligible = acceptedQtyByPoLine.get(line.purchaseOrderLineId) ?? 0;

        if (cumulativeInvoiced > acceptedEligible) {
          throw new ValidationError(
            `Line ${lineIndex}: cumulative invoiced qty ${cumulativeInvoiced} exceeds GR accepted-eligible qty ${acceptedEligible}`,
          );
        }

        // Accumulate line amounts for header check
        lineAmountSumUnits += computedLineAmountUnits;

        // Currency consistency: each line currency must match PO currency AND invoice currency
        const lineCurrency = line.currency ?? "IDR";
        if (lineCurrency !== invoiceCurrency) {
          throw new ValidationError(
            `Line ${lineIndex}: currency ${lineCurrency} does not match invoice currency ${invoiceCurrency}`,
          );
        }
        if (lineCurrency !== poLine.currency) {
          throw new ValidationError(
            `Line ${lineIndex}: currency ${lineCurrency} does not match PO currency ${poLine.currency}`,
          );
        }
      }

      // Rule 5: Header consistency (exact BigInt match)
      if (lineAmountSumUnits !== invoiceAmountUnits) {
        const lineAmountSum = fromExactUnits(lineAmountSumUnits);
        throw new ValidationError(
          `Invoice header: sum of line amounts ${lineAmountSum} does not match invoice amount ${input.invoiceAmount}`,
        );
      }

      // All validations passed; now INSERT (within same transaction/lock)
      const viRes = await client.query(
        `INSERT INTO scm_vendor_invoices (
           tenant_id, invoice_number, idempotency_key, purchase_order_id,
           receiving_record_id, supplier_id, invoice_amount, currency,
           notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          tenantId,
          input.invoiceNumber,
          input.idempotencyKey,
          input.purchaseOrderId,
          input.receivingRecordId,
          input.supplierId,
          input.invoiceAmount,
          invoiceCurrency,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const vendorInvoice = toVendorInvoice(viRes.rows[0]!);

      const lines: ScmVendorInvoiceLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const lRes = await client.query(
          `INSERT INTO scm_vendor_invoice_lines (
             tenant_id, vendor_invoice_id, purchase_order_line_id, receiving_line_id,
             description, quantity_invoiced, unit_price, currency, line_amount,
             account_assignment_type, account_assignment_dimensions,
             notes, sort_order
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8, $9,
             $10, $11,
             $12, $13
           )
           RETURNING *`,
          [
            tenantId,
            vendorInvoice.id,
            line.purchaseOrderLineId,
            line.receivingLineId ?? null,
            line.description,
            line.quantityInvoiced,
            line.unitPrice,
            line.currency ?? "IDR",
            line.lineAmount,
            line.accountAssignmentType ?? "expense",
            JSON.stringify(line.accountAssignmentDimensions ?? {}),
            line.notes ?? null,
            line.sortOrder ?? sort++,
          ],
        );
        lines.push(toVendorInvoiceLine(lRes.rows[0]!));
      }

      return { vendorInvoice, lines };
    });
  }

  async deleteVendorInvoiceWithoutWorkflow(
    tenantId: string,
    vendorInvoiceId: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_vendor_invoices WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, vendorInvoiceId],
    );
  }

  /**
   * Atomically claim the workflow-instance slot for a vendor invoice. Returns
   * true if THIS caller won the claim; false if another concurrent retry
   * already started the workflow. Guards against the 23505 idempotency race
   * where both losers of the insert race would otherwise each start their own
   * workflow instance for the same invoice.
   */
  async claimVendorInvoiceWorkflowInstance(
    tenantId: string,
    vendorInvoiceId: string,
    workflowInstanceId: string,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE scm_vendor_invoices
         SET workflow_instance_id = $3,
             updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL
       RETURNING id`,
      [tenantId, vendorInvoiceId, workflowInstanceId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async updateVendorInvoiceStatus(
    tenantId: string,
    input: UpdateScmVendorInvoiceStatusInput,
  ): Promise<ScmVendorInvoice | null> {
    const r = await this.pool.query(
      `UPDATE scm_vendor_invoices
         SET status = $3,
             workflow_instance_id = COALESCE($4, workflow_instance_id),
             submitted_at = COALESCE($5, submitted_at),
             submitted_by = COALESCE($6, submitted_by),
             approved_at = COALESCE($7, approved_at),
             approved_by = COALESCE($8, approved_by),
             rejected_at = COALESCE($9, rejected_at),
             rejected_by = COALESCE($10, rejected_by),
             rejection_reason = COALESCE($11, rejection_reason),
             updated_by = COALESCE($12, updated_by),
             updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        input.vendorInvoiceId,
        input.status,
        input.workflowInstanceId ?? null,
        input.submittedAt ?? null,
        input.submittedBy ?? null,
        input.approvedAt ?? null,
        input.approvedBy ?? null,
        input.rejectedAt ?? null,
        input.rejectedBy ?? null,
        input.rejectionReason ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toVendorInvoice(r.rows[0]) : null;
  }

  async freezeVendorInvoiceLineAssignment(
    tenantId: string,
    lineId: string,
    frozenAt: Date,
    accountingReadyEventId?: string | null,
  ): Promise<ScmVendorInvoiceLine | null> {
    const r = await this.pool.query(
      `UPDATE scm_vendor_invoice_lines
         SET frozen_account_assignment_at = $3,
             accounting_ready_event_id = COALESCE($4, accounting_ready_event_id)
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, lineId, frozenAt, accountingReadyEventId ?? null],
    );
    return r.rows[0] ? toVendorInvoiceLine(r.rows[0]) : null;
  }

  /**
   * Phase 2 WP-PRO-01 — atomic approval: set the invoice's terminal status and
   * emit one accounting-ready event + freeze per line in a single transaction.
   * Without this, a crash or constraint failure between the status update and
   * the per-line event loop leaves an "approved" invoice with missing AP
   * postings and the status guard blocks any recovery.
   */
  async approveVendorInvoiceWithEvents(
    tenantId: string,
    input: UpdateScmVendorInvoiceStatusInput,
    events: Array<{
      lineId: string;
      event: CreateScmAccountingReadyEventInput;
    }>,
  ): Promise<ScmVendorInvoice | null> {
    return this.inTransaction(async (client) => {
      const r = await client.query(
        `UPDATE scm_vendor_invoices
           SET status = $3,
               workflow_instance_id = COALESCE($4, workflow_instance_id),
               submitted_at = COALESCE($5, submitted_at),
               submitted_by = COALESCE($6, submitted_by),
               approved_at = COALESCE($7, approved_at),
               approved_by = COALESCE($8, approved_by),
               rejected_at = COALESCE($9, rejected_at),
               rejected_by = COALESCE($10, rejected_by),
               rejection_reason = COALESCE($11, rejection_reason),
               updated_by = COALESCE($12, updated_by),
               updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          tenantId,
          input.vendorInvoiceId,
          input.status,
          input.workflowInstanceId ?? null,
          input.submittedAt ?? null,
          input.submittedBy ?? null,
          input.approvedAt ?? null,
          input.approvedBy ?? null,
          input.rejectedAt ?? null,
          input.rejectedBy ?? null,
          input.rejectionReason ?? null,
          input.updatedBy ?? null,
        ],
      );
      const invoice = r.rows[0] ? toVendorInvoice(r.rows[0]) : null;

      for (const { lineId, event } of events) {
        const created = await this.createAccountingReadyEventTx(client, tenantId, event);
        await client.query(
          `UPDATE scm_vendor_invoice_lines
             SET frozen_account_assignment_at = $3,
                 accounting_ready_event_id = COALESCE($4, accounting_ready_event_id)
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, lineId, created.effectiveAt ?? null, created.id],
        );
      }
      return invoice;
    });
  }

  async findVendorInvoiceById(
    tenantId: string,
    vendorInvoiceId: string,
  ): Promise<{ vendorInvoice: ScmVendorInvoice; lines: ScmVendorInvoiceLine[] } | null> {
    const viRes = await this.pool.query(
      `SELECT * FROM scm_vendor_invoices WHERE tenant_id = $1 AND id = $2`,
      [tenantId, vendorInvoiceId],
    );
    if (!viRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_vendor_invoice_lines WHERE tenant_id = $1 AND vendor_invoice_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, vendorInvoiceId],
    );
    return {
      vendorInvoice: toVendorInvoice(viRes.rows[0]),
      lines: linesRes.rows.map(toVendorInvoiceLine),
    };
  }

  async findVendorInvoiceByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ vendorInvoice: ScmVendorInvoice; lines: ScmVendorInvoiceLine[] } | null> {
    const viRes = await this.pool.query(
      `SELECT id FROM scm_vendor_invoices WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!viRes.rows[0]) return null;
    return this.findVendorInvoiceById(tenantId, viRes.rows[0].id);
  }

  async sumVendorInvoiceAmountsForPurchaseOrder(
    tenantId: string,
    purchaseOrderId: string,
    excludeStatuses: ScmVendorInvoiceStatus[] = ["rejected", "cancelled"],
  ): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(invoice_amount), 0) AS total
         FROM scm_vendor_invoices
        WHERE tenant_id = $1 AND purchase_order_id = $2 AND status != ALL($3)`,
      [tenantId, purchaseOrderId, excludeStatuses],
    );
    return num(r.rows[0]?.total ?? 0);
  }

  async listVendorInvoices(
    tenantId: string,
    filter: ScmVendorInvoiceFilter = {},
  ): Promise<ScmVendorInvoice[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.purchaseOrderId) {
      params.push(filter.purchaseOrderId);
      conditions.push(`purchase_order_id = $${params.length}`);
    }
    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.createdFrom) {
      params.push(filter.createdFrom);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.createdTo) {
      params.push(filter.createdTo);
      conditions.push(`created_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_vendor_invoices
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toVendorInvoice);
  }

  // =========================================================================
  // Phase 2 WP-PRO-03: AP Payment Batch
  // =========================================================================

  /**
   * Atomically create a payment batch. Validates each invoice is status='approved'
   * and not already on a non-cancelled payment line. Returns batch + lines.
   */
  async createPaymentBatch(
    tenantId: string,
    input: CreateScmPaymentBatchInput,
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] }> {
    return this.inTransaction(async (client) => {
      // Validate each invoice: status='approved', fetch amount + currency
      const invoiceIds = input.lines.map((l) => l.vendorInvoiceId);
      if (invoiceIds.length === 0) {
        throw new ValidationError("Payment batch must have at least one line");
      }

      const invoicesRes = await client.query(
        `SELECT id, status, invoice_amount, currency FROM scm_vendor_invoices
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])
          FOR UPDATE`,
        [tenantId, invoiceIds],
      );

      const invoicesMap = new Map(invoicesRes.rows.map((r) => [r.id, r]));

      for (const invId of invoiceIds) {
        const inv = invoicesMap.get(invId);
        if (!inv) {
          throw new ValidationError(`Vendor invoice ${invId} not found`);
        }
        if (inv.status !== "approved") {
          throw new ValidationError(`Vendor invoice ${invId} has status '${inv.status}', must be 'approved'`);
        }
      }

      // Recheck accepted eligibility at payment time. Approval can predate a
      // return or receipt reversal, so invoice status alone is insufficient.
      const eligibilityRes = await client.query(
        `SELECT vil.vendor_invoice_id,
                vil.purchase_order_line_id,
                SUM(vil.quantity_invoiced) AS invoiced_qty,
                COALESCE((
                  SELECT SUM(sl.quantity_accepted - sl.quantity_returned - sl.quantity_reversed)
                    FROM scm_receiving_lines sl
                    JOIN scm_receiving_records sr
                      ON sr.id = sl.receiving_record_id AND sr.tenant_id = sl.tenant_id
                   WHERE sl.tenant_id = vil.tenant_id
                     AND sr.purchase_order_id = vi.purchase_order_id
                     AND sl.purchase_order_line_id = vil.purchase_order_line_id
                ), 0) AS eligible_qty
           FROM scm_vendor_invoice_lines vil
           JOIN scm_vendor_invoices vi
             ON vi.id = vil.vendor_invoice_id AND vi.tenant_id = vil.tenant_id
          WHERE vil.tenant_id = $1
            AND vil.vendor_invoice_id = ANY($2::uuid[])
          GROUP BY vil.tenant_id, vil.vendor_invoice_id, vil.purchase_order_line_id, vi.purchase_order_id`,
        [tenantId, invoiceIds],
      );
      for (const row of eligibilityRes.rows) {
        const invoicedQty = num(row.invoiced_qty);
        const eligibleQty = num(row.eligible_qty);
        if (invoicedQty > eligibleQty) {
          throw new ConflictError(
            `Vendor invoice ${row.vendor_invoice_id} is no longer payment-eligible: invoiced qty ${invoicedQty} exceeds accepted-eligible qty ${eligibleQty}`,
          );
        }
      }

      // Check for duplicates within this batch
      const uniqueIds = new Set(invoiceIds);
      if (uniqueIds.size !== invoiceIds.length) {
        throw new ValidationError("Duplicate vendor invoice in payment batch lines");
      }

      // Check if any invoice is already on a non-cancelled payment line. The
      // payment_lines FK to vendor_invoices is RESTRICT, so we hold the invoice
      // row lock taken above for the duration of this read + the line INSERT,
      // closing the window where two concurrent batches could each reserve the
      // same invoice before either line exists. The existing-line scan is
      // shipped under the invoice FOR UPDATE lock, not the line table, because
      // the FK RESTRICT direction makes the invoice the serialization point.
      const existingRes = await client.query(
        `SELECT DISTINCT pl.vendor_invoice_id
           FROM scm_payment_lines pl
           JOIN scm_payment_batches pb
             ON pb.id = pl.payment_batch_id AND pb.tenant_id = pl.tenant_id
          WHERE pl.tenant_id = $1
            AND pl.vendor_invoice_id = ANY($2::uuid[])
            AND pb.status <> 'cancelled'`,
        [tenantId, invoiceIds],
      );
      if (existingRes.rows.length > 0) {
        throw new ConflictError(
          `One or more invoices already exist on a payment batch: ${existingRes.rows.map((r) => r.vendor_invoice_id).join(", ")}`,
        );
      }

      // Calculate approved amount
      let approvedAmount = 0;
      let currency = input.currency;
      for (const line of input.lines) {
        const inv = invoicesMap.get(line.vendorInvoiceId);
        if (inv) {
          approvedAmount += num(inv.invoice_amount);
          if (!currency) {
            currency = inv.currency;
          }
        }
      }

      // Insert batch header
      const batchRes = await client.query(
        `INSERT INTO scm_payment_batches (
           tenant_id, batch_number, idempotency_key, organization_unit_id, status,
           approved_amount, currency, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $7)
         RETURNING *`,
        [
          tenantId,
          input.batchNumber,
          input.idempotencyKey,
          input.organizationUnitId,
          approvedAmount,
          currency ?? "IDR",
          input.createdBy ?? null,
        ],
      );

      const batch = toPaymentBatch(batchRes.rows[0]!);

      // Insert lines
      const lines: ScmPaymentLine[] = [];
      for (const line of input.lines) {
        const inv = invoicesMap.get(line.vendorInvoiceId);
        if (!inv) continue;

        const lineRes = await client.query(
          `INSERT INTO scm_payment_lines (
             tenant_id, payment_batch_id, vendor_invoice_id, amount, currency, approval_override_reason
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            tenantId,
            batch.id,
            line.vendorInvoiceId,
            num(inv.invoice_amount),
            inv.currency,
            line.overrideReason ?? null,
          ],
        );
        lines.push(toPaymentLine(lineRes.rows[0]!));
      }

      return { paymentBatch: batch, lines };
    });
  }

  async deletePaymentBatchWithoutWorkflow(tenantId: string, paymentBatchId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_payment_batches
        WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL`,
      [tenantId, paymentBatchId],
    );
  }

  async claimPaymentBatchWorkflowInstance(
    tenantId: string,
    paymentBatchId: string,
    workflowInstanceId: string,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE scm_payment_batches
         SET workflow_instance_id = $3,
             updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND workflow_instance_id IS NULL
       RETURNING id`,
      [tenantId, paymentBatchId, workflowInstanceId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async findPaymentBatchById(
    tenantId: string,
    paymentBatchId: string,
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] } | null> {
    const batchRes = await this.pool.query(
      `SELECT * FROM scm_payment_batches WHERE tenant_id = $1 AND id = $2`,
      [tenantId, paymentBatchId],
    );
    if (!batchRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_payment_lines WHERE tenant_id = $1 AND payment_batch_id = $2 ORDER BY created_at ASC, id ASC`,
      [tenantId, paymentBatchId],
    );

    return {
      paymentBatch: toPaymentBatch(batchRes.rows[0]),
      lines: linesRes.rows.map(toPaymentLine),
    };
  }

  async findPaymentBatchByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ paymentBatch: ScmPaymentBatch; lines: ScmPaymentLine[] } | null> {
    const batchRes = await this.pool.query(
      `SELECT id FROM scm_payment_batches WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!batchRes.rows[0]) return null;
    return this.findPaymentBatchById(tenantId, batchRes.rows[0].id);
  }

  async listPaymentBatches(
    tenantId: string,
    filter: ScmPaymentBatchFilter = {},
  ): Promise<ScmPaymentBatch[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.organizationUnitIds) {
      if (filter.organizationUnitIds.length === 0) return [];
      params.push(filter.organizationUnitIds);
      conditions.push(`organization_unit_id = ANY($${params.length}::uuid[])`);
    } else if (filter.organizationUnitId) {
      params.push(filter.organizationUnitId);
      conditions.push(`organization_unit_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.createdFrom) {
      params.push(filter.createdFrom);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.createdTo) {
      params.push(filter.createdTo);
      conditions.push(`created_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_payment_batches
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toPaymentBatch);
  }

  async approvePaymentBatch(
    tenantId: string,
    input: {
      paymentBatchId: string;
      approvedBy: string | null;
      approvedAt: Date;
      financeTransactionId: string | null;
    },
    events: Array<{
      lineId: string;
      event: CreateScmAccountingReadyEventInput;
    }>,
  ): Promise<ScmPaymentBatch | null> {
    return this.inTransaction(async (client) => {
      const r = await client.query(
        `UPDATE scm_payment_batches
           SET status = 'approved',
               approved_at = $3,
               approved_by = $4,
               finance_transaction_id = $5,
               updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'submitted'
         RETURNING *`,
        [tenantId, input.paymentBatchId, input.approvedAt, input.approvedBy, input.financeTransactionId],
      );
      const paymentBatch = r.rows[0] ? toPaymentBatch(r.rows[0]) : null;
      if (!paymentBatch) return null;

      for (const { event } of events) {
        await this.createAccountingReadyEventTx(client, tenantId, event);
      }

      return paymentBatch;
    });
  }

  async updatePaymentBatchStatus(
    tenantId: string,
    paymentBatchId: string,
    status: ScmPaymentBatchStatus,
    actor: { userId: string | null; at: Date },
  ): Promise<ScmPaymentBatch | null> {
    let submittedAt: Date | null = null;
    let submittedBy: string | null = null;
    let cancelledAt: Date | null = null;
    let cancelledBy: string | null = null;
    let transitionGuard = "status NOT IN ('approved', 'cancelled')";

    if (status === "submitted") {
      submittedAt = actor.at;
      submittedBy = actor.userId;
      transitionGuard = "status = 'draft'";
    } else if (status === "cancelled") {
      cancelledAt = actor.at;
      cancelledBy = actor.userId;
      transitionGuard = "status IN ('draft', 'submitted')";
    }

    const r = await this.pool.query(
      `UPDATE scm_payment_batches
         SET status = $3,
             submitted_at = COALESCE($4, submitted_at),
             submitted_by = COALESCE($5, submitted_by),
             cancelled_at = COALESCE($6, cancelled_at),
             cancelled_by = COALESCE($7, cancelled_by),
             updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND ${transitionGuard}
       RETURNING *`,
      [tenantId, paymentBatchId, status, submittedAt, submittedBy, cancelledAt, cancelledBy],
    );
    return r.rows[0] ? toPaymentBatch(r.rows[0]) : null;
  }

  async findLegalEntityIdForOrganizationUnit(
    tenantId: string,
    organizationUnitId: string,
  ): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT legal_entity_id FROM organization_units
        WHERE tenant_id = $1 AND id = $2 AND legal_entity_id IS NOT NULL`,
      [tenantId, organizationUnitId],
    );
    return r.rows[0]?.legal_entity_id ?? null;
  }

  async findPaymentApprovalLimits(
    tenantId: string,
    roleCodes: string[],
  ): Promise<Array<{ roleCode: string; nominalLimit: number | null }>> {
    if (roleCodes.length === 0) return [];

    const r = await this.pool.query(
      `SELECT role_code, nominal_limit FROM scm_payment_approval_limits
        WHERE tenant_id = $1 AND role_code = ANY($2::text[])`,
      [tenantId, roleCodes],
    );
    return r.rows.map((row) => ({
      roleCode: row.role_code,
      nominalLimit: row.nominal_limit ? num(row.nominal_limit) : null,
    }));
  }

  async findLandedCostLegalEntityId(tenantId: string, landedCostId: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT ou.legal_entity_id
         FROM scm_landed_cost_allocations lca
         JOIN scm_valuation_layers vl
           ON vl.tenant_id = lca.tenant_id AND vl.id = lca.valuation_layer_id
         JOIN scm_receiving_lines rl
           ON rl.tenant_id = vl.tenant_id AND rl.id = vl.receiving_line_id
         JOIN scm_warehouses w
           ON w.tenant_id = rl.tenant_id AND w.id = rl.warehouse_id
         JOIN organization_units ou
           ON ou.tenant_id = w.tenant_id AND ou.id = w.organization_unit_id
        WHERE lca.tenant_id = $1 AND lca.landed_cost_id = $2
          AND ou.legal_entity_id IS NOT NULL
        GROUP BY ou.legal_entity_id`,
      [tenantId, landedCostId],
    );
    return r.rows.length === 1 ? (r.rows[0].legal_entity_id as string) : null;
  }

  /** WP-PRO-03 period-ID resolution: read-only lookup into the Accounting Kernel's periods table. */
  async listOpenPeriods(
    tenantId: string,
    legalEntityId: string,
  ): Promise<Array<{ id: string; dateFrom: Date; dateTo: Date }>> {
    const r = await this.pool.query(
      `SELECT id, date_from, date_to FROM accounting_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'open'`,
      [tenantId, legalEntityId],
    );
    return r.rows.map((row) => ({
      id: row.id,
      dateFrom: row.date_from,
      dateTo: row.date_to,
    }));
  }

  // =========================================================================
  // Stage 2: Consignment Settlements
  // =========================================================================

  async createConsignmentSettlement(
    tenantId: string,
    input: CreateScmConsignmentSettlementInput,
  ): Promise<{ settlement: ScmConsignmentSettlement; lines: ScmConsignmentSettlementLine[] }> {
    return this.inTransaction(async (client) => {
      const csRes = await client.query(
        `INSERT INTO scm_consignment_settlements (
           tenant_id, settlement_number, idempotency_key, supplier_id, warehouse_id,
           settled_at, settled_by, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $8, $9)
         RETURNING *`,
        [
          tenantId,
          input.settlementNumber,
          input.idempotencyKey,
          input.supplierId,
          input.warehouseId,
          input.settledAt ?? null,
          input.settledBy ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const settlement = toConsignmentSettlement(csRes.rows[0]!);

      const lines: ScmConsignmentSettlementLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const amount = line.amount ?? line.quantity * line.unitCost;
        const currency = line.currency ?? "IDR";

        // 1. Supplier stock out (consignment_out)
        const supplierOut = await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          locationId: line.locationId ?? null,
          batchId: line.batchId ?? null,
          stockCondition: "unrestricted",
          ownerType: "supplier",
          ownerPartyId: settlement.supplierId,
          movementType: "consignment_out",
          quantity: line.quantity,
          unitCost: line.unitCost,
          totalCost: amount,
          referenceType: "scm_consignment_settlement",
          referenceId: settlement.id,
          referenceNumber: settlement.settlementNumber,
          notes: "Consignment settlement - transfer from supplier stock",
          occurredAt: settlement.settledAt,
          createdBy: input.createdBy ?? null,
        });

        // 2. Own stock in (consignment_in)
        const ownIn = await this.recordMovementTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          locationId: line.locationId ?? null,
          batchId: line.batchId ?? null,
          stockCondition: "unrestricted",
          ownerType: "own",
          ownerPartyId: null,
          movementType: "consignment_in",
          quantity: line.quantity,
          unitCost: line.unitCost,
          totalCost: amount,
          referenceType: "scm_consignment_settlement",
          referenceId: settlement.id,
          referenceNumber: settlement.settlementNumber,
          notes: "Consignment settlement - transfer to owned stock",
          occurredAt: settlement.settledAt,
          createdBy: input.createdBy ?? null,
        });

        // 4. Create valuation layer for FIFO tracking
        const valLayer = await this.createValuationLayerTx(client, tenantId, {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          receiptMovementId: ownIn.movement.id,
          receivedDate: settlement.settledAt.toISOString().slice(0, 10),
          originalQuantity: line.quantity,
          remainingQuantity: line.quantity,
          unitCost: line.unitCost,
          totalValue: amount,
          stockCondition: "unrestricted",
          ownerType: "own",
        });

        // 5. Create accounting ready event (inventory.goods_received)
        const event = await this.createAccountingReadyEventTx(
          client,
          tenantId,
          {
            eventType: "inventory.goods_received",
            sourceDocumentType: "scm_consignment_settlement",
            sourceDocumentId: settlement.id,
            sourceMovementId: ownIn.movement.id,
            effectiveAt: settlement.settledAt,
            currency,
            amount,
            quantity: line.quantity,
            unitCost: line.unitCost,
            accountAssignmentType: "stock",
            accountAssignmentDimensions: {},
            idempotencyKey: `${input.idempotencyKey}:line:${sort}`,
            payload: {
              settlementNumber: settlement.settlementNumber,
              supplierId: settlement.supplierId,
            },
            createdBy: input.createdBy ?? null,
          },
        );

        // 6. Insert settlement line
        const lRes = await client.query(
          `INSERT INTO scm_consignment_settlement_lines (
             tenant_id, consignment_settlement_id,
             item_id, warehouse_id, location_id, batch_id,
             quantity, unit_cost, currency, amount,
             supplier_out_movement_id, own_in_movement_id,
             valuation_layer_id, accounting_ready_event_id, sort_order
           ) VALUES (
             $1, $2,
             $3, $4, $5, $6,
             $7, $8, $9, $10,
             $11, $12,
             $13, $14, $15
           )
           RETURNING *`,
          [
            tenantId,
            settlement.id,
            line.itemId,
            line.warehouseId,
            line.locationId ?? null,
            line.batchId ?? null,
            line.quantity,
            line.unitCost,
            currency,
            amount,
            supplierOut.movement.id,
            ownIn.movement.id,
            valLayer.id,
            event.id,
            line.sortOrder ?? sort,
          ],
        );
        lines.push(toConsignmentSettlementLine(lRes.rows[0]!));
        sort += 1;
      }

      return { settlement, lines };
    });
  }

  async findConsignmentSettlementById(
    tenantId: string,
    settlementId: string,
  ): Promise<{ settlement: ScmConsignmentSettlement; lines: ScmConsignmentSettlementLine[] } | null> {
    const csRes = await this.pool.query(
      `SELECT * FROM scm_consignment_settlements WHERE tenant_id = $1 AND id = $2`,
      [tenantId, settlementId],
    );
    if (!csRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_consignment_settlement_lines WHERE tenant_id = $1 AND consignment_settlement_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, settlementId],
    );
    return {
      settlement: toConsignmentSettlement(csRes.rows[0]),
      lines: linesRes.rows.map(toConsignmentSettlementLine),
    };
  }

  async findConsignmentSettlementByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ settlement: ScmConsignmentSettlement; lines: ScmConsignmentSettlementLine[] } | null> {
    const csRes = await this.pool.query(
      `SELECT id FROM scm_consignment_settlements WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!csRes.rows[0]) return null;
    return this.findConsignmentSettlementById(tenantId, csRes.rows[0].id);
  }

  async listConsignmentSettlements(
    tenantId: string,
    filter: ScmConsignmentSettlementFilter = {},
  ): Promise<ScmConsignmentSettlement[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.supplierId) {
      params.push(filter.supplierId);
      conditions.push(`supplier_id = $${params.length}`);
    }
    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.settledFrom) {
      params.push(filter.settledFrom);
      conditions.push(`settled_at >= $${params.length}`);
    }
    if (filter.settledTo) {
      params.push(filter.settledTo);
      conditions.push(`settled_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_consignment_settlements
        WHERE ${conditions.join(" AND ")}
        ORDER BY settled_at DESC, created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toConsignmentSettlement);
  }

  // =========================================================================
  // Stage 2: Inventory Disposal
  // =========================================================================

  async createInventoryDisposal(
    tenantId: string,
    input: CreateScmInventoryDisposalInput,
  ): Promise<{ disposal: ScmInventoryDisposal; lines: ScmInventoryDisposalLine[] }> {
    return this.inTransaction(async (client) => {
      const idRes = await client.query(
        `INSERT INTO scm_inventory_disposals (
           tenant_id, disposal_number, idempotency_key, warehouse_id,
           organization_unit_id, disposal_type, reason, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          tenantId,
          input.disposalNumber,
          input.idempotencyKey,
          input.warehouseId,
          input.organizationUnitId ?? null,
          input.disposalType ?? "write_off",
          input.reason,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const disposal = toInventoryDisposal(idRes.rows[0]!);

      const lines: ScmInventoryDisposalLine[] = [];
      let sort = 0;
      for (const line of input.lines) {
        const lRes = await client.query(
          `INSERT INTO scm_inventory_disposal_lines (
             tenant_id, disposal_id,
             item_id, warehouse_id, location_id, batch_id, serial_id,
             stock_condition, owner_type, owner_party_id,
             quantity, unit_cost, currency, amount,
             movement_id, valuation_layer_allocation_id, accounting_ready_event_id,
             notes, sort_order
           ) VALUES (
             $1, $2,
             $3, $4, $5, $6, $7,
             $8, $9, $10,
             $11, $12, $13, $14,
             $15, $16, $17,
             $18, $19
           )
           RETURNING *`,
          [
            tenantId,
            disposal.id,
            line.itemId,
            line.warehouseId,
            line.locationId ?? null,
            line.batchId ?? null,
            line.serialId ?? null,
            line.stockCondition ?? "unrestricted",
            line.ownerType ?? "own",
            line.ownerPartyId ?? null,
            line.quantity,
            line.unitCost ?? null,
            line.currency ?? "IDR",
            line.quantity * (line.unitCost ?? 0),
            null, // movement_id: set on execution via updateInventoryDisposalLineExecution
            null, // valuation_layer_allocation_id: set on execution
            null, // accounting_ready_event_id: set on execution
            line.notes ?? null,
            line.sortOrder ?? sort++,
          ],
        );
        lines.push(toInventoryDisposalLine(lRes.rows[0]!));
      }

      return { disposal, lines };
    });
  }

  async deleteInventoryDisposalWithoutWorkflow(tenantId: string, disposalId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM scm_inventory_disposals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, disposalId],
    );
  }

  async updateInventoryDisposalStatus(
    tenantId: string,
    input: UpdateScmInventoryDisposalStatusInput,
  ): Promise<ScmInventoryDisposal | null> {
    const r = await this.pool.query(
      `UPDATE scm_inventory_disposals
         SET status = $3,
             workflow_instance_id = COALESCE($4, workflow_instance_id),
             submitted_at = COALESCE($5, submitted_at),
             submitted_by = COALESCE($6, submitted_by),
             approved_at = COALESCE($7, approved_at),
             approved_by = COALESCE($8, approved_by),
             executed_at = COALESCE($9, executed_at),
             executed_by = COALESCE($10, executed_by),
             rejected_at = COALESCE($11, rejected_at),
             rejected_by = COALESCE($12, rejected_by),
             rejection_reason = COALESCE($13, rejection_reason),
             updated_by = COALESCE($14, updated_by),
             updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        input.disposalId,
        input.status,
        input.workflowInstanceId ?? null,
        input.submittedAt ?? null,
        input.submittedBy ?? null,
        input.approvedAt ?? null,
        input.approvedBy ?? null,
        input.executedAt ?? null,
        input.executedBy ?? null,
        input.rejectedAt ?? null,
        input.rejectedBy ?? null,
        input.rejectionReason ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toInventoryDisposal(r.rows[0]) : null;
  }

  async updateInventoryDisposalLineExecution(
    tenantId: string,
    lineId: string,
    movementId: string,
    valuationLayerAllocationId: string | null,
    accountingReadyEventId: string | null,
    unitCost: number | null,
    amount: number | null,
  ): Promise<ScmInventoryDisposalLine | null> {
    const r = await this.pool.query(
      `UPDATE scm_inventory_disposal_lines
         SET movement_id = $3,
             valuation_layer_allocation_id = COALESCE($4, valuation_layer_allocation_id),
             accounting_ready_event_id = COALESCE($5, accounting_ready_event_id),
             unit_cost = COALESCE($6, unit_cost),
             amount = COALESCE($7, amount)
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        lineId,
        movementId,
        valuationLayerAllocationId ?? null,
        accountingReadyEventId ?? null,
        unitCost ?? null,
        amount ?? null,
      ],
    );
    return r.rows[0] ? toInventoryDisposalLine(r.rows[0]) : null;
  }

  async findInventoryDisposalById(
    tenantId: string,
    disposalId: string,
  ): Promise<{ disposal: ScmInventoryDisposal; lines: ScmInventoryDisposalLine[] } | null> {
    const idRes = await this.pool.query(
      `SELECT * FROM scm_inventory_disposals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, disposalId],
    );
    if (!idRes.rows[0]) return null;

    const linesRes = await this.pool.query(
      `SELECT * FROM scm_inventory_disposal_lines WHERE tenant_id = $1 AND disposal_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, disposalId],
    );
    return {
      disposal: toInventoryDisposal(idRes.rows[0]),
      lines: linesRes.rows.map(toInventoryDisposalLine),
    };
  }

  async findInventoryDisposalByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ disposal: ScmInventoryDisposal; lines: ScmInventoryDisposalLine[] } | null> {
    const idRes = await this.pool.query(
      `SELECT id FROM scm_inventory_disposals WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!idRes.rows[0]) return null;
    return this.findInventoryDisposalById(tenantId, idRes.rows[0].id);
  }

  async listInventoryDisposals(
    tenantId: string,
    filter: ScmInventoryDisposalFilter = {},
  ): Promise<ScmInventoryDisposal[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.organizationUnitIds && filter.organizationUnitIds.length > 0) {
      params.push(filter.organizationUnitIds);
      conditions.push(`organization_unit_id = ANY($${params.length})`);
    }
    if (filter.disposalType) {
      params.push(filter.disposalType);
      conditions.push(`disposal_type = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.createdFrom) {
      params.push(filter.createdFrom);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.createdTo) {
      params.push(filter.createdTo);
      conditions.push(`created_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_inventory_disposals
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toInventoryDisposal);
  }

  // =========================================================================
  // Stage 2: Inventory Aging
  // =========================================================================

  async getInventoryAgingBuckets(
    tenantId: string,
    filter: ScmInventoryAgingFilter = {},
  ): Promise<ScmInventoryAgingBucket[]> {
    const conditions = ["sb.tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`sb.warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`sb.warehouse_id = ANY($${params.length})`);
    }
    if (filter.itemId) {
      params.push(filter.itemId);
      conditions.push(`sb.item_id = $${params.length}`);
    }
    if (filter.stockCondition) {
      params.push(filter.stockCondition);
      conditions.push(`sb.stock_condition = $${params.length}`);
    }
    if (filter.ownerType) {
      params.push(filter.ownerType);
      conditions.push(`sb.owner_type = $${params.length}`);
    }

    // `scm_valuation_layers` is keyed by (item_id, warehouse_id) FIFO layers,
    // not by the balance's condition/owner/location/batch dimensions. Aging is
    // a read-only operational report (no GL impact per ADR-0023), so the
    // exposed value uses a weighted-average effective unit cost across the
    // item's remaining layers in that warehouse as a reasonable approximation.
    const r = await this.pool.query(
      `SELECT
         sb.item_id,
         sb.warehouse_id,
         sb.location_id,
         sb.batch_id,
         sb.stock_condition,
         sb.owner_type,
         sb.owner_party_id,
         COALESCE(sb.quantity, 0) as quantity,
         COALESCE(sb.quantity, 0) * COALESCE(vl.avg_unit_cost, 0) as total_value,
         EXTRACT(DAY FROM (now() - sb.condition_since))::int as aging_days,
         CASE
           WHEN EXTRACT(DAY FROM (now() - sb.condition_since)) <= 30 THEN '0-30'
           WHEN EXTRACT(DAY FROM (now() - sb.condition_since)) <= 60 THEN '31-60'
           WHEN EXTRACT(DAY FROM (now() - sb.condition_since)) <= 90 THEN '61-90'
           WHEN EXTRACT(DAY FROM (now() - sb.condition_since)) <= 180 THEN '91-180'
           ELSE '180+'
         END as bucket
       FROM scm_advanced_stock_balances sb
       LEFT JOIN LATERAL (
         SELECT SUM(remaining_quantity * effective_unit_cost) / NULLIF(SUM(remaining_quantity), 0) as avg_unit_cost
         FROM scm_valuation_layers
         WHERE tenant_id = sb.tenant_id
           AND item_id = sb.item_id
           AND warehouse_id IS NOT DISTINCT FROM sb.warehouse_id
           AND remaining_quantity > 0
       ) vl ON true
       WHERE ${conditions.join(" AND ")}
       AND sb.quantity > 0
       ORDER BY sb.condition_since ASC, sb.id ASC`,
      params,
    );

    return r.rows.map(toInventoryAgingBucket);
  }

  // =========================================================================
  // Stage 2: Warehouse Tasks
  // =========================================================================

  async createWarehouseTask(
    tenantId: string,
    input: CreateScmWarehouseTaskInput,
  ): Promise<{ task: ScmWarehouseTask; items: ScmWarehouseTaskItem[] }> {
    return this.inTransaction(async (client) => {
      const wtRes = await client.query(
        `INSERT INTO scm_warehouse_tasks (
           tenant_id, task_number, idempotency_key, warehouse_id, task_type,
           priority, source_document_type, source_document_id,
           assigned_to, due_at, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          tenantId,
          input.taskNumber,
          input.idempotencyKey,
          input.warehouseId,
          input.taskType,
          input.priority ?? "normal",
          input.sourceDocumentType ?? null,
          input.sourceDocumentId ?? null,
          input.assignedTo ?? null,
          input.dueAt ?? null,
          input.notes ?? null,
          input.createdBy ?? null,
        ],
      );
      const task = toWarehouseTask(wtRes.rows[0]!);

      const items: ScmWarehouseTaskItem[] = [];
      let sort = 0;
      for (const item of input.items) {
        const iRes = await client.query(
          `INSERT INTO scm_warehouse_task_items (
             tenant_id, warehouse_task_id,
             item_id, from_location_id, to_location_id, batch_id, serial_id,
             expected_quantity, notes, sort_order
           ) VALUES (
             $1, $2,
             $3, $4, $5, $6, $7,
             $8, $9, $10
           )
           RETURNING *`,
          [
            tenantId,
            task.id,
            item.itemId,
            item.fromLocationId ?? null,
            item.toLocationId ?? null,
            item.batchId ?? null,
            item.serialId ?? null,
            item.expectedQuantity,
            item.notes ?? null,
            item.sortOrder ?? sort++,
          ],
        );
        items.push(toWarehouseTaskItem(iRes.rows[0]!));
      }

      return { task, items };
    });
  }

  /**
   * Executes the physical move a completed warehouse task represents.
   *
   * Only task types that actually relocate or issue goods post movements:
   * putaway/replenishment (no source → into a bin), relocation (bin → bin),
   * pick (bin → out of the warehouse). `pack` and `cycle_count` are pure
   * paperwork — they change no quantity — so they are skipped.
   *
   * Idempotent: items already carrying a `movement_id` are not moved twice.
   */
  async applyWarehouseTaskMovements(
    tenantId: string,
    taskId: string,
    createdBy: string | null,
  ): Promise<ScmWarehouseTaskItem[]> {
    return this.inTransaction(async (client) => {
      const taskRes = await client.query(
        `SELECT * FROM scm_warehouse_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, taskId],
      );
      if (!taskRes.rows[0]) throw new NotFoundError("ScmWarehouseTask", taskId);
      const task = toWarehouseTask(taskRes.rows[0]);
      if (task.taskType === "pack" || task.taskType === "cycle_count") return [];

      const itemsRes = await client.query(
        `SELECT * FROM scm_warehouse_task_items
          WHERE tenant_id = $1 AND warehouse_task_id = $2
          ORDER BY sort_order
          FOR UPDATE`,
        [tenantId, taskId],
      );

      const updated: ScmWarehouseTaskItem[] = [];
      for (const row of itemsRes.rows) {
        const item = toWarehouseTaskItem(row);
        if (item.movementId || item.status === "skipped") continue;
        const quantity = num(item.actualQuantity ?? item.expectedQuantity);
        if (quantity <= 0) continue;

        const base = {
          itemId: item.itemId,
          warehouseId: task.warehouseId,
          batchId: item.batchId,
          serialId: item.serialId,
          stockCondition: "unrestricted" as const,
          ownerType: "own" as const,
          ownerPartyId: null,
          quantity,
          referenceType: "scm_warehouse_task",
          referenceId: task.id,
          referenceNumber: task.taskNumber,
          createdBy,
        };

        // pick issues goods out of the warehouse; putaway and replenishment
        // land goods into a bin; relocation moves them between bins.
        let movementId: string;
        if (task.taskType === "pick") {
          const m = await this.recordMovementTx(client, tenantId, {
            ...base,
            locationId: item.fromLocationId,
            movementType: "out",
            notes: `Pick task ${task.taskNumber} issued from bin`,
          });
          movementId = m.movement.id;
        } else if (task.taskType === "relocation") {
          await this.recordMovementTx(client, tenantId, {
            ...base,
            locationId: item.fromLocationId,
            movementType: "transfer_out",
            notes: `Relocation task ${task.taskNumber} out of source bin`,
          });
          const m = await this.recordMovementTx(client, tenantId, {
            ...base,
            locationId: item.toLocationId,
            movementType: "transfer_in",
            notes: `Relocation task ${task.taskNumber} into destination bin`,
          });
          movementId = m.movement.id;
        } else {
          const m = await this.recordMovementTx(client, tenantId, {
            ...base,
            locationId: item.toLocationId,
            movementType: "in",
            notes: `${task.taskType} task ${task.taskNumber} into destination bin`,
          });
          movementId = m.movement.id;
        }

        const linkRes = await client.query(
          `UPDATE scm_warehouse_task_items
              SET movement_id = $3, actual_quantity = $4, status = 'completed'
            WHERE tenant_id = $1 AND id = $2
            RETURNING *`,
          [tenantId, item.id, movementId, quantity],
        );
        updated.push(toWarehouseTaskItem(linkRes.rows[0]!));
      }

      return updated;
    });
  }

  async updateWarehouseTaskStatus(
    tenantId: string,
    input: UpdateScmWarehouseTaskStatusInput,
  ): Promise<ScmWarehouseTask | null> {
    const r = await this.pool.query(
      `UPDATE scm_warehouse_tasks
         SET status = $3,
             assigned_to = COALESCE($4, assigned_to),
             assigned_at = COALESCE($5, assigned_at),
             started_at = COALESCE($6, started_at),
             completed_at = COALESCE($7, completed_at),
             completed_by = COALESCE($8, completed_by),
             cancelled_at = COALESCE($9, cancelled_at),
             cancelled_by = COALESCE($10, cancelled_by),
             cancellation_reason = COALESCE($11, cancellation_reason),
             updated_by = COALESCE($12, updated_by),
             updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        input.warehouseTaskId,
        input.status,
        input.assignedTo ?? null,
        input.assignedAt ?? null,
        input.startedAt ?? null,
        input.completedAt ?? null,
        input.completedBy ?? null,
        input.cancelledAt ?? null,
        input.cancelledBy ?? null,
        input.cancellationReason ?? null,
        input.updatedBy ?? null,
      ],
    );
    return r.rows[0] ? toWarehouseTask(r.rows[0]) : null;
  }

  async updateWarehouseTaskItem(
    tenantId: string,
    input: UpdateScmWarehouseTaskItemInput,
  ): Promise<ScmWarehouseTaskItem | null> {
    const r = await this.pool.query(
      `UPDATE scm_warehouse_task_items
         SET actual_quantity = COALESCE($3, actual_quantity),
             movement_id = COALESCE($4, movement_id),
             status = COALESCE($5, status)
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        tenantId,
        input.taskItemId,
        input.actualQuantity ?? null,
        input.movementId ?? null,
        input.status ?? null,
      ],
    );
    return r.rows[0] ? toWarehouseTaskItem(r.rows[0]) : null;
  }

  async findWarehouseTaskById(
    tenantId: string,
    warehouseTaskId: string,
  ): Promise<{ task: ScmWarehouseTask; items: ScmWarehouseTaskItem[] } | null> {
    const wtRes = await this.pool.query(
      `SELECT * FROM scm_warehouse_tasks WHERE tenant_id = $1 AND id = $2`,
      [tenantId, warehouseTaskId],
    );
    if (!wtRes.rows[0]) return null;

    const itemsRes = await this.pool.query(
      `SELECT * FROM scm_warehouse_task_items WHERE tenant_id = $1 AND warehouse_task_id = $2 ORDER BY sort_order ASC, id ASC`,
      [tenantId, warehouseTaskId],
    );
    return {
      task: toWarehouseTask(wtRes.rows[0]),
      items: itemsRes.rows.map(toWarehouseTaskItem),
    };
  }

  async findWarehouseTaskByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ task: ScmWarehouseTask; items: ScmWarehouseTaskItem[] } | null> {
    const wtRes = await this.pool.query(
      `SELECT id FROM scm_warehouse_tasks WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    if (!wtRes.rows[0]) return null;
    return this.findWarehouseTaskById(tenantId, wtRes.rows[0].id);
  }

  async listWarehouseTasks(
    tenantId: string,
    filter: ScmWarehouseTaskFilter = {},
  ): Promise<ScmWarehouseTask[]> {
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filter.warehouseId) {
      params.push(filter.warehouseId);
      conditions.push(`warehouse_id = $${params.length}`);
    }
    if (filter.warehouseIds && filter.warehouseIds.length > 0) {
      params.push(filter.warehouseIds);
      conditions.push(`warehouse_id = ANY($${params.length})`);
    }
    if (filter.taskType) {
      params.push(filter.taskType);
      conditions.push(`task_type = $${params.length}`);
    }
    if (filter.priority) {
      params.push(filter.priority);
      conditions.push(`priority = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.assignedTo) {
      params.push(filter.assignedTo);
      conditions.push(`assigned_to = $${params.length}`);
    }
    if (filter.sourceDocumentType) {
      params.push(filter.sourceDocumentType);
      conditions.push(`source_document_type = $${params.length}`);
    }
    if (filter.sourceDocumentId) {
      params.push(filter.sourceDocumentId);
      conditions.push(`source_document_id = $${params.length}`);
    }
    if (filter.createdFrom) {
      params.push(filter.createdFrom);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.createdTo) {
      params.push(filter.createdTo);
      conditions.push(`created_at <= $${params.length}`);
    }

    const limit = filter.limit && filter.limit > 0 ? filter.limit : 100;
    params.push(limit);

    const r = await this.pool.query(
      `SELECT * FROM scm_warehouse_tasks
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toWarehouseTask);
  }

  // =========================================================================
  // Reference checks
  // =========================================================================

  async itemExists(tenantId: string, itemId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM items WHERE tenant_id = $1 AND id = $2`, [tenantId, itemId]);
    return (r.rowCount ?? 0) > 0;
  }

  async findGradeContext(tenantId: string, itemId: string, warehouseId: string) {
    return this.queryGradeContext(this.pool, tenantId, itemId, warehouseId, false);
  }

  /** `lock` (inside a movement transaction) takes FOR SHARE on the item and warehouse rows so a
   * concurrent regrade (FOR UPDATE on the same rows) waits for this movement, or vice versa. */
  private async queryGradeContext(
    db: Pick<Pool, "query">,
    tenantId: string,
    itemId: string,
    warehouseId: string,
    lock: boolean,
  ) {
    const r = await db.query(
      `SELECT i.code AS item_code, i.grade AS item_grade, w.code AS warehouse_code, w.grade AS warehouse_grade
         FROM items i, scm_warehouses w
        WHERE i.tenant_id = $1 AND i.id = $2 AND w.tenant_id = $1 AND w.id = $3${lock ? "\n          FOR SHARE OF i, w" : ""}`,
      [tenantId, itemId, warehouseId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      itemCode: row.item_code as string,
      itemGrade: (row.item_grade ?? null) as ScmGrade | null,
      warehouseCode: row.warehouse_code as string,
      warehouseGrade: (row.warehouse_grade ?? null) as ScmGrade | null,
    };
  }

  async listHeldItemGrades(tenantId: string, warehouseId: string): Promise<ScmGrade[]> {
    return this.queryHeldItemGrades(this.pool, tenantId, warehouseId);
  }

  private async queryHeldItemGrades(
    db: Pick<Pool, "query">,
    tenantId: string,
    warehouseId: string,
  ): Promise<ScmGrade[]> {
    const r = await db.query(
      `SELECT DISTINCT i.grade
         FROM scm_advanced_stock_balances b
         JOIN items i ON i.id = b.item_id AND i.tenant_id = b.tenant_id
        WHERE b.tenant_id = $1 AND b.warehouse_id = $2 AND b.quantity > 0 AND i.grade IS NOT NULL`,
      [tenantId, warehouseId],
    );
    return r.rows.map((row) => row.grade as ScmGrade);
  }

  async supplierExists(tenantId: string, supplierId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM suppliers WHERE tenant_id = $1 AND id = $2`, [tenantId, supplierId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** WP-PRO-04 eligibility gate: null when the supplier does not exist. */
  async findSupplierActive(tenantId: string, supplierId: string): Promise<boolean | null> {
    const r = await this.pool.query(`SELECT is_active FROM suppliers WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      supplierId,
    ]);
    return r.rows[0] ? (r.rows[0].is_active as boolean) : null;
  }

  async purchaseOrderExists(tenantId: string, purchaseOrderId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM purchase_orders WHERE tenant_id = $1 AND id = $2`, [tenantId, purchaseOrderId]);
    return (r.rowCount ?? 0) > 0;
  }

  async purchaseRequestExists(tenantId: string, purchaseRequestId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM purchase_requests WHERE tenant_id = $1 AND id = $2`, [tenantId, purchaseRequestId]);
    return (r.rowCount ?? 0) > 0;
  }

  async organizationUnitExists(tenantId: string, organizationUnitId: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM organization_units WHERE tenant_id = $1 AND id = $2`, [tenantId, organizationUnitId]);
    return (r.rowCount ?? 0) > 0;
  }
}

// === Row Mappers (Stage 2) ===================================================

function toReplacementDelivery(r: QueryResultRow): ScmReplacementDelivery {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    replacementNumber: r.replacement_number,
    idempotencyKey: r.idempotency_key,
    returnToVendorId: r.return_to_vendor_id,
    purchaseOrderId: r.purchase_order_id,
    supplierId: r.supplier_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    receivedAt: r.received_at,
    receivedBy: r.received_by,
    status: r.status as ScmReplacementDeliveryStatus,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toReplacementDeliveryLine(r: QueryResultRow): ScmReplacementDeliveryLine {
  const dims: ScmAccountAssignmentDimensions = typeof r.account_assignment_dimensions === "string"
    ? JSON.parse(r.account_assignment_dimensions)
    : r.account_assignment_dimensions || {};
  return {
    id: r.id,
    tenantId: r.tenant_id,
    replacementDeliveryId: r.replacement_delivery_id,
    returnToVendorLineId: r.return_to_vendor_line_id,
    purchaseOrderLineId: r.purchase_order_line_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    stockCondition: r.stock_condition as ScmStockCondition,
    ownerType: r.owner_type as ScmStockOwnerType,
    ownerPartyId: r.owner_party_id,
    quantity: num(r.quantity),
    unitCost: numOrNull(r.unit_cost),
    currency: r.currency,
    accountAssignmentType: r.account_assignment_type as ScmAccountAssignmentType,
    accountAssignmentDimensions: dims,
    movementId: r.movement_id,
    accountingReadyEventId: r.accounting_ready_event_id,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toServiceAcceptance(r: QueryResultRow): ScmServiceAcceptance {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    acceptanceNumber: r.acceptance_number,
    idempotencyKey: r.idempotency_key,
    purchaseOrderId: r.purchase_order_id,
    supplierId: r.supplier_id,
    organizationUnitId: r.organization_unit_id,
    status: r.status as ScmServiceAcceptanceStatus,
    workflowInstanceId: r.workflow_instance_id,
    submittedAt: r.submitted_at,
    submittedBy: r.submitted_by,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    rejectedAt: r.rejected_at,
    rejectedBy: r.rejected_by,
    rejectionReason: r.rejection_reason,
    servicePeriodStart: r.service_period_start,
    servicePeriodEnd: r.service_period_end,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toServiceAcceptanceLine(r: QueryResultRow): ScmServiceAcceptanceLine {
  const dims: ScmAccountAssignmentDimensions = typeof r.account_assignment_dimensions === "string"
    ? JSON.parse(r.account_assignment_dimensions)
    : r.account_assignment_dimensions || {};
  return {
    id: r.id,
    tenantId: r.tenant_id,
    serviceAcceptanceId: r.service_acceptance_id,
    purchaseOrderLineId: r.purchase_order_line_id,
    description: r.description,
    quantity: num(r.quantity),
    unitPrice: num(r.unit_price),
    currency: r.currency,
    amount: num(r.amount),
    accountAssignmentType: r.account_assignment_type as ScmAccountAssignmentType,
    accountAssignmentDimensions: dims,
    frozenAccountAssignmentAt: r.frozen_account_assignment_at,
    accountingReadyEventId: r.accounting_ready_event_id,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toVendorInvoice(r: QueryResultRow): ScmVendorInvoice {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    invoiceNumber: r.invoice_number,
    idempotencyKey: r.idempotency_key,
    purchaseOrderId: r.purchase_order_id,
    receivingRecordId: r.receiving_record_id,
    supplierId: r.supplier_id,
    invoiceAmount: num(r.invoice_amount),
    currency: r.currency,
    status: r.status as ScmVendorInvoiceStatus,
    workflowInstanceId: r.workflow_instance_id,
    submittedAt: r.submitted_at,
    submittedBy: r.submitted_by,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    rejectedAt: r.rejected_at,
    rejectedBy: r.rejected_by,
    rejectionReason: r.rejection_reason,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toVendorInvoiceLine(r: QueryResultRow): ScmVendorInvoiceLine {
  const dims: ScmAccountAssignmentDimensions = typeof r.account_assignment_dimensions === "string"
    ? JSON.parse(r.account_assignment_dimensions)
    : r.account_assignment_dimensions || {};
  return {
    id: r.id,
    tenantId: r.tenant_id,
    vendorInvoiceId: r.vendor_invoice_id,
    purchaseOrderLineId: r.purchase_order_line_id,
    receivingLineId: r.receiving_line_id,
    description: r.description,
    quantityInvoiced: num(r.quantity_invoiced),
    unitPrice: num(r.unit_price),
    currency: r.currency,
    lineAmount: num(r.line_amount),
    accountAssignmentType: r.account_assignment_type as ScmAccountAssignmentType,
    accountAssignmentDimensions: dims,
    frozenAccountAssignmentAt: r.frozen_account_assignment_at,
    accountingReadyEventId: r.accounting_ready_event_id,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toPaymentBatch(r: QueryResultRow): ScmPaymentBatch {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    batchNumber: r.batch_number,
    idempotencyKey: r.idempotency_key,
    organizationUnitId: r.organization_unit_id,
    status: r.status as ScmPaymentBatchStatus,
    approvedAmount: num(r.approved_amount),
    currency: r.currency,
    workflowInstanceId: r.workflow_instance_id,
    submittedAt: r.submitted_at,
    submittedBy: r.submitted_by,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toPaymentLine(r: QueryResultRow): ScmPaymentLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    paymentBatchId: r.payment_batch_id,
    vendorInvoiceId: r.vendor_invoice_id,
    amount: num(r.amount),
    currency: r.currency,
    approvalOverrideReason: r.approval_override_reason,
    createdAt: r.created_at,
  };
}

function toConsignmentSettlement(r: QueryResultRow): ScmConsignmentSettlement {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    settlementNumber: r.settlement_number,
    idempotencyKey: r.idempotency_key,
    supplierId: r.supplier_id,
    warehouseId: r.warehouse_id,
    settledAt: r.settled_at,
    settledBy: r.settled_by,
    status: r.status as ScmConsignmentSettlementStatus,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function toConsignmentSettlementLine(r: QueryResultRow): ScmConsignmentSettlementLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    consignmentSettlementId: r.consignment_settlement_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    quantity: num(r.quantity),
    unitCost: num(r.unit_cost),
    currency: r.currency,
    amount: num(r.amount),
    supplierOutMovementId: r.supplier_out_movement_id,
    ownInMovementId: r.own_in_movement_id,
    valuationLayerId: r.valuation_layer_id,
    accountingReadyEventId: r.accounting_ready_event_id,
    sortOrder: num(r.sort_order),
  };
}

function toInventoryDisposal(r: QueryResultRow): ScmInventoryDisposal {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    disposalNumber: r.disposal_number,
    idempotencyKey: r.idempotency_key,
    warehouseId: r.warehouse_id,
    organizationUnitId: r.organization_unit_id,
    disposalType: r.disposal_type as ScmDisposalType,
    reason: r.reason,
    status: r.status as ScmDisposalStatus,
    workflowInstanceId: r.workflow_instance_id,
    submittedAt: r.submitted_at,
    submittedBy: r.submitted_by,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    executedAt: r.executed_at,
    executedBy: r.executed_by,
    rejectedAt: r.rejected_at,
    rejectedBy: r.rejected_by,
    rejectionReason: r.rejection_reason,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toInventoryDisposalLine(r: QueryResultRow): ScmInventoryDisposalLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    disposalId: r.disposal_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    serialId: r.serial_id,
    stockCondition: r.stock_condition as ScmStockCondition,
    ownerType: r.owner_type as ScmStockOwnerType,
    ownerPartyId: r.owner_party_id,
    quantity: num(r.quantity),
    unitCost: numOrNull(r.unit_cost),
    currency: r.currency,
    amount: numOrNull(r.amount),
    movementId: r.movement_id,
    valuationLayerAllocationId: r.valuation_layer_allocation_id,
    accountingReadyEventId: r.accounting_ready_event_id,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toInventoryAgingBucket(r: QueryResultRow): ScmInventoryAgingBucket {
  return {
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    stockCondition: r.stock_condition as ScmStockCondition,
    ownerType: r.owner_type as ScmStockOwnerType,
    ownerPartyId: r.owner_party_id,
    quantity: num(r.quantity),
    totalValue: num(r.total_value),
    agingDays: r.aging_days,
    bucket: r.bucket as "0-30" | "31-60" | "61-90" | "91-180" | "180+",
  };
}

function toWarehouseTask(r: QueryResultRow): ScmWarehouseTask {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    taskNumber: r.task_number,
    idempotencyKey: r.idempotency_key,
    warehouseId: r.warehouse_id,
    taskType: r.task_type as ScmWarehouseTaskType,
    priority: r.priority as ScmWarehouseTaskPriority,
    status: r.status as ScmWarehouseTaskStatus,
    sourceDocumentType: r.source_document_type,
    sourceDocumentId: r.source_document_id,
    assignedTo: r.assigned_to,
    assignedAt: r.assigned_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    cancellationReason: r.cancellation_reason,
    dueAt: r.due_at,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toWarehouseTaskItem(r: QueryResultRow): ScmWarehouseTaskItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    warehouseTaskId: r.warehouse_task_id,
    itemId: r.item_id,
    fromLocationId: r.from_location_id,
    toLocationId: r.to_location_id,
    batchId: r.batch_id,
    serialId: r.serial_id,
    expectedQuantity: num(r.expected_quantity),
    actualQuantity: numOrNull(r.actual_quantity),
    movementId: r.movement_id,
    status: r.status as ScmWarehouseTaskItemStatus,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

// === Mapping Helpers =========================================================

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
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

function toWarehouse(r: QueryResultRow): ScmWarehouse {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    siteId: r.site_id,
    organizationUnitId: r.organization_unit_id,
    address: r.address,
    grade: r.grade ?? null,
    isActive: r.is_active,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toWarehouseLocation(r: QueryResultRow): ScmWarehouseLocation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    warehouseId: r.warehouse_id,
    code: r.code,
    zone: r.zone,
    aisle: r.aisle,
    rack: r.rack,
    shelf: r.shelf,
    bin: r.bin,
    isActive: r.is_active,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toItemBatch(r: QueryResultRow): ScmItemBatch {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    batchNumber: r.batch_number,
    manufacturedDate: toDateString(r.manufactured_date),
    expiryDate: toDateString(r.expiry_date),
    supplierId: r.supplier_id,
    notes: r.notes,
    isActive: r.is_active,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toItemSerial(r: QueryResultRow): ScmItemSerial {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    serialNumber: r.serial_number,
    batchId: r.batch_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    status: r.status,
    warrantyExpiryDate: toDateString(r.warranty_expiry_date),
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toStockBalance(r: QueryResultRow): ScmAdvancedStockBalance {
  const qty = num(r.quantity);
  const reserved = num(r.reserved_qty);
  const stockCondition = r.stock_condition as ScmStockCondition;
  const ownerType = r.owner_type as ScmStockOwnerType;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    stockCondition,
    ownerType,
    ownerPartyId: r.owner_party_id,
    conditionSince: r.condition_since,
    quantity: qty,
    reservedQty: reserved,
    quantityOnHand: qty,
    onHandQuantity: qty,
    reservedQuantity: reserved,
    availableQuantity:
      stockCondition === "unrestricted" && ownerType === "own"
        ? Math.max(0, qty - reserved)
        : 0,
    updatedAt: r.updated_at,
  };
}

function toStockMovement(r: QueryResultRow): ScmAdvancedStockMovement {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    serialId: r.serial_id,
    stockCondition: r.stock_condition,
    ownerType: r.owner_type,
    ownerPartyId: r.owner_party_id,
    movementType: r.movement_type,
    quantity: num(r.quantity),
    unitCost: numOrNull(r.unit_cost),
    totalCost: numOrNull(r.total_cost),
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    referenceNumber: r.reference_number,
    reversedMovementId: r.reversed_movement_id,
    accountingReadyEventId: r.accounting_ready_event_id,
    notes: r.notes,
    occurredAt: r.occurred_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toReorderPolicy(r: QueryResultRow): ScmReorderPolicy {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    minQuantity: num(r.min_quantity),
    reorderPoint: num(r.reorder_point),
    reorderQuantity: num(r.reorder_quantity),
    safetyStock: num(r.safety_stock),
    leadTimeDays: num(r.lead_time_days),
    isActive: r.is_active,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toStockReservation(r: QueryResultRow): ScmStockReservation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    reservationNumber: r.reservation_number,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    quantity: num(r.quantity),
    reservedForType: r.reserved_for_type,
    reservedForId: r.reserved_for_id,
    reservedForNumber: r.reserved_for_number,
    status: r.status,
    validUntil: r.valid_until,
    fulfilledAt: r.fulfilled_at,
    cancelledAt: r.cancelled_at,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toStockTransfer(r: QueryResultRow): ScmStockTransfer {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    transferNumber: r.transfer_number,
    fromWarehouseId: r.from_warehouse_id,
    toWarehouseId: r.to_warehouse_id,
    status: r.status,
    shippedAt: r.shipped_at,
    receivedAt: r.received_at,
    cancelledAt: r.cancelled_at,
    workflowInstanceId: r.workflow_instance_id,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toStockTransferLine(r: QueryResultRow): ScmStockTransferLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    transferId: r.transfer_id,
    itemId: r.item_id,
    fromLocationId: r.from_location_id,
    toLocationId: r.to_location_id,
    batchId: r.batch_id,
    quantityRequested: num(r.quantity_requested),
    quantityShipped: num(r.quantity_shipped),
    quantityReceived: num(r.quantity_received),
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toStockOpname(r: QueryResultRow): ScmStockOpname {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    opnameNumber: r.opname_number,
    warehouseId: r.warehouse_id,
    opnameDate: toDateString(r.opname_date)!,
    status: r.status,
    workflowInstanceId: r.workflow_instance_id,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toStockOpnameLine(r: QueryResultRow): ScmStockOpnameLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    opnameId: r.opname_id,
    itemId: r.item_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    systemQuantity: num(r.system_quantity),
    physicalQuantity: numOrNull(r.physical_quantity),
    varianceQuantity: numOrNull(r.variance_quantity),
    adjustmentMovementId: r.adjustment_movement_id,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toValuationLayer(r: QueryResultRow): ScmValuationLayer {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    receiptMovementId: r.receipt_movement_id,
    receivingLineId: r.receiving_line_id,
    sourceInspectionId: r.source_inspection_id,
    stockCondition: r.stock_condition,
    ownerType: r.owner_type,
    ownerPartyId: r.owner_party_id,
    layerStatus: r.layer_status,
    receivedDate: toDateString(r.received_date)!,
    originalQuantity: num(r.original_quantity),
    remainingQuantity: num(r.remaining_quantity),
    unitCost: num(r.unit_cost),
    landedCostAdded: num(r.landed_cost_added),
    effectiveUnitCost: num(r.effective_unit_cost),
    totalValue: num(r.total_value),
    createdAt: r.created_at,
  };
}

function toLandedCost(r: QueryResultRow): ScmLandedCost {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    voucherNumber: r.voucher_number,
    purchaseOrderId: r.purchase_order_id,
    costType: r.cost_type,
    currency: r.currency,
    amount: num(r.amount),
    allocationMethod: r.allocation_method,
    status: r.status,
    appliedAt: r.applied_at,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toLandedCostAllocation(r: QueryResultRow): ScmLandedCostAllocation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    landedCostId: r.landed_cost_id,
    itemId: r.item_id,
    valuationLayerId: r.valuation_layer_id,
    allocatedAmount: num(r.allocated_amount),
    costPerUnitAdded: num(r.cost_per_unit_added),
  };
}

function toRfq(r: QueryResultRow): ScmRfq {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    rfqNumber: r.rfq_number,
    title: r.title,
    procurementType: r.procurement_type,
    organizationUnitId: r.organization_unit_id,
    purchaseRequestId: r.purchase_request_id,
    submissionDeadline: r.submission_deadline,
    status: r.status,
    workflowInstanceId: r.workflow_instance_id,
    awardedAt: r.awarded_at,
    cancelledAt: r.cancelled_at,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toRfqItem(r: QueryResultRow): ScmRfqItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    rfqId: r.rfq_id,
    itemId: r.item_id,
    targetQuantity: num(r.target_quantity),
    targetUnitPrice: numOrNull(r.target_unit_price),
    specifications: r.specifications,
    sortOrder: num(r.sort_order),
  };
}

function toRfqInvitedSupplier(r: QueryResultRow): ScmRfqInvitedSupplier {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    rfqId: r.rfq_id,
    supplierId: r.supplier_id,
    invitedAt: r.invited_at,
    respondedAt: r.responded_at,
  };
}

function toSupplierBid(r: QueryResultRow): ScmSupplierBid {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    bidNumber: r.bid_number,
    rfqId: r.rfq_id,
    supplierId: r.supplier_id,
    submittedAt: r.submitted_at,
    currency: r.currency,
    totalAmount: num(r.total_amount),
    leadTimeDays: num(r.lead_time_days),
    validUntil: toDateString(r.valid_until),
    status: r.status,
    technicalScore: numOrNull(r.technical_score),
    commercialScore: numOrNull(r.commercial_score),
    finalScore: numOrNull(r.final_score),
    rank: numOrNull(r.rank),
    isWinningBid: r.is_winning_bid,
    resultingPurchaseOrderId: r.resulting_po_id,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toSupplierBidLine(r: QueryResultRow): ScmSupplierBidLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    bidId: r.bid_id,
    rfqItemId: r.rfq_item_id,
    offeredQuantity: num(r.offered_quantity),
    offeredUnitPrice: num(r.offered_unit_price),
    offeredTotalPrice: num(r.offered_total_price),
    remarks: r.remarks,
  };
}

function toSupplierEvaluation(r: QueryResultRow): ScmSupplierEvaluation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    evaluationNumber: r.evaluation_number,
    supplierId: r.supplier_id,
    evaluationPeriod: r.evaluation_period,
    periodStartDate: toDateString(r.period_start_date)!,
    periodEndDate: toDateString(r.period_end_date)!,
    qualityScore: num(r.quality_score),
    deliveryScore: num(r.delivery_score),
    pricingScore: num(r.pricing_score),
    serviceScore: num(r.service_score),
    overallScore: num(r.overall_score),
    ratingGrade: r.rating_grade,
    status: r.status,
    workflowInstanceId: r.workflow_instance_id,
    notes: r.notes,
    evaluatedBy: r.evaluated_by,
    evaluatedAt: r.evaluated_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toSupplierContract(r: QueryResultRow): ScmSupplierContract {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    contractNumber: r.contract_number,
    supplierId: r.supplier_id,
    title: r.title,
    contractType: r.contract_type,
    startDate: toDateString(r.start_date)!,
    endDate: toDateString(r.end_date)!,
    currency: r.currency,
    committedAmount: num(r.committed_amount),
    spentAmount: num(r.spent_amount),
    status: r.status,
    workflowInstanceId: r.workflow_instance_id,
    termsAndConditions: r.terms_and_conditions,
    approvedAt: r.approved_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toSupplierContractItem(r: QueryResultRow): ScmSupplierContractItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    contractId: r.contract_id,
    itemId: r.item_id,
    agreedUnitPrice: num(r.agreed_unit_price),
    minOrderQuantity: num(r.min_order_quantity),
    maxOrderQuantity: numOrNull(r.max_order_quantity),
    leadTimeDays: num(r.lead_time_days),
    notes: r.notes,
  };
}

function toSpendAnalyticsSnapshot(r: QueryResultRow): ScmSpendAnalyticsSnapshot {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    snapshotDate: toDateString(r.snapshot_date)!,
    periodType: r.period_type,
    periodKey: r.period_key,
    organizationUnitId: r.organization_unit_id,
    supplierId: r.supplier_id,
    itemCategory: r.item_category,
    totalSpend: num(r.total_spend),
    poCount: num(r.po_count),
    itemsPurchasedCount: num(r.items_purchased_count),
    avgPoValue: num(r.avg_po_value),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function toAccountAssignmentConfig(r: QueryResultRow): ScmAccountAssignmentConfig {
  const reqDims = Array.isArray(r.required_dimensions)
    ? r.required_dimensions
    : typeof r.required_dimensions === "string"
      ? JSON.parse(r.required_dimensions)
      : [];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    assignmentType: r.assignment_type as ScmAccountAssignmentType,
    requiredDimensions: reqDims as string[],
    inventoryRelevant: r.inventory_relevant,
    isActive: r.is_active,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toReceivingRecord(r: QueryResultRow): ScmReceivingRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    receiptNumber: r.receipt_number,
    idempotencyKey: r.idempotency_key,
    purchaseOrderId: r.purchase_order_id,
    supplierId: r.supplier_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    receivedAt: r.received_at,
    receivedBy: r.received_by,
    status: r.status as ScmReceivingStatus,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function toReceivingLine(r: QueryResultRow): ScmReceivingLine {
  const dims = typeof r.account_assignment_dimensions === "object" && r.account_assignment_dimensions !== null
    ? r.account_assignment_dimensions
    : typeof r.account_assignment_dimensions === "string"
      ? JSON.parse(r.account_assignment_dimensions)
      : {};
  return {
    id: r.id,
    tenantId: r.tenant_id,
    receivingRecordId: r.receiving_record_id,
    purchaseOrderLineId: r.purchase_order_line_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    stockCondition: r.stock_condition as ScmStockCondition,
    ownerType: r.owner_type as ScmStockOwnerType,
    ownerPartyId: r.owner_party_id,
    quantityReceived: num(r.quantity_received),
    quantityAccepted: num(r.quantity_accepted),
    quantityRejected: num(r.quantity_rejected),
    quantityQuarantined: num(r.quantity_quarantined),
    quantityReturned: num(r.quantity_returned),
    quantityReversed: num(r.quantity_reversed),
    unitCost: numOrNull(r.unit_cost),
    currency: r.currency,
    accountAssignmentType: r.account_assignment_type as ScmAccountAssignmentType,
    accountAssignmentDimensions: dims,
    frozenAccountAssignmentAt: r.frozen_account_assignment_at,
    inspectionRequired: r.inspection_required,
    holdMovementId: r.hold_movement_id,
    acceptanceMovementId: r.acceptance_movement_id,
    valuationLayerId: r.valuation_layer_id,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toInspection(r: QueryResultRow): ScmInspection {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    receivingLineId: r.receiving_line_id,
    inspectionNumber: r.inspection_number,
    idempotencyKey: r.idempotency_key,
    inspectedAt: r.inspected_at,
    inspectedBy: r.inspected_by,
    quantityAccepted: num(r.quantity_accepted),
    quantityRejected: num(r.quantity_rejected),
    quantityQuarantined: num(r.quantity_quarantined),
    result: r.result,
    reason: r.reason,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function toDiscrepancyRecord(r: QueryResultRow): ScmDiscrepancyRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    receivingLineId: r.receiving_line_id,
    discrepancyType: r.discrepancy_type,
    quantity: numOrNull(r.quantity),
    description: r.description,
    status: r.status,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function toAccountingReadyEvent(r: QueryResultRow): ScmAccountingReadyEvent {
  const dims = typeof r.account_assignment_dimensions === "object" && r.account_assignment_dimensions !== null
    ? r.account_assignment_dimensions
    : typeof r.account_assignment_dimensions === "string"
      ? JSON.parse(r.account_assignment_dimensions)
      : {};
  const payload = typeof r.payload === "object" && r.payload !== null
    ? r.payload
    : typeof r.payload === "string"
      ? JSON.parse(r.payload)
      : {};
  return {
    id: r.id,
    tenantId: r.tenant_id,
    eventType: r.event_type,
    sourceDocumentType: r.source_document_type,
    sourceDocumentId: r.source_document_id,
    sourceDocumentLineId: r.source_document_line_id,
    sourceMovementId: r.source_movement_id,
    sourceDocumentRevision: num(r.source_document_revision) || 1,
    effectiveAt: r.effective_at,
    currency: r.currency,
    amount: num(r.amount),
    quantity: numOrNull(r.quantity),
    unitCost: numOrNull(r.unit_cost),
    accountAssignmentType: r.account_assignment_type as ScmAccountAssignmentType | null,
    accountAssignmentDimensions: dims,
    idempotencyKey: r.idempotency_key,
    reversalOfEventId: r.reversal_of_event_id,
    outboxState: r.outbox_state as ScmAccountingOutboxState,
    reconciliationState: r.reconciliation_state as ScmAccountingReconciliationState,
    payload,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function toAccountingReadyEventStateTransition(r: QueryResultRow): ScmAccountingReadyEventStateTransition {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountingEventId: r.accounting_event_id,
    stateKind: r.state_kind,
    fromState: r.from_state,
    toState: r.to_state,
    reason: r.reason,
    occurredAt: r.occurred_at,
    occurredBy: r.occurred_by,
  };
}

function toReturnToVendor(r: QueryResultRow): ScmReturnToVendor {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    returnNumber: r.return_number,
    idempotencyKey: r.idempotency_key,
    supplierId: r.supplier_id,
    purchaseOrderId: r.purchase_order_id,
    warehouseId: r.warehouse_id,
    returnedAt: r.returned_at,
    returnedBy: r.returned_by,
    reason: r.reason,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function toReturnToVendorLine(r: QueryResultRow): ScmReturnToVendorLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    returnToVendorId: r.return_to_vendor_id,
    receivingLineId: r.receiving_line_id,
    itemId: r.item_id,
    warehouseId: r.warehouse_id,
    locationId: r.location_id,
    batchId: r.batch_id,
    stockCondition: r.stock_condition as ScmStockCondition,
    ownerType: r.owner_type as ScmStockOwnerType,
    ownerPartyId: r.owner_party_id,
    quantity: num(r.quantity),
    movementId: r.movement_id,
    accountingReadyEventId: r.accounting_ready_event_id,
    notes: r.notes,
    sortOrder: num(r.sort_order),
  };
}

function toReceiptReversal(r: QueryResultRow): ScmReceiptReversal {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    reversalNumber: r.reversal_number,
    idempotencyKey: r.idempotency_key,
    receivingRecordId: r.receiving_record_id,
    reason: r.reason,
    reversedAt: r.reversed_at,
    reversedBy: r.reversed_by,
    reversalEventId: r.reversal_event_id,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function toReceiptReversalLine(r: QueryResultRow): ScmReceiptReversalLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    reversalId: r.reversal_id,
    receivingLineId: r.receiving_line_id,
    quantity: num(r.quantity),
    movementId: r.movement_id,
    restoredLayerId: r.restored_layer_id,
    sortOrder: num(r.sort_order),
  };
}

function toValuationLayerAllocation(r: QueryResultRow): ScmValuationLayerAllocation {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    valuationLayerId: r.valuation_layer_id,
    movementId: r.movement_id,
    allocationType: r.allocation_type,
    quantity: num(r.quantity),
    unitCost: num(r.unit_cost),
    amount: num(r.amount),
    reversesAllocationId: r.reverses_allocation_id,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}
