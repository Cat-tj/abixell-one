import type { ActorContext } from "../../../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../../domain/shared-kernel/errors.js";
import type { AuditService } from "../../../../application/audit/audit.service.js";
import type { RbacService } from "../../../../application/rbac/rbac.service.js";
import type { EventBus } from "../../../../application/event/event-bus.js";
import type {
  EntityWorkflowAction,
  EntityWorkflowStatus,
  WorkflowService,
} from "../../../../application/workflow/workflow.service.js";
import type { ConfigurationService } from "../../../../application/configuration/configuration.service.js";
import type {
  AssetAdvancedRepository,
  AssetDowntimeRecord,
  AssetMaintenancePart,
  AssetMaintenanceSchedule,
  AssetMaintenanceWorkOrder,
  AssetMeterReading,
  AssetPredictiveSnapshot,
  DowntimeReasonCategory,
  MaintenanceFrequencyType,
  MaintenancePriority,
  MaintenanceType,
  MaintenanceWorkOrderListFilter,
  MeterReadingType,
  ReliabilityMetrics,
} from "../domain/asset-advanced.entity.js";

/** Tenant configuration codes. */
export const ASSET_MAINTENANCE_WORK_ORDER_NUMBERING_CODE = "asset_maintenance_work_order";
export const ASSET_MAINTENANCE_WORKFLOW_DEFINITION_CODE = "asset_maintenance_work_order";

/** Workflow action code → domain event mapping. */
const ACTION_EVENT_MAP: Record<string, string> = {
  submit: "asset.maintenance.submitted",
  assign: "asset.maintenance.assigned",
  start: "asset.maintenance.started",
  complete: "asset.maintenance.completed",
  verify: "asset.maintenance.verified",
  reject: "asset.maintenance.rejected",
  cancel: "asset.maintenance.cancelled",
};

export interface MaintenanceWorkOrderDetailView {
  workOrder: AssetMaintenanceWorkOrder;
  schedule: AssetMaintenanceSchedule | null;
  parts: AssetMaintenancePart[];
  status: EntityWorkflowStatus | null;
  availableActions: EntityWorkflowAction[];
}

/**
 * Asset Advanced Application Service (AST-ADV-001…007).
 *
 * Provides:
 * - AST-ADV-001: Preventive Maintenance Scheduling (calendar and meter-based)
 * - AST-ADV-002: Maintenance Work Orders (preventive, corrective, emergency)
 *   with generic Workflow Engine lifecycle delegation (zero competing state
 *   machines, zero mutation to Asset Core status)
 * - AST-ADV-003: Monotonic Meter Readings with usage tracking
 * - AST-ADV-004: Spare Parts Consumption (referencing Supply Chain items via narrow port)
 * - AST-ADV-005: Downtime Tracking
 * - AST-ADV-006 / AST-ADV-007: Reliability Metrics (MTBF, MTTR, Availability) & Predictive Snapshots
 */
export class AssetAdvancedService {
  constructor(
    private readonly repo: AssetAdvancedRepository,
    private readonly workflow: WorkflowService,
    private readonly configuration: ConfigurationService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly eventBus: EventBus,
  ) {}

  // =========================================================================
  // Maintenance Schedules (AST-ADV-001)
  // =========================================================================

