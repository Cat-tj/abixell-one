import type { ContractRepository } from "../../domain/customer/contract.entity.js";
import type { DomainEvent } from "../../domain/event/event.entity.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../domain/shared-kernel/errors.js";
import {
  addBusinessMinutes,
  assertValidTimeZone,
  type BusinessCalendarDefinition,
  type WorkweekWindow,
} from "../../domain/service-quality/business-calendar.js";
import type {
  AutomationProposal,
  AutomationTriggerEvent,
  CapaActionType,
  CapaStatus,
  CapaVerdict,
  CreateAutomationRuleInput,
  CreateBusinessCalendarInput,
  CreateCapaActionInput,
  CreateRcaFindingInput,
  CreateRecurrenceRuleInput,
  CreateRootCauseCategoryInput,
  CreateSlaPolicyInput,
  CreateSlaRuleInput,
  ProposalStatus,
  RecurrenceDetection,
  ServiceQualityReconciliationResult,
  ServiceQualityRepository,
  SlaMatchContext,
  SlaTarget,
} from "../../domain/service-quality/service-quality.entity.js";
import {
  matchedDimensions,
  selectSlaRule,
} from "../../domain/service-quality/sla-matching.js";
import type { AuditService } from "../audit/audit.service.js";
import type { ComplaintService } from "../complaint/complaint.service.js";
import type { ConfigurationService } from "../configuration/configuration.service.js";
import type { CustomerService } from "../customer/customer.service.js";
import type { EventBus } from "../event/event-bus.js";
import type { RbacService } from "../rbac/rbac.service.js";
import type { WorkflowService } from "../workflow/workflow.service.js";

export const SERVICE_QUALITY_READ_PERMISSION = "service_quality.read";
export const SERVICE_QUALITY_CONFIGURE_PERMISSION = "service_quality.configure";
export const SERVICE_QUALITY_RCA_MANAGE_PERMISSION = "service_quality.rca.manage";
export const SERVICE_QUALITY_CAPA_MANAGE_PERMISSION = "service_quality.capa.manage";
export const SERVICE_QUALITY_CAPA_VERIFY_PERMISSION = "service_quality.capa.verify";
export const SERVICE_QUALITY_AUTOMATION_READ_PERMISSION = "service_quality.automation.read";
export const SERVICE_QUALITY_AUTOMATION_APPROVE_PERMISSION = "service_quality.automation.approve";

export const RCA_ANALYSIS_METHOD_REF_TYPE = "rca_analysis_method";
export const CAPA_NUMBERING_CODE = "capa_action";
export const CAPA_WORKFLOW_DEFINITION_CODE = "capa_lifecycle";
const COMPLAINT_CATEGORY_REF_TYPE = "complaint_category";
const COMPLAINT_SEVERITY_REF_TYPE = "complaint_severity";

type CreateCalendarInput = Omit<CreateBusinessCalendarInput, "tenantId">;
type CreatePolicyInput = Omit<CreateSlaPolicyInput, "tenantId">;
type CreateRuleInput = Omit<CreateSlaRuleInput, "tenantId">;
type CreateCategoryInput = Omit<CreateRootCauseCategoryInput, "tenantId">;
type CreateFindingInput = Omit<CreateRcaFindingInput, "tenantId">;
type CreateRecurrenceInput = Omit<CreateRecurrenceRuleInput, "tenantId">;
type CreateAutoRuleInput = Omit<CreateAutomationRuleInput, "tenantId">;

/**
 * Wave A1 / SQ-ADV-001…004 — Service Quality Advanced.
 *
 * Complaint remains the owning business aggregate; this service stores only
 * frozen, explainable SLA projections, structured RCA & CAPA actions, recurrence
 * analytics, and proposal-only feedback automation. Lifecycle transitions are
 * delegated to Workflow Engine (CAPA) or Complaint Core (Complaint).
 */
export class ServiceQualityService {
  constructor(
    private readonly repo: ServiceQualityRepository,
    private readonly complaints: ComplaintService,
    private readonly contractRepo: ContractRepository,
    private readonly customers: CustomerService,
    private readonly configuration: ConfigurationService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly eventBus: EventBus,
    private readonly workflow: WorkflowService,
    private readonly onEventError: (eventType: string, error: unknown) => void = () => {},
  ) {}

  // --- Configuration -------------------------------------------------------

  async createCalendar(actor: ActorContext, input: CreateCalendarInput) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    assertValidTimeZone(input.timeZone);
    this.assertCalendarWindows(input.windows, input.isContinuous ?? false);

