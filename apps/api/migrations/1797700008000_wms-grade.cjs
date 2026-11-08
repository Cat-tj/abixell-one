/**
 * WMS grade separation — items and warehouses may be classified as
 * 'food' or 'non_food'. Nullable: NULL means unclassified (legacy rows and
 * master data that carries no grade), and unclassified is always allowed.
 * The match enforcement lives in the movement service, not the DB, so a
 * warehouse's grade can be corrected without a data migration.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE items
      ADD COLUMN grade text
      CHECK (grade IN ('food', 'non_food'));

    ALTER TABLE scm_warehouses
      ADD COLUMN grade text
      CHECK (grade IN ('food', 'non_food'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE scm_warehouses DROP COLUMN IF EXISTS grade;
    ALTER TABLE items DROP COLUMN IF EXISTS grade;
  `);
};
