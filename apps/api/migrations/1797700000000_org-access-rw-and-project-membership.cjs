/**
 * Org-Access RW, Project Membership, and WO project isolation.
 *
 * iDempiere parity (modernized):
 * - AD_Role_OrgAccess.IsReadOnly  -> user_role_assignments.access_mode
 *   ('read' | 'write'; tenant scope defaults 'write' — it is not org-scoped).
 * - Project membership: explicit member list per project (the decisive
 *   grant; org-unit scope stays a fallback filter for lists).
 * - Work-order isolation: work orders record the project they belong to and
 *   reads are restricted to project members (see service-operations reads).
 *
 * All columns nullable/defaulted so existing rows stay valid.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Org Access RW (AD_Role_OrgAccess.IsReadOnly parity)
    ALTER TABLE user_role_assignments
      ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'write'
      CHECK (access_mode IN ('read','write'));

    -- Project membership: explicit per-user grants (decisive isolation rule).
    CREATE TABLE IF NOT EXISTS project_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_code text,
      granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS project_members_project_idx ON project_members(project_id);
    CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id);

    -- Work orders belong to a project (nullable: not every WO is project-bound).
    ALTER TABLE work_orders
      ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS work_orders_project_idx ON work_orders(project_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE work_orders DROP COLUMN IF EXISTS project_id;
    DROP TABLE IF EXISTS project_members;
    ALTER TABLE user_role_assignments DROP COLUMN IF EXISTS access_mode;
  `);
};