  async createMaintenanceSchedule(
    actor: ActorContext,
    input: {
      assetId: string;
      scheduleCode: string;
      title: string;
      description?: string | null;
      frequencyType: MaintenanceFrequencyType;
      intervalDays?: number | null;
      meterInterval?: number | null;
      meterType?: MeterReadingType | null;
      nextDueDate?: string | null;
      nextDueMeter?: number | null;
    },
  ): Promise<AssetMaintenanceSchedule> {
    await this.rbac.requirePermission(actor, "asset.maintenance.manage");
    await this.assertAssetExists(actor.tenantId, input.assetId);

    if (input.frequencyType === "calendar" && (!input.intervalDays || input.intervalDays <= 0)) {
      throw new ValidationError("Calendar frequency requires intervalDays > 0");
    }
    if (input.frequencyType === "meter" && (!input.meterInterval || input.meterInterval <= 0 || !input.meterType)) {
      throw new ValidationError("Meter frequency requires meterInterval > 0 and meterType");
    }

    const schedule = await this.repo.createMaintenanceSchedule({
      tenantId: actor.tenantId,
      assetId: input.assetId,
      scheduleCode: input.scheduleCode.trim(),
      title: input.title.trim(),
      description: input.description ?? null,
      frequencyType: input.frequencyType,
      intervalDays: input.intervalDays ?? null,
      meterInterval: input.meterInterval ?? null,
      meterType: input.meterType ?? null,
      nextDueDate: input.nextDueDate ?? null,
      nextDueMeter: input.nextDueMeter ?? null,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.maintenance_schedule.created",
      entityType: "asset_maintenance_schedule",
      entityId: schedule.id,
      metadata: { scheduleCode: schedule.scheduleCode, assetId: schedule.assetId },
    });

    return schedule;
  }

