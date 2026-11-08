/**
 * Dictionary seed for `wms.price.view` (LOA price visibility).
 *
 * 1797700008100 catalogued the permission but did not extend the dictionary
 * seed (tests/dictionary-seed-parity.test.ts caught it) and granted it to no
 * role. This migration:
 *   1. extends config_dictionary_process_seed() with the new process
 *      (module `warehouse_management`, per module-attribution.ts `wms.` prefix),
 *      following the rename-chain UNION pattern, and backfills existing tenants;
 *   2. does NOT grant any tenant role: full-access roles receive it through
 *      `npm run sync-permissions`; every other role is configured through
 *      governed role configuration.
 */
exports.shorthands = undefined;

const PROCESS_ROW = `
      SELECT 'wms.price.view',
             'View prices (unit cost/price fields) on WMS and procurement documents',
             'warehouse_management'
       WHERE NOT EXISTS (
         SELECT 1 FROM config_dictionary_process_seed_wms_price() l WHERE l.code = 'wms.price.view'
       )`;

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_dictionary_process_seed'
           AND n.nspname = current_schema()
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_dictionary_process_seed_wms_price'
           AND n.nspname = current_schema()
      ) THEN
        ALTER FUNCTION config_dictionary_process_seed()
          RENAME TO config_dictionary_process_seed_wms_price;
      END IF;
    END
    $$;

    CREATE OR REPLACE FUNCTION config_dictionary_process_seed()
    RETURNS TABLE (code TEXT, name TEXT, module_code TEXT) AS $seed$
      SELECT s.code, s.name, s.module_code
        FROM config_dictionary_process_seed_wms_price() s
      UNION
${PROCESS_ROW};
    $seed$ LANGUAGE sql IMMUTABLE;

    INSERT INTO app_processes (tenant_id, code, name, module_code)
    SELECT t.id, s.code, s.name, s.module_code
      FROM tenants t
      CROSS JOIN config_dictionary_process_seed() s
     WHERE s.code = 'wms.price.view'
    ON CONFLICT (tenant_id, code) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM app_processes WHERE code = 'wms.price.view';

    DROP FUNCTION IF EXISTS config_dictionary_process_seed();
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'config_dictionary_process_seed_wms_price'
           AND n.nspname = current_schema()
      ) THEN
        ALTER FUNCTION config_dictionary_process_seed_wms_price()
          RENAME TO config_dictionary_process_seed;
      END IF;
    END
    $$;
  `);
};
