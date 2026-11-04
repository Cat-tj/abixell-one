import type {
  Complaint,
  ComplaintRepository,
  UpdateInvestigationInput,
} from "../../domain/complaint/complaint.entity.js";
import type { AuditService } from "../audit/audit.service.js";
import type { RbacService } from "../rbac/rbac.service.js";
import type { CustomerService } from "../customer/customer.service.js";
import type { WorkflowService } from "../workflow/workflow.service.js";
import type { ConfigurationService } from "../configuration/configuration.service.js";
import type { EventBus } from "../event/event-bus.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../domain/shared-kernel/errors.js";

/** Product Core integration point: the Workflow Definition code every
 * Complaint's lifecycle runs against. The DEFINITION's actual Steps/
 * Transitions/SLA/Assignment Rules are 100% Tenant-configurable through
 * the existing Workflow Engine admin API (`/workflow/definitions/...`)
 * — this constant only fixes WHICH configurable graph a Complaint uses,
 * the same kind of fixed integration point `entityType='complaint'`
 * already is. Not a hardcoded lifecycle — see decision-log.md. */
export const COMPLAINT_WORKFLOW_DEFINITION_CODE = "complaint_lifecycle";
export const COMPLAINT_NUMBERING_CODE = "complaint_number";

/** Product Core integration points: WHICH Tenant-configured reference-data
 * catalogs drive Complaint creation. Like COMPLAINT_WORKFLOW_DEFINITION_CODE,
 * these fix the catalog identity only — the actual option VALUES are 100%
 * Tenant Configuration (never hardcoded business choices). Priority reuses
 * the generic `priority_level` catalog, distinct from `complaint_severity`
 * (Severity ≠ Priority — see seed.ts / decision-log.md). */
export const COMPLAINT_CATEGORY_REF_TYPE = "complaint_category";
export const COMPLAINT_SEVERITY_REF_TYPE = "complaint_severity";
export const COMPLAINT_PRIORITY_REF_TYPE = "priority_level";

/** actionCode -> business-readable Domain Event type (Event Catalog,
 * doc section 33). A Tenant is free to configure Transitions with ANY
 * actionCode; one outside this map still works end-to-end, it just
 * publishes the generic `complaint.status_changed` event instead of a
 * named one — never a hard failure. */
const ACTION_EVENT_MAP: Record<string, string> = {
  submit: "complaint.submitted",
  acknowledge: "complaint.acknowledged",
  assign: "complaint.assigned",
  start_investigation: "complaint.investigation_started",
  submit_corrective_action: "complaint.corrective_action_submitted",
  submit_for_verification: "complaint.verification_requested",
  verify: "complaint.verified",
  confirm: "complaint.customer_confirmed",
  close: "complaint.closed",
  reject: "complaint.rejected",
  cancel: "complaint.cancelled",
};

export interface CreateComplaintInput {
  customerId: string;
  customerContactId?: string | null;
  contractId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  serviceId?: string | null;
  category: string;
  subcategory?: string | null;
  description: string;
  priority: string;
  severity: string;
  source?: string | null;
  channel?: string | null;
}

/** Checkpoint 1C.2 — Tenant-configured option catalogs for the create form. */
export interface ComplaintCreateOptions {
  categories: { code: string; label: string }[];
  severities: { code: string; label: string }[];
  priorities: { code: string; label: string }[];
}

/** Checkpoint 1C.2 — status + SLA for one Complaint list row. */
export interface ComplaintSummaryItem {
  complaint: Complaint;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  sla: { dueAt: Date | null; slaHours: number | null } | null;
}

/**
 * Checkpoint 1C.2 — customer-safe composite detail. Deliberately projects
 * only what a Complaint owner may see: the lifecycle progression, SLA
 * state, the actions THIS actor can take, and reopen eligibility. Internal
 * workflow comments and actor identities are stripped from the timeline
 * (guard 9) — a richer, role-aware operational view is future work (1C.3).
 */
