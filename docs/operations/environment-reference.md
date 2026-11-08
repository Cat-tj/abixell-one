# Staging and Production Environment Reference

This is the generic environment contract for one dedicated Abixell One deployment. No client identity, domain, credential, or hosting-provider value belongs in source control. Copy [`infra/deployment/.env.example`](../../infra/deployment/.env.example) to a protected deployment environment file outside the repository or populate equivalent values through a secret manager.

## Required values

| Variable | Secret | Requirement |
|---|---|---|
| `DEPLOYMENT_ENVIRONMENT` | No | `staging` or `production`. |
| `COMPOSE_PROJECT_NAME` | No | Unique per dedicated deployment; generic environment identifier, not source-code configuration. |
| `API_IMAGE` | No | Immutable API runtime image SHA-256 digest; tags are rejected. |
| `API_OPERATIONS_IMAGE` | No | Immutable API `operations` image SHA-256 digest containing migration, permission-sync, and recovery tooling. |
| `WEB_IMAGE` | No | Immutable Web image SHA-256 digest; tags are rejected. |
| `POSTGRES_IMAGE` | No | Immutable PostgreSQL 16 image SHA-256 digest; tags alone are rejected. |
| `POSTGRES_USER` | No | Deployment-local database role. |
| `POSTGRES_PASSWORD` | Yes | Random secret; URL-encode separately inside `DATABASE_URL`. |
| `POSTGRES_DB` | No | Deployment-local database name. |
| `DATABASE_URL` | Yes | PostgreSQL URL using Compose host `postgres`, never a public host port. |
| `JWT_ACCESS_SECRET` | Yes | At least 32 random characters, unique per deployment. |
| `PLATFORM_BOOTSTRAP_KEY` | Yes | At least 32 random characters, unique per deployment. Rotate/remove access after initial bootstrap where operationally possible. |
| `CORS_ORIGINS` | No | Comma-separated exact approved frontend origins; no wildcard or localhost in staging/production. |

## Tunable values

| Variable | Default | Note |
|---|---:|---|
| `LOG_LEVEL` | `info` | Raise temporarily for diagnosis; avoid logging sensitive payloads. |
| `RATE_LIMIT_GLOBAL_MAX` | `1200` | Requests per window; tune from observed dedicated-deployment traffic. |
| `RATE_LIMIT_WINDOW` | `1 minute` | Fastify rate-limit window. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Login attempts per window and IP. |
| `AUTH_RATE_LIMIT_WINDOW` | `1 minute` | Login window. |
| `WEB_BIND_ADDRESS` | `127.0.0.1` | Keep loopback when a host ingress terminates TLS. Use `0.0.0.0` only with an approved firewall/ingress design. |
| `WEB_PORT` | `8080` | Host ingress target. Only the Web proxy is published. |
| `SCHEDULER_DISABLED` | `false` | Exactly one API process must own in-process Scheduler timers. Set `true` on additional API replicas. |
| `INTEGRATION_OUTBOX_BATCH_SIZE` | `100` | Due deliveries claimed per batch and Tenant. |
| `INTEGRATION_OUTBOX_MAX_ATTEMPTS` | `5` | Terminal-failure threshold. |
| `INTEGRATION_OUTBOX_RETRY_BASE_SECONDS` | `30` | Exponential retry base. |
| `INTEGRATION_OUTBOX_CLAIM_TIMEOUT_SECONDS` | `300` | A processing claim older than this is recovered as interrupted. |

The API container fixes `FILE_STORAGE_ROOT=/data/documents` and mounts a persistent deployment-local document volume there. The operations image contains PostgreSQL 16 clients, `tar`, and the PH-3 scripts. The Compose `backup` service mounts that same document volume read-only and writes complete sets to the protected host `BACKUP_ROOT`; the manifest records `APPLICATION_RELEASE` and the immutable API/operations/Web image identities. Existing deployments stop Web/API write traffic and take a verified-script pre-migration backup labelled with the prior successful release before migration. Restore uses the separate [`compose.restore.yml`](../../infra/deployment/compose.restore.yml) and [`.env.restore.example`](../../infra/deployment/.env.restore.example), its own isolated PostgreSQL named volume and document target, immutable `RESTORE_POSTGRES_IMAGE`/`RESTORE_OPERATIONS_IMAGE`/`RESTORE_API_IMAGE`/`RESTORE_WEB_IMAGE`, exact `RESTORE_APPLICATION_RELEASE`, and mandatory service-DNS health URLs; see the backup/restore runbook.

