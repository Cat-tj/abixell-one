/**
 * Dictionary seed for the partner-credential admin surface (Wave A8):
 *   - processes: integration.partner_credential.{read,manage}
 *   - API resources: GET/POST /integration/partner-credentials,
 *     POST /integration/partner-credentials/:id/{rotate,revoke}
 * Module attribution: `platform` (`integration.` permission prefix and
 * `integration` first path segment both attribute to platform).
 * Extends both seed functions via the rename-chain UNION pattern and
 * backfills existing tenants. Grants no tenant role.
 */
exports.shorthands = undefined;

const PROCESS_VALUES = `
      ('integration.partner_credential.read', 'List partner API credentials (no secrets)', 'platform'),
      ('integration.partner_credential.manage', 'Issue, rotate, and revoke partner API credentials', 'platform')`;

const API_VALUES = `
      ('api:GET /integration/partner-credentials', 'platform', 'GET', '/integration/partner-credentials'),
      ('api:POST /integration/partner-credentials', 'platform', 'POST', '/integration/partner-credentials'),
      ('api:POST /integration/partner-credentials/:id/rotate', 'platform', 'POST', '/integration/partner-credentials/:id/rotate'),
      ('api:POST /integration/partner-credentials/:id/revoke', 'platform', 'POST', '/integration/partner-credentials/:id/revoke')`;

function renameIfPresent(fn, holder) {
  return `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = '${fn}' AND n.nspname = current_schema()
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = '${holder}' AND n.nspname = current_schema()
      ) THEN
        ALTER FUNCTION ${fn}() RENAME TO ${holder};
      END IF;
    END $$;`;
}

function restore(fn, holder) {
  return `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = '${holder}' AND n.nspname = current_schema()
      ) THEN
        DROP FUNCTION IF EXISTS ${fn}();
        ALTER FUNCTION ${holder}() RENAME TO ${fn};
      END IF;
    END $$;`;
}

exports.up = (pgm) => {
  pgm.sql(`
    ${renameIfPresent("config_dictionary_process_seed", "config_dictionary_process_seed_a8_pc")}
    ${renameIfPresent("config_dictionary_api_resource_seed", "config_dictionary_api_resource_seed_a8_pc")}

    CREATE OR REPLACE FUNCTION config_dictionary_process_seed()
    RETURNS TABLE (code TEXT, name TEXT, module_code TEXT) AS $seed$
      SELECT s.code, s.name, s.module_code
        FROM config_dictionary_process_seed_a8_pc() s
      UNION
      SELECT a.code, a.name, a.module_code
        FROM (VALUES ${PROCESS_VALUES}) AS a(code, name, module_code)
       WHERE NOT EXISTS (
         SELECT 1 FROM config_dictionary_process_seed_a8_pc() l WHERE l.code = a.code
       );
    $seed$ LANGUAGE sql IMMUTABLE;

    CREATE OR REPLACE FUNCTION config_dictionary_api_resource_seed()
    RETURNS TABLE (code TEXT, name TEXT, module_code TEXT, http_method TEXT, path_pattern TEXT) AS $seed$
      SELECT s.code, s.name, s.module_code, s.http_method, s.path_pattern
        FROM config_dictionary_api_resource_seed_a8_pc() s
      UNION
      SELECT a.code, a.http_method || ' ' || a.path_pattern, a.module_code, a.http_method, a.path_pattern
        FROM (VALUES ${API_VALUES}) AS a(code, module_code, http_method, path_pattern);
    $seed$ LANGUAGE sql IMMUTABLE;

    INSERT INTO app_processes (tenant_id, code, name, module_code)
    SELECT t.id, a.code, a.name, a.module_code
      FROM tenants t
      CROSS JOIN (VALUES ${PROCESS_VALUES}) AS a(code, name, module_code)
    ON CONFLICT (tenant_id, code) DO NOTHING;

    INSERT INTO app_api_resources (tenant_id, code, name, module_code, http_method, path_pattern)
    SELECT t.id, a.code, a.http_method || ' ' || a.path_pattern, a.module_code, a.http_method, a.path_pattern
      FROM tenants t
      CROSS JOIN (VALUES ${API_VALUES}) AS a(code, module_code, http_method, path_pattern)
    ON CONFLICT (tenant_id, code) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM app_processes WHERE code IN (
      'integration.partner_credential.read', 'integration.partner_credential.manage');
    DELETE FROM app_api_resources WHERE code IN (
      SELECT a.code FROM (VALUES ${API_VALUES}) AS a(code, module_code, http_method, path_pattern));
    ${restore("config_dictionary_process_seed", "config_dictionary_process_seed_a8_pc")}
    ${restore("config_dictionary_api_resource_seed", "config_dictionary_api_resource_seed_a8_pc")}
  `);
};