    try {
      const calendar = await this.repo.createCalendar(
        { ...input, tenantId: actor.tenantId },
        actor.userId,
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.calendar.created",
        entityType: "service_business_calendar",
        entityId: calendar.id,
        metadata: {
          code: calendar.code,
          timeZone: calendar.timeZone,
          isContinuous: calendar.isContinuous,
          isDefault: calendar.isDefault,
          windowCount: input.windows.length,
        },
      });
      return { calendar, windows: await this.repo.listCalendarWindows(actor.tenantId, calendar.id) };
    } catch (error) {
      this.mapUniqueViolation(error, `Business calendar '${input.code}' already exists`);
    }
  }

  async listCalendars(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const calendars = await this.repo.listCalendars(actor.tenantId);
    return Promise.all(
      calendars.map(async (calendar) => ({
        calendar,
        windows: await this.repo.listCalendarWindows(actor.tenantId, calendar.id),
        holidays: await this.repo.listHolidays(actor.tenantId, calendar.id),
      })),
    );
  }

  async addHoliday(
    actor: ActorContext,
    calendarId: string,
    input: { holidayDate: string; name: string },
  ) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    const calendar = await this.repo.findCalendarById(actor.tenantId, calendarId);
    if (!calendar) throw new NotFoundError("BusinessCalendar", calendarId);

    try {
      const holiday = await this.repo.addHoliday(
        actor.tenantId,
        calendar.id,
        input.holidayDate,
        input.name,
        actor.userId,
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.calendar_holiday.created",
        entityType: "service_calendar_holiday",
        entityId: holiday.id,
        metadata: { calendarCode: calendar.code, holidayDate: holiday.holidayDate },
      });
      return holiday;
    } catch (error) {
      this.mapUniqueViolation(
        error,
        `Holiday '${input.holidayDate}' already exists on calendar '${calendar.code}'`,
      );
    }
  }

  async createSlaPolicy(actor: ActorContext, input: CreatePolicyInput) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    const calendar = await this.repo.findCalendarById(actor.tenantId, input.calendarId);
    if (!calendar) throw new NotFoundError("BusinessCalendar", input.calendarId);
    if (!calendar.isActive) throw new ConflictError("The selected business calendar is inactive");

    try {
      const policy = await this.repo.createSlaPolicy(
        { ...input, tenantId: actor.tenantId },
        actor.userId,
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.sla_policy.created",
        entityType: "service_sla_policy",
        entityId: policy.id,
        metadata: { code: policy.code, calendarCode: calendar.code },
      });
      return policy;
    } catch (error) {
      this.mapUniqueViolation(error, `SLA policy '${input.code}' already exists`);
    }
  }

  async getConfigurationOptions(actor: ActorContext) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    const [severities, categories] = await Promise.all([
      this.configuration.listReferenceDataItemsForTrustedCaller(
        actor.tenantId,
        COMPLAINT_SEVERITY_REF_TYPE,
      ),
      this.configuration.listReferenceDataItemsForTrustedCaller(
        actor.tenantId,
        COMPLAINT_CATEGORY_REF_TYPE,
      ),
    ]);
    const active = (items: { code: string; label: string; isActive: boolean }[]) =>
      items.filter((item) => item.isActive).map(({ code, label }) => ({ code, label }));
    return { severities: active(severities), categories: active(categories) };
  }

  async listSlaPolicies(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const policies = await this.repo.listSlaPolicies(actor.tenantId);
    return Promise.all(
      policies.map(async (policy) => ({
        policy,
        calendar: await this.repo.findCalendarById(actor.tenantId, policy.calendarId),
        rules: await this.repo.listSlaRules(actor.tenantId, policy.id),
      })),
    );
  }

  async createSlaRule(actor: ActorContext, input: CreateRuleInput) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    const policy = await this.repo.findSlaPolicyById(actor.tenantId, input.policyId);
    if (!policy) throw new NotFoundError("SlaPolicy", input.policyId);
    if (!policy.isActive) throw new ConflictError("The selected SLA policy is inactive");
    if (input.responseMinutes == null && input.resolutionMinutes == null) {
      throw new ValidationError("At least one response or resolution commitment is required");
    }
    await Promise.all([
      this.assertActiveReferenceCode(
        actor.tenantId,
        COMPLAINT_SEVERITY_REF_TYPE,
        input.severityCode ?? null,
        "severity",
      ),
      this.assertActiveReferenceCode(
        actor.tenantId,
        COMPLAINT_CATEGORY_REF_TYPE,
        input.categoryCode ?? null,
        "category",
      ),
    ]);

    if (input.customerId) {
      await this.customers.getAuthorizedForPermission(
        actor,
        input.customerId,
        SERVICE_QUALITY_CONFIGURE_PERMISSION,
      );
    }
    if (input.contractId) {
      const contract = await this.contractRepo.findById(input.contractId);
      if (!contract || contract.tenantId !== actor.tenantId) {
        throw new NotFoundError("Contract", input.contractId);
      }
      if (input.customerId && contract.customerId !== input.customerId) {
        throw new ValidationError("The SLA rule contract does not belong to its customer dimension");
      }
      await this.customers.getAuthorizedForPermission(
        actor,
        contract.customerId,
        SERVICE_QUALITY_CONFIGURE_PERMISSION,
      );
    }

    try {
      const rule = await this.repo.createSlaRule(
        { ...input, tenantId: actor.tenantId },
        actor.userId,
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.sla_rule.created",
        entityType: "service_sla_rule",
        entityId: rule.id,
        metadata: {
          policyCode: policy.code,
          ruleCode: rule.code,
          customerId: rule.customerId,
          contractId: rule.contractId,
          severityCode: rule.severityCode,
          categoryCode: rule.categoryCode,
          responseMinutes: rule.responseMinutes,
          resolutionMinutes: rule.resolutionMinutes,
          priority: rule.priority,
        },
      });
      return rule;
    } catch (error) {
      this.mapUniqueViolation(
        error,
        `SLA rule '${input.code}' already exists in policy '${policy.code}'`,
      );
    }
  }

  // --- Frozen targets ------------------------------------------------------

  async getComplaintSla(actor: ActorContext, complaintId: string) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const complaint = await this.getComplaintForPermission(
      actor,
      complaintId,
      SERVICE_QUALITY_READ_PERMISSION,
    );
    const target = await this.repo.findSlaTargetByComplaint(actor.tenantId, complaint.id);
    return {
      target,
      state: this.projectSlaState(target, new Date()),
    };
  }

  async getSlaPerformance(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const customerIds = await this.customers.listScopedCustomerIdsForPermission(
      actor,
      SERVICE_QUALITY_READ_PERMISSION,
    );
    return this.repo.summariseSlaPerformance(actor.tenantId, customerIds, new Date());
  }

  /** Trusted Complaint-lifecycle seam. Idempotent by the complaint unique
   * constraint: a replay never re-resolves against edited policy data. */
  async assignTargetForComplaint(
    tenantId: string,
    complaintId: string,
    createdBy: string | null,
  ): Promise<SlaTarget | null> {
    const existing = await this.repo.findSlaTargetByComplaint(tenantId, complaintId);
    if (existing) return existing;

    const complaint = await this.complaints.getForTrustedCaller(tenantId, complaintId);
    if (!complaint || !complaint.submittedAt) return null;
    const startedAt = complaint.submittedAt;
    const context: SlaMatchContext = {
      customerId: complaint.customerId,
      contractId: complaint.contractId,
      severityCode: complaint.severity,
      categoryCode: complaint.category,
    };
    const rule = selectSlaRule(
      await this.repo.listCandidateSlaRules(tenantId, context),
      context,
    );
    if (!rule) return null;

    const policy = await this.repo.findSlaPolicyById(tenantId, rule.policyId);
    if (!policy || !policy.isActive) return null;
    const calendar = await this.repo.findCalendarById(tenantId, policy.calendarId);
    if (!calendar || !calendar.isActive) return null;
    const definition = await this.loadCalendarDefinition(tenantId, calendar.id);

    const responseDue = rule.responseMinutes
      ? addBusinessMinutes(startedAt, rule.responseMinutes, definition)
      : null;
    const resolutionDue = rule.resolutionMinutes
      ? addBusinessMinutes(startedAt, rule.resolutionMinutes, definition)
      : null;
    if (responseDue?.unreachable || resolutionDue?.unreachable) {
      throw new ConflictError(
        `Business calendar '${calendar.code}' has no reachable working window`,
      );
    }

    const result = await this.repo.createSlaTargetIfAbsent(
      {
        tenantId,
        complaintId,
        policyId: policy.id,
        ruleId: rule.id,
        calendarId: calendar.id,
        policyCodeSnapshot: policy.code,
        ruleCodeSnapshot: rule.code,
        calendarCodeSnapshot: calendar.code,
        timeZoneSnapshot: calendar.timeZone,
        matchedDimensions: matchedDimensions(rule),
        startedAt,
        responseMinutes: rule.responseMinutes,
        resolutionMinutes: rule.resolutionMinutes,
        responseDueAt: responseDue?.dueAt ?? null,
        resolutionDueAt: resolutionDue?.dueAt ?? null,
      },
      createdBy,
    );

    if (result.created) {
      await this.audit.record({
        tenantId,
        actorUserId: createdBy,
        action: "service_quality.sla_target.assigned",
        entityType: "complaint_sla_target",
        entityId: result.target.id,
        metadata: {
          complaintId,
          policyCode: policy.code,
          ruleCode: rule.code,
          calendarCode: calendar.code,
          matchedDimensions: result.target.matchedDimensions,
          responseMinutes: result.target.responseMinutes,
          resolutionMinutes: result.target.resolutionMinutes,
        },
      });
    }
    return result.target;
  }

  async markFirstResponseForComplaint(
    tenantId: string,
    complaintId: string,
    at: Date,
  ): Promise<SlaTarget | null> {
    const target = await this.repo.findSlaTargetByComplaint(tenantId, complaintId);
    if (!target) return null;
    const breached = !!target.responseDueAt && at.getTime() > target.responseDueAt.getTime();
    return this.repo.markFirstResponse(tenantId, complaintId, at, breached);
  }

  async markResolvedForComplaint(
    tenantId: string,
    complaintId: string,
    at: Date,
  ): Promise<SlaTarget | null> {
    const target = await this.repo.findSlaTargetByComplaint(tenantId, complaintId);
    if (!target) return null;
    const breached = !!target.resolutionDueAt && at.getTime() > target.resolutionDueAt.getTime();
    const updated = await this.repo.markResolved(tenantId, complaintId, at, breached);
    if (!target.resolvedAt && breached) {
      await this.eventBus.publish({
        tenantId,
        eventType: "service_quality.sla_resolution_breached",
        entityType: "complaint",
        entityId: complaintId,
        payload: {
          complaintId,
          targetId: target.id,
          policyCode: target.policyCodeSnapshot,
          ruleCode: target.ruleCodeSnapshot,
          dueAt: target.resolutionDueAt?.toISOString() ?? null,
        },
        createdBy: null,
      });
    }
    return updated;
  }

  /** EventBus choreography. The immediate path keeps the projection current;
   * a durable receipt plus Scheduler reconciliation closes the process-crash
   * window without coupling Complaint transitions to Service Quality. */
  async handleComplaintEvent(event: DomainEvent): Promise<void> {
    if (!this.isRelevantComplaintEvent(event)) return;
    try {
      await this.projectComplaintLifecycleEvent(event);
      await this.repo.recordLifecycleEventProcessed(event.tenantId, event.id);
    } catch (error) {
      this.onEventError(event.eventType, error);
    }
  }

  async reconcileComplaintLifecycleEvents(
    tenantId: string,
    limit = 500,
  ): Promise<ServiceQualityReconciliationResult> {
    const events = await this.repo.listPendingLifecycleEvents(tenantId, limit);
    let processed = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.projectComplaintLifecycleEvent({
          id: event.id,
          tenantId: event.tenantId,
          eventType: event.eventType,
          entityType: "complaint",
          entityId: event.complaintId,
          payload: {},
          occurredAt: event.occurredAt,
          createdBy: event.createdBy,
        });
        await this.repo.recordLifecycleEventProcessed(event.tenantId, event.id);
        processed += 1;
      } catch (error) {
        failed += 1;
        this.onEventError(event.eventType, error);
      }
    }
    return { scanned: events.length, processed, failed };
  }

  private isRelevantComplaintEvent(
    event: DomainEvent,
  ): event is DomainEvent & { entityId: string } {
    return (
      event.entityType === "complaint" &&
      event.entityId !== null &&
      (event.eventType === "complaint.submitted" ||
        event.eventType === "complaint.acknowledged" ||
        event.eventType === "complaint.customer_confirmed")
    );
  }

  private async projectComplaintLifecycleEvent(
    event: DomainEvent & { entityId: string },
  ): Promise<void> {
    if (event.eventType === "complaint.submitted") {
      await this.assignTargetForComplaint(event.tenantId, event.entityId, event.createdBy);
      return;
    }
    if (event.eventType === "complaint.acknowledged") {
      await this.markFirstResponseForComplaint(event.tenantId, event.entityId, event.occurredAt);
      return;
    }
    if (event.eventType === "complaint.customer_confirmed") {
      await this.markResolvedForComplaint(event.tenantId, event.entityId, event.occurredAt);
    }
  }

  private async assertActiveReferenceCode(
    tenantId: string,
    typeCode: string,
    code: string | null,
    field: string,
  ): Promise<void> {
    if (!code) return;
    const items = await this.configuration.listReferenceDataItemsForTrustedCaller(
      tenantId,
      typeCode,
    );
    if (!items.some((item) => item.code === code && item.isActive)) {
      throw new ValidationError(`Unknown or inactive ${field} code '${code}'`);
    }
  }

  private async loadCalendarDefinition(
    tenantId: string,
    calendarId: string,
  ): Promise<BusinessCalendarDefinition> {
    const calendar = await this.repo.findCalendarById(tenantId, calendarId);
    if (!calendar) throw new NotFoundError("BusinessCalendar", calendarId);
    const [windows, holidays] = await Promise.all([
      this.repo.listCalendarWindows(tenantId, calendar.id),
      this.repo.listHolidays(tenantId, calendar.id),
    ]);
    return {
      timeZone: calendar.timeZone,
      isContinuous: calendar.isContinuous,
      windows,
      holidays: new Set(holidays.map((holiday) => holiday.holidayDate)),
    };
  }

  // --- SQ-ADV-002: Structured RCA -----------------------------------------

  async createRootCauseCategory(actor: ActorContext, input: CreateCategoryInput) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    if (input.parentId) {
      const parent = await this.repo.findRootCauseCategoryById(actor.tenantId, input.parentId);
      if (!parent) throw new NotFoundError("RootCauseCategory", input.parentId);
    }

    try {
      const category = await this.repo.createRootCauseCategory(
        { ...input, tenantId: actor.tenantId },
        actor.userId,
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.rca_category.created",
        entityType: "service_root_cause_category",
        entityId: category.id,
        metadata: { code: category.code, parentId: category.parentId },
      });
      return category;
    } catch (error) {
      this.mapUniqueViolation(error, `Root cause category '${input.code}' already exists`);
    }
  }

  async listRootCauseCategories(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    return this.repo.listRootCauseCategories(actor.tenantId);
  }

  async recordRcaFinding(actor: ActorContext, input: CreateFindingInput) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_RCA_MANAGE_PERMISSION,
    );
    const complaint = await this.getComplaintForPermission(
      actor,
      input.complaintId,
      SERVICE_QUALITY_RCA_MANAGE_PERMISSION,
    );
    const category = await this.repo.findRootCauseCategoryById(
      actor.tenantId,
      input.rootCauseCategoryId,
    );
    if (!category || !category.isActive) {
      throw new NotFoundError("RootCauseCategory", input.rootCauseCategoryId);
    }
    await this.assertActiveReferenceCode(
      actor.tenantId,
      RCA_ANALYSIS_METHOD_REF_TYPE,
      input.analysisMethodCode ?? null,
      "RCA analysis method",
    );

    const finding = await this.repo.createRcaFinding(
      { ...input, tenantId: actor.tenantId },
      actor.userId,
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_quality.rca_finding.recorded",
      entityType: "complaint_rca_finding",
      entityId: finding.id,
      metadata: {
        complaintId: complaint.id,
        rootCauseCategoryCode: category.code,
        isPrimary: finding.isPrimary,
        analysisMethodCode: finding.analysisMethodCode,
      },
    });
    return finding;
  }

  async listRcaFindings(actor: ActorContext, complaintId: string) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const complaint = await this.getComplaintForPermission(
      actor,
      complaintId,
      SERVICE_QUALITY_READ_PERMISSION,
    );
    return this.repo.listRcaFindings(actor.tenantId, complaint.id);
  }

  async clearPrimaryRcaFinding(actor: ActorContext, complaintId: string) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_RCA_MANAGE_PERMISSION,
    );
    const complaint = await this.getComplaintForPermission(
      actor,
      complaintId,
      SERVICE_QUALITY_RCA_MANAGE_PERMISSION,
    );
    await this.repo.clearPrimaryRcaFinding(actor.tenantId, complaint.id, actor.userId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_quality.rca_finding.primary_cleared",
      entityType: "complaint",
      entityId: complaint.id,
    });
  }

  // --- SQ-ADV-002: Advanced CAPA -------------------------------------------

  async createCapaAction(
    actor: ActorContext,
    input: Omit<CreateCapaActionInput, "tenantId" | "actionNumber">,
  ) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CAPA_MANAGE_PERMISSION,
    );
    const { complaint, customer } = await this.getComplaintAndCustomerForPermission(
      actor,
      input.complaintId,
      SERVICE_QUALITY_CAPA_MANAGE_PERMISSION,
    );
    if (input.rcaFindingId) {
      const finding = await this.repo.findRcaFindingById(actor.tenantId, input.rcaFindingId);
      if (!finding || finding.complaintId !== complaint.id) {
        throw new NotFoundError("RcaFinding", input.rcaFindingId);
      }
    }

    const { number: actionNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      CAPA_NUMBERING_CODE,
      actor.userId,
    );

    const action = await this.repo.createCapaAction(
      {
        ...input,
        tenantId: actor.tenantId,
        actionNumber,
      },
      actor.userId,
    );

    // Delegate lifecycle to Workflow Engine if the definition exists for tenant
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: CAPA_WORKFLOW_DEFINITION_CODE,
        entityId: action.id,
        contextData: {
          complaintId: complaint.id,
          customerId: complaint.customerId,
          // ADR-0012: the owning unit follows the parent (Complaint -> Customer),
          // exactly as the Complaint's own Instance does, so org-unit-scoped
          // managers keep seeing the CAPA task.
          organizationUnitId: customer.ownerOrganizationUnitId,
          actionNumber,
        },
      });
      await this.repo.setCapaWorkflowInstance(actor.tenantId, action.id, instance.id);
      action.workflowInstanceId = instance.id;
    } catch {
      // If workflow definition isn't provisioned yet for tenant, CAPA action remains stand-alone
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_quality.capa_action.created",
      entityType: "capa_action",
      entityId: action.id,
      metadata: {
        actionNumber: action.actionNumber,
        complaintId: complaint.id,
        actionType: action.actionType,
        rcaFindingId: action.rcaFindingId,
      },
    });
    return action;
  }

  async listCapaActionsForComplaint(actor: ActorContext, complaintId: string) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const complaint = await this.getComplaintForPermission(
      actor,
      complaintId,
      SERVICE_QUALITY_READ_PERMISSION,
    );
    return this.repo.listCapaActions(actor.tenantId, complaint.id);
  }

  async listCapaActions(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const customerIds = await this.customers.listScopedCustomerIdsForPermission(
      actor,
      SERVICE_QUALITY_READ_PERMISSION,
    );
    return this.repo.listCapaActionsByCustomers(actor.tenantId, customerIds);
  }

  async updateCapaStatus(
    actor: ActorContext,
    id: string,
    status: CapaStatus,
    extra?: { completionNote?: string },
  ) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CAPA_MANAGE_PERMISSION,
    );
    const action = await this.repo.findCapaActionById(actor.tenantId, id);
    if (!action) throw new NotFoundError("CapaAction", id);
    await this.getComplaintForPermission(
      actor,
      action.complaintId,
      SERVICE_QUALITY_CAPA_MANAGE_PERMISSION,
    );

    const completedAt = status === "completed" ? new Date() : null;
    const updated = await this.repo.updateCapaStatus(
      actor.tenantId,
      id,
      status,
      actor.userId,
      {
        completedAt,
        completionNote: extra?.completionNote ?? null,
      },
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_quality.capa_action.status_updated",
      entityType: "capa_action",
      entityId: updated.id,
      metadata: { previousStatus: action.status, newStatus: status },
    });
    return updated;
  }

  async verifyCapaEffectiveness(
    actor: ActorContext,
    id: string,
    input: { verdict: CapaVerdict; note?: string | null },
  ) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CAPA_VERIFY_PERMISSION,
    );
    const action = await this.repo.findCapaActionById(actor.tenantId, id);
    if (!action) throw new NotFoundError("CapaAction", id);
    if (action.status !== "completed") {
      throw new ValidationError("Only completed CAPA actions can be verified for effectiveness");
    }
    await this.getComplaintForPermission(
      actor,
      action.complaintId,
      SERVICE_QUALITY_CAPA_VERIFY_PERMISSION,
    );

    const updated = await this.repo.recordCapaVerification(
      actor.tenantId,
      id,
      input.verdict,
      input.note ?? null,
      actor.userId,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_quality.capa_action.verified",
      entityType: "capa_action",
      entityId: updated.id,
      metadata: { verdict: input.verdict, note: input.note },
    });
    return updated;
  }

  async getCapaEffectivenessSummary(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const customerIds = await this.customers.listScopedCustomerIdsForPermission(
      actor,
      SERVICE_QUALITY_READ_PERMISSION,
    );
    return this.repo.summariseCapaEffectiveness(actor.tenantId, customerIds);
  }

  async canAccessCapaForDocument(
    actor: ActorContext,
    capaId: string,
  ): Promise<boolean> {
    const action = await this.repo.findCapaActionById(actor.tenantId, capaId);
    if (!action) return false;
    const complaint = await this.complaints.getForTrustedCaller(actor.tenantId, action.complaintId);
    if (!complaint) return false;
    return this.customers.canAccessForDocument(actor, complaint.customerId);
  }

  // --- SQ-ADV-003: Deterministic Recurrence Analytics -----------------------

  async createRecurrenceRule(actor: ActorContext, input: CreateRecurrenceInput) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    if (input.windowDays <= 0 || input.minimumOccurrences <= 1) {
      throw new ValidationError("Window days must be > 0 and minimum occurrences must be > 1");
    }

    await Promise.all([
      this.assertActiveReferenceCode(
        actor.tenantId,
        COMPLAINT_SEVERITY_REF_TYPE,
        input.severityCode ?? null,
        "severity",
      ),
      this.assertActiveReferenceCode(
        actor.tenantId,
        COMPLAINT_CATEGORY_REF_TYPE,
        input.categoryCode ?? null,
        "category",
      ),
    ]);

    if (input.customerId) {
      await this.customers.getAuthorizedForPermission(
        actor,
        input.customerId,
        SERVICE_QUALITY_CONFIGURE_PERMISSION,
      );
    }

    try {
      const rule = await this.repo.createRecurrenceRule(
        { ...input, tenantId: actor.tenantId },
        actor.userId,
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.recurrence_rule.created",
        entityType: "service_recurrence_rule",
        entityId: rule.id,
        metadata: {
          code: rule.code,
          groupBy: rule.groupBy,
          windowDays: rule.windowDays,
          minimumOccurrences: rule.minimumOccurrences,
        },
      });
      return rule;
    } catch (error) {
      this.mapUniqueViolation(error, `Recurrence rule '${input.code}' already exists`);
    }
  }

  async listRecurrenceRules(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    return this.repo.listRecurrenceRules(actor.tenantId);
  }

  async detectRecurrenceForRule(
    actor: ActorContext,
    ruleId: string,
    at = new Date(),
  ): Promise<RecurrenceDetection> {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_READ_PERMISSION);
    const rule = await this.repo.findRecurrenceRuleById(actor.tenantId, ruleId);
    if (!rule) throw new NotFoundError("RecurrenceRule", ruleId);

    const customerIds = await this.customers.listScopedCustomerIdsForPermission(
      actor,
      SERVICE_QUALITY_READ_PERMISSION,
    );

    const windowEnd = at;
    const windowStart = new Date(at.getTime() - rule.windowDays * 24 * 60 * 60 * 1000);

    const clusters = await this.repo.detectRecurrence(
      actor.tenantId,
      rule,
      customerIds,
      windowStart,
      windowEnd,
    );

    return {
      ruleCode: rule.code,
      ruleName: rule.name,
      groupBy: rule.groupBy,
      windowDays: rule.windowDays,
      minimumOccurrences: rule.minimumOccurrences,
      windowStart,
      windowEnd,
      clusters,
    };
  }

  // --- SQ-ADV-004: Feedback Automation Proposals ---------------------------

  async createAutomationRule(actor: ActorContext, input: CreateAutoRuleInput) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    try {
      const rule = await this.repo.createAutomationRule(
        { ...input, tenantId: actor.tenantId },
        actor.userId,
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.automation_rule.created",
        entityType: "service_automation_rule",
        entityId: rule.id,
        metadata: {
          code: rule.code,
          triggerEvent: rule.triggerEvent,
          proposedAction: rule.proposedAction,
        },
      });
      return rule;
    } catch (error) {
      this.mapUniqueViolation(error, `Automation rule '${input.code}' already exists`);
    }
  }

  async listAutomationRules(actor: ActorContext) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_AUTOMATION_READ_PERMISSION);
    return this.repo.listAutomationRules(actor.tenantId);
  }

  async setAutomationRuleActive(actor: ActorContext, id: string, isActive: boolean) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_CONFIGURE_PERMISSION,
    );
    const updated = await this.repo.setAutomationRuleActive(
      actor.tenantId,
      id,
      isActive,
      actor.userId,
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_quality.automation_rule.status_changed",
      entityType: "service_automation_rule",
      entityId: updated.id,
      metadata: { isActive: updated.isActive },
    });
    return updated;
  }

  async listProposals(actor: ActorContext, status?: ProposalStatus) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_AUTOMATION_READ_PERMISSION);
    return this.repo.listProposals(actor.tenantId, status);
  }

  async getProposal(actor: ActorContext, id: string) {
    await this.rbac.requirePermission(actor, SERVICE_QUALITY_AUTOMATION_READ_PERMISSION);
    const proposal = await this.repo.findProposalById(actor.tenantId, id);
    if (!proposal) throw new NotFoundError("AutomationProposal", id);
    return proposal;
  }

  async approveProposal(actor: ActorContext, id: string, note?: string | null) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_AUTOMATION_APPROVE_PERMISSION,
    );
    const proposal = await this.repo.findProposalById(actor.tenantId, id);
    if (!proposal) throw new NotFoundError("AutomationProposal", id);
    if (proposal.status !== "pending") {
      throw new ConflictError(`Proposal '${id}' is already in status '${proposal.status}'`);
    }

    // Two-phase lock: transition pending -> applying
    const applying = await this.repo.transitionProposal(
      actor.tenantId,
      id,
      "pending",
      "applying",
      {
        decidedBy: actor.userId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    );
    if (!applying) {
      throw new ConflictError(`Proposal '${id}' could not be claimed for application`);
    }

    try {
      await this.executeProposalAction(applying, actor.userId, actor);
      const applied = await this.repo.transitionProposal(
        actor.tenantId,
        id,
        "applying",
        "applied",
        { appliedAt: new Date() },
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.proposal.applied",
        entityType: "service_automation_proposal",
        entityId: id,
        metadata: { proposedAction: proposal.proposedAction },
      });
      return applied!;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = await this.repo.transitionProposal(
        actor.tenantId,
        id,
        "applying",
        "failed",
        { failureReason: reason },
      );
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "service_quality.proposal.failed",
        entityType: "service_automation_proposal",
        entityId: id,
        metadata: { error: reason },
      });
      return failed!;
    }
  }

  async rejectProposal(actor: ActorContext, id: string, note: string) {
    await this.rbac.requireTenantScopedPermissionForActor(
      actor,
      SERVICE_QUALITY_AUTOMATION_APPROVE_PERMISSION,
    );
    if (!note || note.trim().length === 0) {
      throw new ValidationError("A decision note is required when rejecting a proposal");
    }
    const rejected = await this.repo.transitionProposal(
      actor.tenantId,
      id,
      "pending",
      "rejected",
      {
        decidedBy: actor.userId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    );
    if (!rejected) {
      throw new ConflictError(`Proposal '${id}' is not in pending status`);
    }
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "service_quality.proposal.rejected",
      entityType: "service_automation_proposal",
      entityId: id,
      metadata: { note },
    });
    return rejected;
  }

  /**
   * Event listener: evaluates incoming events against active rules and persists
   * proposal rows without mutating domains autonomously.
   */
  async handleFeedbackEvent(event: DomainEvent): Promise<void> {
    try {
      let trigger: AutomationTriggerEvent | null = null;
      let score: number | null = null;
      let complaintId: string | null = null;

      if (event.eventType === "survey.submitted") {
        trigger = "survey_score_below_threshold";
        score = (event.payload as { score?: number })?.score ?? null;
        complaintId = (event.payload as { complaintId?: string })?.complaintId ?? null;
      } else if (event.eventType === "complaint.reopened") {
        trigger = "complaint_reopened";
        complaintId = event.entityId;
      } else if (event.eventType === "service_quality.sla_resolution_breached") {
        trigger = "sla_resolution_breached";
        complaintId = event.entityId;
      }

      if (!trigger || !complaintId) return;

      const rules = await this.repo.listActiveAutomationRulesByTrigger(event.tenantId, trigger);
      for (const rule of rules) {
        if (rule.scoreThreshold != null && score != null && score > rule.scoreThreshold) {
          continue;
        }

        const idempotencyKey = `${rule.code}:${event.eventType}:${complaintId}`;
        const rationale = `Triggered by ${event.eventType} on complaint ${complaintId} via rule ${rule.code}`;

        await this.repo.createProposalIfAbsent(
          {
            tenantId: event.tenantId,
            ruleId: rule.id,
            idempotencyKey,
            sourceEntityType: event.entityType,
            sourceEntityId: event.entityId ?? complaintId,
            targetEntityType: "complaint",
            targetEntityId: complaintId,
            proposedAction: rule.proposedAction,
            actionParameters: rule.actionParameters,
            rationale,
          },
          event.createdBy,
        );
      }
    } catch (error) {
      this.onEventError(event.eventType, error);
    }
  }

  private async executeProposalAction(
    proposal: AutomationProposal,
    decidedBy: string,
    approver: ActorContext,
  ): Promise<void> {
    // Epic 1 (§4.1 C) — the proposal executes AS the approver's session
    // context, so its reach is the approver's ACTIVE Role. A synthetic
    // userId-only actor would have consulted the union of every Role the
    // approver holds.
    const actor = approver;

    if (proposal.proposedAction === "reopen_complaint") {
      await this.complaints.reopen(
        actor,
        proposal.targetEntityId,
        "investigation",
        proposal.rationale,
      );
      return;
    }

    if (proposal.proposedAction === "raise_complaint_severity") {
      const targetSeverity = (proposal.actionParameters.severity as string) ?? "critical";
      await this.complaints.updateSeverity(
        actor,
        proposal.targetEntityId,
        targetSeverity,
        proposal.rationale,
      );
      return;
    }

    if (proposal.proposedAction === "create_capa_action") {
      const title =
        (proposal.actionParameters.title as string) ??
        `Automated CAPA for ${proposal.targetEntityId}`;
      const actionType = (proposal.actionParameters.actionType as CapaActionType) ?? "corrective";
      // Routed through the permission-checked service method — like the two
      // branches above — so approving a proposal can never grant more reach
      // than the approver already holds. Calling the repository directly here
      // would skip `service_quality.capa.manage` and the Customer Data Scope.
      await this.createCapaAction(actor, {
        complaintId: proposal.targetEntityId,
        rcaFindingId: null,
        actionType,
        title,
        description: proposal.rationale,
        ownerUserId: decidedBy,
        dueDate: null,
      });
    }
  }

  private async getComplaintForPermission(
    actor: ActorContext,
    complaintId: string,
    permissionCode: string,
  ) {
    return (await this.getComplaintAndCustomerForPermission(actor, complaintId, permissionCode))
      .complaint;
  }

  private async getComplaintAndCustomerForPermission(
    actor: ActorContext,
    complaintId: string,
    permissionCode: string,
  ) {
    const complaint = await this.complaints.getForTrustedCaller(actor.tenantId, complaintId);
    if (!complaint) throw new NotFoundError("Complaint", complaintId);
    const customer = await this.customers.getAuthorizedForPermission(
      actor,
      complaint.customerId,
      permissionCode,
    );
    return { complaint, customer };
  }

  private projectSlaState(target: SlaTarget | null, now: Date) {
    if (!target) return null;
    return {
      response: {
        dueAt: target.responseDueAt,
        recordedAt: target.firstResponseAt,
        breached:
          target.responseBreached ||
          (!target.firstResponseAt && !!target.responseDueAt && target.responseDueAt < now),
      },
      resolution: {
        dueAt: target.resolutionDueAt,
        recordedAt: target.resolvedAt,
        breached:
          target.resolutionBreached ||
          (!target.resolvedAt && !!target.resolutionDueAt && target.resolutionDueAt < now),
      },
    };
  }

  private assertCalendarWindows(windows: WorkweekWindow[], isContinuous: boolean): void {
    if (isContinuous && windows.length > 0) {
      throw new ValidationError("A continuous calendar must not define workweek windows");
    }
    if (!isContinuous && windows.length === 0) {
      throw new ValidationError("A non-continuous calendar requires at least one workweek window");
    }

    const byDay = new Map<number, WorkweekWindow[]>();
    for (const window of windows) {
      if (
        !Number.isInteger(window.dayOfWeek) ||
        window.dayOfWeek < 1 ||
        window.dayOfWeek > 7 ||
        !Number.isInteger(window.startMinute) ||
        !Number.isInteger(window.endMinute) ||
        window.startMinute < 0 ||
        window.endMinute > 1440 ||
        window.endMinute <= window.startMinute
      ) {
        throw new ValidationError("Business-calendar workweek window is invalid");
      }
      const day = byDay.get(window.dayOfWeek) ?? [];
      day.push(window);
      byDay.set(window.dayOfWeek, day);
    }
    for (const day of byDay.values()) {
      day.sort((a, b) => a.startMinute - b.startMinute);
      for (let index = 1; index < day.length; index += 1) {
        if (day[index]!.startMinute < day[index - 1]!.endMinute) {
          throw new ValidationError("Business-calendar workweek windows must not overlap");
        }
      }
    }
  }

  private mapUniqueViolation(error: unknown, message: string): never {
    if ((error as { code?: string }).code === "23505") throw new ConflictError(message);
    throw error;
  }
}
