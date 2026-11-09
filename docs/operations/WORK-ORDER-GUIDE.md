# Work Order Process — Complete Operational Guide

**Version:** 1.0  
**Date:** 2026-10-28  
**Tenant:** Demo Catering (`demo-gs`)  
**Status:** Ready for FASE 0 Pilot  

---

## 📋 Table of Contents

1. [Executive Summary](#executive-summary)
2. [Operational Roles & Permissions](#operational-roles--permissions)
3. [Demo User Credentials](#demo-user-credentials)
4. [Demo Tenant Setup](#demo-tenant-setup)
5. [Work Order Lifecycle (13-Step Process)](#work-order-lifecycle-13-step-process)
6. [API Endpoints Reference](#api-endpoints-reference)
7. [Business Rules & Guardrails](#business-rules--guardrails)
8. [Workflow State Transitions](#workflow-state-transitions)

---

## Executive Summary

The **Work Order Process** is a five-phase end-to-end service delivery workflow spanning intake, execution, verification, evidence, and finance. It consolidates service operations (catering, housekeeping, facility management, etc.) into a unified permission-based system with role separation of duties (SoD), immutable templates, idempotent operations, and numeric-precision cost tracking.

### Five Phases at a Glance

| Phase | Steps | Owner | Workflow State | Output |
|-------|-------|-------|---|---|
| **Intake** | 1–2 | COORD_OPS | PLANNED | Work Order created from request |
| **Execution** | 3–5 | EXEC_OPS | IN_PROGRESS | Work completed; checklist finalized |
| **Verification** | 6–7 | VERIFY_OPS | DONE | Signed off; customer token issued |
| **Evidence** | 8–9 | Customer / VERIFY_OPS | DONE → CLOSED | Customer accepts/rejects; SLA tracked |
| **Finance** | 10–11 | BILL_OPS | CLOSED | Invoice generated; GL posted |

---

## Operational Roles & Permissions

### Role Hierarchy

```
Tenant Scope (broadest)
  ├─ COORD_OPS    (Coordinator Operations)
  │   ├─ read service operations
  │   ├─ manage (create, update)
  │   ├─ configure templates
  │   ├─ read customers
  │   └─ start workflows
  ├─ EXEC_OPS     (Executor Operations)
  │   ├─ read service operations
  │   ├─ execute (start work, update checklists)
  │   └─ workflow actions
  ├─ VERIFY_OPS   (Verifier Operations)
  │   ├─ read service operations
  │   ├─ verify (sign off)
  │   └─ workflow actions
  └─ BILL_OPS     (Billing Operations)
      ├─ read service operations
      ├─ manage billing (create invoices)
      └─ read customers
```

### Detailed Permission Codes

| Role | Permission | Capability | Example |
|------|-----------|-----------|---------|
| **COORD_OPS** | `service_operations.read` | View all work orders, requests, checklist templates, costing rules | List pending requests from all sites |
| | `service_operations.manage` | Create/cancel/convert work requests; create, assign, schedule Work Orders; add cost items (only after customer acceptance, before finalization) | Add labor cost item to an accepted WO |
| | `service_operations.configure` | Create service definitions and checklist template items (a snapshot is copied into each WO at creation) | Create new "standard catering" template |
| | `customer.read` | View customer master, scopes, accounts | Look up customer location |
| | `workflow.instance.start` | Initiate new workflow instances | Trigger WO creation → PLANNED state |
| | `workflow.instance.act` | Perform workflow actions (transitions, assignments) | PLANNED → IN_PROGRESS transition |
| **EXEC_OPS** | `service_operations.read` | View assigned work orders and status | See "my work" list |
| | `service_operations.execute` | Start work, update checklist items, add notes | Mark "kitchen setup" complete |
| | `workflow.instance.act` | Perform workflow transitions assigned to this role | IN_PROGRESS → DONE transition |
| **VERIFY_OPS** | `service_operations.read` | View all work orders and their checklist/cost details | Review checklist and cost items before finalizing |
| | `service_operations.verify` | Verify completed work, issue acceptance tokens, record internal customer accept/reject, finalize costs | Sign off WO; generate customer token; finalize costs after acceptance |
| | `workflow.instance.act` | Perform verification transitions | DONE → CLOSED transition |
| **BILL_OPS** | `service_operations.read` | View customer, work order, and cost details | Review total cost before invoicing |
| | `service_operations.billing.manage` | Create customer invoices (with markup/tax calculation); cannot add cost items | Generate INV-00001 with 15% markup + 11% PPN |
| | `customer.read` | Look up customer details and billing address | Verify invoice recipient |

---

## Demo User Credentials

### Setup Instructions (Development)

**⚠️ SECURITY NOTICE:** Demo credentials are hardcoded in `apps/api/scripts/seed.ts` for development use only. In staging/production, passwords are managed via environment variables (`PILOT_ADMIN_PASSWORD`, `PILOT_USER_PASSWORD`) and never printed to stdout or committed.

### Demo Tenant Admin

| Field | Value |
|-------|-------|
| **Email** | `admin@demo.local` |
| **Password** | `admin123!` |
| **Full Name** | Demo Administrator |
| **Scope** | Tenant-wide (all operations) |
| **Roles** | ADMIN (unrestricted) |

**Login:**
```bash
curl -X POST http://localhost:4010/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "tenantCode": "demo-gs",
    "email": "admin@demo.local",
    "password": "admin123!"
  }'
```

### Catering Operations Team (PILOT)

#### 1. Coordinator Ops (COORD_OPS)

| Field | Value |
|-------|-------|
| **Email** | `coord@demo.local` |
| **Password** | `Coord12345!` |
| **Full Name** | Demo Coordinator Ops |
| **Scope** | Tenant-wide |
| **Role Code** | `COORD_OPS` |
| **Can Do** | Create work requests/orders, configure templates, assign executors, start workflows |

**Use Case:** Operations manager planning catering service requests.

#### 2. Executor Ops (EXEC_OPS)

| Field | Value |
|-------|-------|
| **Email** | `exec@demo.local` |
| **Password** | `Exec12345!` |
| **Full Name** | Demo Executor Ops |
| **Scope** | Tenant-wide |
| **Role Code** | `EXEC_OPS` |
| **Can Do** | Start assigned work, update checklist items, record completion notes |

**Use Case:** Field staff executing catering at customer site.

#### 3. Verifier Ops (VERIFY_OPS)

| Field | Value |
|-------|-------|
| **Email** | `verify@demo.local` |
| **Password** | `Verify12345!` |
| **Full Name** | Demo Verifier Ops |
| **Scope** | Tenant-wide |
| **Role Code** | `VERIFY_OPS` |
| **Can Do** | Review completed work, finalize costs, issue public acceptance tokens, sign off |

**Use Case:** Quality assurance or supervisor verifying work completion.

#### 4. Billing Ops (BILL_OPS)

| Field | Value |
|-------|-------|
| **Email** | `bill@demo.local` |
| **Password** | `Bill12345!` |
| **Full Name** | Demo Billing Ops |
| **Scope** | Tenant-wide |
| **Role Code** | `BILL_OPS` |
| **Can Do** | Review costs, create customer invoices, apply markup/tax calculations |

**Use Case:** Finance team generating customer invoices.

### Login Command Template

```bash
# Replace {EMAIL} and {PASSWORD}
curl -X POST http://localhost:4010/auth/login \
  -H "Content-Type: application/json" \
  -d "{
    \"tenantCode\": \"demo-gs\",
    \"email\": \"{EMAIL}\",
    \"password\": \"{PASSWORD}\"
  }"
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "email": "exec@demo.local",
    "fullName": "Demo Executor Ops",
    "tenantId": "uuid",
    "tenantCode": "demo-gs"
  }
}
```

---

## Demo Tenant Setup

### Tenant Identity

| Property | Value |
|----------|-------|
| **Tenant Code** | `demo-gs` |
| **Tenant Name** | Demo Unified Tenant |
| **Legal Entity** | Demo Legal Entity Pte Ltd |
| **Fiscal Year** | FY2026 |

### Customer & Site

| Property | Value |
|----------|-------|
| **Customer Code** | `CUST-CATER` |
| **Customer Name** | Demo Catering Client |
| **Site Code** | `SITE-CATER` |
| **Site Name** | Demo Catering Site |
| **Owner Org Unit** | Catering Operations (pilot unit) |

### Service Definition

| Property | Value |
|----------|-------|
| **Service Code** | `SVC-CATERING` |
| **Service Name** | Catering Service |
| **Service Definition Code** | `catering_demo_service` |
| **Description** | Catering vertical demo service — seeded for unified demo tenant |

### Accounting Period

| Property | Value |
|----------|-------|
| **Period Code** | `OCT-2026` |
| **Period Name** | Oktober 2026 |
| **Fiscal Year Code** | `FY2026` |
| **Date Range** | 2026-10-01 to 2026-10-31 |
| **Status** | OPEN (can post GL journals) |
| **Chart of Accounts** | FY2026 (active) |

### Financial Parameters

| Parameter | Value | Use |
|-----------|-------|-----|
| **Default Markup** | 15% (0.15) | Applied to all cost items unless overridden per invoice |
| **PPN Tax Rate** | 11% (0.11) | Indonesian Value-Added Tax; applied only if `isTaxable=true` |
| **Pricing Formula** | `total = (cost_basis × (1 + markup)) + tax` | If cost is 100, markup 15%, tax 11%: total = 115 × 1.11 = 127.65 |

### Numbering Sequences

| Entity | Sequence Pattern | Starting Value | Example |
|--------|-----------------|-----------------|---------|
| Work Order | `WO-{SEQ:5}` | 0 | WO-00001, WO-00002, … |
| Customer Invoice | `INV-{SEQ:5}` | 0 | INV-00001, INV-00002, … |

---

## Work Order Lifecycle (13-Step Process)

### Step 1: Create Work Request

**Actor:** COORD_OPS  
**Permission:** `service_operations.manage`  
**Endpoint:** `POST /work-requests`

**Payload:**
```json
{
  "customerId": "uuid-of-CUST-CATER",
  "siteId": "uuid-of-SITE-CATER",
  "serviceDefinitionCode": "catering_demo_service",
  "description": "Catering for Q4 2026 company event, 100 pax",
  "priority": "high"
}
```

**Output:** `WorkRequest` with `requestNumber: WR-00001`

---

### Step 2: Convert Request → Work Order

**Actor:** COORD_OPS  
**Permission:** `service_operations.manage`, `workflow.instance.start`  
**Endpoint:** `POST /work-requests/{id}/convert`

**Payload:**
```json
{
  "title": "Q4 2026 Company Event Catering",
  "plannedStartAt": "2026-10-15T09:00:00Z",
  "plannedEndAt": "2026-10-15T18:00:00Z",
  "dueAt": "2026-10-20T23:59:59Z"
}
```

**Triggers:**
- WorkRequest state → "converted"
- Work Order created with `workOrderNumber: WO-00001`
- Workflow instance created; state = `PLANNED`
- Checklist snapshot taken from service template (immutable)

---

### Step 3: Assign Work Order to Executor

**Actor:** COORD_OPS  
**Permission:** `service_operations.manage`  
**Endpoint:** `POST /work-orders/{id}/assign`

**Payload:**
```json
{
  "assigneeUserId": "uuid-of-exec@demo.local"
}
```

**Output:** Work Order updated with `assignedToUserId`, `assignedAt`, `assignedByUserId`

---

### Step 4: Start Work

**Actor:** EXEC_OPS  
**Permission:** `service_operations.execute`, `workflow.instance.act`  
**Endpoint:** `POST /work-orders/{id}/start`

**Triggers:**
- Workflow transition: PLANNED → IN_PROGRESS
- `startedAt`, `startedByUserId` recorded
- Executor can now update checklist items

---

### Step 5: Update Checklist Items

**Actor:** EXEC_OPS  
**Permission:** `service_operations.execute`  
**Endpoint:** `POST /work-orders/{id}/checklist/{itemId}`

**Payload (per item):**
```json
{
  "isCompleted": true,
  "note": "Catering setup completed; all equipment present and working"
}
```

**Examples of checklist items (from template snapshot):**
- [ ] Kitchen setup complete
- [ ] Cooking schedule confirmed
- [ ] Serving setup ready
- [ ] Dietary restrictions honored
- [ ] Quality check passed

---

### Step 6: Mark Work Complete

**Actor:** EXEC_OPS  
**Permission:** `service_operations.execute`  
**Endpoint:** `POST /work-orders/{id}/complete`

**Payload:**
```json
{
  "notes": "All catering delivered on time. Customer satisfied."
}
```

**Triggers:**
- `completedAt`, `completedByUserId` recorded
- Workflow transitions: IN_PROGRESS → DONE (approval step)
- Verifier notified (via assignment rule)

---

### Step 7: Verify Work

**Actor:** VERIFY_OPS  
**Permission:** `service_operations.verify`  
**Endpoint:** `POST /work-orders/{id}/verify`

**Payload:**
```json
{
  "notes": "All checklist items complete; quality verified"
}
```

**Prerequisites:**
- Work order must be completed (`completedAt` not null)

**Triggers:**
- `verifiedAt`, `verifiedByUserId` recorded
- Ready for customer acceptance token generation

---

### Step 8: Issue Acceptance Token

**Actor:** VERIFY_OPS  
**Permission:** `service_operations.verify`  
**Endpoint:** `POST /work-orders/{id}/acceptance-token`

**Payload:**
```json
{
  "expiresInDays": 7
}
```

**Output:**
```json
{
  "token": "abc123def456...xyz (32-byte random hex, returns once only)",
  "expiresAt": "2026-10-22T15:30:45Z"
}
```

**Token Details:**
- Random 32-byte hex string (randomBytes(32).toString("hex"))
- SHA256 hash stored in DB; raw token returned only once
- Default expiry: 30 days (configurable via input)
- One live token per Work Order (prior token revoked atomically)
- Public URL: `https://api.example.com/public/work-orders/acceptance/{token}`

**Token Use:** Customer-facing link for remote sign-off (no authentication required)

---

### Step 9: Customer Accepts Work (or Rejects)

**Actor:** Customer (via public link, no login)  
**Permission:** None required  
**Endpoint:** `POST /public/work-orders/acceptance/{token}/accept`

**Payload:**
```json
{
  "comment": "Service delivered as promised. Excellent quality."
}
```

**Triggers:**
- Workflow transition: DONE → CLOSED (terminal state)
- `acceptedAt`, `acceptedByEmail` recorded
- SLA tracking finalized
- Finance notified to generate invoice

**Alternative (Rejection):**
```bash
POST /public/work-orders/acceptance/{token}/reject
{
  "reason": "Catering did not meet dietary requirements; customer requests refund"
}
```

---

### Step 10: Add Cost Items

**Actor:** COORD_OPS
**Permission:** `service_operations.manage`  
**Endpoint:** `POST /work-orders/{id}/cost-items`

**Prerequisites:**
- Work order must be customer-accepted first (DEC-009: acceptance → cost)
- Not yet finalized (finalized WO rejects further additions)

**Cost Item Example:**
```json
{
  "costType": "material",
  "description": "Catering supplies (ingredients, utensils, packaging)",
  "quantity": "100",
  "unitCost": "12.50"
}
```

**Notes:**
- `costType`: one of material, labor, overhead
- `quantity` & `unitCost`: stored as NUMERIC(14,4); regex validates `^\d{1,14}(\.\d{1,4})?$`
- All must be > 0

**Repeat:** Add all cost items before moving to finalization.

---

### Step 11: Finalize Costs

**Actor:** VERIFY_OPS  
**Permission:** `service_operations.verify`  
**Endpoint:** `POST /work-orders/{id}/finalize-costs`

**Payload:**
```json
{
  "legalEntityId": "uuid-of-Demo-Legal-Entity"
}
```

**Prerequisites:**
- Work order must be customer-accepted (DEC-009 sequence: acceptance → cost)
- At least one cost item must exist
- An open accounting period must exist for the legal entity (valid today)

**Triggers:**
- Locks cost snapshot in a single transaction (row lock + guarded UPDATE)
- Emits outbox event `work_order.cost_accumulated` (idempotency key `wo-cost:{workOrderId}`)
- GL posting rules frozen; no retroactive cost item additions

**Output:** `{workOrder, costsTotal, legalEntityId, periodId, outboxEventEmitted}`

---

### Step 12: Create Customer Invoice

**Actor:** BILL_OPS  
**Permission:** `service_operations.billing.manage`  
**Endpoint:** `POST /work-orders/{id}/create-invoice`

**Payload:**
```json
{
  "legalEntityId": "uuid-of-Demo-Legal-Entity",
  "markupRate": "0.15",
  "isTaxable": true,
  "taxRate": "0.11"
}
```

**Defaults (omit to use):**
- `markupRate` → tenant parameter `service_operations.invoice.default_markup` (0.15)
- `taxRate` → 0.11 (PPN) whenever `isTaxable=true`
- `isTaxable` is required

**Prerequisites:**
- Costs must already be finalized
- One invoice per Work Order (duplicate returns 409)
- Open accounting period for today

**Pricing Calculation:**
```
costBasis = 1250.00 (finalized cost)
markup    = 1250.00 × 0.15 = 187.50
subtotal  = 1250.00 + 187.50 = 1437.50
tax       = 1437.50 × 0.11 = 158.125
total     = 1437.50 + 158.125 = 1595.625
```

**Output:** `CustomerInvoice` with `invoiceNumber: INV-00001`

**Emits:** two outbox events — `work_order.invoiced` (revenue) and, when taxable, `work_order.invoice_tax` (tax leg has its own rule because a posting rule carries a single AMOUNT token).

---

### Step 13: Retrieve Invoice & GL Posting

**Actor:** BILL_OPS (or COORD_OPS with `customer.read`)  
**Permission:** `service_operations.read`  
**Endpoint:** `GET /work-orders/{id}/invoice`

**Response:** invoice record with `invoiceNumber`, `costBasis`, `markupRate`, `taxRate`, `taxAmount`, `totalAmount`, `status`.

**GL Posting (via Finance outbox consumer):**

| Event | Debit | Credit |
|-------|-------|--------|
| `work_order.cost_accumulated` | 6200 (Cost of Services) | 2500 (Accrued Costs) |
| `work_order.invoiced` | 1210 (Accounts Receivable) | 4100 (Service Revenue) |
| `work_order.invoice_tax` | 1210 (Accounts Receivable) | 2410 (Payable VAT/PPN) |

**Finalization:** once posted, the journal is immutable.

---

## API Endpoints Reference

### Authentication

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/auth/login` | POST | Log in with tenant code/email/password | None |
| `/auth/refresh` | POST | Refresh JWT token | None |
| `/auth/logout` | POST | Log out; invalidate refresh token | RefreshToken |
| `/auth/switch-role` | POST | Switch to a different role assignment | JWT (authenticated) |
| `/me` | GET | Retrieve current user + role assignments | JWT |

### Service Definitions

| Endpoint | Method | Permission | Purpose |
|----------|--------|------------|---------|
| `POST /service-definitions` | POST | `service_operations.configure` | Create service definition |
| `GET /service-definitions` | GET | `service_operations.read` | List all service definitions |
| `GET /service-definitions/:code` | GET | `service_operations.read` | Get one service definition |
| `POST /service-definitions/:code/checklist-items` | POST | `service_operations.configure` | Add checklist template item |
| `PATCH /service-definitions/:code/active` | PATCH | `service_operations.configure` | Activate/deactivate definition |

### Work Requests

| Endpoint | Method | Permission | Purpose |
|----------|--------|------------|---------|
| `POST /work-requests` | POST | `service_operations.manage` | Create work request (Step 1) |
| `GET /work-requests` | GET | `service_operations.read` | List requests |
| `GET /work-requests/:id` | GET | `service_operations.read` | Get request details |
| `POST /work-requests/:id/cancel` | POST | `service_operations.manage` | Cancel request (before conversion) |
| `POST /work-requests/:id/convert` | POST | `service_operations.manage`, `workflow.instance.start` | Convert to work order (Step 2) |

### Work Orders

| Endpoint | Method | Permission | Purpose |
|----------|--------|------------|---------|
| `POST /work-orders` | POST | `service_operations.manage` | Create work order directly |
| `GET /work-orders` | GET | `service_operations.read` | List all work orders |
| `GET /work-orders/my` | GET | `service_operations.execute` | List "my work" (assigned to me) |
| `GET /work-orders/:id` | GET | `service_operations.read` | Get work order details |
| `POST /work-orders/:id/assign` | POST | `service_operations.manage` | Assign executor (Step 3) |
| `POST /work-orders/:id/schedule` | POST | `service_operations.manage` | Update planned dates |
| `POST /work-orders/:id/start` | POST | `service_operations.execute`, `workflow.instance.act` | Start work (Step 4) |
| `POST /work-orders/:id/checklist/:itemId` | POST | `service_operations.execute` | Update checklist item (Step 5) |
| `POST /work-orders/:id/complete` | POST | `service_operations.execute` | Mark work complete (Step 6) |
| `POST /work-orders/:id/verify` | POST | `service_operations.verify` | Sign off work (Step 7) |
| `POST /work-orders/:id/actions/:actionCode` | POST | `workflow.instance.act` | Generic workflow action |

### Costs & Invoicing

| Endpoint | Method | Permission | Purpose |
|----------|--------|------------|---------|
| `POST /work-orders/:id/cost-items` | POST | `service_operations.manage` | Add cost line item (Step 10) |
| `GET /work-orders/:id/cost-items` | GET | `service_operations.read` | List cost items |
| `POST /work-orders/:id/finalize-costs` | POST | `service_operations.verify` | Snapshot costs; lock for GL (Step 11) |
| `POST /work-orders/:id/create-invoice` | POST | `service_operations.billing.manage` | Generate customer invoice (Step 12) |
| `GET /work-orders/:id/invoice` | GET | `service_operations.read` | Retrieve invoice details (Step 13) |

### Acceptance & Customer Interface

| Endpoint | Method | Permission | Purpose |
|----------|--------|------------|---------|
| `POST /work-orders/:id/acceptance-token` | POST | `service_operations.verify` | Issue public acceptance link (Step 8) |
| `POST /work-orders/:id/customer-accept` | POST | `service_operations.verify` | Accept internally (alt. to public) |
| `POST /work-orders/:id/customer-reject` | POST | `service_operations.verify` | Reject internally |
| `GET /public/work-orders/acceptance/:token` | GET | None | Retrieve acceptance link metadata |
| `POST /public/work-orders/acceptance/:token/accept` | POST | None | Customer accepts (Step 9a) |
| `POST /public/work-orders/acceptance/:token/reject` | POST | None | Customer rejects (Step 9b) |

---

## Business Rules & Guardrails

### Idempotency & Concurrency

1. **Work Request Creation** → NOT idempotent; every call consumes a new `requestNumber`. Submit once.
2. **Work Order Conversion** → Only an *open* Work Request converts; a second attempt fails with 409 Conflict (never creates a duplicate WO).
3. **Checklist Updates** → Last-write-wins per item; rejected with 409 once the WO is completed.
4. **Cost Finalization** → Once finalized, read-only; adding a cost item returns 409 Conflict.
5. **Invoice Creation** → Only once per Work Order; a duplicate attempt returns 409 Conflict ("An invoice already exists for this Work Order"). A DB unique constraint on (tenant, work order) backs concurrent races.
6. **Customer Acceptance** → Idempotent via guarded UPDATE; the outbox event uses key `wo-accept:{workOrderId}` so it posts once.

### Immutability After WO Creation

- **Service Definition Checklist** → Snapshot at conversion time; edits to template do NOT affect existing WOs.
- **Cost Items** → Append-only (no edit endpoint); can only be added after customer acceptance and before finalization; after finalization, frozen for GL posting.
- **Markup & Tax** → Set at invoice creation; cannot change after posting.

### Role Separation of Duties (SoD)

| Action | Min Roles Required | Reason |
|--------|------------------|--------|
| Create + Execute | At least 2 | COORD_OPS creates; EXEC_OPS executes |
| Execute + Verify | At least 2 | EXEC_OPS completes; VERIFY_OPS signs off |
| Verify + Bill | At least 2 | VERIFY_OPS finalizes costs; BILL_OPS invoices |
| Full lifecycle | At least 4 | Ideally COORD_OPS → EXEC_OPS → VERIFY_OPS → BILL_OPS |

### Customer Scope Authorization

- **Work Order Access** → Allowed when the actor is the assigned executor, has Data Scope over the WO's customer, or is associated with the WO's workflow instance; otherwise 403 ("Your Data Scope does not cover this Work Order").
- **Public Acceptance Link** → No authentication; SHA256 token validates link ownership.
- **Invoice Visibility** → Reading the invoice needs `service_operations.read` plus WO Data Scope; the customer only receives the acceptance link.

### Cost Precision

- **Quantity & Unit Cost** → Stored as NUMERIC(18, 4); both must be > 0. Line total is a generated column (quantity × unit cost).
- **Total Cost** → Aggregated with SQL SUM(); no floating-point round-trip (values travel as numeric strings).
- **Markup & Tax** → Rates are decimals between 0 and 1 with at most 6 decimals (default PPN 0.11). Base = round(cost × (1 + markup), 4); tax = round(base × taxRate, 4); total = base + tax (DB CHECK enforces the identity).

### Workflow Transitions

```
PLANNED —[start]→ IN_PROGRESS —[complete]→ DONE —[verify]→ CLOSED (antarmuka)

No cancel/reopen transition. Customer reject leaves the WO CLOSED; rework + a new token follow.
```

---

## Workflow State Transitions

### Detailed State Machine

```mermaid
graph TD
    A["PLANNED<br/>(WO created)"] -->|start<br/>EXEC_OPS| B["IN_PROGRESS<br/>(work started)"]
    B -->|complete<br/>EXEC_OPS| C["DONE<br/>(work finished,<br/>awaiting verify)"]
    C -->|verify<br/>VERIFY_OPS| D["CLOSED<br/>(terminal)"]
```

### Workflow Assignment Rules

| Step | Default Role | Reassignable | Capability |
|------|--------------|--------------|---------|
| PLANNED | COORD_OPS | Yes | `workflow.instance.start` + `workflow.instance.act` |
| IN_PROGRESS | EXEC_OPS | Yes | `service_operations.execute` + `workflow.instance.act` |
| DONE | VERIFY_OPS | Yes | `service_operations.verify` + `workflow.instance.act` |
| CLOSED | (Terminal) | No | No transitions possible |

### Recovery Scenarios

**Customer Rejects Work (Step 9):**
- `customerRejectWork` records rejection reason
- WO remains in CLOSED state; not terminal until customer accepts
- COORD_OPS can add new cost items OR rework checklist
- `issueAcceptanceToken` can be called again after remediation
- Customer receives new public link to accept reworked WO

**Acceptance Token Expired:**
- If token expires before customer accepts, a new one can be issued
- All prior tokens are atomically revoked (one live token per WO)
- No manual GL reversal needed — acceptance is the gate for cost processing

---

## Appendix: Demo Workflow (Complete Example)

### Timeline: Catering Service for Company Event

**2026-10-14, 10:00 AM** — `coord@demo.local` creates request:
```bash
POST /work-requests
{
  "customerId": "...",
  "siteId": "...",
  "serviceDefinitionCode": "catering_demo_service",
  "description": "Company all-hands meeting: 250 pax, 2 meals",
  "priority": "high"
}
# Response: requestNumber = WR-00001
```

**2026-10-14, 11:30 AM** — `coord@demo.local` converts → WO:
```bash
POST /work-requests/{wr-id}/convert
{
  "title": "Company Meeting Catering 2026-10-15",
  "plannedStartAt": "2026-10-15T07:00:00Z",
  "plannedEndAt": "2026-10-15T17:00:00Z",
  "dueAt": "2026-10-16T17:59:59Z"
}
# Response: workOrderNumber = WO-00001, state = PLANNED
```

**2026-10-14, 12:00 PM** — `coord@demo.local` assigns executor:
```bash
POST /work-orders/{wo-id}/assign
{
  "assigneeUserId": "exec-user-uuid"
}
```

**2026-10-15, 06:45 AM** — `exec@demo.local` starts work:
```bash
POST /work-orders/{wo-id}/start
# state = IN_PROGRESS, startedAt = 2026-10-15 06:45:00
```

**2026-10-15, 09:00 AM, 12:00 PM, 16:30 PM** — `exec@demo.local` updates checklist:
```bash
POST /work-orders/{wo-id}/checklist/{item-id}
{ "isCompleted": true, "note": "Catering delivered; customer confirmed" }
# Repeat for each of 5 checklist items
```

**2026-10-15, 17:15 PM** — `exec@demo.local` marks complete:
```bash
POST /work-orders/{wo-id}/complete
{
  "notes": "All meals served on schedule; zero complaints. Excellent event."
}
# state = DONE
```

**2026-10-15, 18:00 PM** — `verify@demo.local` verifies work:
```bash
POST /work-orders/{wo-id}/verify
{ "notes": "Checklist complete; ready for customer acceptance token" }
# state = DONE→CLOSED (with verification)
```

**2026-10-15, 18:15 PM** — `verify@demo.local` issues acceptance token:
```bash
POST /work-orders/{wo-id}/finalize-costs
{ "legalEntityId": "..." }
# Costs locked; total = 2075.00
```

**2026-10-15, 18:30 PM** — `verify@demo.local` issues acceptance token:
```bash
POST /work-orders/{wo-id}/acceptance-token
{ "expiresInDays": 7 }
# Response: token = "abc123...", expires 2026-10-22 18:30:00
# Public URL: https://api.example.com/public/work-orders/acceptance/abc123...
```

**2026-10-16, 09:00 AM** — Customer (no login) accepts:
```bash
POST /public/work-orders/acceptance/abc123.../accept
{ "comment": "Perfect! Service exceeded expectations." }
# acceptedAt = 2026-10-16 09:00:00
```

**2026-10-16, 09:30 AM** — `coord@demo.local` adds cost items:
```bash
POST /work-orders/{wo-id}/cost-items
[
  { "costType": "material", "description": "Ingredients", "quantity": "250", "unitCost": "8.00" },
  { "costType": "labor", "description": "Chef + kitchen staff (8 hrs)", "quantity": "3", "unitCost": "25.00" },
  { "costType": "overhead", "description": "Equipment rental", "quantity": "1", "unitCost": "150.00" }
]
# Total: (250×8) + (3×25) + 150 = 2075.00
```

**2026-10-16, 09:45 AM** — `verify@demo.local` finalizes costs:
```bash
POST /work-orders/{wo-id}/finalize-costs
{ "legalEntityId": "..." }
# Costs locked; total = 2075.00
```

**2026-10-16, 10:00 AM** — `bill@demo.local` creates invoice:
```bash
POST /work-orders/{wo-id}/create-invoice
{
  "legalEntityId": "...",
  "markupRate": "0.15",
  "isTaxable": true,
  "taxRate": "0.11"
}
# Calculation:
#   subtotal = 2075.00
#   markup   = 2075.00 × 0.15 = 311.25
#   base     = 2386.25
#   tax      = 2386.25 × 0.11 = 262.49 (rounded)
#   total    = 2648.74
# Response: invoiceNumber = INV-00001
```

**2026-10-16, 10:15 AM** — `bill@demo.local` retrieves & publishes:
```bash
GET /work-orders/{wo-id}/invoice
# Response: invoice details + GL posting status
# Finance team posts to GL (external module)
```

---

## Configuration & Deployment

### Environment Variables (Staging)

```bash
# seed.ts reads these
export PILOT_ADMIN_PASSWORD="YourStrongPassword!2026"
export PILOT_USER_PASSWORD="PilotUserPassword!2026"
export PLATFORM_BOOTSTRAP_KEY="bootstrap-secret-key-hex"
export DATABASE_URL="postgresql://user:pass@staging-db:5432/abixell_one_staging"

# API server
export API_PORT=4010
export API_BASE_URL="http://localhost:4010"
```

### Seed Script (runs once on migration)

```bash
cd apps/api
npm run migrate  # Create schema
npm run seed     # Populate demo data (demo-gs tenant)
```

### Verify Setup

```bash
# Tenant created
psql $DATABASE_URL -c "SELECT code, name FROM tenants LIMIT 1;"

# Users seeded
psql $DATABASE_URL -c "SELECT email, full_name FROM users WHERE email LIKE '%demo.local' LIMIT 10;"

# Roles defined
psql $DATABASE_URL -c "SELECT code, name FROM roles WHERE code IN ('COORD_OPS', 'EXEC_OPS', 'VERIFY_OPS', 'BILL_OPS');"

# Customer + site
psql $DATABASE_URL -c "SELECT code, name FROM customers WHERE code = 'CUST-CATER';"
```

---

**⚠️ Technical Note:**
- Work request numbering (`work_request` sequence) must be seeded in `numbering_sequences` before creating work requests. The system will raise `NotFoundError` if the sequence does not exist for the tenant. Ensure `seed.ts` includes `INSERT INTO numbering_sequences (tenant_id, code, pattern, current_sequence) VALUES (..., 'work_request', 'WR-{SEQ:5}', 0)` for each tenant.

## Summary Table: At a Glance

| Aspect | Value |
|--------|-------|
| **Tenant** | `demo-gs` / Demo Unified Tenant |
| **Customer** | `CUST-CATER` / Demo Catering Client |
| **Site** | `SITE-CATER` / Demo Catering Site |
| **Service** | `catering_demo_service` / Catering Demo Service |
| **Period** | `OCT-2026` / Oktober 2026 (2026-10-01 to 2026-10-31) |
| **Markup** | 15% (0.15) |
| **Tax (PPN)** | 11% (0.11) |
| **Work Order Prefix** | `WO-` (e.g., WO-00001) |
| **Invoice Prefix** | `INV-` (e.g., INV-00001) |
| **Roles** | COORD_OPS, EXEC_OPS, VERIFY_OPS, BILL_OPS |
| **Workflow** | PLANNED → IN_PROGRESS → DONE → CLOSED |
| **GL Integration** | Posting rules locked at cost finalization; GL journal posted on customer acceptance |

---

**Document Owner:** Engineering (WP-OPS)  
**Last Updated:** 2026-10-28  
**Next Review:** Upon WP-OPS-03 completion

---

**Indonesian Summary / Ringkasan Bahasa Indonesia:**

Panduan ini mendeskripsikan proses Work Order end-to-end untuk operasi catering. Mencakup 4 peran operasional (COORD_OPS, EXEC_OPS, VERIFY_OPS, BILL_OPS) dengan permission terpisah, 11 langkah dari intake hingga finance, akses publik untuk penerimaan pelanggan, dan kalkulasi harga dengan markup 15% + pajak PPN 11%. Semua demo credential disimpan di seed.ts dan tidak pernah dicetak ke stdout di staging/production.
