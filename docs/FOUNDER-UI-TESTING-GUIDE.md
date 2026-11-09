# Founder UI Testing Guide

Use this guide to open the current Abixell One Pilot build locally, sign in with the seeded demo administrator, and smoke-test the completed Core modules. The account and password below are for local/demo data only; they must never be reused as deployed-environment credentials.

## Manual smoke closure — 2026-08-22

Founder manual UI smoke testing passed after the local launcher correction:

- login succeeded at `http://localhost:5173/login`;
- the application remained reachable and did not redirect back to login after authentication;
- tested internal Core pages returned no `401`, `403`, or `Unauthorized` result;
- pages rendered without blank screens or crashes; and
- module headings loaded successfully (empty tables were accepted for this navigation smoke).

This records Pilot UI smoke evidence only. It does not change canonical progress, start Phase H2, authorize production deployment, or start any Advanced wave.

## 1. Prerequisites

- Windows 11
- Docker Desktop running with Linux containers
- Node.js 20 or later
- Ports `5432`, `4000`, and `5173` available
- Repository at `D:\Abixell One - By Insting Tekno Sinergi\abixell-one`

## 2. Recommended one-click start

1. Start Docker Desktop and wait until its engine reports that it is running.
2. Open `D:\Abixell One - By Insting Tekno Sinergi\RUN-ABIXELL-ONE.bat`.
3. Leave the two terminal windows named **Abixell One API** and **Abixell One Web** open.
4. The launcher opens `http://localhost:5173` automatically. If it does not, open that URL manually.

The launcher is intentionally outside the repository and beside the `abixell-one` folder. It resolves the repository relative to its own location; it does not depend on a second hard-coded checkout path. On each run it:

1. verifies Docker and Node.js;
2. creates `apps\api\.env` from `.env.example` only if the local file is absent;
3. installs dependencies when `node_modules` is absent;
4. starts PostgreSQL;
5. applies pending migrations;
6. runs the idempotent demo seed and full-access permission sync; and
7. starts the API on port `4000` and the Web app on port `5173`.

## 3. Login

Open `http://localhost:5173/login` and use:

| Field | Local/demo value |
|---|---|
| Tenant code | `demo-gs` |
| Email | `admin@demo.local` |
| Password | `admin123!` |

Successful login redirects to `http://localhost:5173/` and displays **Welcome to Demo Enterprise Client**. The demo administrator is tenant-scoped and has the full-access role, so all capability-gated internal Core pages are available.

## 4. Core UI smoke route

Start from **Overview**. Open each page below and confirm its heading or principal content renders without an error banner. Empty tables are acceptable; a page load, visible controls, and no authorization/network error constitute a successful navigation smoke check.

| Completed Core area | Click or open | Expected success signal |
|---|---|---|
| Customer & Commercial | **Customers** (`/customer-commercial`) | **Customer & Commercial** heading; Customers, Contacts, Contracts, Projects, Sites, Services, and Assignments sections load |
| Complaints / Service Quality | **Queue** (`/queue`) | **Complaint Queue** heading and summary cards/list load |
| Complaints verification | **Verification** (`/verification`) | Verification queue loads |
| Complaints management | **Management** (`/management`) | Complaint performance dashboard loads |
| Survey | **Surveys** (`/surveys`) | **Surveys** heading and survey-definition list load |
| Service Operations | **Work Orders** (`/work-orders`) | **Work Orders** heading and create/list controls load |
| Service Operations configuration | **Service Types** (`/service-types`) | Service definition page loads |
| Workforce | **Employees** (`/employees`) | **Employees** heading and employee list/form load |
| Supply Chain | **Items & Stock** (`/items`) | **Items & Stock** heading and item/stock controls load |
| Supply Chain | **Suppliers** (`/suppliers`) | Supplier page loads |
| Supply Chain | **Purchasing** (`/purchasing`) | Purchasing page loads |
| Asset | **Assets** (`/assets`) | **Assets** heading and asset register controls load |
| Finance | **Transactions** (`/finance/transactions`) | **Transactions** heading and transaction controls load |
| Finance | **Cashflow** (`/finance/cashflow`) | Cashflow summary loads |
| Finance | **Cash & Bank** (`/finance/accounts`) | Account list/configuration loads |
| HSE | Open `http://localhost:5173/hse` | **HSE Register** heading and incident/observation filters load |
| Project Delivery | **Project Delivery** (`/project-delivery`) | **Project Delivery** heading and delivery list load |
| Reporting | **Reporting** (`/reporting`) | **Reporting** heading and operational reporting/dashboard controls load |

The HSE Core route is available to the full-access demo administrator. In the current shell it is reached directly at `/hse` rather than through an Overview/navigation card; this smoke instruction does not add or imply a new capability.

The **Complaints** customer-facing page is intentionally hidden from this internal tenant-wide administrator because that navigation item requires customer Data Scope. Use **Queue**, **Verification**, and **Management** for the administrator-side Service Quality smoke check. This is expected capability-gate behavior, not a missing permission.

## 5. What success looks like

The local Pilot UI smoke is successful when:

- login reaches **Welcome to Demo Enterprise Client**;
- all Core routes listed above render their expected headings or controls;
- no page shows `Unauthorized`, `Forbidden`, `Could not load`, or a network failure;
- browser refresh keeps the authenticated session; and
- **Sign out** returns to `/login` and the protected pages remain inaccessible after refresh.

This check verifies local login, capability-gated navigation, and page loading. It is not user-acceptance testing of every create/update workflow and does not represent production deployment approval.

## 6. Manual start fallback

If the launcher closes with an error, open a terminal in the repository and run these commands in order:

```bash
npm install
```

```bash
npm run db:up
```

```bash
npm run migrate -w apps/api
```

```bash
npm run seed -w apps/api
```

```bash
npm run sync-permissions -w apps/api
```

Then keep two terminals open. In the first:

```bash
npm run dev:api
```

In the second:

```bash
npm run dev:web
```

Open `http://localhost:5173/login` and use the demo credentials above. The seed is safe to rerun locally: if `demo-gs` already exists it reports that the seed was skipped, while permission sync reports zero additions when already current.

## 7. Troubleshooting

### Docker or database startup fails

- Start or restart Docker Desktop.
- Confirm no unrelated process occupies port `5432`.
- Retry the launcher after the Docker engine is ready.
- Inspect the PostgreSQL container with `docker compose -f infra/postgres/docker-compose.yml ps` from the repository.

### Login reports invalid credentials

- Confirm tenant code, email, and password match the table exactly.
- Confirm the API terminal is still running on port `4000`.
- Rerun the migration, seed, and permission-sync commands in section 6.
- The seed deliberately does not overwrite an existing tenant. If a local database was manually modified, use a fresh local development database rather than changing seed credentials or adding production secrets to source control.

### Web page does not open

- Confirm the Web terminal shows Vite listening on `http://localhost:5173`.
- Confirm the API terminal is listening on `http://localhost:4000`.
- Close stale dev-server terminals before restarting the launcher if either port is already occupied.

### A page is missing from navigation

The shell hides pages that the signed-in user's permissions or Data Scope do not cover. For this guide, use `admin@demo.local`. The customer-facing **Complaints** item is intentionally customer-scope-only; the HSE smoke route is opened directly as documented above.

## Scope boundary

This guide covers local Pilot UI readiness only. Phase H2 production work (`PH-3`, `PH-4`, `PH-8`), Advanced waves, client extensions, and new roadmap capabilities remain outside this activity and remain unstarted.