export interface ComplaintDetailView {
  complaint: Complaint;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  sla: { dueAt: Date | null; slaHours: number | null } | null;
  timeline: { occurredAt: Date; actionCode: string; stepCode: string | null; stepName: string | null }[];
  availableActions: { actionCode: string; name: string }[];
  reopen: { canReopen: boolean; targetSteps: { code: string; name: string }[] };
}

/** Checkpoint 1C.3 — operational queue row (complaint as a business object,
 * not a raw Workflow Assignment). */
export interface OperationalQueueItem {
  complaint: Complaint;
  customerName: string | null;
  siteName: string | null;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  sla: { dueAt: Date | null; slaHours: number | null } | null;
  assignment: { roleCode: string | null; userId: string | null; isMine: boolean } | null;
  overdue: boolean;
}

export interface OperationalQueueFilters {
  assignedToMe?: boolean;
  severity?: string;
  stepCode?: string;
  overdue?: boolean;
  customerId?: string;
}

export interface OperationalQueueResult {
  items: OperationalQueueItem[];
  total: number;
}

/** Wave 1 dynamic dashboard — complaint drill-down row (flat, dashboard-shaped). */
export interface ComplaintDashboardListItem {
  id: string;
  complaintNumber: string;
  customerName: string | null;
  category: string;
  severity: string;
  status: string; // workflow instance status (in_progress / terminal)
  createdAt: string;
}

export interface ComplaintDashboardListFilters {
  status?: string;
  severity?: string;
  category?: string;
  customerId?: string;
  limit?: number;
  offset?: number;
}

export interface ComplaintDashboardListResult {
  items: ComplaintDashboardListItem[];
  total: number;
}

/** Checkpoint 1C.3 — operational (internal) detail. Unlike the customer-safe
 * ComplaintDetailView, the timeline here is role-appropriate: it retains
 * actor and workflow comments (section 11). Access is restricted to internal
 * actors — see `requireInternalActor`. */
export interface OperationalComplaintDetail {
  complaint: Complaint;
  customerName: string | null;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  sla: { dueAt: Date | null; slaHours: number | null } | null;
  assignment: { roleCode: string | null; userId: string | null; isMine: boolean } | null;
  timeline: {
    occurredAt: Date;
    actionCode: string;
    fromStepName: string | null;
    toStepName: string | null;
    actorUserId: string | null;
    comment: string | null;
  }[];
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
  reopen: { canReopen: boolean; targetSteps: { code: string; name: string }[] };
}

/**
 * Generic Customer Complaint Engine (Checkpoint 1B). Deliberately thin —
 * every lifecycle/assignment/SLA concern is delegated to the generic
 * Workflow Engine (0D/0E); this class's job is Complaint-specific
 * authorization (Customer Data Scope, ADR-0011) and Complaint-specific
 * data (category/priority/severity/investigation/evidence context),
 * never re-implementing state machine logic.
 */
export class ComplaintService {
  constructor(
    private readonly repo: ComplaintRepository,
    private readonly customers: CustomerService,
    private readonly workflow: WorkflowService,
    private readonly configuration: ConfigurationService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly eventBus: EventBus,
    /** Site names for the operational queue display (owner request).
     * Optional so existing tests that construct the service directly keep
     * compiling. */
    private readonly sites?: { listForTenant(actor: ActorContext): Promise<Array<{ id: string; name: string }>> },
  ) {}

  async create(actor: ActorContext, input: CreateComplaintInput): Promise<Complaint> {
    await this.rbac.requirePermission(actor, "complaint.manage");
    // Customer/Data Scope Validation — the E2E target's second step.
    // Works identically whether `actor` is a Customer User (scope_type
    // 'customer', exact match, ADR-0011) or an internal user filing on a
    // Customer's behalf (organization_unit scope, hierarchical, ADR-0009).
    const customer = await this.customers.getAuthorized(actor, input.customerId);

    const { number } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      COMPLAINT_NUMBERING_CODE,
      actor.userId,
    );

