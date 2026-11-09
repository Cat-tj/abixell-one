/**
 * Work Order regular vs back-charge (WP-OPS back-charge). `wo_type` is
 * NOT NULL with a 'regular' default so every existing row and every
 * insert that omits the field stays a regular Work Order. A back-charge
 * WO is billable work raised without a delivery contract; contract-price
 * resolution does not apply to it.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE work_orders
      ADD COLUMN wo_type text NOT NULL DEFAULT 'regular'
      CHECK (wo_type IN ('regular', 'back_charge'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE work_orders DROP COLUMN IF EXISTS wo_type;
  `);
};