## Continuous Deployment Environment Rendering (Staging)

On staging, the environment file is **automatically rendered** by GitHub Actions ([`infra/deployment/render-env.mjs`](../../infra/deployment/render-env.mjs)) from:

1. **Template defaults** (`infra/deployment/.env.example`) — safe fallback values for non-secrets (log level, rate limits, scheduler settings, port, etc.).
2. **Image digests** — supplied by the CD workflow from a successful build artifact (immutable `@sha256:...` references, never tags).
3. **Release identifier** — supplied by the CD workflow from the build artifact.
4. **GitHub Environment Secrets** — provisioned by the operator in the `staging` GitHub Environment:
   - `STAGING_POSTGRES_PASSWORD`
   - `STAGING_DATABASE_URL`
   - `STAGING_JWT_ACCESS_SECRET`
   - `STAGING_PLATFORM_BOOTSTRAP_KEY`
   - `STAGING_CORS_ORIGINS` (may be a variable instead of a secret if the approved origin is not confidential)
5. **GitHub Environment Variables** — tunable non-secret config, overriding template defaults:
   - `STAGING_POSTGRES_USER`
   - `STAGING_POSTGRES_DB`
   - `STAGING_COMPOSE_PROJECT_NAME`
   - `STAGING_POSTGRES_IMAGE` (immutable PostgreSQL digest)
   - `STAGING_WEB_BIND_ADDRESS`
   - `STAGING_WEB_PORT`
   - `STAGING_BACKUP_ROOT`
   - Any other non-secret variable from the template (e.g., `STAGING_LOG_LEVEL`, `STAGING_RATE_LIMIT_*`, `STAGING_SCHEDULER_DISABLED`)

The rendered environment file is validated locally (`deploy:validate`) before being piped to the VPS over SSH. No secret value is ever printed to workflow logs or artifacts; only the fact that rendering succeeded is reported.

For **production** (manual deployment), copy the `.env.example` template and fill secrets from a secret manager, using the same variable names and format.

## Secret and file rules

- Keep environment files mode `0600` or stricter on POSIX hosts.
- Never run `docker compose config` into a ticket or shared log; rendered output may include secrets. `deploy:validate` uses quiet validation.
- Never reuse development/demo credentials, `Admin12345!`, `admin123!`, or values containing `replace-`, `change-me`, `dev-only`, or `abixell_dev_password`.
- Rotate secrets per deployment. A compromise or client offboarding does not rotate any other deployment.
- Single-quote protected environment values containing a literal `$`. Validation compares the parsed values with the rendered Compose model and rejects interpolation changes.
- The deployment lock/state root defaults to a host-global location keyed by `COMPOSE_PROJECT_NAME` (`$XDG_STATE_HOME/abixell-one`, i.e. `~/.local/state/abixell-one`, on POSIX, `%ProgramData%/AbixellOne/deployments` on Windows). If `DEPLOYMENT_STATE_ROOT` is overridden, every checkout/automation path for that deployment must use the same protected host-global root. The directory is owned by the deploy user and must live on persistent storage: `/var/lock` is tmpfs on systemd hosts, so state there is lost on reboot and the next deploy fails closed with no prior release state.
- TLS is terminated by the approved host/cloud ingress. Only Web is published and dual-homed onto a dedicated ingress network; API and PostgreSQL remain exclusively on the internal backend network.
- Do not run the demo seed in staging or production. Bootstrap the first Tenant using the protected platform flow, then run permission sync after every migration.
