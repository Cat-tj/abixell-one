import { createHash, randomBytes } from "crypto";
import type { PoolClient } from "pg";
import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { EventBus } from "../../../../application/event/event-bus.js";
import type {
  EntityWorkflowAction,
  EntityWorkflowStatus,
  WorkflowService,
} from "../../../../application/workflow/workflow.service.js";
import type { ConfigurationService } from "../../../../application/configuration/configuration.service.js";
import type { CustomerScopePort } from "../domain/service-operations.entity.js";
import type {
  CreateInvoiceInput,
  CreateInvoiceResult,
  FinalizeCostsResult,
  IssueAcceptanceTokenInput,
  MarkCustomerAcceptedInput,
  MarkCustomerRejectedInput,
  ServiceDefinition,
  ServiceDefinitionChecklistItem,
  ServiceOperationsRepository,
  WorkOrder,
  WorkOrderType,
  WorkOrderAcceptanceToken,
  WorkOrderChecklistItem,
  WorkOrderCostItem,
  WorkOrderServingLog,
  WorkRequest,
  CustomerInvoice,
} from "../domain/service-operations.entity.js";
import { workRequestState } from "../domain/service-operations.entity.js";

/** Narrow outbox port used by WP-OPS-01 Phase 6 to publish
 * `work_order.accepted` into `scm_accounting_ready_events` without pulling
 * the Supply-Chain module's internals into Service Operations. The structural
 * shape matches `AccountingEventWritePort.createEvent` + `.getEventByIdempotencyKey`
 * so composition root wires the same `PgAccountingEventWritePort` here that
 * Workforce Advanced already uses (same pattern as `PayrollAccountingEventPort`). */
export interface WorkOrderAccountingEventPort {
  createEvent(
    tenantId: string,
    input: WorkOrderAccountingEventInput,
    client?: PoolClient,
  ): Promise<unknown>;
  getEventByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
    client?: PoolClient,
  ): Promise<unknown | null>;
}

export interface WorkOrderAccountingEventInput {
  eventType:
    | "work_order.accepted"
    | "work_order.cost_accumulated"
    | "work_order.invoiced"
    | "work_order.invoice_tax";
  sourceDocumentType: string;
  sourceDocumentId: string;
  effectiveAt?: Date;
  currency?: string;
  /** Numeric string allowed so a NUMERIC(18,4) sum reaches the outbox row
   * without a float round-trip. */
  amount?: number | string;
  quantity?: number | null;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
}

/** Tenant Configuration codes this module expects to exist. All three are
 * Client Configuration, never Product Core content. */
export const WORK_REQUEST_NUMBERING_CODE = "work_request";
export const WORK_ORDER_NUMBERING_CODE = "work_order";
export const WORK_ORDER_WORKFLOW_DEFINITION_CODE = "service_operations_work_order";
export const CUSTOMER_INVOICE_NUMBERING_CODE = "customer_invoice";
export const WORK_ORDER_SERVING_NUMBERING_CODE = "work_order_serving";
/** PPN default rate (Indonesia PPN 11%). Per-invoice override allowed. */
const DEFAULT_PPN_RATE = "0.11";

/** Workflow action code → domain event name (SO-CORE-015). The Step graph
 * itself is Tenant Configuration; this map only names the events a Tenant's
 * chosen action codes publish, exactly like the Complaint Engine does. */
const ACTION_EVENT_MAP: Record<string, string> = {
  submit: "work_order.submitted",
  assign: "work_order.assigned",
  start: "work_order.started",
  complete: "work_order.completed",
  verify: "work_order.verified",
  reject: "work_order.rejected",
  cancel: "work_order.cancelled",
};

export interface WorkOrderDetailView {
  workOrder: WorkOrder;
  serviceDefinition: ServiceDefinition | null;
  checklist: WorkOrderChecklistItem[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

/**
 * Service Operations & Work Management Core (Phase 2, SO-CORE-001…015).
 *
 * The generic service-delivery spine: what work is requested, who executes
 * it, when, with what evidence, and whether it was completed and verified.
 *
 * Architectural constraints honoured here:
 * - **Workflow owns lifecycle STATE** (SO-CORE-004). This service never
 *   stores a work-order status column and never encodes a Step graph; it
 *   forwards action codes to `WorkflowService` and records business FACTS
 *   (started/completed/verified by whom, when) alongside.
 * - **Platform Core is reused, never re-implemented** — numbering,
 *   configuration, workflow, audit, events, documents, RBAC, Data Scope.
 * - **Customer & Commercial owns the customer** — this module references it
 *   through `CustomerService`, and never keeps its own customer master.
 * - **No vertical assumptions.** Nothing here knows what a catering,
 *   housekeeping, camp, or facility job is; those arrive as Configuration
 *   and Vertical Service Packs over these same entities.
 */
export class ServiceOperationsService {
  constructor(
    private readonly repo: ServiceOperationsRepository,
    private readonly customers: CustomerScopePort,
    private readonly workflow: WorkflowService,
    private readonly configuration: ConfigurationService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly eventBus: EventBus,
    private readonly accountingEvents: WorkOrderAccountingEventPort,
  ) {}

  // ===================================================================
  // Service Definition — SO-CORE-001 / SO-CORE-007
  // ===================================================================

  async createServiceDefinition(
    actor: ActorContext,
    input: { code: string; name: string; description?: string | null; category?: string | null },
  ): Promise<ServiceDefinition> {
    await this.rbac.requirePermission(actor, "service_operations.configure");
    const existing = await this.repo.findServiceDefinitionByCode(actor.tenantId, input.code);
    if (existing) throw new ConflictError(`Service Definition '${input.code}' already exists`);

    const definition = await this.repo.createServiceDefinition({
      tenantId: actor.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      createdBy: actor.userId,
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_operations.service_definition.created",
      entityType: "service_definition",
      entityId: definition.id,
      metadata: { code: definition.code, name: definition.name },
    });
    return definition;
  }

  async addChecklistTemplateItem(
    actor: ActorContext,
    definitionCode: string,
    input: { code: string; label: string; isRequired?: boolean; sortOrder?: number },
  ): Promise<ServiceDefinitionChecklistItem> {
    await this.rbac.requirePermission(actor, "service_operations.configure");
    const definition = await this.getServiceDefinitionOrThrow(actor.tenantId, definitionCode);
    return this.repo.addChecklistTemplateItem({
      serviceDefinitionId: definition.id,
      code: input.code,
      label: input.label,
      isRequired: input.isRequired ?? false,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  async setServiceDefinitionActive(
    actor: ActorContext,
    definitionCode: string,
    isActive: boolean,
  ): Promise<ServiceDefinition> {
    await this.rbac.requirePermission(actor, "service_operations.configure");
    const definition = await this.getServiceDefinitionOrThrow(actor.tenantId, definitionCode);
    const updated = await this.repo.setServiceDefinitionActive(definition.id, isActive, actor.userId);
    return updated!;
  }

  async listServiceDefinitions(actor: ActorContext): Promise<ServiceDefinition[]> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    return this.repo.listServiceDefinitions(actor.tenantId);
  }

  async getServiceDefinition(
    actor: ActorContext,
    definitionCode: string,
  ): Promise<{ definition: ServiceDefinition; checklist: ServiceDefinitionChecklistItem[] }> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    const definition = await this.getServiceDefinitionOrThrow(actor.tenantId, definitionCode);
    return { definition, checklist: await this.repo.listChecklistTemplateItems(definition.id) };
  }

  // ===================================================================
  // Work Request (intake) — SO-CORE-002 / SO-CORE-011 / SO-CORE-012
  // ===================================================================

  async createWorkRequest(
    actor: ActorContext,
    input: {
      customerId: string;
      contractId?: string | null;
      projectId?: string | null;
      siteId?: string | null;
      serviceDefinitionCode: string;
      description: string;
      priority?: string | null;
    },
  ): Promise<WorkRequest> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    // Customer Data Scope — identical posture to the Complaint Engine: works
    // whether the actor is a Customer User or an internal coordinator.
    const customer = await this.customers.getAuthorized(actor, input.customerId);
    const definition = await this.getActiveServiceDefinitionOrThrow(actor.tenantId, input.serviceDefinitionCode);

    const { number } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORK_REQUEST_NUMBERING_CODE,
      actor.userId,
    );

    const request = await this.repo.createWorkRequest({
      tenantId: actor.tenantId,
      requestNumber: number,
      customerId: customer.id,
      contractId: input.contractId ?? null,
      projectId: input.projectId ?? null,
      siteId: input.siteId ?? null,
      serviceDefinitionId: definition.id,
      description: input.description,
      priority: input.priority ?? null,
      requestedByUserId: actor.userId,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_request.created",
      entityType: "work_request",
      entityId: request.id,
      metadata: { requestNumber: number, customerId: customer.id, serviceDefinitionCode: definition.code },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "work_request.created",
      entityType: "work_request",
      entityId: request.id,
      payload: { requestNumber: number, customerId: customer.id, targetUserId: actor.userId },
      createdBy: actor.userId,
    });
    return request;
  }

  async listWorkRequests(actor: ActorContext): Promise<{ request: WorkRequest; state: string }[]> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    const customerIds = await this.customers.listScopedCustomerIdsForActor(actor);
    const requests = await this.repo.listWorkRequests(actor.tenantId, { customerIds });
    const customer = this.isCustomerActor(actor);
    return requests.map((request) => ({
      request: customer ? { ...request, requestedByUserId: "" } : request,
      state: workRequestState(request),
    }));
  }

