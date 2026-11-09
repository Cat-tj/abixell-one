/**
 * LOA price visibility — `wms.price.view` gates unitCost/unitPrice-style
 * fields on WMS and procurement reads. Endpoints apply the mask through
 * `maskPrices` (apps/api/src/application/supply-chain/price-visibility.ts);
 * a role without the code still sees the rows, only with prices nulled.
 */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO permissions (code, description) VALUES
      ('wms.price.view', 'View prices (unit cost/price fields) on WMS and procurement documents')
    ON CONFLICT (code) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM permissions WHERE code = 'wms.price.view'
  `);
};
