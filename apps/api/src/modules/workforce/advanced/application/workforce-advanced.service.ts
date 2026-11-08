/**
 * Workforce Advanced Application Service (Wave A4: HR-ADV-001…009).
 *
 * Implements the six Advanced Workforce capability groups:
 * 1. Attendance, Shift & Roster (HR-ADV-001, HR-ADV-002)
 * 2. Leave & Overtime (HR-ADV-003, HR-ADV-004) — generic Workflow Engine lifecycle delegation
 * 3. Payroll, BPJS & PPh 21 (HR-ADV-005) — deterministic calculation engine & workflow delegation
 * 4. Recruitment (HR-ADV-006) — job postings & candidate application tracking
 * 5. Competency, Training, Performance & Career (HR-ADV-007, HR-ADV-008) — career paths & reviews
 * 6. Manpower Planning (HR-ADV-009) — deterministic advisory-only planning
 *
 * Architectural constraints:
 * - Workforce Core is never mutated or directly imported; narrow repository read ports only.
 * - All lifecycles with workflows use WorkflowService exclusively with zero competing state machines.
 * - Workflow start failures are safely compensated (deleted if workflow fails to initialize).
 * - Statutory policies are pure data (effective-dated), calculated via payroll-policy.ts.
 * - Manpower planning applying is advisory-only and never modifies employee records.
 * - Enforces the 15 Wave A4 RBAC permissions and organization-unit scope.
 */

import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { EventBus } from "../../../../application/event/event-bus.js";
import type { ConfigurationService } from "../../../../application/configuration/configuration.service.js";
import type {
  EntityWorkflowAction,
  EntityWorkflowStatus,
  WorkflowService,
} from "../../../../application/workflow/workflow.service.js";
import type {
  AdvanceJobApplicationInput,
  AttendanceListFilter,
  CompleteTrainingInput,
  CreateStatutoryPolicyInput,
  EmployeeReference,
  JobApplicationListFilter,
  JobPostingListFilter,
  LeaveRequestListFilter,
  ManpowerGapEntry,
  ManpowerPlanListFilter,
  OvertimeRequestListFilter,
  PayrollRunListFilter,
  PerformanceReviewListFilter,
  RosterListFilter,
  SetSalaryProfileInput,
  WorkforceAdvancedRepository,
  WorkforceAttendanceRecord,
  WorkforceCareerPath,
  WorkforceCompetency,
  WorkforceEmployeeCompetency,
  WorkforceEmployeeSalaryProfile,
  WorkforceJobApplication,
  WorkforceJobPosting,
  WorkforceLeaveBalance,
  WorkforceLeaveRequest,
  WorkforceLeaveType,
  WorkforceManpowerPlan,
  WorkforceOvertimeRequest,
  WorkforcePayrollRun,
  WorkforcePayslip,
  WorkforcePerformanceReview,
  WorkforceRoster,
  WorkforceShift,
  WorkforceStatutoryPolicy,
  WorkforceTrainingCourse,
  WorkforceTrainingEnrollment,
} from "../domain/workforce-advanced.entity.js";
import {
  calculateEmployeePayroll,
  fromCents,
  toCents,
} from "../domain/payroll-policy.js";

