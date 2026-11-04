/**
 * Daily backup scheduler job (owner request: harian + offsite via rclone).
 *
 * Registers the "daily-backup" job (24h interval, disabled by default until
 * an operator sets BACKUP_SCRIPT_PATH or enables it deliberately — a failed
 * backup job on a deployment without the CLI tooling must never look like a
 * healthy tick). The handler shells out to scripts/backup-postgres.mjs via
 * node, so the exact production-safe backup path (pg_dump custom+zstd, doc
 * archive, manifest, SHA256, validation) is reused, not reimplemented.
 *
 * Offsite copy is NOT part of the job itself: the backup script already
 * produces a complete, checksummed set under BACKUP_ROOT; the operator wires
 * `rclone copy BACKUP_ROOT remote:bucket` on the host (systemd timer or cron
 * reading the same BACKUP_ROOT), keeping the API container free of cloud
 * credentials. The Settings Backup tab surfaces last_status/last_error so a
 * silent failure is impossible.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO scheduled_jobs (job_code, name, description, interval_seconds, handler_key, is_enabled)
    VALUES (
      'daily-backup',
      'Daily Database Backup',
      'Runs scripts/backup-postgres.mjs (pg_dump + documents + manifest) once per day. Offsite copy is a host-side rclone step reading BACKUP_ROOT — see docs/operations/backup-restore-dr-runbook.md.',
      86400,
      'daily-backup',
      false
    )
    ON CONFLICT (job_code) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM scheduled_jobs WHERE job_code = 'daily-backup';
  `);
};
