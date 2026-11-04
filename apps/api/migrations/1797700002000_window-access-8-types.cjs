/**
 * Window Access full model (iDempiere AD_*_Access parity, modernized to one
 * table + typed access rows instead of eight tables).
 *
 * - app_windows: the registry of "windows" (page/process/form/info/workflow/
 *   task surfaces). route_registry already seeds app_windows — this adds the
 *   window_type column.
 * - window_access(role_id, window_id): one row per grant with is_read_write
 *   (AD_Window_Access.IsReadWrite parity).
 * - window_access_types(window_access_id, access_type): which of the 8 types
 *   the grant covers — process | form | info | workflow | task | document |
 *   action | include.
 * - role_included(parent_role_id, included_role_id, seqno): AD_Role_Included
 *   parity — role templates composed into other roles.
 *
 * Enforcement composes with the existing RBAC permission checks: window
 * access narrows WHICH surfaces a role may open; permissions still decide
 * WHAT actions are allowed inside.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE app_windows
      ADD COLUMN IF NOT EXISTS window_type text NOT NULL DEFAULT 'window'
      CHECK (window_type IN ('window','process','form','info','workflow','task'));

    CREATE TABLE IF NOT EXISTS window_access (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      window_code text NOT NULL,
      is_read_write boolean NOT NULL DEFAULT false,
      granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      UNIQUE (tenant_id, role_id, window_code)
    );
    CREATE INDEX IF NOT EXISTS window_access_role_idx ON window_access(role_id);

    CREATE TABLE IF NOT EXISTS window_access_types (
      window_access_id uuid NOT NULL REFERENCES window_access(id) ON DELETE CASCADE,
      access_type text NOT NULL CHECK (access_type IN
        ('process','form','info','workflow','task','document','action','include')),
      PRIMARY KEY (window_access_id, access_type)
    );

    CREATE TABLE IF NOT EXISTS role_included (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      parent_role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      included_role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      seqno integer NOT NULL DEFAULT 0,
      UNIQUE (parent_role_id, included_role_id)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS role_included;
    DROP TABLE IF EXISTS window_access_types;
    DROP TABLE IF EXISTS window_access;
    ALTER TABLE app_windows DROP COLUMN IF EXISTS window_type;
  `);
};