interface PayrollAccountingReadyEventInput {
  eventType: "payroll.run_posted";
  sourceDocumentType: string;
  sourceDocumentId: string;
  effectiveAt?: Date;
  currency?: string;
  amount?: number;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface PayrollAccountingEventPort {
  createEvent(tenantId: string, input: PayrollAccountingReadyEventInput): Promise<unknown>;
  getEventByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<unknown | null>;
}

/** Configuration numbering codes for Workforce Advanced. */
export const WORKFORCE_LEAVE_REQUEST_NUMBERING_CODE = "workforce_leave_request";
export const WORKFORCE_OVERTIME_REQUEST_NUMBERING_CODE = "workforce_overtime_request";
export const WORKFORCE_PAYROLL_RUN_NUMBERING_CODE = "workforce_payroll_run";
export const WORKFORCE_JOB_POSTING_NUMBERING_CODE = "workforce_job_posting";
export const WORKFORCE_PERFORMANCE_REVIEW_NUMBERING_CODE = "workforce_performance_review";
export const WORKFORCE_MANPOWER_PLAN_NUMBERING_CODE = "workforce_manpower_plan";

/** Workflow definition codes for Workforce Advanced. */
export const WORKFORCE_LEAVE_WORKFLOW_DEFINITION_CODE = "workforce_leave_request";
export const WORKFORCE_OVERTIME_WORKFLOW_DEFINITION_CODE = "workforce_overtime_request";
export const WORKFORCE_PAYROLL_WORKFLOW_DEFINITION_CODE = "workforce_payroll_run";
export const WORKFORCE_JOB_POSTING_WORKFLOW_DEFINITION_CODE = "workforce_job_posting";
export const WORKFORCE_PERFORMANCE_REVIEW_WORKFLOW_DEFINITION_CODE = "workforce_performance_review";

export interface LeaveRequestDetailView {
  leaveRequest: WorkforceLeaveRequest;
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface OvertimeRequestDetailView {
  overtimeRequest: WorkforceOvertimeRequest;
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface PayrollRunDetailView {
  payrollRun: WorkforcePayrollRun;
  payslips: WorkforcePayslip[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface JobPostingDetailView {
  jobPosting: WorkforceJobPosting;
  applications: WorkforceJobApplication[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export interface PerformanceReviewDetailView {
  review: WorkforcePerformanceReview;
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

export class WorkforceAdvancedService {
  constructor(
    private readonly repo: WorkforceAdvancedRepository,
    private readonly workflow: WorkflowService,
    private readonly configuration: ConfigurationService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly eventBus: EventBus,
    private readonly accountingEvents: PayrollAccountingEventPort,
  ) {}

  // =========================================================================
  // 1. Attendance, Shift & Roster (HR-ADV-001, HR-ADV-002)
  // =========================================================================

  async createShift(
    actor: ActorContext,
    input: {
      shiftCode: string;
      name: string;
      startTime: string;
      endTime: string;
      breakMinutes?: number;
      isOvernight?: boolean;
    },
  ): Promise<WorkforceShift> {
    await this.rbac.requirePermission(actor, "workforce.attendance.manage");
    await this.assertOrganizationUnitInScope(actor, null);
    this.validateTimeString(input.startTime, "startTime");
    this.validateTimeString(input.endTime, "endTime");

    const shift = await this.repo.createShift({
      tenantId: actor.tenantId,
      shiftCode: input.shiftCode.trim(),
      name: input.name.trim(),
      startTime: input.startTime,
      endTime: input.endTime,
      breakMinutes: input.breakMinutes ?? 60,
      isOvernight: input.isOvernight ?? false,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.shift.created",
      entityType: "workforce_shift",
      entityId: shift.id,
      metadata: { shiftCode: shift.shiftCode, name: shift.name },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "workforce.shift.created",
      entityType: "workforce_shift",
      entityId: shift.id,
      payload: { shiftCode: shift.shiftCode, name: shift.name },
      createdBy: actor.userId,
    });

    return shift;
  }

  async listShifts(actor: ActorContext, includeInactive = false): Promise<WorkforceShift[]> {
    await this.rbac.requirePermission(actor, "workforce.attendance.read");
    await this.assertOrganizationUnitInScope(actor, null);
    return this.repo.listShifts(actor.tenantId, includeInactive);
  }

  async getShift(actor: ActorContext, id: string): Promise<WorkforceShift> {
    await this.rbac.requirePermission(actor, "workforce.attendance.read");
    await this.assertOrganizationUnitInScope(actor, null);
    const shift = await this.repo.findShiftById(actor.tenantId, id);
    if (!shift) throw new NotFoundError("WorkforceShift", id);
    return shift;
  }

  async setShiftActive(actor: ActorContext, id: string, isActive: boolean): Promise<WorkforceShift> {
    await this.rbac.requirePermission(actor, "workforce.attendance.manage");
    await this.assertOrganizationUnitInScope(actor, null);
    const shift = await this.repo.findShiftById(actor.tenantId, id);
    if (!shift) throw new NotFoundError("WorkforceShift", id);

    const updated = await this.repo.setShiftActive(actor.tenantId, id, isActive);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.shift.status_changed",
      entityType: "workforce_shift",
      entityId: updated.id,
      metadata: { shiftCode: updated.shiftCode, isActive },
    });

    return updated;
  }

  async upsertRoster(
    actor: ActorContext,
    input: {
      employeeId: string;
      shiftId: string;
      rosterDate: string;
      organizationUnitId?: string | null;
      notes?: string | null;
    },
  ): Promise<WorkforceRoster> {
    await this.rbac.requirePermission(actor, "workforce.attendance.manage");
    await this.assertEmployeeInScope(actor, input.employeeId);

    const shift = await this.repo.findShiftById(actor.tenantId, input.shiftId);
    if (!shift) throw new NotFoundError("WorkforceShift", input.shiftId);
    if (!shift.isActive) throw new ConflictError("Cannot assign an inactive shift");

    const rosterDate = this.validateDateOnly(input.rosterDate, "rosterDate");

    if (input.organizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, input.organizationUnitId);
    }

    const roster = await this.repo.upsertRoster({
      tenantId: actor.tenantId,
      employeeId: input.employeeId,
      shiftId: input.shiftId,
      rosterDate,
      organizationUnitId: input.organizationUnitId ?? null,
      notes: input.notes ?? null,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.roster.upserted",
      entityType: "workforce_roster",
      entityId: roster.id,
      metadata: { employeeId: roster.employeeId, shiftId: roster.shiftId, rosterDate },
    });

    return roster;
  }

  async listRosters(actor: ActorContext, filter: RosterListFilter = {}): Promise<WorkforceRoster[]> {
    await this.rbac.requirePermission(actor, "workforce.attendance.read");
    if (filter.employeeId) {
      await this.assertEmployeeInScope(actor, filter.employeeId);
    }
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor, filter.organizationUnitId);
    return this.repo.listRosters(actor.tenantId, filter, organizationUnitIds);
  }

  async recordAttendance(
    actor: ActorContext,
    input: {
      employeeId: string;
      attendanceDate: string;
      shiftId?: string | null;
      clockIn?: string | null;
      clockOut?: string | null;
      status?: import("../domain/workforce-advanced.entity.js").AttendanceStatus;
      source?: import("../domain/workforce-advanced.entity.js").AttendanceSource;
      notes?: string | null;
    },
  ): Promise<WorkforceAttendanceRecord> {
    await this.rbac.requirePermission(actor, "workforce.attendance.manage");
    await this.assertEmployeeInScope(actor, input.employeeId);

    const attendanceDate = this.validateDateOnly(input.attendanceDate, "attendanceDate");
    if (input.shiftId) {
      const shift = await this.repo.findShiftById(actor.tenantId, input.shiftId);
      if (!shift) throw new NotFoundError("WorkforceShift", input.shiftId);
    }

    const record = await this.repo.recordAttendance({
      tenantId: actor.tenantId,
      employeeId: input.employeeId,
      attendanceDate,
      shiftId: input.shiftId ?? null,
      clockIn: input.clockIn ?? null,
      clockOut: input.clockOut ?? null,
      status: input.status ?? "present",
      source: input.source ?? "manual",
      notes: input.notes ?? null,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.attendance.recorded",
      entityType: "workforce_attendance_record",
      entityId: record.id,
      metadata: { employeeId: record.employeeId, attendanceDate, status: record.status },
    });

    return record;
  }

  async listAttendance(actor: ActorContext, filter: AttendanceListFilter = {}): Promise<WorkforceAttendanceRecord[]> {
    await this.rbac.requirePermission(actor, "workforce.attendance.read");
    if (filter.employeeId) {
      await this.assertEmployeeInScope(actor, filter.employeeId);
    }
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor);
    return this.repo.listAttendance(actor.tenantId, filter, organizationUnitIds);
  }

  // =========================================================================
  // 2. Leave & Overtime (HR-ADV-003, HR-ADV-004)
  // =========================================================================

  async createLeaveType(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      annualAllowanceDays?: number;
      isPaid?: boolean;
      requiresAttachment?: boolean;
    },
  ): Promise<WorkforceLeaveType> {
    await this.rbac.requirePermission(actor, "workforce.leave.manage");
    await this.assertOrganizationUnitInScope(actor, null);

    const leaveType = await this.repo.createLeaveType({
      tenantId: actor.tenantId,
      code: input.code.trim(),
      name: input.name.trim(),
      annualAllowanceDays: input.annualAllowanceDays ?? 12,
      isPaid: input.isPaid ?? true,
      requiresAttachment: input.requiresAttachment ?? false,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.leave_type.created",
      entityType: "workforce_leave_type",
      entityId: leaveType.id,
      metadata: { code: leaveType.code, name: leaveType.name },
    });

    return leaveType;
  }

  async listLeaveTypes(actor: ActorContext, includeInactive = false): Promise<WorkforceLeaveType[]> {
    await this.rbac.requirePermission(actor, "workforce.leave.read");
    await this.assertOrganizationUnitInScope(actor, null);
    return this.repo.listLeaveTypes(actor.tenantId, includeInactive);
  }

  async setLeaveAllocation(
    actor: ActorContext,
    input: {
      employeeId: string;
      leaveTypeId: string;
      balanceYear: number;
      allocatedDays: number;
    },
  ): Promise<WorkforceLeaveBalance> {
    await this.rbac.requirePermission(actor, "workforce.leave.manage");
    await this.assertEmployeeInScope(actor, input.employeeId);

    if (input.allocatedDays < 0) {
      throw new ValidationError("allocatedDays cannot be negative");
    }

    const balance = await this.repo.setLeaveAllocation({
      tenantId: actor.tenantId,
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      balanceYear: input.balanceYear,
      allocatedDays: input.allocatedDays,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.leave_balance.allocated",
      entityType: "workforce_leave_balance",
      entityId: balance.id,
      metadata: { employeeId: balance.employeeId, leaveTypeId: balance.leaveTypeId, allocatedDays: input.allocatedDays },
    });

    return balance;
  }

  async listLeaveBalances(actor: ActorContext, employeeId: string, balanceYear?: number): Promise<WorkforceLeaveBalance[]> {
    await this.rbac.requirePermission(actor, "workforce.leave.read");
    await this.assertEmployeeInScope(actor, employeeId);
    const year = balanceYear ?? new Date().getFullYear();
    return this.repo.listLeaveBalances(actor.tenantId, employeeId, year);
  }

  async createLeaveRequest(
    actor: ActorContext,
    input: {
      employeeId: string;
      leaveTypeId: string;
      startDate: string;
      endDate: string;
      totalDays: number;
      reason?: string | null;
      attachmentDocumentId?: string | null;
    },
  ): Promise<WorkforceLeaveRequest> {
    await this.rbac.requirePermission(actor, "workforce.leave.manage");
    const employee = await this.assertEmployeeInScope(actor, input.employeeId);

    const startDate = this.validateDateOnly(input.startDate, "startDate");
    const endDate = this.validateDateOnly(input.endDate, "endDate");
    if (new Date(endDate).getTime() < new Date(startDate).getTime()) {
      throw new ValidationError("endDate cannot be earlier than startDate");
    }
    if (input.totalDays <= 0) {
      throw new ValidationError("totalDays must be > 0");
    }

    const balanceYear = parseInt(startDate.slice(0, 4), 10);
    const balance = await this.repo.findLeaveBalance(actor.tenantId, input.employeeId, input.leaveTypeId, balanceYear);
    if (balance) {
      const remaining = balance.allocatedDays - (balance.usedDays + balance.pendingDays);
      if (input.totalDays > remaining) {
        throw new ValidationError(`Insufficient leave balance: requested ${input.totalDays} days, available ${remaining} days`);
      }
    }

    const { number: requestNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORKFORCE_LEAVE_REQUEST_NUMBERING_CODE,
      actor.userId,
    );

    const leaveRequest = await this.repo.createLeaveRequest(
      {
        tenantId: actor.tenantId,
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        startDate,
        endDate,
        totalDays: input.totalDays,
        reason: input.reason ?? null,
        attachmentDocumentId: input.attachmentDocumentId ?? null,
        actorUserId: actor.userId,
      },
      requestNumber,
    );

    // Reserve pending balance
    await this.repo.adjustLeaveBalancePending(
      actor.tenantId,
      input.employeeId,
      input.leaveTypeId,
      balanceYear,
      input.totalDays,
      0,
    );

    // Start workflow engine instance with compensation
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: WORKFORCE_LEAVE_WORKFLOW_DEFINITION_CODE,
        entityId: leaveRequest.id,
        contextData: {
          // ADR-0012: follows the employee's owning Organization Unit.
          organizationUnitId: employee.organizationUnitId,
          employeeId: leaveRequest.employeeId,
          leaveTypeId: leaveRequest.leaveTypeId,
          totalDays: leaveRequest.totalDays,
          requestNumber: leaveRequest.requestNumber,
        },
      });
      await this.repo.setLeaveRequestWorkflowInstance(actor.tenantId, leaveRequest.id, instance.id);
    } catch (error) {
      await this.repo.adjustLeaveBalancePending(
        actor.tenantId,
        input.employeeId,
        input.leaveTypeId,
        balanceYear,
        -input.totalDays,
        0,
      );
      await this.repo.deleteLeaveRequestWithoutWorkflow(actor.tenantId, leaveRequest.id);
      throw error;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.leave_request.created",
      entityType: "workforce_leave_request",
      entityId: leaveRequest.id,
      metadata: { requestNumber, employeeId: leaveRequest.employeeId, totalDays: leaveRequest.totalDays },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "workforce.leave_request.created",
      entityType: "workforce_leave_request",
      entityId: leaveRequest.id,
      payload: { requestNumber, employeeId: leaveRequest.employeeId, totalDays: leaveRequest.totalDays },
      createdBy: actor.userId,
    });

    return (await this.repo.findLeaveRequestById(actor.tenantId, leaveRequest.id))!;
  }

  async listLeaveRequests(
    actor: ActorContext,
    filter: LeaveRequestListFilter = {},
  ): Promise<{ leaveRequest: WorkforceLeaveRequest; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "workforce.leave.read");
    if (filter.employeeId) {
      await this.assertEmployeeInScope(actor, filter.employeeId);
    }
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor);
    const requests = await this.repo.listLeaveRequests(actor.tenantId, filter, organizationUnitIds);
    return this.withWorkflowStatus(actor, requests, (r) => r.workflowInstanceId, (leaveRequest, status) => ({ leaveRequest, status }));
  }

  async getLeaveRequest(actor: ActorContext, id: string): Promise<LeaveRequestDetailView> {
    await this.rbac.requirePermission(actor, "workforce.leave.read");
    const leaveRequest = await this.repo.findLeaveRequestById(actor.tenantId, id);
    if (!leaveRequest) throw new NotFoundError("WorkforceLeaveRequest", id);
    await this.assertEmployeeInScope(actor, leaveRequest.employeeId);

    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (leaveRequest.workflowInstanceId) {
      status = await this.workflow.getEntityStatus(actor, leaveRequest.workflowInstanceId);
      const view = await this.workflow.getEntityWorkflowView(actor, leaveRequest.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }

    return { leaveRequest, status, availableActions };
  }

  async actOnLeaveRequest(
    actor: ActorContext,
    id: string,
    actionCode: string,
    comment: string | null = null,
  ): Promise<{ leaveRequest: WorkforceLeaveRequest; workflowResult: unknown }> {
    await this.rbac.requirePermission(actor, "workforce.leave.approve");
    const leaveRequest = await this.repo.findLeaveRequestById(actor.tenantId, id);
    if (!leaveRequest) throw new NotFoundError("WorkforceLeaveRequest", id);
    await this.assertEmployeeInScope(actor, leaveRequest.employeeId);
    if (!leaveRequest.workflowInstanceId) {
      throw new ConflictError("This leave request has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(actor.tenantId, leaveRequest.workflowInstanceId);
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action exists on this leave request");

    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);
    const balanceYear = parseInt(leaveRequest.startDate.slice(0, 4), 10);

    let projected = leaveRequest;
    if (actionCode === "approve") {
      projected = await this.repo.projectLeaveRequestDecision(actor.tenantId, id, "approved", new Date());
      await this.repo.adjustLeaveBalancePending(
        actor.tenantId,
        leaveRequest.employeeId,
        leaveRequest.leaveTypeId,
        balanceYear,
        -leaveRequest.totalDays,
        leaveRequest.totalDays,
      );
    } else if (actionCode === "reject") {
      projected = await this.repo.projectLeaveRequestDecision(actor.tenantId, id, "rejected", new Date());
      await this.repo.adjustLeaveBalancePending(
        actor.tenantId,
        leaveRequest.employeeId,
        leaveRequest.leaveTypeId,
        balanceYear,
        -leaveRequest.totalDays,
        0,
      );
    } else if (actionCode === "cancel") {
      projected = await this.repo.projectLeaveRequestDecision(actor.tenantId, id, "cancelled", new Date());
      await this.repo.adjustLeaveBalancePending(
        actor.tenantId,
        leaveRequest.employeeId,
        leaveRequest.leaveTypeId,
        balanceYear,
        -leaveRequest.totalDays,
        0,
      );
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: `workforce.leave_request.${actionCode}`,
      entityType: "workforce_leave_request",
      entityId: leaveRequest.id,
      metadata: { actionCode, comment, requestNumber: leaveRequest.requestNumber },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: `workforce.leave_request.${actionCode}`,
      entityType: "workforce_leave_request",
      entityId: leaveRequest.id,
      payload: { requestNumber: leaveRequest.requestNumber, actionCode },
      createdBy: actor.userId,
    });

    return {
      leaveRequest: (await this.repo.findLeaveRequestById(actor.tenantId, id)) ?? projected,
      workflowResult: result,
    };
  }

  async createOvertimeRequest(
    actor: ActorContext,
    input: {
      employeeId: string;
      overtimeDate: string;
      startTime: string;
      endTime: string;
      estimatedHours: number;
      reason?: string | null;
    },
  ): Promise<WorkforceOvertimeRequest> {
    await this.rbac.requirePermission(actor, "workforce.leave.manage");
    const employee = await this.assertEmployeeInScope(actor, input.employeeId);

    const overtimeDate = this.validateDateOnly(input.overtimeDate, "overtimeDate");
    this.validateTimeString(input.startTime, "startTime");
    this.validateTimeString(input.endTime, "endTime");
    if (input.estimatedHours <= 0) {
      throw new ValidationError("estimatedHours must be > 0");
    }

    const { number: requestNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORKFORCE_OVERTIME_REQUEST_NUMBERING_CODE,
      actor.userId,
    );

    const overtimeRequest = await this.repo.createOvertimeRequest(
      {
        tenantId: actor.tenantId,
        employeeId: input.employeeId,
        overtimeDate,
        startTime: input.startTime,
        endTime: input.endTime,
        estimatedHours: input.estimatedHours,
        reason: input.reason ?? null,
        actorUserId: actor.userId,
      },
      requestNumber,
    );

    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: WORKFORCE_OVERTIME_WORKFLOW_DEFINITION_CODE,
        entityId: overtimeRequest.id,
        contextData: {
          // ADR-0012: follows the employee's owning Organization Unit.
          organizationUnitId: employee.organizationUnitId,
          employeeId: overtimeRequest.employeeId,
          overtimeDate: overtimeRequest.overtimeDate,
          estimatedHours: overtimeRequest.estimatedHours,
          requestNumber: overtimeRequest.requestNumber,
        },
      });
      await this.repo.setOvertimeRequestWorkflowInstance(actor.tenantId, overtimeRequest.id, instance.id);
    } catch (error) {
      await this.repo.deleteOvertimeRequestWithoutWorkflow(actor.tenantId, overtimeRequest.id);
      throw error;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.overtime_request.created",
      entityType: "workforce_overtime_request",
      entityId: overtimeRequest.id,
      metadata: { requestNumber, employeeId: overtimeRequest.employeeId, estimatedHours: input.estimatedHours },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "workforce.overtime_request.created",
      entityType: "workforce_overtime_request",
      entityId: overtimeRequest.id,
      payload: { requestNumber, employeeId: overtimeRequest.employeeId },
      createdBy: actor.userId,
    });

    return (await this.repo.findOvertimeRequestById(actor.tenantId, overtimeRequest.id))!;
  }

  async listOvertimeRequests(
    actor: ActorContext,
    filter: OvertimeRequestListFilter = {},
  ): Promise<{ overtimeRequest: WorkforceOvertimeRequest; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "workforce.leave.read");
    if (filter.employeeId) {
      await this.assertEmployeeInScope(actor, filter.employeeId);
    }
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor);
    const requests = await this.repo.listOvertimeRequests(actor.tenantId, filter, organizationUnitIds);
    return this.withWorkflowStatus(actor, requests, (r) => r.workflowInstanceId, (overtimeRequest, status) => ({ overtimeRequest, status }));
  }

  async getOvertimeRequest(actor: ActorContext, id: string): Promise<OvertimeRequestDetailView> {
    await this.rbac.requirePermission(actor, "workforce.leave.read");
    const overtimeRequest = await this.repo.findOvertimeRequestById(actor.tenantId, id);
    if (!overtimeRequest) throw new NotFoundError("WorkforceOvertimeRequest", id);
    await this.assertEmployeeInScope(actor, overtimeRequest.employeeId);

    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (overtimeRequest.workflowInstanceId) {
      status = await this.workflow.getEntityStatus(actor, overtimeRequest.workflowInstanceId);
      const view = await this.workflow.getEntityWorkflowView(actor, overtimeRequest.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }

    return { overtimeRequest, status, availableActions };
  }

  async recordActualOvertimeHours(
    actor: ActorContext,
    id: string,
    actualHours: number,
  ): Promise<WorkforceOvertimeRequest> {
    await this.rbac.requirePermission(actor, "workforce.leave.manage");
    if (actualHours < 0) throw new ValidationError("actualHours cannot be negative");
    const overtimeRequest = await this.repo.findOvertimeRequestById(actor.tenantId, id);
    if (!overtimeRequest) throw new NotFoundError("WorkforceOvertimeRequest", id);
    await this.assertEmployeeInScope(actor, overtimeRequest.employeeId);

    const updated = await this.repo.recordActualOvertimeHours({
      tenantId: actor.tenantId,
      id,
      actualHours,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.overtime_request.actual_hours_recorded",
      entityType: "workforce_overtime_request",
      entityId: id,
      metadata: { actualHours },
    });

    return updated;
  }

  async actOnOvertimeRequest(
    actor: ActorContext,
    id: string,
    actionCode: string,
    comment: string | null = null,
  ): Promise<{ overtimeRequest: WorkforceOvertimeRequest; workflowResult: unknown }> {
    await this.rbac.requirePermission(actor, "workforce.leave.approve");
    const overtimeRequest = await this.repo.findOvertimeRequestById(actor.tenantId, id);
    if (!overtimeRequest) throw new NotFoundError("WorkforceOvertimeRequest", id);
    await this.assertEmployeeInScope(actor, overtimeRequest.employeeId);
    if (!overtimeRequest.workflowInstanceId) {
      throw new ConflictError("This overtime request has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(actor.tenantId, overtimeRequest.workflowInstanceId);
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action exists on this overtime request");

    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    let projected = overtimeRequest;
    if (actionCode === "approve") {
      projected = await this.repo.projectOvertimeRequestDecision(actor.tenantId, id, "approved", new Date());
    } else if (actionCode === "reject") {
      projected = await this.repo.projectOvertimeRequestDecision(actor.tenantId, id, "rejected", new Date());
    } else if (actionCode === "cancel") {
      projected = await this.repo.projectOvertimeRequestDecision(actor.tenantId, id, "cancelled", new Date());
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: `workforce.overtime_request.${actionCode}`,
      entityType: "workforce_overtime_request",
      entityId: overtimeRequest.id,
      metadata: { actionCode, comment, requestNumber: overtimeRequest.requestNumber },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: `workforce.overtime_request.${actionCode}`,
      entityType: "workforce_overtime_request",
      entityId: overtimeRequest.id,
      payload: { requestNumber: overtimeRequest.requestNumber, actionCode },
      createdBy: actor.userId,
    });

    return {
      overtimeRequest: (await this.repo.findOvertimeRequestById(actor.tenantId, id)) ?? projected,
      workflowResult: result,
    };
  }

  // =========================================================================
  // 3. Payroll, BPJS & PPh 21 (HR-ADV-005)
  // =========================================================================

  async createStatutoryPolicy(
    actor: ActorContext,
    input: Omit<CreateStatutoryPolicyInput, "tenantId" | "createdBy">,
  ): Promise<WorkforceStatutoryPolicy> {
    await this.rbac.requirePermission(actor, "workforce.payroll.manage");
    await this.assertOrganizationUnitInScope(actor, null);

    const policy = await this.repo.createStatutoryPolicy({
      ...input,
      tenantId: actor.tenantId,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.statutory_policy.created",
      entityType: "workforce_statutory_policy",
      entityId: policy.id,
      metadata: { policyCode: policy.policyCode, name: policy.name, effectiveFrom: policy.effectiveFrom },
    });

    return policy;
  }

  async listStatutoryPolicies(actor: ActorContext): Promise<WorkforceStatutoryPolicy[]> {
    await this.rbac.requirePermission(actor, "workforce.payroll.read");
    await this.assertOrganizationUnitInScope(actor, null);
    return this.repo.listStatutoryPolicies(actor.tenantId);
  }

  async getActiveStatutoryPolicy(actor: ActorContext, asOfDate?: string): Promise<WorkforceStatutoryPolicy | null> {
    await this.rbac.requirePermission(actor, "workforce.payroll.read");
    await this.assertOrganizationUnitInScope(actor, null);
    const targetDate = asOfDate ? this.validateDateOnly(asOfDate, "asOfDate") : new Date().toISOString().slice(0, 10);
    return this.repo.findActiveStatutoryPolicy(actor.tenantId, targetDate);
  }

  async setSalaryProfile(
    actor: ActorContext,
    input: Omit<SetSalaryProfileInput, "tenantId" | "actorUserId">,
  ): Promise<WorkforceEmployeeSalaryProfile> {
    await this.rbac.requirePermission(actor, "workforce.payroll.manage");
    await this.assertEmployeeInScope(actor, input.employeeId);

    const effectiveFrom = this.validateDateOnly(input.effectiveFrom, "effectiveFrom");
    await this.repo.closeOpenSalaryProfile(actor.tenantId, input.employeeId, effectiveFrom);

    const profile = await this.repo.setSalaryProfile({
      ...input,
      effectiveFrom,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.salary_profile.set",
      entityType: "workforce_employee_salary_profile",
      entityId: profile.id,
      metadata: { employeeId: profile.employeeId, baseSalary: profile.baseSalary, ptkpStatus: profile.ptkpStatus },
    });

    return profile;
  }

  async getCurrentSalaryProfile(actor: ActorContext, employeeId: string): Promise<WorkforceEmployeeSalaryProfile | null> {
    await this.rbac.requirePermission(actor, "workforce.payroll.read");
    await this.assertEmployeeInScope(actor, employeeId);
    return this.repo.findCurrentSalaryProfile(actor.tenantId, employeeId);
  }

  async createPayrollRun(
    actor: ActorContext,
    input: {
      periodMonth: number;
      periodYear: number;
      organizationUnitId?: string | null;
    },
  ): Promise<WorkforcePayrollRun> {
    await this.rbac.requirePermission(actor, "workforce.payroll.manage");

    if (input.periodMonth < 1 || input.periodMonth > 12) {
      throw new ValidationError("periodMonth must be between 1 and 12");
    }
    if (input.periodYear < 2000 || input.periodYear > 2100) {
      throw new ValidationError("periodYear is out of valid range");
    }

    await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);

    const { number: runNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORKFORCE_PAYROLL_RUN_NUMBERING_CODE,
      actor.userId,
    );

    const payrollRun = await this.repo.createPayrollRun(
      {
        tenantId: actor.tenantId,
        periodMonth: input.periodMonth,
        periodYear: input.periodYear,
        organizationUnitId: input.organizationUnitId ?? null,
        actorUserId: actor.userId,
      },
      runNumber,
    );

    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: WORKFORCE_PAYROLL_WORKFLOW_DEFINITION_CODE,
        entityId: payrollRun.id,
        contextData: {
          periodMonth: payrollRun.periodMonth,
          periodYear: payrollRun.periodYear,
          runNumber: payrollRun.runNumber,
          organizationUnitId: payrollRun.organizationUnitId,
        },
      });
      await this.repo.setPayrollRunWorkflowInstance(actor.tenantId, payrollRun.id, instance.id);
    } catch (error) {
      await this.repo.deletePayrollRunWithoutWorkflow(actor.tenantId, payrollRun.id);
      throw error;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.payroll_run.created",
      entityType: "workforce_payroll_run",
      entityId: payrollRun.id,
      metadata: { runNumber, periodMonth: input.periodMonth, periodYear: input.periodYear },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "workforce.payroll_run.created",
      entityType: "workforce_payroll_run",
      entityId: payrollRun.id,
      payload: { runNumber, periodMonth: input.periodMonth, periodYear: input.periodYear },
      createdBy: actor.userId,
    });

    return (await this.repo.findPayrollRunById(actor.tenantId, payrollRun.id))!;
  }

  async getPayrollRun(actor: ActorContext, id: string): Promise<PayrollRunDetailView> {
    await this.rbac.requirePermission(actor, "workforce.payroll.read");
    const payrollRun = await this.repo.findPayrollRunById(actor.tenantId, id);
    if (!payrollRun) throw new NotFoundError("WorkforcePayrollRun", id);
    await this.assertOrganizationUnitInScope(actor, payrollRun.organizationUnitId);

    const payslips = await this.repo.listPayslipsByRun(actor.tenantId, id);

    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (payrollRun.workflowInstanceId) {
      status = await this.workflow.getEntityStatus(actor, payrollRun.workflowInstanceId);
      const view = await this.workflow.getEntityWorkflowView(actor, payrollRun.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }

    return { payrollRun, payslips, status, availableActions };
  }

  async listPayrollRuns(
    actor: ActorContext,
    filter: PayrollRunListFilter = {},
  ): Promise<{ payrollRun: WorkforcePayrollRun; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "workforce.payroll.read");
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor, filter.organizationUnitId);
    const runs = await this.repo.listPayrollRuns(actor.tenantId, filter, organizationUnitIds);
    return this.withWorkflowStatus(actor, runs, (r) => r.workflowInstanceId, (payrollRun, status) => ({ payrollRun, status }));
  }

  async calculatePayrollRun(
    actor: ActorContext,
    id: string,
  ): Promise<{
    payrollRun: WorkforcePayrollRun;
    payslipCount: number;
    totals: { totalGross: number; totalDeductions: number; totalNet: number; totalEmployerContributions: number };
  }> {
    await this.rbac.requirePermission(actor, "workforce.payroll.manage");
    const run = await this.repo.findPayrollRunById(actor.tenantId, id);
    if (!run) throw new NotFoundError("WorkforcePayrollRun", id);
    await this.assertOrganizationUnitInScope(actor, run.organizationUnitId);
    if (run.approvedAt || run.closedAt) {
      throw new ConflictError("Cannot recalculate an approved or closed payroll run");
    }

    const periodMonth = String(run.periodMonth).padStart(2, "0");
    const periodStartDate = `${run.periodYear}-${periodMonth}-01`;
    const periodEndDate = new Date(Date.UTC(run.periodYear, run.periodMonth, 0))
      .toISOString()
      .slice(0, 10);
    const policy = await this.repo.findActiveStatutoryPolicy(actor.tenantId, periodStartDate);
    if (!policy) {
      throw new ValidationError(`No active statutory policy found effective for period ${run.periodYear}-${run.periodMonth}`);
    }

    let employeeOrganizationUnitIds: string[] | null = null;
    if (run.organizationUnitId) {
      const descendantIds = await this.repo.listOrganizationUnitDescendantIds(actor.tenantId, [run.organizationUnitId]);
      employeeOrganizationUnitIds = descendantIds.length > 0 ? descendantIds : [run.organizationUnitId];
    }

    const employees = await this.repo.listActiveEmployeeReferences(actor.tenantId, employeeOrganizationUnitIds);
    if (employees.length === 0) {
      throw new ValidationError("No active employees found to calculate payroll for");
    }

    const payslips: Array<Omit<WorkforcePayslip, "id" | "tenantId" | "payrollRunId" | "createdAt">> = [];

    let totalGrossCents = 0n;
    let totalDeductionsCents = 0n;
    let totalNetCents = 0n;
    let totalEmployerContributionsCents = 0n;

    for (const employee of employees) {
      const profile = await this.repo.findCurrentSalaryProfile(actor.tenantId, employee.id, periodStartDate);
      if (!profile) continue;

      const overtimeHours = await this.repo.findApprovedOvertimeHoursForEmployeePeriod(
        actor.tenantId,
        employee.id,
        periodStartDate,
        periodEndDate,
      );

      const calc = calculateEmployeePayroll({
        baseSalary: profile.baseSalary,
        fixedAllowance: profile.fixedAllowance,
        overtimeHours,
        overtimeHourlyRate: profile.overtimeHourlyRate,
        ptkpStatus: profile.ptkpStatus,
        hasNpwp: profile.hasNpwp,
        otherDeductions: 0,
        policy,
      });

      totalGrossCents += toCents(calc.grossSalary);
      totalDeductionsCents += toCents(calc.totalDeductions);
      totalNetCents += toCents(calc.netSalary);
      totalEmployerContributionsCents += toCents(calc.employerContributions);

      payslips.push({
        employeeId: employee.id,
        baseSalary: calc.baseSalary,
        allowances: calc.allowances,
        overtimeHours: calc.overtimeHours,
        overtimePay: calc.overtimePay,
        grossSalary: calc.grossSalary,
        bpjsKesehatanEmployee: calc.bpjsKesehatanEmployee,
        bpjsKesehatanEmployer: calc.bpjsKesehatanEmployer,
        bpjsTkJhtEmployee: calc.bpjsTkJhtEmployee,
        bpjsTkJhtEmployer: calc.bpjsTkJhtEmployer,
        bpjsTkJkkEmployer: calc.bpjsTkJkkEmployer,
        bpjsTkJkmEmployer: calc.bpjsTkJkmEmployer,
        bpjsTkJpEmployee: calc.bpjsTkJPSEmployee,
        bpjsTkJpEmployer: calc.bpjsTkJPSEmployer,
        pph21Withheld: calc.pph21Withheld,
        otherDeductions: calc.otherDeductions,
        totalDeductions: calc.totalDeductions,
        employerContributions: calc.employerContributions,
        netSalary: calc.netSalary,
        ptkpStatus: calc.ptkpStatus,
        calculationBreakdown: calc.breakdown as unknown as Record<string, unknown>,
      });
    }

    const totals = {
      totalGross: fromCents(totalGrossCents),
      totalDeductions: fromCents(totalDeductionsCents),
      totalNet: fromCents(totalNetCents),
      totalEmployerContributions: fromCents(totalEmployerContributionsCents),
      employeeCount: payslips.length,
    };

    await this.repo.savePayslipsAndTotals(actor.tenantId, run.id, payslips, totals);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.payroll_run.calculated",
      entityType: "workforce_payroll_run",
      entityId: run.id,
      metadata: { runNumber: run.runNumber, ...totals },
    });

    const updatedRun = (await this.repo.findPayrollRunById(actor.tenantId, run.id))!;
    return {
      payrollRun: updatedRun,
      payslipCount: payslips.length,
      totals,
    };
  }

  async actOnPayrollRun(
    actor: ActorContext,
    id: string,
    actionCode: string,
    comment: string | null = null,
  ): Promise<{ payrollRun: WorkforcePayrollRun; workflowResult: unknown }> {
    await this.rbac.requirePermission(actor, "workforce.payroll.approve");
    const payrollRun = await this.repo.findPayrollRunById(actor.tenantId, id);
    if (!payrollRun) throw new NotFoundError("WorkforcePayrollRun", id);
    await this.assertOrganizationUnitInScope(actor, payrollRun.organizationUnitId);
    if (!payrollRun.workflowInstanceId) {
      throw new ConflictError("This payroll run has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(actor.tenantId, payrollRun.workflowInstanceId);
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action exists on this payroll run");

    let payrollPostingContext: { decisionAt: Date; legalEntityId: string; periodId: string } | null = null;
    if (actionCode === "approve" || actionCode === "close") {
      const decisionAt = new Date();
      const legalEntityId = await this.resolvePayrollLegalEntityId(actor.tenantId, payrollRun);
      const periodId = await this.resolveOpenPayrollPeriod(actor.tenantId, legalEntityId, decisionAt);
      if (!periodId) {
        throw new ConflictError(
          `No open accounting period for date ${decisionAt.toISOString().split("T")[0]} in legal entity ${legalEntityId}`,
        );
      }
      payrollPostingContext = { decisionAt, legalEntityId, periodId };
    }

    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    let projected = payrollRun;
    if (payrollPostingContext) {
      projected = await this.repo.projectPayrollRunDecision(
        actor.tenantId,
        id,
        actionCode === "approve" ? "approved" : "closed",
        payrollPostingContext.decisionAt,
      );

      const idempotencyKey = `payroll-run:${id}:${actionCode}`;
      const existingEvent = await this.accountingEvents.getEventByIdempotencyKey(
        actor.tenantId,
        idempotencyKey,
      );
      if (!existingEvent) {
        await this.accountingEvents.createEvent(actor.tenantId, {
          eventType: "payroll.run_posted",
          sourceDocumentType: "workforce_payroll_run",
          sourceDocumentId: id,
          effectiveAt: payrollPostingContext.decisionAt,
          currency: "IDR",
          amount: projected.totalGross + projected.totalEmployerContributions,
          idempotencyKey,
          payload: {
            legalEntityId: payrollPostingContext.legalEntityId,
            periodId: payrollPostingContext.periodId,
            totalGross: projected.totalGross,
            totalDeductions: projected.totalDeductions,
            totalNet: projected.totalNet,
            totalEmployerContributions: projected.totalEmployerContributions,
            runNumber: projected.runNumber,
          },
          createdBy: actor.userId,
        });
      }
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: `workforce.payroll_run.${actionCode}`,
      entityType: "workforce_payroll_run",
      entityId: payrollRun.id,
      metadata: { actionCode, comment, runNumber: payrollRun.runNumber },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: `workforce.payroll_run.${actionCode}`,
      entityType: "workforce_payroll_run",
      entityId: payrollRun.id,
      payload: { runNumber: payrollRun.runNumber, actionCode },
      createdBy: actor.userId,
    });

    return {
      payrollRun: (await this.repo.findPayrollRunById(actor.tenantId, id)) ?? projected,
      workflowResult: result,
    };
  }

  async listPayslipsByRun(actor: ActorContext, payrollRunId: string): Promise<WorkforcePayslip[]> {
    await this.rbac.requirePermission(actor, "workforce.payroll.read");
    const run = await this.repo.findPayrollRunById(actor.tenantId, payrollRunId);
    if (!run) throw new NotFoundError("WorkforcePayrollRun", payrollRunId);
    await this.assertOrganizationUnitInScope(actor, run.organizationUnitId);
    return this.repo.listPayslipsByRun(actor.tenantId, payrollRunId);
  }

  // =========================================================================
  // 4. Recruitment (HR-ADV-006)
  // =========================================================================

  async createJobPosting(
    actor: ActorContext,
    input: {
      title: string;
      positionId?: string | null;
      organizationUnitId?: string | null;
      headcountTarget?: number;
      employmentType?: string | null;
      jobDescription?: string | null;
    },
  ): Promise<WorkforceJobPosting> {
    await this.rbac.requirePermission(actor, "workforce.recruitment.manage");

    if (input.positionId) {
      const posExists = await this.repo.positionExists(actor.tenantId, input.positionId);
      if (!posExists) throw new NotFoundError("Position", input.positionId);
    }
    await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);

    const { number: postingCode } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORKFORCE_JOB_POSTING_NUMBERING_CODE,
      actor.userId,
    );

    const jobPosting = await this.repo.createJobPosting(
      {
        tenantId: actor.tenantId,
        title: input.title.trim(),
        positionId: input.positionId ?? null,
        organizationUnitId: input.organizationUnitId ?? null,
        headcountTarget: input.headcountTarget ?? 1,
        employmentType: input.employmentType ?? null,
        jobDescription: input.jobDescription ?? null,
        actorUserId: actor.userId,
      },
      postingCode,
    );

    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: WORKFORCE_JOB_POSTING_WORKFLOW_DEFINITION_CODE,
        entityId: jobPosting.id,
        contextData: {
          // ADR-0012: the posting's owning Organization Unit (null = company-wide posting, tenant-level).
          organizationUnitId: jobPosting.organizationUnitId,
          postingCode: jobPosting.postingCode,
          title: jobPosting.title,
          headcountTarget: jobPosting.headcountTarget,
        },
      });
      await this.repo.setJobPostingWorkflowInstance(actor.tenantId, jobPosting.id, instance.id);
    } catch (error) {
      await this.repo.deleteJobPostingWithoutWorkflow(actor.tenantId, jobPosting.id);
      throw error;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.job_posting.created",
      entityType: "workforce_job_posting",
      entityId: jobPosting.id,
      metadata: { postingCode, title: jobPosting.title },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "workforce.job_posting.created",
      entityType: "workforce_job_posting",
      entityId: jobPosting.id,
      payload: { postingCode, title: jobPosting.title },
      createdBy: actor.userId,
    });

    return (await this.repo.findJobPostingById(actor.tenantId, jobPosting.id))!;
  }

  async getJobPosting(actor: ActorContext, id: string): Promise<JobPostingDetailView> {
    await this.rbac.requirePermission(actor, "workforce.recruitment.read");
    const jobPosting = await this.repo.findJobPostingById(actor.tenantId, id);
    if (!jobPosting) throw new NotFoundError("WorkforceJobPosting", id);
    await this.assertOrganizationUnitInScope(actor, jobPosting.organizationUnitId);

    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor, jobPosting.organizationUnitId);
    const applications = await this.repo.listJobApplications(
      actor.tenantId,
      { jobPostingId: id },
      organizationUnitIds,
    );

    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (jobPosting.workflowInstanceId) {
      status = await this.workflow.getEntityStatus(actor, jobPosting.workflowInstanceId);
      const view = await this.workflow.getEntityWorkflowView(actor, jobPosting.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }

    return { jobPosting, applications, status, availableActions };
  }

  async listJobPostings(
    actor: ActorContext,
    filter: JobPostingListFilter = {},
  ): Promise<{ jobPosting: WorkforceJobPosting; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "workforce.recruitment.read");
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor, filter.organizationUnitId);
    const postings = await this.repo.listJobPostings(actor.tenantId, filter, organizationUnitIds);
    return this.withWorkflowStatus(actor, postings, (r) => r.workflowInstanceId, (jobPosting, status) => ({ jobPosting, status }));
  }

  async actOnJobPosting(
    actor: ActorContext,
    id: string,
    actionCode: string,
    comment: string | null = null,
  ): Promise<{ jobPosting: WorkforceJobPosting; workflowResult: unknown }> {
    await this.rbac.requirePermission(actor, "workforce.recruitment.manage");
    const jobPosting = await this.repo.findJobPostingById(actor.tenantId, id);
    if (!jobPosting) throw new NotFoundError("WorkforceJobPosting", id);
    await this.assertOrganizationUnitInScope(actor, jobPosting.organizationUnitId);
    if (!jobPosting.workflowInstanceId) {
      throw new ConflictError("This job posting has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(actor.tenantId, jobPosting.workflowInstanceId);
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action exists on this job posting");

    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    let projected = jobPosting;
    if (actionCode === "publish" || actionCode === "approve") {
      projected = await this.repo.projectJobPostingDecision(actor.tenantId, id, "published", new Date());
    } else if (actionCode === "close") {
      projected = await this.repo.projectJobPostingDecision(actor.tenantId, id, "closed", new Date());
    } else if (actionCode === "cancel") {
      projected = await this.repo.projectJobPostingDecision(actor.tenantId, id, "cancelled", new Date());
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: `workforce.job_posting.${actionCode}`,
      entityType: "workforce_job_posting",
      entityId: jobPosting.id,
      metadata: { actionCode, comment, postingCode: jobPosting.postingCode },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: `workforce.job_posting.${actionCode}`,
      entityType: "workforce_job_posting",
      entityId: jobPosting.id,
      payload: { postingCode: jobPosting.postingCode, actionCode },
      createdBy: actor.userId,
    });

    return {
      jobPosting: (await this.repo.findJobPostingById(actor.tenantId, id)) ?? projected,
      workflowResult: result,
    };
  }

  async createJobApplication(
    actor: ActorContext,
    input: {
      jobPostingId: string;
      candidateName: string;
      candidateEmail?: string | null;
      candidatePhone?: string | null;
      resumeDocumentId?: string | null;
    },
  ): Promise<WorkforceJobApplication> {
    await this.rbac.requirePermission(actor, "workforce.recruitment.manage");
    const posting = await this.repo.findJobPostingById(actor.tenantId, input.jobPostingId);
    if (!posting) throw new NotFoundError("WorkforceJobPosting", input.jobPostingId);
    await this.assertOrganizationUnitInScope(actor, posting.organizationUnitId);

    const application = await this.repo.createJobApplication({
      tenantId: actor.tenantId,
      jobPostingId: input.jobPostingId,
      candidateName: input.candidateName.trim(),
      candidateEmail: input.candidateEmail ?? null,
      candidatePhone: input.candidatePhone ?? null,
      resumeDocumentId: input.resumeDocumentId ?? null,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.job_application.created",
      entityType: "workforce_job_application",
      entityId: application.id,
      metadata: { jobPostingId: application.jobPostingId, candidateName: application.candidateName },
    });

    return application;
  }

  async listJobApplications(actor: ActorContext, filter: JobApplicationListFilter = {}): Promise<WorkforceJobApplication[]> {
    await this.rbac.requirePermission(actor, "workforce.recruitment.read");
    if (filter.jobPostingId) {
      const posting = await this.repo.findJobPostingById(actor.tenantId, filter.jobPostingId);
      if (!posting) throw new NotFoundError("WorkforceJobPosting", filter.jobPostingId);
      await this.assertOrganizationUnitInScope(actor, posting.organizationUnitId);
    }
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor);
    return this.repo.listJobApplications(actor.tenantId, filter, organizationUnitIds);
  }

  async advanceJobApplication(
    actor: ActorContext,
    input: Omit<AdvanceJobApplicationInput, "tenantId" | "actorUserId">,
  ): Promise<WorkforceJobApplication> {
    await this.rbac.requirePermission(actor, "workforce.recruitment.manage");
    const application = await this.repo.findJobApplicationById(actor.tenantId, input.id);
    if (!application) throw new NotFoundError("WorkforceJobApplication", input.id);
    const posting = await this.repo.findJobPostingById(actor.tenantId, application.jobPostingId);
    if (!posting) throw new NotFoundError("WorkforceJobPosting", application.jobPostingId);
    await this.assertOrganizationUnitInScope(actor, posting.organizationUnitId);

    if (input.hiredEmployeeId) {
      await this.assertEmployeeInScope(actor, input.hiredEmployeeId);
    }

    const advanced = await this.repo.advanceJobApplication({
      ...input,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.job_application.advanced",
      entityType: "workforce_job_application",
      entityId: advanced.id,
      metadata: { stage: advanced.stage, rating: advanced.rating },
    });

    return advanced;
  }

  // =========================================================================
  // 5. Competency, Training, Performance & Career (HR-ADV-007, HR-ADV-008)
  // =========================================================================

  async createCompetency(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      category?: string | null;
      description?: string | null;
      scaleMin?: number;
      scaleMax?: number;
    },
  ): Promise<WorkforceCompetency> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    await this.assertOrganizationUnitInScope(actor, null);

    const competency = await this.repo.createCompetency({
      tenantId: actor.tenantId,
      code: input.code.trim(),
      name: input.name.trim(),
      category: input.category ?? null,
      description: input.description ?? null,
      scaleMin: input.scaleMin ?? 1,
      scaleMax: input.scaleMax ?? 5,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.competency.created",
      entityType: "workforce_competency",
      entityId: competency.id,
      metadata: { code: competency.code, name: competency.name },
    });

    return competency;
  }

  async listCompetencies(actor: ActorContext, includeInactive = false): Promise<WorkforceCompetency[]> {
    await this.rbac.requirePermission(actor, "workforce.performance.read");
    await this.assertOrganizationUnitInScope(actor, null);
    return this.repo.listCompetencies(actor.tenantId, includeInactive);
  }

  async assessEmployeeCompetency(
    actor: ActorContext,
    input: {
      employeeId: string;
      competencyId: string;
      proficiencyLevel: number;
      notes?: string | null;
    },
  ): Promise<WorkforceEmployeeCompetency> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    await this.assertEmployeeInScope(actor, input.employeeId);

    const assessed = await this.repo.assessEmployeeCompetency({
      tenantId: actor.tenantId,
      employeeId: input.employeeId,
      competencyId: input.competencyId,
      proficiencyLevel: input.proficiencyLevel,
      notes: input.notes ?? null,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.employee_competency.assessed",
      entityType: "workforce_employee_competency",
      entityId: assessed.id,
      metadata: { employeeId: assessed.employeeId, competencyId: assessed.competencyId, proficiencyLevel: assessed.proficiencyLevel },
    });

    return assessed;
  }

  async listEmployeeCompetencies(actor: ActorContext, employeeId: string): Promise<WorkforceEmployeeCompetency[]> {
    await this.rbac.requirePermission(actor, "workforce.performance.read");
    await this.assertEmployeeInScope(actor, employeeId);
    return this.repo.listEmployeeCompetencies(actor.tenantId, employeeId);
  }

  async createTrainingCourse(
    actor: ActorContext,
    input: {
      courseCode: string;
      title: string;
      provider?: string | null;
      durationHours?: number;
      competencyId?: string | null;
      description?: string | null;
    },
  ): Promise<WorkforceTrainingCourse> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    await this.assertOrganizationUnitInScope(actor, null);

    const course = await this.repo.createTrainingCourse({
      tenantId: actor.tenantId,
      courseCode: input.courseCode.trim(),
      title: input.title.trim(),
      provider: input.provider ?? null,
      durationHours: input.durationHours ?? 8,
      competencyId: input.competencyId ?? null,
      description: input.description ?? null,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.training_course.created",
      entityType: "workforce_training_course",
      entityId: course.id,
      metadata: { courseCode: course.courseCode, title: course.title },
    });

    return course;
  }

  async listTrainingCourses(actor: ActorContext, includeInactive = false): Promise<WorkforceTrainingCourse[]> {
    await this.rbac.requirePermission(actor, "workforce.performance.read");
    await this.assertOrganizationUnitInScope(actor, null);
    return this.repo.listTrainingCourses(actor.tenantId, includeInactive);
  }

  async enrollTraining(
    actor: ActorContext,
    input: {
      trainingCourseId: string;
      employeeId: string;
    },
  ): Promise<WorkforceTrainingEnrollment> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    await this.assertEmployeeInScope(actor, input.employeeId);

    const enrollment = await this.repo.enrollTraining({
      tenantId: actor.tenantId,
      trainingCourseId: input.trainingCourseId,
      employeeId: input.employeeId,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.training.enrolled",
      entityType: "workforce_training_enrollment",
      entityId: enrollment.id,
      metadata: { trainingCourseId: enrollment.trainingCourseId, employeeId: enrollment.employeeId },
    });

    return enrollment;
  }

  async listTrainingEnrollments(actor: ActorContext, employeeId: string): Promise<WorkforceTrainingEnrollment[]> {
    await this.rbac.requirePermission(actor, "workforce.performance.read");
    await this.assertEmployeeInScope(actor, employeeId);
    return this.repo.listTrainingEnrollments(actor.tenantId, employeeId);
  }

  async completeTraining(
    actor: ActorContext,
    input: Omit<CompleteTrainingInput, "tenantId" | "actorUserId">,
  ): Promise<WorkforceTrainingEnrollment> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    const enrollment = await this.repo.findTrainingEnrollmentById(actor.tenantId, input.id);
    if (!enrollment) throw new NotFoundError("WorkforceTrainingEnrollment", input.id);
    await this.assertEmployeeInScope(actor, enrollment.employeeId);

    const completionDate = this.validateDateOnly(input.completionDate, "completionDate");

    const completed = await this.repo.completeTraining({
      ...input,
      completionDate,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.training.completed",
      entityType: "workforce_training_enrollment",
      entityId: completed.id,
      metadata: { status: completed.status, score: completed.score, completionDate },
    });

    return completed;
  }

  async createPerformanceReview(
    actor: ActorContext,
    input: {
      employeeId: string;
      periodStart: string;
      periodEnd: string;
      reviewerUserId?: string | null;
      goalsScore?: number | null;
      competencyScore?: number | null;
      overallRating?: number | null;
      reviewNotes?: string | null;
      developmentPlan?: string | null;
    },
  ): Promise<WorkforcePerformanceReview> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    const employee = await this.assertEmployeeInScope(actor, input.employeeId);

    const periodStart = this.validateDateOnly(input.periodStart, "periodStart");
    const periodEnd = this.validateDateOnly(input.periodEnd, "periodEnd");

    const { number: reviewCode } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORKFORCE_PERFORMANCE_REVIEW_NUMBERING_CODE,
      actor.userId,
    );

    const review = await this.repo.createPerformanceReview(
      {
        tenantId: actor.tenantId,
        employeeId: input.employeeId,
        periodStart,
        periodEnd,
        reviewerUserId: input.reviewerUserId ?? actor.userId,
        goalsScore: input.goalsScore ?? null,
        competencyScore: input.competencyScore ?? null,
        overallRating: input.overallRating ?? null,
        reviewNotes: input.reviewNotes ?? null,
        developmentPlan: input.developmentPlan ?? null,
        actorUserId: actor.userId,
      },
      reviewCode,
    );

    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: WORKFORCE_PERFORMANCE_REVIEW_WORKFLOW_DEFINITION_CODE,
        entityId: review.id,
        contextData: {
          // ADR-0012: follows the employee's owning Organization Unit.
          organizationUnitId: employee.organizationUnitId,
          employeeId: review.employeeId,
          reviewCode: review.reviewCode,
          periodStart: review.periodStart,
          periodEnd: review.periodEnd,
        },
      });
      await this.repo.setPerformanceReviewWorkflowInstance(actor.tenantId, review.id, instance.id);
    } catch (error) {
      await this.repo.deletePerformanceReviewWithoutWorkflow(actor.tenantId, review.id);
      throw error;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.performance_review.created",
      entityType: "workforce_performance_review",
      entityId: review.id,
      metadata: { reviewCode, employeeId: review.employeeId },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "workforce.performance_review.created",
      entityType: "workforce_performance_review",
      entityId: review.id,
      payload: { reviewCode, employeeId: review.employeeId },
      createdBy: actor.userId,
    });

    return (await this.repo.findPerformanceReviewById(actor.tenantId, review.id))!;
  }

  async getPerformanceReview(actor: ActorContext, id: string): Promise<PerformanceReviewDetailView> {
    await this.rbac.requirePermission(actor, "workforce.performance.read");
    const review = await this.repo.findPerformanceReviewById(actor.tenantId, id);
    if (!review) throw new NotFoundError("WorkforcePerformanceReview", id);
    await this.assertEmployeeInScope(actor, review.employeeId);

    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (review.workflowInstanceId) {
      status = await this.workflow.getEntityStatus(actor, review.workflowInstanceId);
      const view = await this.workflow.getEntityWorkflowView(actor, review.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }

    return { review, status, availableActions };
  }

  async listPerformanceReviews(
    actor: ActorContext,
    filter: PerformanceReviewListFilter = {},
  ): Promise<{ review: WorkforcePerformanceReview; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "workforce.performance.read");
    if (filter.employeeId) {
      await this.assertEmployeeInScope(actor, filter.employeeId);
    }
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor);
    const reviews = await this.repo.listPerformanceReviews(actor.tenantId, filter, organizationUnitIds);
    return this.withWorkflowStatus(actor, reviews, (r) => r.workflowInstanceId, (review, status) => ({ review, status }));
  }

  async actOnPerformanceReview(
    actor: ActorContext,
    id: string,
    actionCode: string,
    comment: string | null = null,
  ): Promise<{ review: WorkforcePerformanceReview; workflowResult: unknown }> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    const review = await this.repo.findPerformanceReviewById(actor.tenantId, id);
    if (!review) throw new NotFoundError("WorkforcePerformanceReview", id);
    await this.assertEmployeeInScope(actor, review.employeeId);
    if (!review.workflowInstanceId) {
      throw new ConflictError("This performance review has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(actor.tenantId, review.workflowInstanceId);
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action exists on this performance review");

    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    let projected = review;
    if (actionCode === "submit") {
      projected = await this.repo.projectPerformanceReviewDecision(actor.tenantId, id, "submitted", new Date());
    } else if (actionCode === "finalize" || actionCode === "approve") {
      projected = await this.repo.projectPerformanceReviewDecision(actor.tenantId, id, "finalized", new Date());
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: `workforce.performance_review.${actionCode}`,
      entityType: "workforce_performance_review",
      entityId: review.id,
      metadata: { actionCode, comment, reviewCode: review.reviewCode },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: `workforce.performance_review.${actionCode}`,
      entityType: "workforce_performance_review",
      entityId: review.id,
      payload: { reviewCode: review.reviewCode, actionCode },
      createdBy: actor.userId,
    });

    return {
      review: (await this.repo.findPerformanceReviewById(actor.tenantId, id)) ?? projected,
      workflowResult: result,
    };
  }

  async createCareerPath(
    actor: ActorContext,
    input: {
      fromPositionId: string;
      toPositionId: string;
      requiredTenureMonths?: number;
      requiredCompetencyIds?: string[];
      guidelines?: string | null;
    },
  ): Promise<WorkforceCareerPath> {
    await this.rbac.requirePermission(actor, "workforce.performance.manage");
    await this.assertOrganizationUnitInScope(actor, null);

    if (input.fromPositionId === input.toPositionId) {
      throw new ValidationError("fromPositionId and toPositionId must be distinct positions");
    }

    const [fromExists, toExists] = await Promise.all([
      this.repo.positionExists(actor.tenantId, input.fromPositionId),
      this.repo.positionExists(actor.tenantId, input.toPositionId),
    ]);
    if (!fromExists) throw new NotFoundError("Position", input.fromPositionId);
    if (!toExists) throw new NotFoundError("Position", input.toPositionId);

    const careerPath = await this.repo.createCareerPath({
      tenantId: actor.tenantId,
      fromPositionId: input.fromPositionId,
      toPositionId: input.toPositionId,
      requiredTenureMonths: input.requiredTenureMonths ?? 12,
      requiredCompetencyIds: input.requiredCompetencyIds ?? [],
      guidelines: input.guidelines ?? null,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.career_path.created",
      entityType: "workforce_career_path",
      entityId: careerPath.id,
      metadata: { fromPositionId: careerPath.fromPositionId, toPositionId: careerPath.toPositionId },
    });

    return careerPath;
  }

  async listCareerPaths(actor: ActorContext, fromPositionId?: string): Promise<WorkforceCareerPath[]> {
    await this.rbac.requirePermission(actor, "workforce.performance.read");
    await this.assertOrganizationUnitInScope(actor, null);
    return this.repo.listCareerPaths(actor.tenantId, fromPositionId);
  }

  // =========================================================================
  // 6. Manpower Planning (HR-ADV-009) — advisory only
  // =========================================================================

  async createManpowerPlan(
    actor: ActorContext,
    input: {
      planYear: number;
      title: string;
      organizationUnitId?: string | null;
      parameters?: Record<string, unknown>;
    },
  ): Promise<WorkforceManpowerPlan> {
    await this.rbac.requirePermission(actor, "workforce.planning.manage");

    if (input.planYear < 2000 || input.planYear > 2100) {
      throw new ValidationError("planYear is out of valid range");
    }

    await this.assertOrganizationUnitInScope(actor, input.organizationUnitId);

    const { number: planNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      WORKFORCE_MANPOWER_PLAN_NUMBERING_CODE,
      actor.userId,
    );

    const plan = await this.repo.createManpowerPlan(
      {
        tenantId: actor.tenantId,
        planYear: input.planYear,
        title: input.title.trim(),
        organizationUnitId: input.organizationUnitId ?? null,
        parameters: input.parameters ?? {},
        actorUserId: actor.userId,
      },
      planNumber,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.manpower_plan.created",
      entityType: "workforce_manpower_plan",
      entityId: plan.id,
      metadata: { planNumber, planYear: input.planYear, title: plan.title },
    });

    return plan;
  }

  async getManpowerPlan(actor: ActorContext, id: string): Promise<WorkforceManpowerPlan> {
    await this.rbac.requirePermission(actor, "workforce.planning.read");
    const plan = await this.repo.findManpowerPlanById(actor.tenantId, id);
    if (!plan) throw new NotFoundError("WorkforceManpowerPlan", id);
    await this.assertOrganizationUnitInScope(actor, plan.organizationUnitId);
    return plan;
  }

  async listManpowerPlans(actor: ActorContext, filter: ManpowerPlanListFilter = {}): Promise<WorkforceManpowerPlan[]> {
    await this.rbac.requirePermission(actor, "workforce.planning.read");
    const organizationUnitIds = await this.resolveScopedOrganizationUnitIds(actor, filter.organizationUnitId);
    return this.repo.listManpowerPlans(actor.tenantId, filter, organizationUnitIds);
  }

  async computeManpowerPlan(
    actor: ActorContext,
    input: {
      id: string;
      targetHeadcountByPosition: Record<string, number>;
    },
  ): Promise<WorkforceManpowerPlan> {
    await this.rbac.requirePermission(actor, "workforce.planning.manage");
    const plan = await this.repo.findManpowerPlanById(actor.tenantId, input.id);
    if (!plan) throw new NotFoundError("WorkforceManpowerPlan", input.id);
    await this.assertOrganizationUnitInScope(actor, plan.organizationUnitId);
    if (plan.status === "applied" || plan.status === "dismissed") {
      throw new ConflictError(`Cannot compute manpower plan in '${plan.status}' status`);
    }

    let employeeOrganizationUnitIds: string[] | null = null;
    if (plan.organizationUnitId) {
      const descendantIds = await this.repo.listOrganizationUnitDescendantIds(actor.tenantId, [plan.organizationUnitId]);
      employeeOrganizationUnitIds = descendantIds.length > 0 ? descendantIds : [plan.organizationUnitId];
    }

    const employees = await this.repo.listActiveEmployeeReferences(actor.tenantId, employeeOrganizationUnitIds);

    // Group current headcount by positionId
    const currentByPosition = new Map<string, number>();
    for (const emp of employees) {
      const pos = emp.positionId ?? "unassigned";
      currentByPosition.set(pos, (currentByPosition.get(pos) ?? 0) + 1);
    }

    // Default average cost estimate per employee position (IDR 10,000,000 / month = 120,000,000 / year)
    const DEFAULT_ANNUAL_COST_PER_HEAD = 120_000_000;

    const allPositionIds = new Set<string>([
      ...Array.from(currentByPosition.keys()),
      ...Object.keys(input.targetHeadcountByPosition),
    ]);

    const gapAnalysis: ManpowerGapEntry[] = [];
    let currentHeadcount = 0;
    let plannedHeadcount = 0;

    for (const posId of allPositionIds) {
      const currentCount = currentByPosition.get(posId) ?? 0;
      const plannedCount = input.targetHeadcountByPosition[posId] ?? currentCount;
      const variance = plannedCount - currentCount;
      const costImpact = variance * DEFAULT_ANNUAL_COST_PER_HEAD;

      currentHeadcount += currentCount;
      plannedHeadcount += plannedCount;

      gapAnalysis.push({
        organizationUnitId: plan.organizationUnitId,
        positionId: posId === "unassigned" ? null : posId,
        currentHeadcount: currentCount,
        plannedHeadcount: plannedCount,
        variance,
        costImpact,
      });
    }

    const varianceHeadcount = plannedHeadcount - currentHeadcount;
    const currentCostProjection = currentHeadcount * DEFAULT_ANNUAL_COST_PER_HEAD;
    const plannedCostProjection = plannedHeadcount * DEFAULT_ANNUAL_COST_PER_HEAD;
    const varianceCostProjection = plannedCostProjection - currentCostProjection;

    const updated = await this.repo.saveManpowerPlanComputation(actor.tenantId, plan.id, {
      currentHeadcount,
      plannedHeadcount,
      varianceHeadcount,
      currentCostProjection,
      plannedCostProjection,
      varianceCostProjection,
      gapAnalysis,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.manpower_plan.computed",
      entityType: "workforce_manpower_plan",
      entityId: plan.id,
      metadata: { planNumber: plan.planNumber, currentHeadcount, plannedHeadcount, varianceHeadcount },
    });

    return updated;
  }

  async applyManpowerPlan(actor: ActorContext, id: string): Promise<WorkforceManpowerPlan> {
    await this.rbac.requirePermission(actor, "workforce.planning.apply");
    const plan = await this.repo.findManpowerPlanById(actor.tenantId, id);
    if (!plan) throw new NotFoundError("WorkforceManpowerPlan", id);
    await this.assertOrganizationUnitInScope(actor, plan.organizationUnitId);
    if (plan.status === "applied" || plan.status === "dismissed") {
      throw new ConflictError(`Cannot apply manpower plan in '${plan.status}' status`);
    }

    const applied = await this.repo.applyManpowerPlan(actor.tenantId, id, actor.userId);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.manpower_plan.applied",
      entityType: "workforce_manpower_plan",
      entityId: applied.id,
      metadata: { planNumber: applied.planNumber, appliedBy: actor.userId },
    });

    return applied;
  }

  async dismissManpowerPlan(actor: ActorContext, id: string): Promise<WorkforceManpowerPlan> {
    await this.rbac.requirePermission(actor, "workforce.planning.manage");
    const plan = await this.repo.findManpowerPlanById(actor.tenantId, id);
    if (!plan) throw new NotFoundError("WorkforceManpowerPlan", id);
    await this.assertOrganizationUnitInScope(actor, plan.organizationUnitId);
    if (plan.status === "applied" || plan.status === "dismissed") {
      throw new ConflictError(`Cannot dismiss manpower plan in '${plan.status}' status`);
    }

    const dismissed = await this.repo.dismissManpowerPlan(actor.tenantId, id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "workforce.manpower_plan.dismissed",
      entityType: "workforce_manpower_plan",
      entityId: dismissed.id,
      metadata: { planNumber: dismissed.planNumber },
    });

    return dismissed;
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async resolvePayrollLegalEntityId(
    tenantId: string,
    payrollRun: WorkforcePayrollRun,
  ): Promise<string> {
    if (!payrollRun.organizationUnitId) {
      throw new ConflictError("Payroll run must have an organization unit before posting");
    }

    const legalEntityId = await this.repo.findLegalEntityIdForOrganizationUnit(
      tenantId,
      payrollRun.organizationUnitId,
    );
    if (!legalEntityId) {
      throw new ConflictError("Payroll run organization unit has no legal entity");
    }
    return legalEntityId;
  }

  private async resolveOpenPayrollPeriod(
    tenantId: string,
    legalEntityId: string,
    at: Date,
  ): Promise<string | null> {
    const decisionDate = at.toISOString().split("T")[0];
    const periods = await this.repo.listOpenAccountingPeriods(tenantId, legalEntityId);
    const matching = periods.find((period) => {
      const dateFrom = period.dateFrom.toISOString().split("T")[0];
      const dateTo = period.dateTo.toISOString().split("T")[0];
      return dateFrom <= decisionDate && decisionDate <= dateTo;
    });
    return matching?.id ?? null;
  }

  private async assertEmployeeExists(tenantId: string, employeeId: string): Promise<EmployeeReference> {
    const employee = await this.repo.findEmployeeReference(tenantId, employeeId);
    if (!employee) throw new NotFoundError("Employee", employeeId);
    return employee;
  }

  private async assertEmployeeInScope(actor: ActorContext, employeeId: string): Promise<EmployeeReference> {
    const employee = await this.assertEmployeeExists(actor.tenantId, employeeId);
    const hasTenant = await this.rbac.hasTenantScope(actor);
    if (!hasTenant) {
      if (!employee.organizationUnitId) {
        throw new ForbiddenError("Your assigned Data Scope does not cover unassigned employees");
      }
      await this.rbac.requireOrganizationUnitScopeForActor(actor, employee.organizationUnitId);
    }
    return employee;
  }

  private async assertOrganizationUnitInScope(
    actor: ActorContext,
    organizationUnitId: string | null | undefined,
  ): Promise<void> {
    if (organizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, organizationUnitId);
    } else {
      const hasTenant = await this.rbac.hasTenantScope(actor);
      if (!hasTenant) {
        throw new ForbiddenError("Tenant-wide scope required for tenant-level entities");
      }
    }
  }

  private async resolveScopedOrganizationUnitIds(
    actor: ActorContext,
    requestedOrgUnitId?: string | null,
  ): Promise<string[] | null> {
    const hasTenant = await this.rbac.hasTenantScope(actor);
    if (requestedOrgUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, requestedOrgUnitId);
      const descendantIds = await this.repo.listOrganizationUnitDescendantIds(actor.tenantId, [requestedOrgUnitId]);
      return descendantIds.length > 0 ? descendantIds : [requestedOrgUnitId];
    }
    if (hasTenant) {
      return null;
    }
    const assignments = await this.rbac.getAssignments(actor.userId);
    const rootOrgUnitIds = assignments
      .filter((a) => a.scopeType === "organization_unit" && a.scopeOrganizationUnitId)
      .map((a) => a.scopeOrganizationUnitId as string);
    if (rootOrgUnitIds.length === 0) {
      return [];
    }
    const descendantIds = await this.repo.listOrganizationUnitDescendantIds(actor.tenantId, rootOrgUnitIds);
    return descendantIds.length > 0 ? descendantIds : rootOrgUnitIds;
  }

  private async withWorkflowStatus<T, R>(
    actor: ActorContext,
    items: T[],
    getWorkflowInstanceId: (item: T) => string | null,
    combine: (item: T, status: EntityWorkflowStatus | null) => R,
  ): Promise<R[]> {
    const result: R[] = [];
    for (const item of items) {
      const instanceId = getWorkflowInstanceId(item);
      let status: EntityWorkflowStatus | null = null;
      if (instanceId) {
        try {
          status = await this.workflow.getEntityStatus(actor, instanceId);
        } catch {
          // Stale or unassigned instance
        }
      }
      result.push(combine(item, status));
    }
    return result;
  }

  private validateDateOnly(dateStr: string, field: string): string {
    const trimmed = (dateStr ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new ValidationError(`${field} must be in YYYY-MM-DD format`);
    }
    if (Number.isNaN(new Date(`${trimmed}T00:00:00Z`).getTime())) {
      throw new ValidationError(`${field} is not a valid calendar date`);
    }
    return trimmed;
  }

  private validateTimeString(timeStr: string, field: string): string {
    const trimmed = (timeStr ?? "").trim();
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) {
      throw new ValidationError(`${field} must be in HH:MM:SS format`);
    }
    return trimmed;
  }

  /**
   * Entity Authorization Resolvers for secure attachment handling (ADR-0012).
   */
  async canAccessLeaveRequestForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const req = await this.repo.findLeaveRequestById(actor.tenantId, entityId);
    if (!req) return false;
    try {
      await this.rbac.requirePermission(actor, "workforce.leave.read");
      await this.assertEmployeeInScope(actor, req.employeeId);
      return true;
    } catch {
      return false;
    }
  }

  async canAccessJobApplicationForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const app = await this.repo.findJobApplicationById(actor.tenantId, entityId);
    if (!app) return false;
    const posting = await this.repo.findJobPostingById(actor.tenantId, app.jobPostingId);
    if (!posting) return false;
    try {
      await this.rbac.requirePermission(actor, "workforce.recruitment.read");
      await this.assertOrganizationUnitInScope(actor, posting.organizationUnitId);
      return true;
    } catch {
      return false;
    }
  }

  async canAccessTrainingEnrollmentForDocument(actor: ActorContext, entityId: string): Promise<boolean> {
    const enrollment = await this.repo.findTrainingEnrollmentById(actor.tenantId, entityId);
    if (!enrollment) return false;
    try {
      await this.rbac.requirePermission(actor, "workforce.performance.read");
      await this.assertEmployeeInScope(actor, enrollment.employeeId);
      return true;
    } catch {
      return false;
    }
  }
}

