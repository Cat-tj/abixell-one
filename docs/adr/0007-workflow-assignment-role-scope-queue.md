# ADR-0007: Workflow Assignment Routes to a Role+Scope Queue, Not a Pre-Picked User

- **Status:** APPROVED for Checkpoint 0D
- **Date:** 2026-08-18
- **Source:** `04-Workflow-Approval-Engine-Foundation.md`

## Context

Doc 04 describes Assignment as "penentuan siapa/role apa yang menerima
tugas di suatu step, berdasar Data Scope" — routing can target either a
specific person or, more commonly in the illustrative examples ("Assign
ke: Site Supervisor"), a role within an organizational scope. When a
Workflow Instance reaches a Step, the engine has to decide who is allowed
to act on it.

Two designs were possible:
1. **Pre-pick one user** at assignment time (e.g. round-robin, least-busy,
   or "the first user found holding that role in that scope") and route
   the task to them specifically.
2. **Route to a Role+Organization Unit "queue"**: the task is assigned to
   `(role_code, organization_unit_id | null-for-tenant-wide)`, and ANY
   user who currently holds that role within that scope is authorized to
   act on it — same shape as a real approval inbox shared by a team.

## Decision

Checkpoint 0D implements design 2 for `assignment_type = 'role'`
Assignments. `workflow_instance_assignments` stores
`assigned_role_code` + `assigned_organization_unit_id` (nullable =
tenant-wide), not a specific `assigned_user_id`. Authorization to act
(`WorkflowService.actOnAssignment` / `RbacService.hasRoleCoveringScope`)
checks whether the acting user currently holds an assignment with that
Role and a Data Scope that covers the target — the exact same Role +
Data Scope model Checkpoint 0B already built for the rest of the
platform (ADR-0005's exact-match semantics apply here too: a
tenant-wide Role holder can act on a scoped task, but not vice versa).

A second `assignment_type = 'specific_user'` exists alongside this for
the cases doc 04 also describes (delegation, "assign back to the
submitter" for a Return/Revise step) where a named individual, not a
role, is the correct target — demonstrated by the demo workflow's REVISE
step, which is assigned to whoever started the Instance.

## Consequences

- No round-robin, load-balancing, or "claim this task" locking exists in
  Phase 0 — every eligible role holder can act on a pending role-scoped
  Assignment at any time; the first decision wins (the Assignment's
  `status` flips away from `pending`, so a second actor gets a
  `ConflictError`, not a silent double-decision). This is a deliberate,
  documented simplification, not an oversight — introducing a
  claim/lock mechanism before a real usage pattern demands one would be
  premature per anti-overengineering guidance.
- `GET /workflow/my-assignments` ("My Tasks") has to compute this
  role+scope match per pending Assignment rather than a simple `WHERE
  assigned_user_id = $1` — acceptable at Phase 0 scale (same trade-off
  philosophy as Configuration Scope resolution in ADR-0006 and 0C's
  decision log), revisit with caching/materialization only if a real
  tenant's inbox size makes it measurably slow.
- Nothing about the schema needs to change if load-balancing or explicit
  claiming is added later — it's new logic layered on top of the same
  `workflow_instance_assignments` shape, not a redesign.

## Amendment 2026-11-08 — Instance reads are filtered by the active Data Scope (site-scoping)

- **Status of this amendment:** PENDING FOUNDER CONFIRMATION. Implemented to
  unblock site-scoping of field-officer tasks; it applies existing mechanisms
  (ADR-0009 hierarchical walk, ADR-0011 customer scope, ADR-0012
  parent-follows-entity) and does not change Data Scope semantics. Revert by
  removing the visibility filter in `WorkflowService` if not confirmed.

**What changed.** `GET /workflow/instances`, `GET /workflow/instances/:id` and
`GET /workflow/instances/:id/history` were Tenant-wide for any holder of
`workflow.instance.read`. For an actor whose ACTIVE assignment is narrower than
the Tenant (Organization Unit / Legal Entity / Customer scope) an Instance is now
visible only when one of these holds; otherwise the single reads answer 404 and
the list omits it. Tenant-scoped actors are unchanged.

1. **Owning unit** - `contextData.organizationUnitId` (set by the business
   module from the parent entity's owning unit, ADR-0012) is covered by the
   active scope (ADR-0009: scope unit and every descendant).
2. **Legal Entity stamp** - `contextData.legalEntityId` equals the active,
   usable Legal Entity scope. Used by entities that belong to a Legal Entity but
   to no Organization Unit (tax rule versions; budget versions).
3. **Customer stamp** - `contextData.customerId` equals the active customer
   scope (ADR-0011), so a customer-scoped reader who holds
   `workflow.instance.read` can read the Instance of a Work Order/Complaint of
   their own Customer.
4. **Exceptions (always visible):** the actor started the Instance, or is a named
   or Role+Scope-eligible assignee on it (any assignment status), evaluated
   against the ACTIVE assignment only (same rule as `assertEligible`).

**Unstamped Instances.** Tenant-level entities have no owning unit and no Legal
Entity (consolidation groups, FSV versions, eliminations) and the Supply Chain
supplier evaluations and supplier contracts (guarded by tenant-level scope). They
stay visible to tenant-scoped actors, their starter and eligible assignees only.
A job posting without an organization unit, a tenant-level warehouse, and a
vendor invoice received into one are likewise unstamped (`organizationUnitId`
null) and behave the same way. HSE records/permits, leave/overtime/performance
requests (employee's unit), job postings, stock transfers (source warehouse),
opnames, disposals (warehouse or explicit unit), vendor invoices (receiving
warehouse) and payment batches (batch unit) are stamped from their parent.

**Start-time validation.** `contextData` is caller-supplied on
`POST /workflow/instances` and now drives visibility, so for a non-tenant actor
that route (`WorkflowService.startInstanceFromRequest`) rejects (403) an
`organizationUnitId` not covered by the active scope, a `legalEntityId` other
than the actor's own Legal Entity scope and a `customerId` other than the actor's
own customer scope; a non-string `organizationUnitId` is a 400. Internal business
modules call `startInstance` directly as trusted callers deriving the stamps from
the entity and are not subject to it.

**Work Orders and My Tasks.** The Work Order list and `/my/dashboard` use the
same predicate as detail (assigned executor, OR Customer Data Scope, OR
workflow-associated), and `listMyAssignments` matches Role+Scope against the
active assignment. All are computed from one read of the tenant's units and one
association query per request (no per-row queries). Read sub-resources of an
out-of-scope Work Order answer 404 like detail; mutations keep 403.
