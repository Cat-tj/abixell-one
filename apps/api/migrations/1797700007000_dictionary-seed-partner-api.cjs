/**
 * Dictionary seed for Wave A8 / WP-PLT-A8-01 partner API surface routes.
 *   GET /api/partner/v1/customers, GET /api/partner/v1/customers/:id
 * Module attribution: `platform` (the versioned partner surface is a
 * platform-level API-economy capability, PLT-ADV-001; see
 * module-attribution.ts `/api/partner` override).
 */
exports.shorthands = undefined;

const API_RESOURCE_ROWS = `
      ('api:GET /api/partner/v1/customers', 'platform', 'GET', '/api/partner/v1/customers'),
      ('api:GET /api/partner/v1/customers/:id', 'platform', 'GET', '/api/partner/v1/customers/:id')`;

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_dictionary_api_resource_seed'
           AND n.nspname = current_schema()
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_dictionary_api_resource_seed_a69'
           AND n.nspname = current_schema()
      ) THEN
        ALTER FUNCTION config_dictionary_api_resource_seed()
          RENAME TO config_dictionary_api_resource_seed_a69;
      END IF;
    END $$;

    CREATE OR REPLACE FUNCTION config_dictionary_api_resource_seed()
    RETURNS TABLE (code TEXT, name TEXT, module_code TEXT, http_method TEXT, path_pattern TEXT) AS $seed$
      SELECT s.code, s.name, s.module_code, s.http_method, s.path_pattern
        FROM config_dictionary_api_resource_seed_a69() s
      UNION
      SELECT a.code, a.http_method || ' ' || a.path_pattern, a.module_code, a.http_method, a.path_pattern
        FROM (VALUES
          ${API_RESOURCE_ROWS}
        ) AS a(code, module_code, http_method, path_pattern);
    $seed$ LANGUAGE sql IMMUTABLE;

    INSERT INTO app_api_resources (tenant_id, code, name, module_code, http_method, path_pattern)
    SELECT t.id, a.code, a.http_method || ' ' || a.path_pattern, a.module_code, a.http_method, a.path_pattern
      FROM tenants t
      CROSS JOIN (VALUES
        ${API_RESOURCE_ROWS}
      ) AS a(code, module_code, http_method, path_pattern)
    ON CONFLICT (tenant_id, code) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM app_api_resources WHERE code IN (
      SELECT a.code FROM (VALUES
        ${API_RESOURCE_ROWS}
      ) AS a(code, module_code, http_method, path_pattern)
    );
    DO $$
    BEGIN
      -- Only undo the rename if up() actually performed it (the _a69 holder
      -- exists); otherwise leave the head function untouched.
      IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_dictionary_api_resource_seed_a69'
           AND n.nspname = current_schema()
      ) THEN
        DROP FUNCTION IF EXISTS config_dictionary_api_resource_seed();
        ALTER FUNCTION config_dictionary_api_resource_seed_a69()
          RENAME TO config_dictionary_api_resource_seed;
      END IF;
    END $$;
  `);
};
