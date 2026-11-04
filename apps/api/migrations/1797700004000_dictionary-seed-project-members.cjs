/**
 * Dictionary seed for the project membership routes (owner request):
 *   GET    /projects/:id/members            -> service_operations
 *   POST   /projects/:id/members            -> service_operations
 *   DELETE /projects/:id/members/:userId    -> service_operations
 */
exports.shorthands = undefined;

const API_RESOURCE_ROWS = `
      ('api:GET /projects/:id/members', 'customer_commercial', 'GET', '/projects/:id/members'),
      ('api:POST /projects/:id/members', 'customer_commercial', 'POST', '/projects/:id/members'),
      ('api:DELETE /projects/:id/members/:userId', 'customer_commercial', 'DELETE', '/projects/:id/members/:userId')`;

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
         WHERE p.proname = 'config_dictionary_api_resource_seed_a67'
           AND n.nspname = current_schema()
      ) THEN
        ALTER FUNCTION config_dictionary_api_resource_seed()
          RENAME TO config_dictionary_api_resource_seed_a67;
      END IF;
    END $$;

    CREATE OR REPLACE FUNCTION config_dictionary_api_resource_seed()
    RETURNS TABLE (code TEXT, name TEXT, module_code TEXT, http_method TEXT, path_pattern TEXT) AS $seed$
      SELECT s.code, s.name, s.module_code, s.http_method, s.path_pattern
        FROM config_dictionary_api_resource_seed_a67() s
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
    DROP FUNCTION IF EXISTS config_dictionary_api_resource_seed();
    ALTER FUNCTION config_dictionary_api_resource_seed_a67()
      RENAME TO config_dictionary_api_resource_seed;
  `);
};