  async getWorkRequest(actor: ActorContext, id: string): Promise<{ request: WorkRequest; state: string }> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    const request = await this.getAuthorizedWorkRequest(actor, id);
    return {
      request: this.isCustomerActor(actor) ? { ...request, requestedByUserId: "" } : request,
      state: workRequestState(request),
    };
  }

  async cancelWorkRequest(actor: ActorContext, id: string, reason: string | null): Promise<WorkRequest> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const request = await this.getAuthorizedWorkRequest(actor, id);
    const cancelled = await this.repo.cancelWorkRequest(request.id, reason, actor.userId);
    if (!cancelled) {
      throw new ConflictError("Only an open Work Request can be cancelled");
    }
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_request.cancelled",
      entityType: "work_request",
      entityId: request.id,
      metadata: { reason },
    });
    return cancelled;
  }

  // ===================================================================
  // Work Order — SO-CORE-003 … SO-CORE-006
  // ===================================================================

  /** Convert an open Work Request into an executable Work Order
   * (SO-CORE-003). Guarded so one request can never produce two orders. */
  async convertRequestToWorkOrder(
    actor: ActorContext,
    requestId: string,
    input: { title?: string; plannedStartAt?: string | null; plannedEndAt?: string | null; dueAt?: string | null },
  ): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const request = await this.getAuthorizedWorkRequest(actor, requestId);
    if (workRequestState(request) !== "open") {
      throw new ConflictError(`Only an open Work Request can be converted (is '${workRequestState(request)}')`);
    }
    const definition = await this.repo.findServiceDefinitionById(request.serviceDefinitionId);
    if (!definition) throw new NotFoundError("ServiceDefinition", request.serviceDefinitionId);

    const workOrder = await this.createWorkOrderInternal(actor, {
      workRequestId: request.id,
      customerId: request.customerId,
      contractId: request.contractId,
      projectId: request.projectId,
      siteId: request.siteId,
      definition,
      title: input.title ?? `${definition.name}`,
      description: request.description,
      priority: request.priority,
      plannedStartAt: input.plannedStartAt ?? null,
      plannedEndAt: input.plannedEndAt ?? null,
      dueAt: input.dueAt ?? null,
    });

    const converted = await this.repo.markWorkRequestConverted(request.id, workOrder.id, actor.userId);
    if (!converted) {
      // Lost a race with a concurrent conversion — surface it rather than
      // leaving two orders silently attached to one request.
      throw new ConflictError("This Work Request has already been converted or cancelled");
    }
    return workOrder;
  }

  /** Create a Work Order directly, without an intake request. */
  async createWorkOrder(
    actor: ActorContext,
    input: {
      customerId: string;
      contractId?: string | null;
      woType?: WorkOrderType;
      projectId?: string | null;
      siteId?: string | null;
      serviceDefinitionCode: string;
      title: string;
      description?: string | null;
      priority?: string | null;
      plannedStartAt?: string | null;
      plannedEndAt?: string | null;
      dueAt?: string | null;
    },
  ): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const woType: WorkOrderType = input.woType ?? "regular";
    // A back-charge WO is work done without a delivery contract, so it
    // must not reference one and never enters contract-price resolution.
    if (woType === "back_charge" && input.contractId) {
      throw new ValidationError("A back_charge Work Order cannot reference a contract");
    }
    // Owner request: WO isolation decided at creation. A project-bound WO
    // requires the creator to be an explicit project member.
    if (input.projectId && !(await this.repo.isProjectMember(actor.tenantId, input.projectId, actor.userId))) {
      throw new ConflictError("Only a member of the project can create Work Orders in it");
    }
    const customer = await this.customers.getAuthorized(actor, input.customerId);
    const definition = await this.getActiveServiceDefinitionOrThrow(actor.tenantId, input.serviceDefinitionCode);
    return this.createWorkOrderInternal(actor, {
      workRequestId: null,
      customerId: customer.id,
      contractId: woType === "back_charge" ? null : (input.contractId ?? null),
      woType,
      projectId: input.projectId ?? null,
      siteId: input.siteId ?? null,
      definition,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? null,
      plannedStartAt: input.plannedStartAt ?? null,
      plannedEndAt: input.plannedEndAt ?? null,
      dueAt: input.dueAt ?? null,
    });
  }

  /** Assignment (SO-CORE-005) — the responsible executor. Workflow
   * role+scope routing remains available for queue-based assignment; this
   * records the named individual responsible for the work. */
  async assignWorkOrder(actor: ActorContext, id: string, assigneeUserId: string): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    const assigneeTenant = await this.repo.findUserTenantId(assigneeUserId);
    if (!assigneeTenant) throw new NotFoundError("User", assigneeUserId);
    if (assigneeTenant !== actor.tenantId) {
      throw new ForbiddenError("Cannot assign work to a user in another tenant");
    }

    const updated = await this.repo.assignWorkOrder(workOrder.id, assigneeUserId, actor.userId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.assigned",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { assigneeUserId },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "work_order.assigned",
      entityType: "work_order",
      entityId: workOrder.id,
      payload: {
        workOrderNumber: workOrder.workOrderNumber,
        targetUserId: assigneeUserId,
        assignedByUserId: actor.userId,
      },
      createdBy: actor.userId,
    });
    return updated!;
  }

  /** Basic scheduling only (SO-CORE-006): planned window + due date. No
   * capacity model, no route sequencing, no recurrence — those are Advanced. */
  async scheduleWorkOrder(
    actor: ActorContext,
    id: string,
    input: { plannedStartAt?: string | null; plannedEndAt?: string | null; dueAt?: string | null },
  ): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    const plannedStartAt = parseDate(input.plannedStartAt, "plannedStartAt");
    const plannedEndAt = parseDate(input.plannedEndAt, "plannedEndAt");
    const dueAt = parseDate(input.dueAt, "dueAt");
    if (plannedStartAt && plannedEndAt && plannedEndAt < plannedStartAt) {
      throw new ValidationError("plannedEndAt cannot be earlier than plannedStartAt");
    }

    const updated = await this.repo.scheduleWorkOrder(
      workOrder.id,
      { plannedStartAt, plannedEndAt, dueAt },
      actor.userId,
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.scheduled",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { plannedStartAt, plannedEndAt, dueAt },
    });
    return updated!;
  }

  // ===================================================================
  // Execution — SO-CORE-008 / SO-CORE-010 / SO-CORE-004
  // ===================================================================

  /**
   * Generic lifecycle dispatch (SO-CORE-004). This service does NOT know the
   * Step graph: it finds whatever pending Workflow Assignment exists on the
   * Work Order's Instance and forwards `actionCode` verbatim. An invalid
   * transition is rejected by the Workflow Engine itself.
   */
  async act(actor: ActorContext, id: string, actionCode: string, comment: string | null) {
    // A lifecycle transition can legitimately be taken by a coordinator
    // (assign/cancel), an executor (start/complete), or a verifier (verify),
    // so the module gate is "holds any operational capability" and the
    // PRECISE gate remains the Workflow Engine's own assignment eligibility
    // (role+scope / specific_user), exactly as in the Complaint Engine.
    await this.rbac.requirePermission(actor, "service_operations.read");
    await this.requireAnyOperationalCapability(actor);
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    if (!workOrder.workflowInstanceId) {
      throw new ConflictError("This Work Order has no active Workflow Instance");
    }
    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      workOrder.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action currently exists on this Work Order");

    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    const eventType = ACTION_EVENT_MAP[actionCode] ?? "work_order.status_changed";
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: eventType,
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { actionCode, comment },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType,
      entityType: "work_order",
      entityId: workOrder.id,
      payload: {
        workOrderNumber: workOrder.workOrderNumber,
        actionCode,
        targetUserId: workOrder.assignedToUserId,
        comment,
      },
      createdBy: actor.userId,
    });
    return { workOrder: (await this.repo.findWorkOrderById(workOrder.id))!, workflowResult: result };
  }

  /** Record that execution has begun (SO-CORE-008). Idempotent: a repeated
   * start is a no-op rather than an error, and never overwrites the original
   * executor/timestamp. */
  async startWork(actor: ActorContext, id: string): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.execute");
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    this.assertExecutor(actor, workOrder);
    if (workOrder.completedAt) throw new ConflictError("This Work Order is already completed");

    const started = await this.repo.markWorkOrderStarted(workOrder.id, actor.userId);
    if (!started) return workOrder; // already started — idempotent

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.started",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: {},
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "work_order.started",
      entityType: "work_order",
      entityId: workOrder.id,
      payload: { workOrderNumber: workOrder.workOrderNumber, targetUserId: workOrder.assignedToUserId },
      createdBy: actor.userId,
    });
    return started;
  }

  /** Record a checklist item result (SO-CORE-007/008). */
  async setChecklistItem(
    actor: ActorContext,
    workOrderId: string,
    itemId: string,
    input: { isCompleted: boolean; note?: string | null },
  ): Promise<WorkOrderChecklistItem> {
    await this.rbac.requirePermission(actor, "service_operations.execute");
    const workOrder = await this.getAuthorizedWorkOrder(actor, workOrderId);
    this.assertExecutor(actor, workOrder);
    if (workOrder.completedAt) throw new ConflictError("This Work Order is already completed");

    const item = await this.repo.findWorkOrderChecklistItem(itemId);
    if (!item || item.workOrderId !== workOrder.id) {
      throw new NotFoundError("WorkOrderChecklistItem", itemId);
    }
    const updated = await this.repo.setChecklistItemCompletion(item.id, {
      isCompleted: input.isCompleted,
      note: input.note ?? null,
      userId: actor.userId,
    });
    return updated!;
  }

  /**
   * Record completion (SO-CORE-010). Required checklist items must be done
   * first. Idempotent by guarded UPDATE: a duplicate completion cannot
   * overwrite the original facts or re-publish the event.
   */
  async completeWork(actor: ActorContext, id: string, notes: string | null): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.execute");
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    this.assertExecutor(actor, workOrder);

    const checklist = await this.repo.listWorkOrderChecklistItems(workOrder.id);
    const outstanding = checklist.filter((c) => c.isRequired && !c.isCompleted);
    if (outstanding.length > 0) {
      throw new ValidationError(
        `Required checklist item(s) not completed: ${outstanding.map((c) => c.code).join(", ")}`,
      );
    }

    const completed = await this.repo.markWorkOrderCompleted(workOrder.id, notes, actor.userId);
    if (!completed) throw new ConflictError("This Work Order is already completed");

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.completed",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { notes },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "work_order.completed",
      entityType: "work_order",
      entityId: workOrder.id,
      payload: { workOrderNumber: workOrder.workOrderNumber, targetUserId: workOrder.assignedToUserId },
      createdBy: actor.userId,
    });
    return completed;
  }

  /** Supervisor verification (SO-CORE-010). Requires a distinct capability
   * from execution, so segregation of duties is possible. */
  async verifyWork(actor: ActorContext, id: string, notes: string | null): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.verify");
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    if (!workOrder.completedAt) throw new ConflictError("Only completed work can be verified");

    const verified = await this.repo.markWorkOrderVerified(workOrder.id, notes, actor.userId);
    if (!verified) throw new ConflictError("This Work Order is already verified");

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.verified",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { notes },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "work_order.verified",
      entityType: "work_order",
      entityId: workOrder.id,
      payload: { workOrderNumber: workOrder.workOrderNumber, targetUserId: workOrder.completedByUserId },
      createdBy: actor.userId,
    });
    return verified;
  }

  // ===================================================================
  // Customer Acceptance Gate (WP-OPS-01 Phase 6 — FR-OPS-001, E2EGAP-014)
  // ===================================================================

  /** Issue a single-use public sign-off link for a verified Work Order.
   * Revokes any still-live token for the same WO (atomic, one live link max),
   * stores only the SHA256 hash, and returns the raw token exactly once —
   * the same delivery contract as `SurveyPublicService`. */
  async issueAcceptanceToken(
    actor: ActorContext,
    workOrderId: string,
    input: IssueAcceptanceTokenInput,
  ): Promise<{ token: string; expiresAt: Date }> {
    await this.rbac.requirePermission(actor, "service_operations.verify");
    const workOrder = await this.getAuthorizedWorkOrder(actor, workOrderId);
    if (!workOrder.verifiedAt) {
      throw new ConflictError("Cannot issue an acceptance token before the Work Order is verified");
    }
    if (workOrder.customerAcceptedAt) {
      throw new ConflictError("This Work Order has already been accepted by the customer");
    }

    const expiresInDays = input.expiresInDays ?? 30;
    if (expiresInDays <= 0 || !Number.isFinite(expiresInDays)) {
      throw new ValidationError("expiresInDays must be a positive number");
    }
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const stored: WorkOrderAcceptanceToken = await this.repo.replaceAcceptanceToken(
      actor.tenantId,
      workOrder.id,
      tokenHash,
      expiresAt,
      actor.userId,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.acceptance_token_issued",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { tokenId: stored.id, expiresAt: stored.expiresAt.toISOString() },
    });

    return { token: rawToken, expiresAt: stored.expiresAt };
  }

  /** Mark a Work Order accepted by the customer. Idempotent: a guarded UPDATE
   * returns null when already accepted. Emits the outbox event
   * `work_order.accepted` (amount 0 — real cost arrives in WP-OPS-02) and the
   * in-process `work_order.accepted` bus event that drives CSAT assignment. */
  async customerAcceptWork(
    tenantId: string,
    workOrderId: string,
    via: "token" | "internal",
    comment: string | null,
    actorUserId: string | null,
  ): Promise<WorkOrder> {
    const workOrder = await this.repo.findWorkOrderById(workOrderId);
    if (!workOrder || workOrder.tenantId !== tenantId) {
      throw new NotFoundError("Work Order", workOrderId);
    }

    const accepted = await this.repo.markCustomerAccepted(workOrder.id, {
      via,
      comment,
      acceptedBy: actorUserId,
    } satisfies MarkCustomerAcceptedInput);
    if (!accepted) {
      throw new ConflictError("This Work Order cannot be accepted (not verified or already accepted)");
    }

    await this.audit.record({
      tenantId,
      actorUserId,
      action: "work_order.customer_accepted",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { via, comment, workOrderNumber: workOrder.workOrderNumber },
    });

    // Outbox: idempotent on `wo-accept:{workOrderId}`. A repeated accept (which
    // the guard above already prevents at the WO level) or a retry of the
    // consumer cannot duplicate the event.
    const idempotencyKey = `wo-accept:${workOrder.id}`;
    const existing = await this.accountingEvents.getEventByIdempotencyKey(tenantId, idempotencyKey);
    if (!existing) {
      await this.accountingEvents.createEvent(tenantId, {
        eventType: "work_order.accepted",
        sourceDocumentType: "work_order",
        sourceDocumentId: workOrder.id,
        quantity: 1,
        amount: 0,
        idempotencyKey,
        payload: {
          workOrderNumber: workOrder.workOrderNumber,
          customerId: workOrder.customerId,
          serviceDefinitionId: workOrder.serviceDefinitionId,
          acceptedVia: via,
        },
        createdBy: actorUserId,
      });
    }

    await this.eventBus.publish({
      tenantId,
      eventType: "work_order.accepted",
      entityType: "work_order",
      entityId: workOrder.id,
      payload: {
        workOrderNumber: workOrder.workOrderNumber,
        customerId: workOrder.customerId,
        acceptedVia: via,
        actorUserId,
      },
      createdBy: actorUserId,
    });

    return accepted;
  }

  /** Customer rejection — not terminal. The WO can be reworked and a fresh
   * token issued; a later accept clears the rejection facts. */
  async customerRejectWork(
    tenantId: string,
    workOrderId: string,
    reason: string | null,
    actorUserId: string | null,
  ): Promise<WorkOrder> {
    const workOrder = await this.repo.findWorkOrderById(workOrderId);
    if (!workOrder || workOrder.tenantId !== tenantId) {
      throw new NotFoundError("Work Order", workOrderId);
    }

    const rejected = await this.repo.markCustomerRejected(workOrder.id, {
      reason,
      rejectedBy: actorUserId,
    } satisfies MarkCustomerRejectedInput);
    if (!rejected) {
      throw new ConflictError("This Work Order cannot be rejected (not verified or already accepted)");
    }

    await this.audit.record({
      tenantId,
      actorUserId,
      action: "work_order.customer_rejected",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { reason, workOrderNumber: workOrder.workOrderNumber },
    });

    await this.eventBus.publish({
      tenantId,
      eventType: "work_order.customer_rejected",
      entityType: "work_order",
      entityId: workOrder.id,
      payload: {
        workOrderNumber: workOrder.workOrderNumber,
        customerId: workOrder.customerId,
        reason,
        actorUserId,
      },
      createdBy: actorUserId,
    });

    return rejected;
  }

  /** Authenticated manual acceptance (`via = 'internal'`), e.g. a customer
   * representative signing on paper and a supervisor recording it. */
  async acceptWorkInternally(actor: ActorContext, id: string, comment: string | null): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.verify");
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    return this.customerAcceptWork(actor.tenantId, workOrder.id, "internal", comment, actor.userId);
  }

  async rejectWorkInternally(actor: ActorContext, id: string, reason: string | null): Promise<WorkOrder> {
    await this.rbac.requirePermission(actor, "service_operations.verify");
    const workOrder = await this.getAuthorizedWorkOrder(actor, id);
    return this.customerRejectWork(actor.tenantId, workOrder.id, reason, actor.userId);
  }

  // ===================================================================
  // Cost Accumulator (WP-OPS-02 Phase 6 — FR-OPS-002, E2E-010)
  // ===================================================================

  /** Record one cost item on an accepted Work Order. Guarded: the WO must
   * be customer-accepted first (DEC-009 sequence acceptance → cost) and not
   * yet finalized (a non-null costs_finalized_at locks further adds). */
  async addCostItem(
    actor: ActorContext,
    workOrderId: string,
    input: { costType: WorkOrderCostItem["costType"]; description?: string | null; quantity: string; unitCost: string; costCenterId?: string | null },
  ): Promise<WorkOrderCostItem> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const workOrder = await this.getAuthorizedWorkOrder(actor, workOrderId);
    if (!workOrder.customerAcceptedAt) {
      throw new ConflictError("Costs can only be recorded on a customer-accepted Work Order");
    }
    if (workOrder.costsFinalizedAt) {
      throw new ConflictError("Costs on this Work Order are already finalized");
    }
    if (!(Number(input.quantity) > 0)) {
      throw new ValidationError("quantity must be greater than 0");
    }
    if (!(Number(input.unitCost) > 0)) {
      throw new ValidationError("unitCost must be greater than 0");
    }
    if (input.costCenterId && !(await this.repo.costCenterBelongsToTenant(actor.tenantId, input.costCenterId))) {
      throw new NotFoundError("Cost center", input.costCenterId);
    }

    const item = await this.repo.insertCostItem(actor.tenantId, workOrder.id, {
      costType: input.costType,
      description: input.description ?? null,
      quantity: input.quantity,
      unitCost: input.unitCost,
      costCenterId: input.costCenterId ?? null,
      recordedBy: actor.userId,
    });
    if (!item) {
      // DB fence lost a race against a concurrent finalize.
      throw new ConflictError("Costs on this Work Order are already finalized");
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.cost_item.recorded",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { costItemId: item.id, costType: item.costType, totalCost: item.totalCost },
    });
    return item;
  }

  /** List cost items for a Work Order (read tier). */
  async listCostItems(actor: ActorContext, workOrderId: string): Promise<WorkOrderCostItem[]> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    this.requireInternalActor(actor);
    const workOrder = await this.getAuthorizedWorkOrderForRead(actor, workOrderId);
    return this.repo.listCostItems(actor.tenantId, workOrder.id);
  }

  /**
   * Finalize cost accumulation: compute the sum, resolve the open accounting
   * period for the caller-provided legal entity, then emit the outbox event
   * `work_order.cost_accumulated` (amount = real cost, payload carries
   * legalEntityId + periodId so the consumer can post to GL). Race-safe via
   * a guarded UPDATE (costs_finalized_at IS NULL) that claims the finalize.
   */
  async finalizeCosts(
    actor: ActorContext,
    workOrderId: string,
    input: { legalEntityId: string },
  ): Promise<FinalizeCostsResult> {
    await this.rbac.requirePermission(actor, "service_operations.verify");
    const workOrder = await this.getAuthorizedWorkOrder(actor, workOrderId);
    // Reference check first: a foreign/unknown legal entity is a 404
    // regardless of the WO's acceptance state.
    if (!(await this.repo.legalEntityBelongsToTenant(actor.tenantId, input.legalEntityId))) {
      throw new NotFoundError("Legal entity", input.legalEntityId);
    }
    if (!workOrder.customerAcceptedAt) {
      throw new ConflictError("Costs can only be finalized on a customer-accepted Work Order");
    }
    if (workOrder.costsFinalizedAt) {
      throw new ConflictError("Costs on this Work Order are already finalized");
    }

    const periodId = await this.repo.findOpenAccountingPeriodIdForToday(actor.tenantId, input.legalEntityId);
    if (!periodId) {
      throw new ConflictError("No open accounting period for the legal entity");
    }

    const idempotencyKey = `wo-cost:${workOrder.id}`;
    const tenantId = actor.tenantId;
    // One transaction: row lock → sum → guarded claim → outbox. The lock
    // serialises against concurrent finalizes and against `insertCostItem`'s
    // FOR SHARE fence, so the sum written to costs_total is exactly the sum
    // the outbox event carries, and neither exists without the other.
    const { finalized, costsTotal, outboxEventEmitted } = await this.repo.withTransaction(async (client) => {
      const locked = await this.repo.lockWorkOrderForCostFinalize(workOrder.id, client);
      if (!locked) {
        throw new ConflictError("Costs on this Work Order are already finalized");
      }
      const costsTotal = await this.repo.sumCostItems(tenantId, workOrder.id, client);
      if (Number(costsTotal) <= 0) {
        throw new ValidationError("Cannot finalize costs: no cost items recorded");
      }
      const finalized = await this.repo.finalizeWorkOrderCosts(workOrder.id, costsTotal, actor.userId, client);
      if (!finalized) {
        throw new ConflictError("Costs on this Work Order are already finalized");
      }

      // Outbox: idempotent on `wo-cost:{workOrderId}`.
      let outboxEventEmitted = false;
      const existing = await this.accountingEvents.getEventByIdempotencyKey(tenantId, idempotencyKey, client);
      if (!existing) {
        await this.accountingEvents.createEvent(
          tenantId,
          {
            eventType: "work_order.cost_accumulated",
            sourceDocumentType: "work_order",
            sourceDocumentId: workOrder.id,
            quantity: 1,
            // Passed as the numeric string so no float rounding occurs
            // between the SUM and the outbox row.
            amount: costsTotal,
            idempotencyKey,
            payload: {
              legalEntityId: input.legalEntityId,
              periodId,
              workOrderNumber: workOrder.workOrderNumber,
              costsTotal,
            },
            createdBy: actor.userId,
          },
          client,
        );
        outboxEventEmitted = true;
      }
      return { finalized, costsTotal, outboxEventEmitted };
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.costs_finalized",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: { costsTotal, legalEntityId: input.legalEntityId, periodId },
    });

    return {
      workOrder: finalized,
      costsTotal,
      legalEntityId: input.legalEntityId,
      periodId,
      outboxEventEmitted,
    };
  }

  // ===================================================================
  // Customer Invoice / Billing-AR (WP-OPS-03 Phase 6 — FR-FIN-008, E2E-010)
  // ===================================================================

  /**
   * Create the customer invoice for a cost-finalized Work Order (one invoice
   * per WO, DEC-009 chain acceptance → cost → invoice). Value =
   * costs_total × (1 + markup); markup defaults to the tenant parameter
   * `service_operations.invoice.default_markup`, overridable per request.
   * PPN is optional per invoice; the taxable leg posts as its own outbox
   * event `work_order.invoice_tax` because a posting rule can only carry a
   * single `AMOUNT` token. No-op when the invoice exists (409).
   */
  async createInvoice(actor: ActorContext, workOrderId: string, input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    await this.rbac.requirePermission(actor, "service_operations.billing.manage");
    const workOrder = await this.getAuthorizedWorkOrder(actor, workOrderId);
    // Reference check first: a foreign/unknown legal entity is a 404
    // regardless of the WO's cost state.
    if (!(await this.repo.legalEntityBelongsToTenant(actor.tenantId, input.legalEntityId))) {
      throw new NotFoundError("Legal entity", input.legalEntityId);
    }
    if (!workOrder.costsFinalizedAt) {
      throw new ConflictError("Costs must be finalized before invoicing this Work Order");
    }
    const existing = await this.repo.findInvoiceByWorkOrder(actor.tenantId, workOrder.id);
    if (existing) {
      throw new ConflictError("An invoice already exists for this Work Order");
    }

    const markupRate = input.markupRate ?? (await this.resolveDefaultMarkupRate(actor.tenantId));
    validateRate(markupRate, "markupRate");
    let taxRate: string | null = null;
    if (input.isTaxable) {
      taxRate = input.taxRate ?? DEFAULT_PPN_RATE;
      validateRate(taxRate, "taxRate");
    }

    const periodId = await this.repo.findOpenAccountingPeriodIdForToday(actor.tenantId, input.legalEntityId);
    if (!periodId) {
      throw new ConflictError("No open accounting period for the legal entity");
    }

    const { number: invoiceNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      CUSTOMER_INVOICE_NUMBERING_CODE,
      actor.userId,
    );

    const tenantId = actor.tenantId;
    const result = await this.repo.withTransaction(async (client) => {
      // ON CONFLICT DO NOTHING: null = a concurrent create already won.
      const invoice = await this.repo.insertCustomerInvoice(
        {
          tenantId,
          workOrderId: workOrder.id,
          invoiceNumber,
          customerId: workOrder.customerId,
          legalEntityId: input.legalEntityId,
          periodId,
          costBasis: workOrder.costsTotal!,
          markupRate,
          isTaxable: input.isTaxable,
          taxRate,
          issuedBy: actor.userId,
        },
        client,
      );
      if (!invoice) {
        throw new ConflictError("An invoice already exists for this Work Order");
      }

      let outboxEventsEmitted = 0;
      const payload = {
        legalEntityId: invoice.legalEntityId,
        periodId: invoice.periodId,
        workOrderNumber: workOrder.workOrderNumber,
        invoiceNumber: invoice.invoiceNumber,
        sourceDocumentType: "customer_invoice",
        sourceDocumentId: invoice.id,
        baseAmount: invoice.baseAmount,
        taxAmount: invoice.taxAmount,
        totalAmount: invoice.totalAmount,
        markupRate: invoice.markupRate,
        taxRate: invoice.taxRate,
        isTaxable: invoice.isTaxable,
      };
      // Base leg: debit AR 1210 / credit revenue 4100. Idempotent on
      // `wo-inv:{workOrderId}`.
      const baseKey = `wo-inv:${workOrder.id}`;
      if (!(await this.accountingEvents.getEventByIdempotencyKey(tenantId, baseKey, client))) {
        await this.accountingEvents.createEvent(
          tenantId,
          {
            eventType: "work_order.invoiced",
            sourceDocumentType: "customer_invoice",
            sourceDocumentId: invoice.id,
            currency: invoice.currency,
            amount: invoice.baseAmount,
            quantity: 1,
            idempotencyKey: baseKey,
            payload,
            createdBy: actor.userId,
          },
          client,
        );
        outboxEventsEmitted++;
      }
      // Tax leg (PPN Keluaran 2410) only when the amount is postable — the
      // consumer requires amount > 0, so a 0-rate taxable invoice skips it.
      if (Number(invoice.taxAmount) > 0) {
        const taxKey = `wo-inv-tax:${workOrder.id}`;
        if (!(await this.accountingEvents.getEventByIdempotencyKey(tenantId, taxKey, client))) {
          await this.accountingEvents.createEvent(
            tenantId,
            {
              eventType: "work_order.invoice_tax",
              sourceDocumentType: "customer_invoice",
              sourceDocumentId: invoice.id,
              currency: invoice.currency,
              amount: invoice.taxAmount,
              quantity: 1,
              idempotencyKey: taxKey,
              payload,
              createdBy: actor.userId,
            },
            client,
          );
          outboxEventsEmitted++;
        }
      }
      return { invoice, outboxEventsEmitted };
    });

    await this.audit.record({
      tenantId,
      actorUserId: actor.userId,
      action: "work_order.invoiced",
      entityType: "customer_invoice",
      entityId: result.invoice.id,
      metadata: {
        workOrderId: workOrder.id,
        invoiceNumber: result.invoice.invoiceNumber,
        baseAmount: result.invoice.baseAmount,
        taxAmount: result.invoice.taxAmount,
        totalAmount: result.invoice.totalAmount,
      },
    });
    return result;
  }

  /** Read-tier invoice lookup for a Work Order (404 when not yet invoiced). */
  async getInvoice(actor: ActorContext, workOrderId: string): Promise<CustomerInvoice> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    const workOrder = await this.getAuthorizedWorkOrderForRead(actor, workOrderId);
    const invoice = await this.repo.findInvoiceByWorkOrder(actor.tenantId, workOrder.id);
    if (!invoice) {
      throw new NotFoundError("Invoice", workOrder.id);
    }
    return invoice;
  }

  /** Tenant default markup via the parameter bridge — trusted-caller read so
   * a billing manager does not also need `config.read`. Missing parameter or
   * value falls back to 0 (cost price). */
  private async resolveDefaultMarkupRate(tenantId: string): Promise<string> {
    const value = await this.configuration.getEffectiveParameterValueForTrustedCaller(
      tenantId,
      "service_operations.invoice.default_markup",
    );
    if (value === null || value === undefined || value === "") return "0";
    return String(value);
  }

  // =========================================================================
  // Work Order Serving Log (SO-CORE-016) — Last-mile meal tracking
  // =========================================================================

  /** Record a serving event: meals received, served, wasted, returned. */
  async recordServingLog(
    actor: ActorContext,
    workOrderId: string,
    input: {
      mealDate: string;
      mealType: "breakfast" | "lunch" | "dinner" | "snack";
      openingTime: Date;
      closingTime?: Date | null;
      receivedQty: string;
      servedQty: string;
      returnedQty: string;
      wastedQty: string;
      servicePointId?: string | null;
      servingSupervisorUserId?: string | null;
      notes?: string | null;
    },
  ): Promise<{ servingLog: WorkOrderServingLog; workOrder: WorkOrder }> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const workOrder = await this.getAuthorizedWorkOrder(actor, workOrderId);

    // Validate state: invoicing must have happened for serving to make sense.
    if (!workOrder.customerAcceptedAt) {
      throw new ConflictError("Serving can only be recorded on a customer-accepted Work Order");
    }

    // Validate quantities.
    const qty = {
      received: Number(input.receivedQty),
      served: Number(input.servedQty),
      returned: Number(input.returnedQty),
      wasted: Number(input.wastedQty),
    };
    if (!(qty.received > 0)) {
      throw new ValidationError("receivedQty must be greater than 0");
    }
    if (qty.served < 0 || qty.returned < 0 || qty.wasted < 0) {
      throw new ValidationError("servedQty, returnedQty, wastedQty must be >= 0");
    }
    if (qty.served + qty.returned + qty.wasted > qty.received) {
      throw new ValidationError("served + returned + wasted cannot exceed receivedQty");
    }

    // Generate serving number (idempotency: one serving log per WO).
    const existingServing = await this.repo.findServingLogByWorkOrder(workOrderId);
    if (existingServing) {
      throw new ConflictError("A serving log has already been recorded for this Work Order");
    }

    const { number: servingNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORK_ORDER_SERVING_NUMBERING_CODE,
      actor.userId,
    );

    const servingLog = await this.repo.createServingLog({
      tenantId: actor.tenantId,
      workOrderId,
      servingNumber,
      mealDate: input.mealDate,
      mealType: input.mealType,
      openingTime: input.openingTime,
      closingTime: input.closingTime ?? null,
      receivedQty: input.receivedQty,
      servedQty: input.servedQty,
      returnedQty: input.returnedQty,
      wastedQty: input.wastedQty,
      servicePointId: input.servicePointId ?? null,
      servingSupervisorUserId: input.servingSupervisorUserId ?? null,
      notes: input.notes ?? null,
      recordedBy: actor.userId,
    });

    // Mark the WO as serving-recorded.
    const updated = await this.repo.markWorkOrderServingRecorded(
      workOrderId,
      input.servingSupervisorUserId ?? null,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.serving_recorded",
      entityType: "work_order_serving_log",
      entityId: servingLog.id,
      metadata: {
        workOrderId,
        servingNumber,
        receivedQty: input.receivedQty,
        servedQty: input.servedQty,
        wastedQty: input.wastedQty,
      },
    });

    return { servingLog, workOrder: updated! };
  }

  /** Retrieve serving log for a Work Order (read tier). */
  async getServingLog(actor: ActorContext, workOrderId: string): Promise<WorkOrderServingLog> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    this.requireInternalActor(actor);
    const workOrder = await this.getAuthorizedWorkOrderForRead(actor, workOrderId);
    const servingLog = await this.repo.findServingLogByWorkOrder(workOrder.id);
    if (!servingLog) {
      throw new NotFoundError("ServingLog", workOrderId);
    }
    return servingLog;
  }

  /** Update serving log (adjust closing time, quantities, supervisor). */
  async updateServingLog(
    actor: ActorContext,
    workOrderId: string,
    input: {
      closingTime?: Date | null;
      servedQty?: string;
      returnedQty?: string;
      wastedQty?: string;
      servingSupervisorUserId?: string | null;
      notes?: string | null;
    },
  ): Promise<WorkOrderServingLog> {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    const workOrder = await this.getAuthorizedWorkOrder(actor, workOrderId);
    const servingLog = await this.repo.findServingLogByWorkOrder(workOrder.id);
    if (!servingLog) {
      throw new NotFoundError("ServingLog", workOrderId);
    }

    // Re-validate quantities if any are supplied.
    if (input.servedQty !== undefined || input.returnedQty !== undefined || input.wastedQty !== undefined) {
      const qty = {
        received: Number(servingLog.receivedQty),
        served: input.servedQty !== undefined ? Number(input.servedQty) : Number(servingLog.servedQty),
        returned: input.returnedQty !== undefined ? Number(input.returnedQty) : Number(servingLog.returnedQty),
        wasted: input.wastedQty !== undefined ? Number(input.wastedQty) : Number(servingLog.wastedQty),
      };
      if (qty.served + qty.returned + qty.wasted > qty.received) {
        throw new ValidationError("served + returned + wasted cannot exceed receivedQty");
      }
    }

    const updated = await this.repo.updateServingLog(servingLog.id, input);
    if (!updated) {
      throw new ValidationError("No fields supplied to update");
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.serving_updated",
      entityType: "work_order_serving_log",
      entityId: servingLog.id,
      metadata: { workOrderId, updates: Object.keys(input) },
    });

    return updated;
  }

  // --- Public (authless) token surface -------------------------------

  /** Minimal summary for the public sign-off page. Reveals nothing beyond
   * what the link holder needs to recognise the job. */
  async getAcceptanceSummary(
    rawToken: string,
  ): Promise<{ workOrderNumber: string; title: string; accepted: boolean; expiresAt: Date }> {
    const { token, workOrder } = await this.resolveLiveAcceptanceToken(rawToken);
    return {
      workOrderNumber: workOrder.workOrderNumber,
      title: workOrder.title,
      accepted: workOrder.customerAcceptedAt !== null,
      expiresAt: token.expiresAt,
    };
  }

  async acceptViaToken(rawToken: string, comment: string | null): Promise<{ workOrderNumber: string }> {
    const { token, workOrder } = await this.resolveLiveAcceptanceToken(rawToken);
    // Single-use: claim before acting so a concurrent double-submit loses.
    if (!(await this.repo.claimAcceptanceToken(token.id))) {
      throw new ConflictError("This acceptance link is no longer valid");
    }
    await this.customerAcceptWork(token.tenantId, workOrder.id, "token", comment, null);
    return { workOrderNumber: workOrder.workOrderNumber };
  }

  async rejectViaToken(rawToken: string, reason: string): Promise<{ workOrderNumber: string }> {
    const { token, workOrder } = await this.resolveLiveAcceptanceToken(rawToken);
    if (!(await this.repo.claimAcceptanceToken(token.id))) {
      throw new ConflictError("This acceptance link is no longer valid");
    }
    await this.customerRejectWork(token.tenantId, workOrder.id, reason, null);
    return { workOrderNumber: workOrder.workOrderNumber };
  }

  /** Hash lookup + liveness check. Unknown → 404; revoked/used/expired → 409
   * with a specific message (the link holder is not an attacker-oracle: the
   * token is 256 bits of entropy). */
  private async resolveLiveAcceptanceToken(
    rawToken: string,
  ): Promise<{ token: WorkOrderAcceptanceToken; workOrder: WorkOrder }> {
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const token = await this.repo.findAcceptanceTokenByHash(tokenHash);
    if (!token) throw new NotFoundError("Acceptance link", "token");
    if (token.revokedAt) throw new ConflictError("This acceptance link has been revoked");
    if (token.usedAt) throw new ConflictError("This acceptance link has already been used");
    if (token.expiresAt.getTime() <= Date.now()) throw new ConflictError("This acceptance link has expired");

    const workOrder = await this.repo.findWorkOrderById(token.workOrderId);
    if (!workOrder || workOrder.tenantId !== token.tenantId) {
      throw new NotFoundError("Acceptance link", "token");
    }
    return { token, workOrder };
  }

  // ===================================================================
  // Reads — SO-CORE-012 / SO-CORE-013 / SO-CORE-014
  // ===================================================================

  /** Coordinator/supervisor queue. Scoped to the customers the actor's Data
   * Scope covers. */
  // --- Project membership (owner request) --------------------------------

  async listProjectMembers(actor: ActorContext, projectId: string) {
    await this.rbac.requirePermission(actor, "service_operations.read");
    return this.repo.listProjectMembers(actor.tenantId, projectId);
  }

  async addProjectMember(actor: ActorContext, projectId: string, userId: string, roleCode: string | null) {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    await this.repo.addProjectMember(actor.tenantId, projectId, userId, roleCode, actor.userId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "project.member_added",
      entityType: "project",
      entityId: projectId,
      metadata: { userId, roleCode },
    });
  }

  async removeProjectMember(actor: ActorContext, projectId: string, userId: string) {
    await this.rbac.requirePermission(actor, "service_operations.manage");
    await this.repo.removeProjectMember(actor.tenantId, projectId, userId, actor.userId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "project.member_removed",
      entityType: "project",
      entityId: projectId,
      metadata: { userId },
    });
  }
  async listWorkOrders(
    actor: ActorContext,
    filter: { siteId?: string; status?: "open" | "completed" } = {},
  ): Promise<{ workOrder: WorkOrder; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    const customerIds = await this.customers.listScopedCustomerIdsForActor(actor);
    const tenantWide = actor.scopeType === "tenant";
    // Same visibility rule as the detail read (`isWorkOrderVisible`): assigned
    // to the actor, OR Customer Data Scope covers the customer, OR the actor is
    // associated with the Work Order's Workflow Instance. The association is
    // computed once for the whole list (two queries), not per row.
    const associated = tenantWide
      ? new Set<string>()
      : await this.workflow.listAssociatedInstanceIds(actor);
    const coveredCustomers = new Set(customerIds);
    const all = await this.repo.listWorkOrders(actor.tenantId, {
      siteId: filter.siteId,
      visibleTo: {
        customerIds,
        assignedToUserId: actor.userId,
        workflowInstanceIds: [...associated],
      },
    });
    const probes: WorkOrderVisibilityProbes = {
      customerCovered: async (customerId) => coveredCustomers.has(customerId),
      associated: async (instanceId) => associated.has(instanceId),
    };
    const visible: WorkOrder[] = [];
    for (const row of all) {
      if (await this.isWorkOrderVisible(actor, row, probes)) visible.push(row);
    }
    // Owner request: WO isolation. Tenant-wide readers (admins) see
    // everything; org/customer-scoped actors see WOs without a project, plus
    // WOs of projects they are an explicit member of. A Work Order routed to
    // the actor (assigned executor, or workflow-associated) is exempt: they
    // were explicitly given it and detail already shows it to them.
    let orders = visible;
    if (!tenantWide) {
      const memberOf = await this.repo.listUserProjectIds(actor.tenantId, actor.userId);
      orders = visible.filter(
        (row) =>
          row.projectId == null ||
          memberOf.has(row.projectId) ||
          row.assignedToUserId === actor.userId ||
          (row.workflowInstanceId != null && associated.has(row.workflowInstanceId)),
      );
    }
    const rows = await this.withStatus(actor, orders);
    if (!filter.status) return rows;
    // "open" → in_progress; "completed" → approved (workflow terminal state).
    const want = filter.status === "open" ? "in_progress" : "approved";
    return rows.filter((r) => r.status?.instanceStatus === want);
  }

  /** Field surface (SO-CORE-014): the work assigned to this actor. Reachable
   * without Customer Data Scope — an executor is authorised by assignment. */
  async listMyWork(actor: ActorContext): Promise<{ workOrder: WorkOrder; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "service_operations.execute");
    const orders = await this.repo.listWorkOrders(actor.tenantId, { assignedToUserId: actor.userId });
    return this.withStatus(actor, orders);
  }

  async getWorkOrderDetail(actor: ActorContext, id: string): Promise<WorkOrderDetailView> {
    await this.rbac.requirePermission(actor, "service_operations.read");
    // Site-scoping: a Work Order outside the actor's Data Scope is
    // indistinguishable from a missing one on the READ path (404, no
    // existence disclosure). Mutations keep the 403 of getAuthorizedWorkOrder.
    const workOrder = await this.getAuthorizedWorkOrderForRead(actor, id);
    const [serviceDefinition, checklist] = await Promise.all([
      this.repo.findServiceDefinitionById(workOrder.serviceDefinitionId),
      this.repo.listWorkOrderChecklistItems(workOrder.id),
    ]);

    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (workOrder.workflowInstanceId) {
      status = await this.workflow.getEntityStatus(actor, workOrder.workflowInstanceId);
      const view = await this.workflow.getEntityWorkflowView(actor, workOrder.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }
    if (this.isCustomerActor(actor)) {
      return {
        workOrder: this.redactWorkOrder(workOrder),
        serviceDefinition,
        checklist: checklist.map((item) => ({ ...item, note: null, completedByUserId: null })),
        status: redactStatus(status),
        availableActions,
      };
    }
    return { workOrder, serviceDefinition, checklist, status, availableActions };
  }

  /** Document Core authorization hook (SO-CORE-009) — evidence attached to a
   * Work Order inherits the Work Order's own authorization (ADR-0012). */
  async canAccessForDocument(actor: ActorContext, workOrderId: string): Promise<boolean> {
    const workOrder = await this.repo.findWorkOrderById(workOrderId);
    if (!workOrder || workOrder.tenantId !== actor.tenantId) return false;
    return this.isAuthorizedForWorkOrder(actor, workOrder);
  }

  // ===================================================================
  // Internals
  // ===================================================================

  private async createWorkOrderInternal(
    actor: ActorContext,
    input: {
      workRequestId: string | null;
      customerId: string;
      contractId: string | null;
      woType?: WorkOrderType;
      projectId: string | null;
      siteId: string | null;
      definition: ServiceDefinition;
      title: string;
      description: string | null;
      priority: string | null;
      plannedStartAt: string | null;
      plannedEndAt: string | null;
      dueAt: string | null;
    },
  ): Promise<WorkOrder> {
    const customer = await this.customers.getAuthorized(actor, input.customerId);
    const { number } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORK_ORDER_NUMBERING_CODE,
      actor.userId,
    );

    const workOrder = await this.repo.createWorkOrder({
      tenantId: actor.tenantId,
      workOrderNumber: number,
      workRequestId: input.workRequestId,
      customerId: customer.id,
      contractId: input.contractId,
      woType: input.woType ?? "regular",
      projectId: input.projectId,
      siteId: input.siteId,
      serviceDefinitionId: input.definition.id,
      title: input.title,
      description: input.description,
      priority: input.priority,
      plannedStartAt: parseDate(input.plannedStartAt, "plannedStartAt"),
      plannedEndAt: parseDate(input.plannedEndAt, "plannedEndAt"),
      dueAt: parseDate(input.dueAt, "dueAt"),
      createdBy: actor.userId,
    });

    // Snapshot the checklist template so later edits to the Service
    // Definition cannot rewrite the history of executed work.
    const template = await this.repo.listChecklistTemplateItems(input.definition.id);
    if (template.length > 0) {
      await this.repo.createWorkOrderChecklistItems(
        workOrder.id,
        template.map((t) => ({
          sourceChecklistItemId: t.id,
          code: t.code,
          label: t.label,
          isRequired: t.isRequired,
          sortOrder: t.sortOrder,
        })),
      );
    }

    // Lifecycle is owned by the Workflow Engine, started at the Tenant's
    // configured initial Step. `organizationUnitId` lets `submitter_unit`
    // assignment rules route to the Customer's own owning team without this
    // service knowing anything about routing.
    const { instance } = await this.workflow.startInstance(actor, {
      definitionCode: WORK_ORDER_WORKFLOW_DEFINITION_CODE,
      entityId: workOrder.id,
      contextData: {
        customerId: customer.id,
        organizationUnitId: customer.ownerOrganizationUnitId,
        serviceDefinitionCode: input.definition.code,
        priority: input.priority,
        siteId: input.siteId,
      },
    });
    await this.repo.setWorkOrderWorkflowInstance(workOrder.id, instance.id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "work_order.created",
      entityType: "work_order",
      entityId: workOrder.id,
      metadata: {
        workOrderNumber: number,
        customerId: customer.id,
        serviceDefinitionCode: input.definition.code,
        workRequestId: input.workRequestId,
      },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "work_order.created",
      entityType: "work_order",
      entityId: workOrder.id,
      payload: {
        workOrderNumber: number,
        customerId: customer.id,
        targetUserId: actor.userId,
        serviceDefinitionCode: input.definition.code,
      },
      createdBy: actor.userId,
    });

    return (await this.repo.findWorkOrderById(workOrder.id))!;
  }

  private async withStatus(actor: ActorContext, orders: WorkOrder[]) {
    const customer = this.isCustomerActor(actor);
    const rows: { workOrder: WorkOrder; status: EntityWorkflowStatus | null }[] = [];
    for (const workOrder of orders) {
      let status: EntityWorkflowStatus | null = null;
      if (workOrder.workflowInstanceId) {
        status = await this.workflow.getEntityStatus(actor, workOrder.workflowInstanceId);
      }
      rows.push({
        workOrder: customer ? this.redactWorkOrder(workOrder) : workOrder,
        status: customer ? redactStatus(status) : status,
      });
    }
    return rows;
  }

  // ===================================================================
  // Customer-safe projection (Epic 4 §4.4 line 3)
  // ===================================================================

  /** True when the actor's ACTIVE assignment is customer-scoped. Such an actor
   * sees the internal operational surface filtered: no internal staff
   * identities and no internal notes. Internal actors are unaffected. */
  private isCustomerActor(actor: ActorContext): boolean {
    return actor.assignmentId !== null && actor.scopeType === "customer";
  }

  /** Internal-only surface: cost breakdowns and supplier prices have no
   * customer axis, so a customer-scoped actor is refused outright rather
   * than shown a partial view. Same posture as Complaint's internal view. */
  private requireInternalActor(actor: ActorContext): void {
    if (this.isCustomerActor(actor)) {
      throw new ForbiddenError("This area is available to internal operational users only");
    }
  }

  /** Drops the staff identities and internal notes carried by a Work Order.
   * Customer acceptance facts are the customer's own words — kept. */
  private redactWorkOrder(workOrder: WorkOrder): WorkOrder {
    return {
      ...workOrder,
      assignedToUserId: null,
      assignedByUserId: null,
      startedByUserId: null,
      completedByUserId: null,
      verifiedByUserId: null,
      completionNotes: null,
      verificationNotes: null,
    };
  }

  private async requireAnyOperationalCapability(actor: ActorContext): Promise<void> {
    const permissions = await this.rbac.getActivePermissions(actor);
    const allowed = ["service_operations.manage", "service_operations.execute", "service_operations.verify"];
    if (!allowed.some((code) => permissions.has(code))) {
      throw new ForbiddenError("You do not hold an operational capability for Service Operations");
    }
  }

  private async getServiceDefinitionOrThrow(tenantId: string, code: string): Promise<ServiceDefinition> {
    const definition = await this.repo.findServiceDefinitionByCode(tenantId, code);
    if (!definition) throw new NotFoundError("ServiceDefinition", code);
    return definition;
  }

  private async getActiveServiceDefinitionOrThrow(tenantId: string, code: string): Promise<ServiceDefinition> {
    const definition = await this.getServiceDefinitionOrThrow(tenantId, code);
    if (!definition.isActive) throw new ConflictError(`Service Definition '${code}' is not active`);
    return definition;
  }

  private async getAuthorizedWorkRequest(actor: ActorContext, id: string): Promise<WorkRequest> {
    const request = await this.repo.findWorkRequestById(id);
    if (!request || request.tenantId !== actor.tenantId) throw new NotFoundError("WorkRequest", id);
    const allowed = await this.customers.canAccessForDocument(actor, request.customerId);
    if (!allowed) throw new ForbiddenError("Your Data Scope does not cover this Work Request");
    return request;
  }

  /**
   * Work Order visibility (SO-CORE-012): Customer Data Scope OR the actor is
   * the assigned executor OR the actor is associated with the Work Order's
   * Workflow Instance. The assignee path matters because a field executor is
   * authorised by assignment, not by owning the Customer's scope.
   */
  private async getAuthorizedWorkOrder(actor: ActorContext, id: string): Promise<WorkOrder> {
    const workOrder = await this.repo.findWorkOrderById(id);
    if (!workOrder || workOrder.tenantId !== actor.tenantId) throw new NotFoundError("WorkOrder", id);
    if (!(await this.isAuthorizedForWorkOrder(actor, workOrder))) {
      throw new ForbiddenError("Your Data Scope does not cover this Work Order");
    }
    return workOrder;
  }

  /** READ-path variant: an out-of-scope Work Order is indistinguishable from a
   * missing one (404, no existence disclosure) - detail, cost items, invoice,
   * serving log. Mutations keep `getAuthorizedWorkOrder`'s 403 (the caller
   * already holds the capability; the refusal is about scope, not existence). */
  private async getAuthorizedWorkOrderForRead(actor: ActorContext, id: string): Promise<WorkOrder> {
    return this.getAuthorizedWorkOrder(actor, id).catch((error: unknown) => {
      if (error instanceof ForbiddenError) throw new NotFoundError("WorkOrder", id);
      throw error;
    });
  }

  private async isAuthorizedForWorkOrder(actor: ActorContext, workOrder: WorkOrder): Promise<boolean> {
    return this.isWorkOrderVisible(actor, workOrder, {
      customerCovered: (customerId) => this.customers.canAccessForDocument(actor, customerId),
      associated: (instanceId) => this.workflow.isActorAssociatedWithInstance(actor, instanceId),
    });
  }

  /** THE Work Order visibility rule, shared by the detail/sub-resource gate
   * (live probes) and the list/dashboard (set-backed probes) so they cannot
   * drift: assigned executor, OR Customer Data Scope covers the customer, OR
   * associated with the Work Order's Workflow Instance. */
  private async isWorkOrderVisible(
    actor: ActorContext,
    workOrder: WorkOrder,
    probes: WorkOrderVisibilityProbes,
  ): Promise<boolean> {
    if (workOrder.assignedToUserId === actor.userId) return true;
    if (await probes.customerCovered(workOrder.customerId)) return true;
    return !!workOrder.workflowInstanceId && (await probes.associated(workOrder.workflowInstanceId));
  }

  /** Only the assigned executor may record execution facts. A Work Order
   * with no assignee yet may be executed by any holder of the execute
   * capability whose scope already covers it. */
  private assertExecutor(actor: ActorContext, workOrder: WorkOrder): void {
    if (workOrder.assignedToUserId && workOrder.assignedToUserId !== actor.userId) {
      throw new ForbiddenError("This Work Order is assigned to another executor");
    }
  }
}

interface WorkOrderVisibilityProbes {
  customerCovered(customerId: string): Promise<boolean>;
  associated(instanceId: string): Promise<boolean>;
}

/** Workflow status carries the pending Assignment's staff id — null it for a
 * customer-scoped reader. `isMine` is harmless (it is the reader's own id). */
function redactStatus(status: EntityWorkflowStatus | null): EntityWorkflowStatus | null {
  if (!status?.assignment) return status;
  return { ...status, assignment: { ...status.assignment, userId: null } };
}

function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} is not a valid date`);
  return date;
}

/** Validate a markup/tax rate: decimal string, 0 ≤ rate ≤ 1, at most 6
 * decimals (matches NUMERIC(8,6)). Rejects negatives, >1, and malformed
 * strings before they reach SQL. */
function validateRate(value: string, field: string): void {
  if (!/^0(\.\d{1,6})?$|^1(\.0{1,6})?$/.test(value)) {
    throw new ValidationError(`${field} must be a decimal between 0 and 1 with at most 6 decimals`);
  }
}
