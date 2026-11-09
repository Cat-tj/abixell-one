/**
 * DB-level guard for the back-charge invariant: a back-charge Work Order is
 * raised without a delivery contract, so `contract_id` must be NULL whenever
 * `wo_type = 'back_charge'`. The service already enforces this; the CHECK
 * stops any other writer from violating it.
 *
 * Added NOT VALID first (constrains all future writes, takes only a brief
 * lock), then VALIDATEd (scans existing rows under a weaker lock). If legacy
 * rows violate it, VALIDATE fails the migration loudly instead of leaving an
 * unverified constraint.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE work_orders
      ADD CONSTRAINT work_orders_back_charge_no_contract_check
      CHECK (wo_type <> 'back_charge' OR contract_id IS NULL) NOT VALID;
  `);
  pgm.sql(`ALTER TABLE work_orders VALIDATE CONSTRAINT work_orders_back_charge_no_contract_check;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_back_charge_no_contract_check;`);
};
