# ADR-0030: Marketplace and Ecosystem Packaging

- **Status:** APPROVED — Founder authorization 2026-11-06; runtime implementation authorized under Wave A8
- **Date:** 2026-10-26
- **Source:** Pre-Wave A8 planning decision; anchored on ADR-0014

## Context

Wave A8 commits 5 points to "marketplace and ecosystem". No requirement ID existed before this
planning cycle; the only prior references are legacy IGSEP history documents recorded as
SUPERSEDED in the traceability matrix.

The platform already has a packaging model: ADR-0014 fixed the Platform Kernel, static package
composition, and a governed metadata Builder. Packages are composed at build time from a fixed
catalogue; the Builder is governed and cannot author arbitrary behaviour. Any "marketplace"
that lets a third party inject runtime code would break that decision, the module-boundary
validator, and the permission discipline in one move.

So the question this ADR answers is narrow: what can be distributed, by whom, through what
gate, without weakening the kernel.

## Decision

### 1. The distributable unit is a package manifest, not code

An ecosystem item is a declarative manifest: module identity, required capability set, metadata
contributions (forms, menus, workflow templates, report definitions, dictionary entries),
configuration schema, and declared dependencies. It carries no executable server code, no
migration, no SQL, and no client bundle outside the governed extension points.

### 2. Composition stays static and validated

Manifests are composed into the tenant's package set at deploy time, exactly as ADR-0014
specifies. Composition is validated by the existing boundary validator plus a manifest
validator that rejects unknown keys, undeclared dependencies, capability grants beyond the
publishing tenant's own, and any contribution type outside the allowlist.

### 3. The Builder is the only authoring surface for metadata

A manifest contributes metadata through the same governed Builder paths an internal package
uses. There is no second authoring channel, no direct table write, and no "marketplace mode"
that relaxes validation.

### 4. Capability grants are explicit and bounded

A manifest declares the permissions it needs. Installation grants nothing implicitly: the
installing tenant reviews the declared set and the grant is recorded with the manifest version
and the granting actor. A manifest cannot request a permission that does not exist in the
catalogue, and cannot request configuration, permission-administration, or Builder
capabilities.

### 5. Marketplace items are versioned and pinned

Each installed manifest is pinned to an exact version with a content digest. Upgrade is an
explicit action that shows the manifest diff. A digest mismatch blocks installation. Uninstall
is reversible for metadata contributions and never deletes business records the tenant created
under the package.

### 6. Provenance and trust are recorded, not assumed

Each manifest records publisher identity, version, digest, and the signature or attestation
supplied by the publisher. Installation records which of these were verified. A manifest
without verification is installable only under an explicit tenant-level trust decision, and
that decision is audited.

### 7. Nothing in the ecosystem path can reach another tenant

Manifests are installed per tenant. A manifest contribution is tenant-scoped by the same
composite-key discipline as product data. No shared registry row, cache, or index may carry
tenant business data; the registry holds manifests, not tenant records.

## Rejected alternatives

- Letting marketplace items ship executable server code or their own migrations.
- A runtime plugin loader that evaluates third-party JavaScript.
- Implicit permission grants at install time.
- A second authoring channel parallel to the Builder.
- Unpinned "latest" installs or silent auto-upgrade.
- A shared multi-tenant manifest registry that also stores tenant configuration.
- Treating publisher identity as sufficient without a digest.

## Consequences

- The ecosystem surface is deliberately narrow; some vendor integrations cannot be packaged.
- Manifest validation becomes a real gate with its own test suite.
- Upgrade and uninstall flows need explicit UI and audit, not just an API.
- Trust decisions become a visible tenant responsibility rather than a platform assumption.
- The kernel, the boundary validator, and permission discipline are unchanged.

## Runtime authorization gate

This proposal does not authorize runtime implementation. Final Founder approval is required
for the manifest-only distributable unit, static composition through ADR-0014, Builder-only
metadata authoring, explicit bounded capability grants, version pinning with content digest,
recorded provenance, and per-tenant isolation of the registry. Runtime authorization must
include manifest-validator rejection tests, digest-mismatch tests, implicit-grant denial tests,
uninstall-reversibility tests, cross-tenant isolation tests, and a check that no manifest path
can introduce executable code or a migration.

## Related documents

- [ADR-0014: Platform Kernel, Static Package Composition, and Governed Metadata Builder](0014-platform-kernel-static-packages-and-governed-builder.md)
- [ADR-0028: Partner API Surface and Versioning](0028-partner-api-surface-and-versioning.md)
- [ADR-0029: AI Readiness Data Boundary](0029-ai-readiness-data-boundary.md)
- [Advanced Capabilities PRD](../prd/abixell-one/06-advanced-capabilities.md)
