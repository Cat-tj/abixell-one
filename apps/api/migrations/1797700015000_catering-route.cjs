/**
 * Catering vertical page (`/catering`) — menu + route catalogue half.
 *
 * Same rename-chain UNION pattern as the dashboard-route migration. Suffix
 * _a14 follows the settings-nav-consolidation migration (_a13).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // [path, name, permissions, note]
  const ROUTES = [
    [
      "/catering",
      "Catering",
      ["service_operations.read"],
      "Catering menus, recipes, meal plans, ingredient requirements and production batches.",
    ],
  ];

  // [code, name, path, seq_no, parent_code, module_code, permissions, description]
  const MENUS = [
    [
      "nav-service_operations-catering",
      "Catering",
      "/catering",
      25,
      "nav-service_operations",
      "service_operations",
      ["service_operations.read"],
      "Plan menus, recipes and meal orders, see what to buy, and track meal batches.",
    ],
  ];

  function textArray(values) {
    return `ARRAY[${values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ")}]::text[]`;
  }
  function str(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  const ROUTE_VALUES = ROUTES.map(
    ([path, name, permissions, note]) =>
      `(${str(`route:${path}`)}, ${str(name)}, 'service_operations', 'di_menu',\n           ${textArray(permissions)},\n           NULL,\n           ${str(note)})`,
  ).join(",\n          ");

  const MENU_VALUES = MENUS.map(
    ([code, name, path, seq, parent, moduleCode, permissions, description]) =>
      `(${str(code)},\n           ${str(name)},\n           ${str(path)},\n           false,\n           '${moduleCode}',\n           false,\n           ${textArray(permissions)},\n           ${str(description)},\n           ${str(parent)},\n           ${seq})`,
  ).join(",\n          ");

  const ROUTE_CODES = ROUTES.map(([path]) => str(`route:${path}`)).join(", ");
  const MENU_CODES = MENUS.map(([code]) => str(code)).join(",\n               ");

  pgm.sql(`
    -- 1. Snapshot the catalogue as A9 left it (if not already done) ----------
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_route_window_seed'
           AND n.nspname = current_schema()
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_route_window_seed_a14'
           AND n.nspname = current_schema()
      ) THEN
        ALTER FUNCTION config_route_window_seed()
          RENAME TO config_route_window_seed_a14;
      END IF;

      IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_menu_seed'
           AND n.nspname = current_schema()
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_menu_seed_a14'
           AND n.nspname = current_schema()
      ) THEN
        ALTER FUNCTION config_menu_seed()
          RENAME TO config_menu_seed_a14;
      END IF;
    END
    $$;

    -- 2. Extend the route window catalogue ---------------------------------
    CREATE OR REPLACE FUNCTION config_route_window_seed()
    RETURNS TABLE (
      code                TEXT,
      name                TEXT,
      module_code         TEXT,
      registration_status TEXT,
      required_permissions TEXT[],
      parent_path         TEXT,
      note                TEXT
    ) AS $seed$
      SELECT s.code, s.name, s.module_code, s.registration_status,
             s.required_permissions, s.parent_path, s.note
        FROM config_route_window_seed_a14() s
      UNION
      SELECT r.code, r.name, r.module_code, r.registration_status,
             r.required_permissions, r.parent_path, r.note
        FROM (VALUES
          ${ROUTE_VALUES}
        ) AS r(code, name, module_code, registration_status, required_permissions, parent_path, note);
    $seed$ LANGUAGE sql IMMUTABLE;

    -- 3. Extend the menu catalogue ------------------------------------------
    CREATE OR REPLACE FUNCTION config_menu_seed()
    RETURNS TABLE (
      code                 TEXT,
      name                 TEXT,
      window_code          TEXT,
      is_summary           BOOLEAN,
      module_code          TEXT,
      is_external_allowed  BOOLEAN,
      required_permissions TEXT[],
      description          TEXT,
      parent_code          TEXT,
      seq_no               INTEGER
    ) AS $seed$
      SELECT s.code, s.name, s.window_code, s.is_summary, s.module_code,
             s.is_external_allowed, s.required_permissions, s.description,
             s.parent_code, s.seq_no
        FROM config_menu_seed_a14() s
      UNION
      SELECT m.code, m.name, m.window_code, m.is_summary, m.module_code,
             m.is_external_allowed, m.required_permissions, m.description,
             m.parent_code, m.seq_no
        FROM (VALUES
          ${MENU_VALUES}
        ) AS m(code, name, window_code, is_summary, module_code,
               is_external_allowed, required_permissions, description,
               parent_code, seq_no);
    $seed$ LANGUAGE sql IMMUTABLE;

    -- 4. Backfill existing tenants -------------------------------------------
    INSERT INTO app_windows (
      tenant_id, code, name, module_code,
      registration_status, required_permissions, parent_path, description
    )
    SELECT t.id, s.code, s.name, s.module_code,
           s.registration_status, s.required_permissions, s.parent_path, s.note
      FROM tenants t
      CROSS JOIN config_route_window_seed() s
     WHERE s.code IN (${ROUTE_CODES})
    ON CONFLICT (tenant_id, code) DO NOTHING;

    INSERT INTO app_menus (
      tenant_id, code, name, description, action, window_id,
      is_summary, module_id, is_external_allowed, required_permissions
    )
    SELECT t.id, s.code, s.name, s.description, 'window',
           (SELECT w.id FROM app_windows w
             WHERE w.tenant_id = t.id AND w.code = 'route:' || s.window_code),
           s.is_summary,
           (SELECT m.id FROM modules m WHERE m.code = s.module_code),
           s.is_external_allowed, s.required_permissions
      FROM tenants t
      CROSS JOIN config_menu_seed() s
     WHERE s.code IN (${MENU_CODES})
    ON CONFLICT (tenant_id, code) DO NOTHING;

    INSERT INTO app_menu_tree (tenant_id, menu_id, parent_id, seq_no)
    SELECT t.id,
           (SELECT id FROM app_menus WHERE tenant_id = t.id AND code = s.code),
           (SELECT id FROM app_menus WHERE tenant_id = t.id AND code = s.parent_code),
           s.seq_no
      FROM tenants t
      CROSS JOIN config_menu_seed() s
     WHERE s.code IN (${MENU_CODES})
    ON CONFLICT (tenant_id, menu_id) DO NOTHING;

    -- 5. Terminology keys and their allowlist rows ---------------------------
    INSERT INTO terminology_keys (code, default_label, description)
    SELECT 'menu.' || s.code || '.name',
           s.name,
           'Tenant label override for the menu ' || s.code || ' (Epic 3 Wave 3, step 11).'
      FROM config_menu_seed() s
     WHERE s.code IN (${MENU_CODES})
    ON CONFLICT (code) DO NOTHING;

    INSERT INTO terminology_keys (code, default_label, description)
    SELECT 'menu.' || s.code || '.description',
           s.description,
           'Tenant description override for the menu ' || s.code || ' (Epic 3 Wave 3, step 11).'
      FROM config_menu_seed() s
     WHERE s.code IN (${MENU_CODES})
       AND s.description IS NOT NULL
    ON CONFLICT (code) DO NOTHING;

    INSERT INTO menu_terminology_allowlist (menu_code, field, terminology_key_id)
    SELECT s.code, 'name', tk.id
      FROM config_menu_seed() s
      JOIN terminology_keys tk ON tk.code = 'menu.' || s.code || '.name'
     WHERE s.code IN (${MENU_CODES})
    ON CONFLICT (menu_code, field) DO NOTHING;

    INSERT INTO menu_terminology_allowlist (menu_code, field, terminology_key_id)
    SELECT s.code, 'description', tk.id
      FROM config_menu_seed() s
      JOIN terminology_keys tk ON tk.code = 'menu.' || s.code || '.description'
     WHERE s.code IN (${MENU_CODES})
       AND s.description IS NOT NULL
    ON CONFLICT (menu_code, field) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  const MENU_CODES = ["nav-service_operations-catering"]
    .map((code) => `'${code}'`)
    .join(", ");

  const ROUTE_CODES = ["route:/catering"]
    .map((code) => `'${code}'`)
    .join(", ");

  const TERMINOLOGY_CODES = ["nav-service_operations-catering"]
    .flatMap((code) => [`'menu.${code}.name'`, `'menu.${code}.description'`])
    .join(", ");

  pgm.sql(`
    DELETE FROM menu_terminology_allowlist
     WHERE menu_code IN (${MENU_CODES});
    DELETE FROM terminology_keys
     WHERE code IN (${TERMINOLOGY_CODES});

    DELETE FROM app_menu_tree WHERE menu_id IN (
      SELECT id FROM app_menus
       WHERE code IN (${MENU_CODES})
    );
    DELETE FROM app_menus
     WHERE code IN (${MENU_CODES});
    DELETE FROM app_windows
     WHERE code IN (${ROUTE_CODES});

    DROP FUNCTION IF EXISTS config_menu_seed();
    ALTER FUNCTION config_menu_seed_a14() RENAME TO config_menu_seed;

    DROP FUNCTION IF EXISTS config_route_window_seed();
    ALTER FUNCTION config_route_window_seed_a14() RENAME TO config_route_window_seed;
  `);
};
