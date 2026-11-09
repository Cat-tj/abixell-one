/**
 * Supply Chain Ports — Anti-Corruption Layer barrel.
 *
 * Re-exports the port interfaces and PostgreSQL implementations that
 * decouple the Warehouse Management (WMS) and Procurement Management
 * bounded contexts from Shared Master Data and the ADR-0023 outbox.
 *
 * Boundary discipline: this folder (`ports/`) lives under
 * `apps/api/src/modules/supply-chain/` so it satisfies the
 * `platform-boundary-validator` module-name rule while keeping the
 * ACL contracts physically adjacent to the contexts that consume them.
 */
export type {
  IUnitOfWork,
} from "./unit-of-work.js";
export { PgUnitOfWork } from "./unit-of-work.js";

export type {
  SharedMasterDataReadPort,
  PurchaseOrderWithLines,
  AccountAssignmentConfigView,
} from "./shared-master-data-read-port.js";
export { PgSharedMasterDataReadPort } from "./shared-master-data.port.pg.js";

export type {
  ItemStockExposurePort,
  ConflictingWarehouseStock,
} from "./item-stock-exposure-port.js";
export { PgItemStockExposurePort } from "./item-stock-exposure-port.js";

export type { AccountingEventWritePort } from "./accounting-event-write-port.js";
export { PgAccountingEventWritePort } from "./accounting-event.port.pg.js";
