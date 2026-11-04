/**
 * Terminated user status (owner request: karyawan keluar — data tetap
 * tercatat, user ditandai terminated dengan nama dicoret di UI).
 *
 * 'terminated' is a hard stop distinct from 'inactive': login denied, active
 * sessions revoked on mark, historical records untouched (audit rows keep the
 * user id; the UI renders the name with a strikethrough + badge).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
    ALTER TABLE users
      ADD CONSTRAINT users_status_check
      CHECK (status IN ('active','inactive','terminated'));
    -- Backfill: existing inactive users keep their status; terminated is
    -- only ever set explicitly by an operator (POST /users/:id/terminate).
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE users SET status='inactive' WHERE status='terminated';
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
    ALTER TABLE users
      ADD CONSTRAINT users_status_check CHECK (status IN ('active','inactive'));
  `);
};