    const complaint = await this.repo.create(
      { ...input, tenantId: actor.tenantId, complaintNumber: number, submittedByUserId: actor.userId },
      actor.userId,
    );

    // Starts the Workflow Instance at its configured initial Step
    // (Draft, in the demo Workflow Definition — Tenant-configurable,
    // never hardcoded here). `organizationUnitId` in contextData is what
    // lets a `submitter_unit` Assignment/Escalation Rule route to the
    // Customer's own internal owning team (ADR-0011's convergence point)
    // without Complaint Service knowing anything about routing itself.
    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: COMPLAINT_WORKFLOW_DEFINITION_CODE,
      entityId: complaint.id,
      contextData: {
        customerId: customer.id,
        organizationUnitId: customer.ownerOrganizationUnitId,
        category: input.category,
        subcategory: input.subcategory ?? null,
        priority: input.priority,
        severity: input.severity,
      },
    });
    await this.repo.setWorkflowInstance(complaint.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "complaint.created",
      entityType: "complaint",
      entityId: complaint.id,
      metadata: { complaintNumber: number, customerId: customer.id, category: input.category, priority: input.priority, severity: input.severity },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "complaint.created",
      entityType: "complaint",
      entityId: complaint.id,
      payload: { complaintNumber: number, customerId: customer.id, targetUserId: actor.userId },
      createdBy: actor.userId,
    });

    return { ...complaint, workflowInstanceId: instance.id };
  }

  async get(actor: ActorContext, id: string): Promise<{
    complaint: Complaint;
    status: { stepCode: string | null; instanceStatus: string } | null;
  }> {
    await this.rbac.requirePermission(actor, "complaint.read");
    const complaint = await this.getAuthorized(actor, id);
    if (!complaint.workflowInstanceId) {
      return { complaint, status: null };
    }
    const { instance, currentStep } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      complaint.workflowInstanceId,
    );
    return { complaint, status: { stepCode: currentStep?.code ?? null, instanceStatus: instance.status } };
  }

  async listByCustomer(actor: ActorContext, customerId: string): Promise<Complaint[]> {
    await this.rbac.requirePermission(actor, "complaint.read");
    await this.customers.getAuthorized(actor, customerId);
    return this.repo.listByCustomer(customerId);
  }

  /**
   * Checkpoint 1C.2 — Tenant-configured option catalogs the create form
   * needs (category / severity / priority). Gated on `complaint.manage`
   * (the permission required to actually create), reading the same
   * Configuration reference data an Administrator manages — so a Customer
   * User can populate the form without the broad `config.read` permission.
   * Only active items are returned.
   */
  async getCreateOptions(actor: ActorContext): Promise<ComplaintCreateOptions> {
    await this.rbac.requirePermission(actor, "complaint.manage");
    const [categories, severities, priorities] = await Promise.all([
      this.configuration.listReferenceDataItemsForTrustedCaller(actor.tenantId, COMPLAINT_CATEGORY_REF_TYPE),
      this.configuration.listReferenceDataItemsForTrustedCaller(actor.tenantId, COMPLAINT_SEVERITY_REF_TYPE),
      this.configuration.listReferenceDataItemsForTrustedCaller(actor.tenantId, COMPLAINT_PRIORITY_REF_TYPE),
    ]);
    const active = (items: { code: string; label: string; isActive: boolean }[]) =>
      items.filter((i) => i.isActive).map((i) => ({ code: i.code, label: i.label }));
    return {
      categories: active(categories),
      severities: active(severities),
      priorities: active(priorities),
    };
  }

  /**
   * Checkpoint 1C.2 — list a Customer's Complaints enriched with each one's
   * live Workflow status + SLA, for the customer list experience. Same
   * authorization as `listByCustomer` (permission + Customer Data Scope);
   * status is composed per row via the trusted-caller Workflow projection.
   */
  async listByCustomerSummary(actor: ActorContext, customerId: string): Promise<ComplaintSummaryItem[]> {
    await this.rbac.requirePermission(actor, "complaint.read");
    await this.customers.getAuthorized(actor, customerId);
    const complaints = await this.repo.listByCustomer(customerId);
    const items: ComplaintSummaryItem[] = [];
    for (const complaint of complaints) {
      if (!complaint.workflowInstanceId) {
        items.push({ complaint, status: null, sla: null });
        continue;
      }
      const status = await this.workflow.getEntityStatus(actor, complaint.workflowInstanceId);
      items.push({
        complaint,
        status: {
          stepCode: status.stepCode,
          stepName: status.stepName,
          instanceStatus: status.instanceStatus,
        },
        sla: status.sla,
      });
    }
    return items;
  }

  /**
   * Checkpoint 1C.2 — customer-safe composite detail (see ComplaintDetailView).
   * Authorization is the existing `getAuthorized` visibility gate; the
   * Workflow projection is trusted-caller (this method already authorized
   * the Complaint). `canReopen` reflects the real reopen rule
   * (`complaint.manage` + a completed Instance), so the UI never hardcodes
   * lifecycle state to decide it.
   */
  async getDetail(actor: ActorContext, id: string): Promise<ComplaintDetailView> {
    await this.rbac.requirePermission(actor, "complaint.read");
    const complaint = await this.getAuthorized(actor, id);
    if (!complaint.workflowInstanceId) {
      return {
        complaint,
        status: null,
        sla: null,
        timeline: [],
        availableActions: [],
        reopen: { canReopen: false, targetSteps: [] },
      };
    }

    const view = await this.workflow.getEntityWorkflowView(actor, complaint.workflowInstanceId);
    const permissions = await this.rbac.getActivePermissions(actor);
    const canReopen = permissions.has("complaint.manage") && view.instanceStatus !== "in_progress";

    return {
      complaint,
      status: {
        stepCode: view.currentStep?.code ?? null,
        stepName: view.currentStep?.name ?? null,
        instanceStatus: view.instanceStatus,
      },
      sla: view.sla,
      // Customer-safe timeline: lifecycle progression only — never internal
      // actor identities or internal workflow comments (guard 9).
      timeline: view.timeline.map((t) => ({
        occurredAt: t.occurredAt,
        actionCode: t.actionCode,
        stepCode: t.toStepCode,
        stepName: t.toStepName,
      })),
      availableActions: view.availableActions.map((a) => ({ actionCode: a.actionCode, name: a.name })),
      reopen: { canReopen, targetSteps: canReopen ? view.nonTerminalSteps : [] },
    };
  }

  /**
   * Checkpoint 1C.3 — restricts an operation to INTERNAL actors (those with
   * an organization_unit or tenant Data Scope). A Customer User (customer
   * scope only) is denied even for their own complaints — they use the
   * customer-safe experience instead. This is what keeps internal
   * operational data (full timeline, assignments) from leaking to customers
   * through the operational endpoints, independent of the frontend.
   */
  /**
   * Wave 1 dynamic dashboard — complaint drill-down list. Gated on
   * `complaint.dashboard.read` (same permission as the Management Dashboard)
   * and Data-Scope-aware. `status` maps to the Workflow instance status:
   * "open" = `in_progress`, "closed" = any terminal state.
   */
  async listForDashboard(
    actor: ActorContext,
    filters: ComplaintDashboardListFilters,
  ): Promise<ComplaintDashboardListResult> {
    await this.rbac.requirePermission(actor, "complaint.dashboard.read");

    const customers = await this.customers.listForTenant(actor);
    const nameById = new Map(customers.map((c) => [c.id, c.name]));
    const sites = await this.sites?.listForTenant(actor) ?? [];
    const siteNameById = new Map(sites.map((site) => [site.id, site.name]));

    const scopedCustomerIds = filters.customerId
      ? customers.filter((customer) => customer.id === filters.customerId).map((customer) => customer.id)
      : customers.map((customer) => customer.id);
    const complaints = await this.repo.listByCustomers(scopedCustomerIds);

    const statusRows = await this.workflow.getEntityStatuses(
      actor,
      complaints
        .map((complaint) => complaint.workflowInstanceId)
        .filter((id): id is string => id !== null),
    );
    const statusByInstanceId = new Map(statusRows.map((status) => [status.instanceId, status]));

    let items: ComplaintDashboardListItem[] = complaints.map((complaint) => {
      const s = complaint.workflowInstanceId ? statusByInstanceId.get(complaint.workflowInstanceId) : null;
      return {
        id: complaint.id,
        complaintNumber: complaint.complaintNumber,
        customerName: nameById.get(complaint.customerId) ?? null,
        category: complaint.category,
        severity: complaint.severity,
        status: s?.instanceStatus ?? "unknown",
        createdAt: complaint.createdAt.toISOString(),
      };
    });

    if (filters.status === "open") items = items.filter((i) => i.status === "in_progress");
    if (filters.status === "closed") items = items.filter((i) => i.status !== "in_progress");
    if (filters.severity) items = items.filter((i) => i.severity === filters.severity);
    if (filters.category) items = items.filter((i) => i.category === filters.category);

    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = items.length;
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    return { items: items.slice(offset, offset + limit), total };
  }

  private async requireInternalActor(actor: ActorContext): Promise<void> {
    const assignments = await this.rbac.getAssignments(actor.userId);
    const internal = assignments.some((a) => a.scopeType !== "customer");
    if (!internal) {
      throw new ForbiddenError("This area is available to internal operational users only");
    }
  }

  /**
   * Checkpoint 1C.3 — operational queue: complaints within the actor's
   * Customer Data Scope (ADR-0011, reusing `CustomerService.listForTenant`),
   * enriched with live Workflow status/SLA/assignment. `assignment.isMine`
   * marks the ones the actor is currently eligible to act on. Read-only,
   * composed live from existing records (FD-1C-01) — no queue store.
   * Filters and simple limit/offset pagination are applied after
   * enrichment; the candidate set is already bounded by the actor's scope.
   */
  async listOperationalQueue(
    actor: ActorContext,
    filters: OperationalQueueFilters,
    pagination: { limit?: number; offset?: number },
  ): Promise<OperationalQueueResult> {
    await this.rbac.requirePermission(actor, "complaint.read");
    await this.requireInternalActor(actor);

    const customers = await this.customers.listForTenant(actor);
    const sites = await this.sites?.listForTenant(actor) ?? [];
    const siteNameById = new Map(sites.map((site) => [site.id, site.name]));
    const nameById = new Map(customers.map((c) => [c.id, c.name]));

    const scopedCustomerIds = filters.customerId
      ? customers.filter((customer) => customer.id === filters.customerId).map((customer) => customer.id)
      : customers.map((customer) => customer.id);
    const complaints = await this.repo.listByCustomers(scopedCustomerIds);

    const statusRows = await this.workflow.getEntityStatuses(
      actor,
      complaints
        .map((complaint) => complaint.workflowInstanceId)
        .filter((id): id is string => id !== null),
    );
    const statusByInstanceId = new Map(statusRows.map((status) => [status.instanceId, status]));

    const now = Date.now();
    let items: OperationalQueueItem[] = [];
    for (const complaint of complaints) {
      const s = complaint.workflowInstanceId ? statusByInstanceId.get(complaint.workflowInstanceId) : null;
      const status = s
        ? { stepCode: s.stepCode, stepName: s.stepName, instanceStatus: s.instanceStatus }
        : null;
      const sla = s?.sla ?? null;
      const assignment = s?.assignment ?? null;
      const overdue = !!(
        sla?.dueAt &&
        status?.instanceStatus === "in_progress" &&
        sla.dueAt.getTime() < now
      );
      items.push({
        complaint,
        customerName: nameById.get(complaint.customerId) ?? null,
        siteName: complaint.siteId ? siteNameById.get(complaint.siteId) ?? null : null,
        status,
        sla,
        assignment,
        overdue,
      });
    }

    if (filters.severity) items = items.filter((i) => i.complaint.severity === filters.severity);
    if (filters.stepCode) items = items.filter((i) => i.status?.stepCode === filters.stepCode);
    if (filters.assignedToMe) items = items.filter((i) => i.assignment?.isMine);
    if (filters.overdue) items = items.filter((i) => i.overdue);

    // Overdue first, then newest — the operationally useful ordering.
    items.sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        new Date(b.complaint.createdAt).getTime() - new Date(a.complaint.createdAt).getTime(),
    );

    const total = items.length;
    const limit = pagination.limit ?? 50;
    const offset = pagination.offset ?? 0;
    return { items: items.slice(offset, offset + limit), total };
  }

  /**
   * Checkpoint 1C.3 — operational (internal) complaint detail. Restricted to
   * internal actors; the timeline is role-appropriate (retains actor +
   * workflow comments). Reuses the existing composite Workflow view.
   */
  async getOperationalDetail(actor: ActorContext, id: string): Promise<OperationalComplaintDetail> {
    await this.rbac.requirePermission(actor, "complaint.read");
    await this.requireInternalActor(actor);
    const complaint = await this.getAuthorized(actor, id);

    // Customer name is cosmetic — never let its absence (an actor authorized
    // for the complaint via workflow association but not Customer Data Scope)
    // fail the whole read.
    let customerName: string | null = null;
    try {
      customerName = (await this.customers.getAuthorized(actor, complaint.customerId)).name;
    } catch {
      customerName = null;
    }

    if (!complaint.workflowInstanceId) {
      return {
        complaint,
        customerName,
        status: null,
        sla: null,
        assignment: null,
        timeline: [],
        availableActions: [],
        reopen: { canReopen: false, targetSteps: [] },
      };
    }

    const view = await this.workflow.getEntityWorkflowView(actor, complaint.workflowInstanceId);
    const s = await this.workflow.getEntityStatus(actor, complaint.workflowInstanceId);
    const permissions = await this.rbac.getActivePermissions(actor);
    const canReopen = permissions.has("complaint.manage") && view.instanceStatus !== "in_progress";

    return {
      complaint,
      customerName,
      status: {
        stepCode: view.currentStep?.code ?? null,
        stepName: view.currentStep?.name ?? null,
        instanceStatus: view.instanceStatus,
      },
      sla: view.sla,
      assignment: s.assignment,
      timeline: view.timeline.map((t) => ({
        occurredAt: t.occurredAt,
        actionCode: t.actionCode,
        fromStepName: t.fromStepName,
        toStepName: t.toStepName,
        actorUserId: t.actorUserId,
        comment: t.comment,
      })),
      availableActions: view.availableActions,
      reopen: { canReopen, targetSteps: canReopen ? view.nonTerminalSteps : [] },
    };
  }

  /** Submit is just the first Transition (Draft -> Submitted) — no
   * special-cased code path, goes through the exact same generic
   * `act()` machinery as every other action. Kept as a named method only
   * because the Phase 1 instruction calls it out as its own E2E step. */
  async submit(actor: ActorContext, id: string, comment: string | null) {
    return this.act(actor, id, "submit", comment);
  }

  /**
   * Generic action dispatch — wraps `WorkflowService.actOnAssignment`.
   * Complaint Service does NOT know the Step graph; it finds whatever
   * pending Assignment currently exists on the Complaint's Workflow
   * Instance and forwards `actionCode` verbatim. An invalid
   * transition (wrong actionCode for the current Step, or a Condition
   * that doesn't match) is rejected by the Workflow Engine itself
   * (`ValidationError`), not by anything here — this is the literal
   * meaning of "Workflow tidak boleh hardcoded di Complaint Service".
   */
  async act(actor: ActorContext, id: string, actionCode: string, comment: string | null) {
    await this.rbac.requirePermission(actor, "complaint.manage");
    const complaint = await this.getAuthorized(actor, id);
    if (!complaint.workflowInstanceId) {
      throw new ConflictError("This Complaint has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      complaint.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) {
      throw new ConflictError("No pending action currently exists on this Complaint");
    }

    // `actOnAssignment` re-validates eligibility itself (role+scope or
    // specific_user match) — the `getAuthorized` call above is Complaint
    // VISIBILITY (Customer Data Scope OR workflow association), a
    // strictly broader net than "can act right now", by design (see
    // `getAuthorized` doc comment).
    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    if (actionCode === "submit") {
      await this.repo.markSubmitted(id, new Date());
    }
    if (result.instance.status !== "in_progress") {
      await this.repo.markClosed(id, new Date());
    }

    const eventType = ACTION_EVENT_MAP[actionCode] ?? "complaint.status_changed";
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: eventType,
      entityType: "complaint",
      entityId: id,
      metadata: { actionCode, comment },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType,
      entityType: "complaint",
      entityId: id,
      payload: { complaintNumber: complaint.complaintNumber, actionCode, targetUserId: complaint.submittedByUserId, comment },
      createdBy: actor.userId,
    });

    return { complaint: (await this.repo.findById(id))!, workflowResult: result };
  }

  async updateInvestigation(actor: ActorContext, id: string, input: UpdateInvestigationInput) {
    await this.rbac.requirePermission(actor, "complaint.manage");
    await this.getAuthorized(actor, id);
    const updated = await this.repo.updateInvestigation(id, input, actor.userId);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "complaint.investigation_updated",
      entityType: "complaint",
      entityId: id,
      metadata: { ...input },
    });

    return updated;
  }

  async verify(actor: ActorContext, id: string, verificationNote: string | null) {
    await this.rbac.requirePermission(actor, "complaint.manage");
    await this.getAuthorized(actor, id);
    const updated = await this.repo.updateVerification(
      id,
      { verificationNote, verifiedByUserId: actor.userId },
      actor.userId,
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "complaint.verified",
      entityType: "complaint",
      entityId: id,
      metadata: { verificationNote },
    });
    return updated;
  }

  async confirmByCustomer(actor: ActorContext, id: string, note: string | null) {
    await this.rbac.requirePermission(actor, "complaint.manage");
    await this.getAuthorized(actor, id);
    const updated = await this.repo.updateCustomerConfirmation(
      id,
      { customerConfirmationNote: note },
      actor.userId,
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "complaint.customer_confirmation_recorded",
      entityType: "complaint",
      entityId: id,
      metadata: { note },
    });
    return updated;
  }

  /**
   * Reopen — the one Complaint action that CANNOT go through `act()`
   * (a completed Instance has no pending Assignment to act on, see
   * `WorkflowService.reopenInstance`'s doc comment). Complaint-specific
   * authorization happens HERE (permission + Customer Data Scope +
   * "must actually be closed"); the generic reopen mechanics are 100%
   * `WorkflowService`'s, reused as-is.
   */
  async reopen(actor: ActorContext, id: string, toStepCode: string, comment: string | null) {
    await this.rbac.requirePermission(actor, "complaint.manage");
    const complaint = await this.getAuthorized(actor, id);
    if (!complaint.workflowInstanceId) {
      throw new ConflictError("This Complaint has no active Workflow Instance");
    }

    const { instance } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      complaint.workflowInstanceId,
    );
    if (instance.status === "in_progress") {
      throw new ConflictError("Only a Closed/Rejected/Cancelled Complaint can be reopened");
    }

    const result = await this.workflow.reopenInstance(actor, complaint.workflowInstanceId, {
      toStepCode,
      comment,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "complaint.reopened",
      entityType: "complaint",
      entityId: id,
      metadata: { toStepCode, comment },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "complaint.reopened",
      entityType: "complaint",
      entityId: id,
      payload: { complaintNumber: complaint.complaintNumber, targetUserId: complaint.submittedByUserId, comment },
      createdBy: actor.userId,
    });

    return { complaint: (await this.repo.findById(id))!, workflowResult: result };
  }

  async updateSeverity(actor: ActorContext, id: string, severity: string, note?: string | null) {
    await this.rbac.requirePermission(actor, "complaint.manage");
    await this.getAuthorized(actor, id);
    const severities = await this.configuration.listReferenceDataItemsForTrustedCaller(
      actor.tenantId,
      COMPLAINT_SEVERITY_REF_TYPE,
    );
    if (!severities.some((s) => s.code === severity && s.isActive)) {
      throw new ValidationError(`Unknown or inactive severity code '${severity}'`);
    }

    const updated = await this.repo.updateSeverity(id, severity, actor.userId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "complaint.severity_updated",
      entityType: "complaint",
      entityId: id,
      metadata: { severity, note },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "complaint.severity_updated",
      entityType: "complaint",
      entityId: id,
      payload: { complaintNumber: updated.complaintNumber, severity, note },
      createdBy: actor.userId,
    });
    return updated;
  }

  /**
   * Complaint visibility gate — Customer Data Scope (ADR-0011, via
   * `CustomerService.canAccessForDocument`, deliberately the
   * permission-free scope-only check) OR the actor is associated with
   * the Complaint's Workflow Instance (started it, or currently/
   * previously assigned — `WorkflowService.isActorAssociatedWithInstance`).
   * The second path matters because an internal investigator's Role+
   * Organization-Unit Assignment routing is independent of the
   * Customer's own `ownerOrganizationUnitId` (e.g. a central
   * investigation team serving every Customer) — Customer Data Scope
   * alone would wrongly block a legitimately assigned investigator.
   * `WorkflowService.actOnAssignment`'s own `assertEligible` remains the
   * PRECISE gate for whether a given action is allowed right now; this
   * method only answers "may this actor know the Complaint exists".
   */
  /** Trusted read for a subscribing application service. It reveals only the
   * Complaint aggregate after tenant ownership is proved; it grants no end-user
   * visibility and must never be exposed directly from an HTTP route. */
  async getForTrustedCaller(tenantId: string, id: string): Promise<Complaint | null> {
    const complaint = await this.repo.findById(id);
    return complaint?.tenantId === tenantId ? complaint : null;
  }

  async getAuthorized(actor: ActorContext, id: string): Promise<Complaint> {
    const complaint = await this.repo.findById(id);
    if (!complaint || complaint.tenantId !== actor.tenantId) {
      throw new NotFoundError("Complaint", id);
    }
    if (await this.customers.canAccessForDocument(actor, complaint.customerId)) {
      return complaint;
    }
    if (complaint.submittedByUserId === actor.userId) {
      return complaint;
    }
    if (
      complaint.workflowInstanceId &&
      (await this.workflow.isActorAssociatedWithInstance(actor, complaint.workflowInstanceId))
    ) {
      return complaint;
    }
    throw new ForbiddenError("Your Data Scope does not cover this Complaint");
  }

  /** Entity Authorization Resolver for `entityType='complaint'`
   * (ADR-0012 pattern, reused from 1A's `customer` resolver). Data-Scope-
   * only, no separate `document.*`/`complaint.*` permission required —
   * same binding decision as Customer's attachments. */
  async canAccessForDocument(actor: ActorContext, complaintId: string): Promise<boolean> {
    try {
      await this.getAuthorized(actor, complaintId);
      return true;
    } catch {
      return false;
    }
  }
}
