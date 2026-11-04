/**
 * Terminate support: sessions.revoked_at for session revocation on
 * termination (the existing columns only carry soft-expiry).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
      ADD COLUMN IF NOT EXISTS revoked_reason text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE sessions DROP COLUMN IF EXISTS revoked_reason;
    ALTER TABLE sessions DROP COLUMN IF EXISTS revoked_at;
  `);
};
