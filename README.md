# Abixell One — Integrated Enterprise Management System

Internal project codename: **Abixell One** (by Insting Tekno Sinergi).
Internal positioning: *Whitelabel Integrated Enterprise Management System*.

> **Client-facing rule:** the word "whitelabel" (and "multi-tenant product",
> "shared product core", "reusable platform", "template platform") must
> **never** appear in any user-facing string, UI copy, email template, PDF,
> report, or client-facing document. All such strings must be sourced from
> per-Tenant Branding/Terminology Configuration, never hardcoded. See
> `docs/adr/0003-client-facing-branding-rule.md`.

## Canonical documentation

Start with [docs/canonical/documentation-map.md](docs/canonical/documentation-map.md) — it
defines authority and reading order. The sources of truth are:

| Document | Purpose |
|---|---|
| [docs/prd/abixell-one/](docs/prd/abixell-one/00-README.md) | **What must the product do?** — requirements with stable IDs, per module |
| [docs/canonical/product-blueprint.md](docs/canonical/product-blueprint.md) | **How is it structured?** — architecture layers, Platform Core, 11 Business Core modules, Advanced / Configuration / Extension, repository architecture rules |
| [docs/canonical/product-roadmap.md](docs/canonical/product-roadmap.md) | **When is it delivered?** — historical delivery, future phases, roadmap units and weights |
| [docs/canonical/product-progress.md](docs/canonical/product-progress.md) | **How much is done?** — measured progress with calculation basis |
| [docs/decision-log.md](docs/decision-log.md) · [docs/adr/](docs/adr/) | **Why?** — product and architecture decisions |

Supporting: [docs/technical-debt-register.md](docs/technical-debt-register.md),
[docs/implementation-notes.md](docs/implementation-notes.md).
Historical: [docs/history/](docs/history/) — IGSEP legacy requirements, pre-Phase-0
founding decisions, Phase 0 specification. **Never** derive current scope from it.

## Current state

**Phase 0 — Enterprise Core Foundation: COMPLETED.**
**Phase 1 — Customer Complaint Management + Survey & Assessment: COMPLETED.**

Implemented business capability: Customer & Commercial foundation, Service
Quality (Complaint) end-to-end, Survey & Assessment engine, and Survey-to-Action
integration. Remaining domains (Service Operations, HR, Supply Chain, Asset,
Finance, HSE, Project, Reporting) are planned — see the roadmap.

Abixell One is the successor to **IGSEP**, an earlier vertical product concept.
That corpus is preserved as a legacy requirement source in
[docs/history/igsep/](docs/history/igsep/README.md) and is **not** the
implementation source of truth.

## Contributing new modules

New code must follow the target repository architecture frozen in
[the blueprint](docs/canonical/product-blueprint.md#11a-repository-architecture-target--binding-for-new-code):
`modules/<module>/core|advanced|packs`, cross-domain capability in
`orchestration/`, platform capability in `core/`, technical helpers in `shared/`,
and a single migration stream. Existing Phase 0/1 code predates this layout;
its migration is deliberately deferred.

## Repository layout

```
apps/api/        Node.js + TypeScript backend (Fastify, modular monolith)
apps/web/        React + Vite + TypeScript frontend (application shell)
packages/        Shared TypeScript contracts/types between api and web
docs/adr/        Architecture Decision Records
docs/            Decision log, implementation notes, gap/risk tracking
tests/           Cross-cutting / integration tests
infra/           Docker Compose, database infrastructure
scripts/         Dev/setup scripts
config/          Environment templates
```

`docs/00-prd/` holds the historical IGSEP-era blueprint corpus and the
Abixell One Phase 0 foundation specifications. The canonical product
documents listed above supersede it for implementation decisions.

## Getting started

```bash
npm install
npm run db:up          # starts local PostgreSQL via Docker Compose
cp apps/api/.env.example apps/api/.env
npm run migrate -w apps/api
npm run seed -w apps/api   # optional: demo Tenant + Admin/Supervisor users
npm run dev:api         # http://localhost:4000
npm run dev:web         # http://localhost:5173
```

Demo login (after `npm run seed`): `admin@demo.local` / `admin123!`
(tenant-wide) or `supervisor@demo.local` / `Supervisor12345!` (Site A scope
only, read-only), Tenant code `demo-gs`.

Demo also seeds `customeruser@democlient.local` / `CustomerUser12345!`
(customer scope), `handler@demo.local` / `Handler12345!`, and
`complaintmanager@demo.local` / `ComplaintManager12345!`.

## Status

| | |
|---|---|
| Roadmap Baseline | v1.29 |
| Measured at | `master` @ `e6a5b14` (2026-10-27) |
| Phases complete | Phase 0–10, H, H2, 11A–11F, Waves A1–A7 |
| Tests | 586/586 (39 files) — handoff baseline `7b66c65`, not rerun at measured point |
| Migrations | 151 |
| Core Product Readiness | **100.0 %** (174/174) |
| Full Approved Roadmap | **94.9 %** (335/353) |

Progress figures and their calculation basis: [docs/canonical/product-progress.md](docs/canonical/product-progress.md).
Next phase awaits Founder approval — see [docs/canonical/product-roadmap.md](docs/canonical/product-roadmap.md).
