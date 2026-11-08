# ADR-0029: AI Readiness Data Boundary

- **Status:** APPROVED — Founder authorization 2026-11-06; runtime implementation authorized under Wave A8
- **Date:** 2026-10-26
- **Source:** Pre-Wave A8 planning decision; scopes `PLT-ADV-002`

## Context

Wave A8 commits 5 points to "AI readiness for sentiment, summarization, and assistive
automation". No requirement ID existed before this planning cycle; the only prior references
are legacy IGSEP history documents that the traceability matrix records as SUPERSEDED.

The platform already holds multi-tenant operational data: complaints, surveys, HSE incidents,
workforce records, finance postings. Any AI capability placed on top of that data creates a
data-boundary question that is strictly harder than the feature question. A summarization
feature that silently sends tenant data to an external model, or that trains on tenant data,
is a breach of the tenant isolation contract that every other module enforces structurally.

This ADR fixes the boundary. It does not choose a vendor, a model, or a provider.

## Decision

### 1. AI capability is assistive, never authoritative

Every AI output is a proposal shown to a human. No AI output posts a journal, closes an
incident, approves a request, changes a permission, or mutates a record. Acceptance is an
explicit human action routed through the same permission-checked service method a manual
operator would use. This matches the existing rule for feedback-driven domain mutation
(`SQ-ADV-004`), where `requires_approval` is pinned true by a database CHECK.

### 2. No cross-tenant data, in any direction

Inference input is scoped to one tenant. No request may carry data from two tenants. No
model output may be shared between tenants. No embedding index, cache, or vector store may
mix tenants. This is enforced at the boundary, not by prompt instruction.

### 3. No training or fine-tuning on tenant data

Tenant data is never used to train, fine-tune, or otherwise durably adapt a model. Provider
terms that permit training on submitted content disqualify the provider. This is a hard
constraint, not a preference.

### 4. Data minimization and redaction before egress

Only the fields required for the specific capability leave the platform. Personal data,
credentials, and free-text audit metadata are redacted before egress. The redaction set is
defined per capability and tested, not left to the caller.

### 5. Every AI call is auditable and reversible in effect

Each invocation records tenant, capability, requesting actor, input field set, provider,
model identifier, and outcome. Outputs are stored with provenance so a later human decision
can be traced to the proposal that informed it. Deleting an AI-derived proposal leaves the
underlying business record unchanged.

### 6. Capability is opt-in per tenant and fails closed

AI capability is off by default. A tenant enables it explicitly. If the provider is
unavailable, the capability degrades to its absence — it never falls back to a different
provider, a different data boundary, or a heuristic that was not reviewed.

### 7. Provider substitution does not change the contract

The boundary rules above are provider-independent. Swapping a provider is an operational
change that must not alter what data may leave the platform.

## Rejected alternatives

- Sending full records to a provider and relying on provider-side policy for isolation.
- A shared embedding index across tenants for "better recommendations".
- Letting AI output write directly to business tables with a review flag set afterwards.
- Enabling AI by default with an opt-out.
- Treating prompt instructions as a data-boundary control.
- Training a platform model on accumulated tenant data.

## Consequences

- AI features are slower to ship because each capability needs a defined redaction set.
- Some desirable capabilities are excluded (cross-tenant benchmarking, pooled models).
- Provider selection becomes a procurement decision constrained by section 3.
- Audit volume grows; retention for AI provenance must be decided.
- A tenant without AI enabled sees no behavioural change anywhere.

## Runtime authorization gate

This proposal does not authorize runtime implementation, and it selects no vendor, model, or
provider. Final Founder approval is required for the assistive-only rule, the no-cross-tenant
boundary, the no-training constraint, the per-capability redaction obligation, the audit
record shape, and the opt-in fail-closed default. Runtime authorization must include
cross-tenant leakage tests, redaction coverage tests, provider-failure degradation tests,
provenance-traceability tests, and a check that no AI path can reach a posting, approval, or
permission mutation.

## Related documents

- [Advanced Capabilities PRD](../prd/abixell-one/06-advanced-capabilities.md)
- [ADR-0014: Platform Kernel, Static Package Composition, and Governed Metadata Builder](0014-platform-kernel-static-packages-and-governed-builder.md)
- [ADR-0028: Partner API Surface and Versioning](0028-partner-api-surface-and-versioning.md)
- [ADR-0030: Marketplace and Ecosystem Packaging](0030-marketplace-and-ecosystem-packaging.md)
