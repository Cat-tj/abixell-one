# ADR-0028: Partner API Surface and Versioning

- **Status:** APPROVED — Founder authorization 2026-11-06; runtime implementation authorized under Wave A8
- **Date:** 2026-10-26
- **Source:** Pre-Wave A8 planning decision; implements `INT-012` and `PLT-ADV-001`

## Context

`INT-012` states the platform shall expose a documented, versioned API for partner/client
system integration, and is currently `DEFERRED (Advanced)`. The internal API already exists
(`/api/*`, session-cookie authenticated, permission-gated per route) but was never designed
as a public contract: it is unversioned, its permission model assumes an interactive actor,
and its responses carry internal shape that a partner cannot be told to depend on.

Wave A8 commits 3 points to "API economy / partner integration surface". That is not a new
gateway; it is a bounded, versioned, machine-authenticated slice of capability that already
exists. Deciding otherwise would duplicate the API surface and split the authorization model.

## Decision

### 1. Partner surface is a versioned path prefix over existing services

Partner routes live under an explicit version segment (`/api/partner/v1/...`). A version
bump is a new prefix, never a mutation of `v1`. Partner routes call the same application
services as the internal routes; they do not fork business logic.

### 2. Machine authentication is separate from session authentication

Partners authenticate with a dedicated credential class (tenant-scoped client credential,
hashed at rest, rotatable, revocable). Partner credentials cannot be used on internal routes,
and a partner token never resolves to an interactive actor. The existing permission catalogue
still governs what a credential may do; the credential carries an explicit permission set
that must be a subset of what the granting tenant holds.

### 3. Tenant isolation is structural, not conventional

Every partner route derives tenant from the credential, never from a request parameter.
Cross-tenant access is not expressible in the route contract. Tenant-scoped composite foreign
keys and hierarchical Organization Unit Data Scope apply exactly as on internal routes.

### 4. The partner contract is a documented, stable subset

Only routes explicitly registered in the partner surface are exposed. The set is enumerated
in one registry, is permission-checked at registration time, and is validated by a check that
fails when an internal route is reachable through the partner prefix without registration.
Partner responses are their own DTOs, not internal entity shapes, so internal refactors cannot
break the contract.

### 5. Rate limiting, audit, and deprecation are part of the surface

Partner calls are rate limited per credential, audited with credential identity rather than
user identity, and deprecation is announced through RFC-8594 headers, matching the existing
legacy-route convention in Wave A5.1.

### 6. No partner route mutates configuration or schema

Partner routes may read and transact within business capability. They cannot change tenant
configuration, permissions, module activation, workflow definitions, or schema. Builder and
manifest surfaces remain internal-only (ADR-0014).

## Rejected alternatives

- Exposing the internal API directly with a token instead of a session.
- A separate partner gateway service with duplicated business logic.
- Tenant selection via a request header or query parameter.
- Returning internal entity shapes as the partner contract.
- Allowing partner credentials to reach configuration or Builder surfaces.
- Silently changing a published partner contract in place.

## Consequences

- The partner surface is small and auditable by construction.
- Partner DTOs add a mapping layer that must be maintained as the contract grows.
- Credential lifecycle (issue, rotate, revoke) becomes a real operational surface.
- Internal refactors no longer threaten partner integrations.
- Version bumps are additive; no in-place breaking change is permitted.

## Runtime authorization gate

This proposal does not authorize runtime implementation. Final Founder approval is required
for the versioned prefix, the separate machine-credential class and its subset rule, the
structural tenant derivation, the registered-subset registry, the dedicated DTO layer, and
the rate-limit/audit/deprecation obligations. Runtime authorization must include
cross-tenant denial, credential-revocation, permission-subset, unregistered-route denial,
rate-limit, and contract-stability tests.

## Related documents

- [Integration PRD](../prd/abixell-one/11-integration.md)
- [ADR-0014: Platform Kernel, Static Package Composition, and Governed Metadata Builder](0014-platform-kernel-static-packages-and-governed-builder.md)
- [ADR-0009: Hierarchical Data Scope](0009-hierarchical-data-scope.md)
- [ADR-0029: AI Readiness Data Boundary](0029-ai-readiness-data-boundary.md)
