/**
 * Wave A8 / WP-PLT-A8-01 — Partner API credentials (PLT-ADV-001, ADR-0028).
 *
 * Dedicated machine-credential class, separate from session authentication:
 *   - tenant-scoped, hashed at rest (SHA-256 of the secret; the plaintext is
 *     shown exactly once at issue time and never recoverable),
 *   - rotatable (new secret, old one invalidated immediately) and revocable,
 *   - carries an explicit permission set that must be a SUBSET of the
 *     granting tenant's own permission catalogue at grant time.
 *
 * Partner credentials never resolve to an interactive actor: there is no
 * user, no session, and no Role assignment behind them. The permission
 * catalogue still governs what a credential may do — enforcement happens in
 * the partner route layer via `requirePartnerPermission`, which checks the
 * credential's own permission set (already validated to be a subset at
 * issuance).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable(
    "partner_credentials",
    {
      id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
      tenant_id: { type: "uuid", notNull: true, references: "tenants", onDelete: "CASCADE" },
      name: { type: "text", notNull: true },
      client_id: { type: "text", notNull: true },
      secret_hash: { type: "text", notNull: true },
      permissions: { type: "text[]", notNull: true, default: pgm.func("ARRAY[]::text[]") },
      status: { type: "text", notNull: true, default: "active" },
      last_used_at: { type: "timestamptz" },
      created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
      created_by: { type: "uuid" },
      rotated_at: { type: "timestamptz" },
      revoked_at: { type: "timestamptz" },
    },
    {
      constraints: {
        unique: ["client_id"],
        check: "status IN ('active', 'revoked')",
      },
    },
  );
  pgm.createIndex("partner_credentials", ["tenant_id", "status"]);
};

exports.down = (pgm) => {
  pgm.dropTable("partner_credentials");
};