  async listMaintenanceSchedules(actor: ActorContext, assetId?: string): Promise<AssetMaintenanceSchedule[]> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    if (assetId) await this.assertAssetExists(actor.tenantId, assetId);
    return this.repo.listMaintenanceSchedules(actor.tenantId, assetId);
  }

  async getMaintenanceSchedule(actor: ActorContext, id: string): Promise<AssetMaintenanceSchedule> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    const schedule = await this.repo.findMaintenanceScheduleById(actor.tenantId, id);
    if (!schedule) throw new NotFoundError("AssetMaintenanceSchedule", id);
    return schedule;
  }

  async listDueSchedules(actor: ActorContext, asOfDate?: string): Promise<AssetMaintenanceSchedule[]> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    const targetDate = asOfDate ? this.validateDateOnly(asOfDate, "asOfDate") : this.todayDateString();
    return this.repo.listDueMaintenanceSchedules(actor.tenantId, targetDate);
  }

  // =========================================================================
  // Maintenance Work Orders (AST-ADV-001 / AST-ADV-002)
  // =========================================================================

  async createMaintenanceWorkOrder(
    actor: ActorContext,
    input: {
      assetId: string;
      scheduleId?: string | null;
      maintenanceType: MaintenanceType;
      priority?: MaintenancePriority;
      title: string;
      description?: string | null;
      costEstimate?: number | null;
    },
  ): Promise<AssetMaintenanceWorkOrder> {
    await this.rbac.requirePermission(actor, "asset.maintenance.manage");
    await this.assertAssetExists(actor.tenantId, input.assetId);

    if (input.scheduleId) {
      const schedule = await this.repo.findMaintenanceScheduleById(actor.tenantId, input.scheduleId);
      if (!schedule) throw new NotFoundError("AssetMaintenanceSchedule", input.scheduleId);
      if (schedule.assetId !== input.assetId) {
        throw new ValidationError("Maintenance schedule must belong to the selected asset");
      }
    }

    const { number: orderNumber } = await this.configuration.generateNumberForTenant(
      actor.tenantId,
      ASSET_MAINTENANCE_WORK_ORDER_NUMBERING_CODE,
      actor.userId,
    );

    const workOrder = await this.repo.createMaintenanceWorkOrder({
      tenantId: actor.tenantId,
      orderNumber,
      assetId: input.assetId,
      scheduleId: input.scheduleId ?? null,
      maintenanceType: input.maintenanceType,
      priority: input.priority ?? "medium",
      title: input.title.trim(),
      description: input.description ?? null,
      costEstimate: input.costEstimate ?? null,
      createdBy: actor.userId,
    });

    // Lifecycle is owned exclusively by the generic Workflow Engine. If an
    // instance cannot be started, compensate the just-created row and surface
    // the configuration error; a workflow-less order must never be actionable.
    try {
      const { instance } = await this.workflow.startInstance(actor, {
        definitionCode: ASSET_MAINTENANCE_WORKFLOW_DEFINITION_CODE,
        entityId: workOrder.id,
        contextData: {
          assetId: workOrder.assetId,
          // ADR-0012: the maintenance order follows its asset's owning unit.
          organizationUnitId: await this.repo.findAssetOrganizationUnitId(
            actor.tenantId,
            workOrder.assetId,
          ),
          maintenanceType: workOrder.maintenanceType,
          priority: workOrder.priority,
          orderNumber: workOrder.orderNumber,
        },
      });
      await this.repo.setMaintenanceWorkOrderWorkflowInstance(actor.tenantId, workOrder.id, instance.id);
    } catch (error) {
      await this.repo.deleteMaintenanceWorkOrderWithoutWorkflow(actor.tenantId, workOrder.id);
      throw error;
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.maintenance_work_order.created",
      entityType: "asset_maintenance_work_order",
      entityId: workOrder.id,
      metadata: { orderNumber, assetId: workOrder.assetId, maintenanceType: workOrder.maintenanceType },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "asset.maintenance_work_order.created",
      entityType: "asset_maintenance_work_order",
      entityId: workOrder.id,
      payload: { orderNumber, assetId: workOrder.assetId, maintenanceType: workOrder.maintenanceType },
      createdBy: actor.userId,
    });

    return (await this.repo.findMaintenanceWorkOrderById(actor.tenantId, workOrder.id))!;
  }

  async listMaintenanceWorkOrders(
    actor: ActorContext,
    filter: MaintenanceWorkOrderListFilter = {},
  ): Promise<{ workOrder: AssetMaintenanceWorkOrder; status: EntityWorkflowStatus | null }[]> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    const orders = await this.repo.listMaintenanceWorkOrders(actor.tenantId, filter);
    return this.withWorkflowStatus(actor, orders);
  }

  async getMaintenanceWorkOrderDetail(actor: ActorContext, id: string): Promise<MaintenanceWorkOrderDetailView> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    const workOrder = await this.repo.findMaintenanceWorkOrderById(actor.tenantId, id);
    if (!workOrder) throw new NotFoundError("AssetMaintenanceWorkOrder", id);

    const [schedule, parts] = await Promise.all([
      workOrder.scheduleId
        ? this.repo.findMaintenanceScheduleById(actor.tenantId, workOrder.scheduleId)
        : Promise.resolve(null),
      this.repo.listMaintenanceParts(actor.tenantId, workOrder.id),
    ]);

    let status: EntityWorkflowStatus | null = null;
    let availableActions: EntityWorkflowAction[] = [];
    if (workOrder.workflowInstanceId) {
      status = await this.workflow.getEntityStatus(actor, workOrder.workflowInstanceId);
      const view = await this.workflow.getEntityWorkflowView(actor, workOrder.workflowInstanceId);
      availableActions = view.availableActions ?? [];
    }

    return { workOrder, schedule, parts, status, availableActions };
  }

  /** Assignment is execution metadata, not lifecycle state. The order must
   * already have an authoritative Workflow Instance, and the assignee must be
   * a user owned by this tenant (enforced again by the composite FK). */
  async assignMaintenanceWorkOrder(
    actor: ActorContext,
    id: string,
    assigneeUserId: string,
  ): Promise<AssetMaintenanceWorkOrder> {
    await this.rbac.requirePermission(actor, "asset.maintenance.manage");
    const workOrder = await this.repo.findMaintenanceWorkOrderById(actor.tenantId, id);
    if (!workOrder) throw new NotFoundError("AssetMaintenanceWorkOrder", id);
    if (!workOrder.workflowInstanceId) {
      throw new ConflictError("This maintenance work order has no active Workflow Instance");
    }
    if (workOrder.assignedAt) throw new ConflictError("This maintenance work order is already assigned");

    const updated = await this.repo.assignMaintenanceWorkOrder({
      tenantId: actor.tenantId,
      id: workOrder.id,
      assignedToUserId: assigneeUserId,
      assignedByUserId: actor.userId,
    });

    if (!updated) throw new ConflictError("Failed to assign maintenance work order — concurrent modification");

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.maintenance_work_order.assigned",
      entityType: "asset_maintenance_work_order",
      entityId: workOrder.id,
      metadata: { assigneeUserId },
    });

    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType: "asset.maintenance_work_order.assigned",
      entityType: "asset_maintenance_work_order",
      entityId: workOrder.id,
      payload: { orderNumber: workOrder.orderNumber, targetUserId: assigneeUserId },
      createdBy: actor.userId,
    });

    return updated;
  }

  async startMaintenanceWorkOrder(actor: ActorContext, id: string): Promise<AssetMaintenanceWorkOrder> {
    return (await this.actOnMaintenanceWorkOrder(actor, id, "start", null)).workOrder;
  }

  async completeMaintenanceWorkOrder(
    actor: ActorContext,
    id: string,
    input: {
      completionNotes?: string | null;
      actualCost?: number | null;
      downtimeHours?: number | null;
      currentMeterReading?: number | null;
    } = {},
  ): Promise<AssetMaintenanceWorkOrder> {
    return (
      await this.actOnMaintenanceWorkOrder(actor, id, "complete", input.completionNotes ?? null, {
        actualCost: input.actualCost ?? null,
        downtimeHours: input.downtimeHours ?? null,
        currentMeterReading: input.currentMeterReading ?? null,
      })
    ).workOrder;
  }

  async verifyMaintenanceWorkOrder(
    actor: ActorContext,
    id: string,
    verificationNotes?: string | null,
  ): Promise<AssetMaintenanceWorkOrder> {
    return (await this.actOnMaintenanceWorkOrder(actor, id, "verify", verificationNotes ?? null)).workOrder;
  }

  /** Generic workflow action forwarder (AST-ADV-001/002). */
  async actOnMaintenanceWorkOrder(
    actor: ActorContext,
    id: string,
    actionCode: string,
    comment: string | null,
    completionFacts?: {
      actualCost?: number | null;
      downtimeHours?: number | null;
      currentMeterReading?: number | null;
    },
  ) {
    await this.rbac.requirePermission(actor, "asset.maintenance.manage");
    const workOrder = await this.repo.findMaintenanceWorkOrderById(actor.tenantId, id);
    if (!workOrder) throw new NotFoundError("AssetMaintenanceWorkOrder", id);
    if (!workOrder.workflowInstanceId) {
      throw new ConflictError("This maintenance work order has no active Workflow Instance");
    }

    const { assignments } = await this.workflow.getInstanceForEntityOwner(
      actor.tenantId,
      workOrder.workflowInstanceId,
    );
    const pending = assignments.find((a) => a.status === "pending");
    if (!pending) throw new ConflictError("No pending action exists on this maintenance work order");

    // Workflow transition first: timestamps below are projections of a
    // transition that the authoritative engine has accepted, never an
    // independent lifecycle decision.
    const result = await this.workflow.actOnAssignment(actor, pending.id, actionCode, comment);

    let projected = workOrder;
    if (actionCode === "start" && !workOrder.startedAt) {
      projected =
        (await this.repo.startMaintenanceWorkOrder({
          tenantId: actor.tenantId,
          id: workOrder.id,
          startedByUserId: actor.userId,
        })) ?? workOrder;
    } else if (actionCode === "complete" && !workOrder.completedAt) {
      projected =
        (await this.repo.completeMaintenanceWorkOrder({
          tenantId: actor.tenantId,
          id: workOrder.id,
          completedByUserId: actor.userId,
          completionNotes: comment,
          actualCost: completionFacts?.actualCost ?? null,
          downtimeHours: completionFacts?.downtimeHours ?? null,
        })) ?? workOrder;
      if (workOrder.scheduleId && projected.completedAt) {
        await this.repo.advanceScheduleAfterCompletion(
          actor.tenantId,
          workOrder.scheduleId,
          projected.completedAt,
          completionFacts?.currentMeterReading ?? null,
        );
      }
    } else if (actionCode === "verify" && !workOrder.verifiedAt) {
      projected =
        (await this.repo.verifyMaintenanceWorkOrder({
          tenantId: actor.tenantId,
          id: workOrder.id,
          verifiedByUserId: actor.userId,
          verificationNotes: comment,
        })) ?? workOrder;
    }

    const eventType = ACTION_EVENT_MAP[actionCode] ?? "asset.maintenance.status_changed";
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: eventType,
      entityType: "asset_maintenance_work_order",
      entityId: workOrder.id,
      metadata: { actionCode, comment, ...completionFacts },
    });
    await this.eventBus.publish({
      tenantId: actor.tenantId,
      eventType,
      entityType: "asset_maintenance_work_order",
      entityId: workOrder.id,
      payload: {
        orderNumber: workOrder.orderNumber,
        assetId: workOrder.assetId,
        targetUserId: workOrder.assignedToUserId,
        actionCode,
      },
      createdBy: actor.userId,
    });

    return {
      workOrder: (await this.repo.findMaintenanceWorkOrderById(actor.tenantId, workOrder.id)) ?? projected,
      workflowResult: result,
    };
  }

  // =========================================================================
  // Spare Parts Management (AST-ADV-004)
  // =========================================================================

  async recordSparePart(
    actor: ActorContext,
    workOrderId: string,
    input: { itemId: string; quantity: number; unitCost?: number | null; notes?: string | null },
  ): Promise<AssetMaintenancePart> {
    await this.rbac.requirePermission(actor, "asset.maintenance.manage");
    const workOrder = await this.repo.findMaintenanceWorkOrderById(actor.tenantId, workOrderId);
    if (!workOrder) throw new NotFoundError("AssetMaintenanceWorkOrder", workOrderId);
    if (workOrder.completedAt) throw new ConflictError("Cannot record parts on completed maintenance work order");

    if (input.quantity <= 0) throw new ValidationError("Spare part quantity must be > 0");

    const itemExists = await this.repo.itemExists(actor.tenantId, input.itemId);
    if (!itemExists) throw new NotFoundError("Item", input.itemId);

    const part = await this.repo.recordMaintenancePart({
      tenantId: actor.tenantId,
      maintenanceWorkOrderId: workOrder.id,
      itemId: input.itemId,
      quantity: input.quantity,
      unitCost: input.unitCost ?? null,
      notes: input.notes ?? null,
      recordedByUserId: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.maintenance_part.recorded",
      entityType: "asset_maintenance_part",
      entityId: part.id,
      metadata: { workOrderId: workOrder.id, itemId: input.itemId, quantity: input.quantity },
    });

    return part;
  }

  async listSpareParts(actor: ActorContext, workOrderId: string): Promise<AssetMaintenancePart[]> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    const workOrder = await this.repo.findMaintenanceWorkOrderById(actor.tenantId, workOrderId);
    if (!workOrder) throw new NotFoundError("AssetMaintenanceWorkOrder", workOrderId);
    return this.repo.listMaintenanceParts(actor.tenantId, workOrderId);
  }

  // =========================================================================
  // Meter Readings (AST-ADV-003)
  // =========================================================================

  async recordMeterReading(
    actor: ActorContext,
    assetId: string,
    input: { readingType: MeterReadingType; readingValue: number; readingDate?: string | null; notes?: string | null },
  ): Promise<AssetMeterReading> {
    await this.rbac.requirePermission(actor, "asset.meter.manage");
    await this.assertAssetExists(actor.tenantId, assetId);

    if (input.readingValue < 0) throw new ValidationError("Meter reading value cannot be negative");
    const readingDate = input.readingDate ? this.validateIsoDateTime(input.readingDate, "readingDate") : new Date().toISOString();

    const latest = await this.repo.findLatestMeterReading(actor.tenantId, assetId, input.readingType);
    if (latest && input.readingValue < latest.readingValue) {
      throw new ValidationError(
        `Monotonic violation: new reading (${input.readingValue}) cannot be lower than latest reading (${latest.readingValue})`,
      );
    }
    if (latest && new Date(readingDate).getTime() < latest.readingDate.getTime()) {
      throw new ValidationError("Monotonic violation: reading date cannot be earlier than latest reading date");
    }

    const reading = await this.repo.recordMeterReading({
      tenantId: actor.tenantId,
      assetId,
      readingType: input.readingType,
      readingValue: input.readingValue,
      readingDate,
      recordedByUserId: actor.userId,
      notes: input.notes ?? null,
    });

    if (!reading) {
      throw new ConflictError(
        "Monotonic violation: concurrent reading was recorded with a higher value or newer timestamp",
      );
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.meter_reading.recorded",
      entityType: "asset_meter_reading",
      entityId: reading.id,
      metadata: { assetId, readingType: reading.readingType, readingValue: reading.readingValue },
    });

    return reading;
  }

  async listMeterReadings(
    actor: ActorContext,
    assetId: string,
    readingType?: MeterReadingType,
  ): Promise<AssetMeterReading[]> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    await this.assertAssetExists(actor.tenantId, assetId);
    return this.repo.listMeterReadings(actor.tenantId, assetId, readingType);
  }

  // =========================================================================
  // Downtime Tracking (AST-ADV-005)
  // =========================================================================

  async recordDowntime(
    actor: ActorContext,
    assetId: string,
    input: {
      maintenanceWorkOrderId?: string | null;
      startTime: string;
      endTime?: string | null;
      reasonCategory: DowntimeReasonCategory;
      notes?: string | null;
    },
  ): Promise<AssetDowntimeRecord> {
    await this.rbac.requirePermission(actor, "asset.downtime.manage");
    await this.assertAssetExists(actor.tenantId, assetId);

    const startTime = this.validateIsoDateTime(input.startTime, "startTime");
    let endTime: string | null = null;
    if (input.endTime) {
      endTime = this.validateIsoDateTime(input.endTime, "endTime");
      if (new Date(endTime).getTime() <= new Date(startTime).getTime()) {
        throw new ValidationError("endTime must be strictly after startTime");
      }
    }

    if (input.maintenanceWorkOrderId) {
      const workOrder = await this.repo.findMaintenanceWorkOrderById(actor.tenantId, input.maintenanceWorkOrderId);
      if (!workOrder) throw new NotFoundError("AssetMaintenanceWorkOrder", input.maintenanceWorkOrderId);
      if (workOrder.assetId !== assetId) {
        throw new ValidationError("Referenced maintenance work order must belong to the selected asset");
      }
    }

    const downtime = await this.repo.recordDowntime({
      tenantId: actor.tenantId,
      assetId,
      maintenanceWorkOrderId: input.maintenanceWorkOrderId ?? null,
      startTime,
      endTime,
      reasonCategory: input.reasonCategory,
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.downtime.recorded",
      entityType: "asset_downtime_record",
      entityId: downtime.id,
      metadata: { assetId, reasonCategory: downtime.reasonCategory },
    });

    return downtime;
  }

  async closeDowntime(actor: ActorContext, id: string, endTime?: string | null): Promise<AssetDowntimeRecord> {
    await this.rbac.requirePermission(actor, "asset.downtime.manage");
    const end = endTime ? new Date(this.validateIsoDateTime(endTime, "endTime")) : new Date();
    const updated = await this.repo.closeDowntime(actor.tenantId, id, end);
    if (!updated) throw new ConflictError("Downtime record not found or already closed");

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.downtime.closed",
      entityType: "asset_downtime_record",
      entityId: id,
      metadata: { durationMinutes: updated.durationMinutes },
    });

    return updated;
  }

  async listDowntimeRecords(actor: ActorContext, assetId: string): Promise<AssetDowntimeRecord[]> {
    await this.rbac.requirePermission(actor, "asset.maintenance.read");
    await this.assertAssetExists(actor.tenantId, assetId);
    return this.repo.listDowntimeRecords(actor.tenantId, assetId);
  }

  // =========================================================================
  // Reliability Metrics & Predictive Maintenance (AST-ADV-006 / AST-ADV-007)
  // =========================================================================

  async calculateReliabilityMetrics(
    actor: ActorContext,
    assetId: string,
    periodStartStr: string,
    periodEndStr: string,
  ): Promise<ReliabilityMetrics> {
    await this.rbac.requirePermission(actor, "asset.analytics.read");
    await this.assertAssetExists(actor.tenantId, assetId);

    const periodStart = new Date(`${this.validateDateOnly(periodStartStr, "periodStart")}T00:00:00.000Z`);
    const periodEnd = new Date(`${this.validateDateOnly(periodEndStr, "periodEnd")}T23:59:59.999Z`);
    if (periodEnd.getTime() <= periodStart.getTime()) {
      throw new ValidationError("periodEnd must be after periodStart");
    }

    const elapsedHours = Math.max(0, (periodEnd.getTime() - periodStart.getTime()) / (1000 * 3600));
    const [downtimeHours, correctiveFailures, repairDowntimeHours] = await Promise.all([
      this.repo.sumDowntimeHours(actor.tenantId, assetId, periodStart, periodEnd),
      this.repo.countCorrectiveFailures(actor.tenantId, assetId, periodStart, periodEnd),
      this.repo.sumRepairDowntimeHours(actor.tenantId, assetId, periodStart, periodEnd),
    ]);

    const boundedDowntime = Math.min(elapsedHours, downtimeHours);
    const operationalHours = Math.max(0, elapsedHours - boundedDowntime);

    // MTBF = Operational Hours / Corrective Failure Count (if 0 failures -> MTBF = operational hours)
    const mtbfHours = correctiveFailures > 0 ? operationalHours / correctiveFailures : operationalHours;

    // MTTR = Repair Downtime Hours / Corrective Failure Count (if 0 failures -> MTTR = 0)
    const mttrHours = correctiveFailures > 0 ? repairDowntimeHours / correctiveFailures : 0;

    // Availability % = (Operational Hours / (Operational Hours + Downtime Hours)) * 100
    const totalAccounted = operationalHours + boundedDowntime;
    const availabilityPct = totalAccounted > 0 ? (operationalHours / totalAccounted) * 100 : 100;

    return {
      periodStart: periodStartStr,
      periodEnd: periodEndStr,
      elapsedHours: round(elapsedHours, 2),
      downtimeHours: round(boundedDowntime, 2),
      operationalHours: round(operationalHours, 2),
      correctiveFailureCount: correctiveFailures,
      mtbfHours: round(mtbfHours, 2),
      mttrHours: round(mttrHours, 2),
      availabilityPct: round(availabilityPct, 2),
    };
  }

  async generatePredictiveSnapshot(
    actor: ActorContext,
    assetId: string,
  ): Promise<AssetPredictiveSnapshot> {
    await this.rbac.requirePermission(actor, "asset.analytics.read");
    await this.assertAssetExists(actor.tenantId, assetId);

    const analysisDate = this.todayDateString();
    const lookbackStart = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const metrics = await this.calculateReliabilityMetrics(actor, assetId, lookbackStart, analysisDate);

    // Heuristic deterministic Health Score (0 - 100)
    let healthScore = 100;
    if (metrics.availabilityPct < 95) healthScore -= 20;
    if (metrics.availabilityPct < 85) healthScore -= 25;
    if (metrics.correctiveFailureCount >= 3) healthScore -= 25;
    else if (metrics.correctiveFailureCount >= 1) healthScore -= 10;
    if (metrics.mttrHours > 12) healthScore -= 15;
    healthScore = Math.max(10, Math.min(100, healthScore));

    let recommendation: string | null = null;
    let predictedFailureDate: string | null = null;
    let confidencePct: number | null = 80.0;

    if (healthScore < 50) {
      recommendation = "Immediate overhaul and critical component replacement advised. High failure probability.";
      predictedFailureDate = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      confidencePct = 85.0;
    } else if (healthScore < 75) {
      recommendation = "Perform scheduled preventive inspection and lube cycle within 14 days.";
      predictedFailureDate = new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      confidencePct = 75.0;
    } else {
      recommendation = "Asset operating within optimal reliability parameters. Maintain routine schedule.";
      confidencePct = 90.0;
    }

    const snapshot = await this.repo.createPredictiveSnapshot({
      tenantId: actor.tenantId,
      assetId,
      analysisDate,
      mtbfHours: metrics.mtbfHours,
      mttrHours: metrics.mttrHours,
      availabilityPct: metrics.availabilityPct,
      healthScore,
      predictedFailureDate,
      confidencePct,
      recommendation,
      createdBy: actor.userId,
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "asset.predictive_snapshot.generated",
      entityType: "asset_predictive_snapshot",
      entityId: snapshot.id,
      metadata: { assetId, healthScore, availabilityPct: metrics.availabilityPct },
    });

    return snapshot;
  }

  async listPredictiveSnapshots(actor: ActorContext, assetId: string, limit?: number): Promise<AssetPredictiveSnapshot[]> {
    await this.rbac.requirePermission(actor, "asset.analytics.read");
    await this.assertAssetExists(actor.tenantId, assetId);
    return this.repo.listPredictiveSnapshots(actor.tenantId, assetId, limit);
  }

  async getLatestPredictiveSnapshot(actor: ActorContext, assetId: string): Promise<AssetPredictiveSnapshot | null> {
    await this.rbac.requirePermission(actor, "asset.analytics.read");
    await this.assertAssetExists(actor.tenantId, assetId);
    return this.repo.findLatestPredictiveSnapshot(actor.tenantId, assetId);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async assertAssetExists(tenantId: string, assetId: string): Promise<void> {
    const exists = await this.repo.assetExists(tenantId, assetId);
    if (!exists) throw new NotFoundError("Asset", assetId);
  }

  private async withWorkflowStatus(actor: ActorContext, orders: AssetMaintenanceWorkOrder[]) {
    const rows: { workOrder: AssetMaintenanceWorkOrder; status: EntityWorkflowStatus | null }[] = [];
    for (const workOrder of orders) {
      let status: EntityWorkflowStatus | null = null;
      if (workOrder.workflowInstanceId) {
        try {
          status = await this.workflow.getEntityStatus(actor, workOrder.workflowInstanceId);
        } catch {
          // Unassigned or stale instance
        }
      }
      rows.push({ workOrder, status });
    }
    return rows;
  }

  private todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private validateDateOnly(dateStr: string, field: string): string {
    const trimmed = (dateStr ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new ValidationError(`${field} must be YYYY-MM-DD format`);
    }
    if (Number.isNaN(new Date(`${trimmed}T00:00:00Z`).getTime())) {
      throw new ValidationError(`${field} is not a valid calendar date`);
    }
    return trimmed;
  }

  private validateIsoDateTime(dateTimeStr: string, field: string): string {
    const trimmed = (dateTimeStr ?? "").trim();
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new ValidationError(`${field} is not a valid ISO timestamp`);
    }
    return trimmed;
  }
}

function round(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}
