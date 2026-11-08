/**
 * Wave A8 / ADR-0028 §2 — permissions governing partner credential lifecycle.
 *   integration.partner_credential.read    list credentials (never secrets)
 *   integration.partner_credential.manage  issue / rotate / revoke
 * Idempotent. Grants NO tenant role: full-access roles receive these through
 * `npm run sync-permissions`; other roles via governed role configuration.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO permissions (code, description) VALUES
      ('integration.partner_credential.read', 'List partner API credentials (no secrets)'),
      ('integration.partner_credential.manage', 'Issue, rotate, and revoke partner API credentials')
    ON CONFLICT (code) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM permissions
     WHERE code IN ('integration.partner_credential.read', 'integration.partner_credential.manage')
  `);
};
