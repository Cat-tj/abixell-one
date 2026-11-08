import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../../composition-root.js";

/**
 * Service Operations HTTP surface (Phase 2). Follows the existing API
 * conventions exactly: `app.authenticate` preHandler, zod body validation,
 * `request.actor!` for tenant/user context, and errors mapped centrally.
 */

const serviceDefinitionSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});

const checklistTemplateSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const activeSchema = z.object({ isActive: z.boolean() });

const workRequestSchema = z.object({
  customerId: z.string().uuid(),
  contractId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
  serviceDefinitionCode: z.string().min(1),
  description: z.string().min(1),
  priority: z.string().nullable().optional(),
});

const cancelSchema = z.object({ reason: z.string().nullable().optional() });

const scheduleSchema = z.object({
  plannedStartAt: z.string().nullable().optional(),
  plannedEndAt: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
});

const convertSchema = scheduleSchema.extend({ title: z.string().min(1).optional() });

const workOrderSchema = scheduleSchema.extend({
  customerId: z.string().uuid(),
  contractId: z.string().uuid().nullable().optional(),
  woType: z.enum(["regular", "back_charge"]).optional(),
  projectId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
  serviceDefinitionCode: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
});

const assignSchema = z.object({ assigneeUserId: z.string().uuid() });
const notesSchema = z.object({ notes: z.string().nullable().optional() });
const commentSchema = z.object({ comment: z.string().nullable().optional() });
const checklistResultSchema = z.object({
  isCompleted: z.boolean(),
  note: z.string().nullable().optional(),
});
const acceptanceTokenSchema = z.object({
  expiresInDays: z.number().int().positive().max(365).optional(),
});
const rejectReasonSchema = z.object({ reason: z.string().min(1).max(2000) });
const costAmountSchema = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const costItemSchema = z.object({
  costType: z.enum(["material", "labor", "overhead"]),
  description: z.string().nullable().optional(),
  quantity: costAmountSchema,
  unitCost: costAmountSchema,
  costCenterId: z.string().uuid().nullable().optional(),
});
const finalizeCostsSchema = z.object({ legalEntityId: z.string().uuid() });
const servingQtySchema = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const servingLogSchema = z.object({
  mealDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  openingTime: z.string().datetime(),
  closingTime: z.string().datetime().nullable().optional(),
  receivedQty: servingQtySchema,
  servedQty: servingQtySchema,
  returnedQty: servingQtySchema,
  wastedQty: servingQtySchema,
  servicePointId: z.string().uuid().nullable().optional(),
  servingSupervisorUserId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
});
const servingLogUpdateSchema = z.object({
  closingTime: z.string().datetime().nullable().optional(),
  servedQty: servingQtySchema.optional(),
  returnedQty: servingQtySchema.optional(),
  wastedQty: servingQtySchema.optional(),
  servingSupervisorUserId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
});
const rateSchema = z.string().regex(/^0(\.\d{1,6})?$|^1(\.0{1,6})?$/);
const createInvoiceSchema = z.object({
  legalEntityId: z.string().uuid(),
  markupRate: rateSchema.optional(),
  isTaxable: z.boolean(),
  taxRate: rateSchema.optional(),
});

export function registerServiceOperationsRoutes(app: FastifyInstance, container: Container) {
  const svc = () => container.serviceOperations;
  const kpiSvc = () => container.kpi;

  // --- Service Definitions (SO-CORE-001 / SO-CORE-007) -----------------

  app.post("/service-definitions", { preHandler: app.authenticate }, async (request, reply) => {
    const body = serviceDefinitionSchema.parse(request.body);
    return reply.status(201).send(await svc().createServiceDefinition(request.actor!, body));
  });

  app.get("/service-definitions", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await svc().listServiceDefinitions(request.actor!));
  });

  app.get("/service-definitions/:code", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    return reply.send(await svc().getServiceDefinition(request.actor!, code));
  });

  app.post(
    "/service-definitions/:code/checklist-items",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const body = checklistTemplateSchema.parse(request.body);
      return reply.status(201).send(await svc().addChecklistTemplateItem(request.actor!, code, body));
    },
  );

  app.patch("/service-definitions/:code/active", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const { isActive } = activeSchema.parse(request.body);
    return reply.send(await svc().setServiceDefinitionActive(request.actor!, code, isActive));
  });

  // --- Work Requests (SO-CORE-002) -------------------------------------

  app.post("/work-requests", { preHandler: app.authenticate }, async (request, reply) => {
    const body = workRequestSchema.parse(request.body);
    return reply.status(201).send(await svc().createWorkRequest(request.actor!, body));
  });

  app.get("/work-requests", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await svc().listWorkRequests(request.actor!));
  });

  app.get("/work-requests/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().getWorkRequest(request.actor!, id));
  });

  app.post("/work-requests/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = cancelSchema.parse(request.body ?? {});
    return reply.send(await svc().cancelWorkRequest(request.actor!, id, reason ?? null));
  });

  /** Intake -> executable work (SO-CORE-003). */
  app.post("/work-requests/:id/convert", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = convertSchema.parse(request.body ?? {});
    return reply.status(201).send(await svc().convertRequestToWorkOrder(request.actor!, id, body));
  });

  // --- Work Orders (SO-CORE-003 … SO-CORE-014) -------------------------

  // --- Project membership (owner request: project isolation) -------------

  app.get("/projects/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().listProjectMembers(request.actor!, id));
  });

  app.post("/projects/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ userId: z.string().uuid(), roleCode: z.string().nullable().optional() }).parse(request.body);
    await svc().addProjectMember(request.actor!, id, body.userId, body.roleCode ?? null);
    return reply.status(201).send({ ok: true });
  });

  app.delete("/projects/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId } = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).parse(request.params);
    await svc().removeProjectMember(request.actor!, id, userId);
    return reply.status(204).send();
  });
  app.post("/work-orders", { preHandler: app.authenticate }, async (request, reply) => {
    const body = workOrderSchema.parse(request.body);
    return reply.status(201).send(await svc().createWorkOrder(request.actor!, body));
  });

  /** Coordinator/supervisor queue (SO-CORE-013). */
  app.get("/work-orders", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { siteId?: string; status?: "open" | "completed" };
    return reply.send(await svc().listWorkOrders(request.actor!, { siteId: query.siteId, status: query.status }));
  });

  /** Field surface (SO-CORE-014) — declared before `/:id` so "my" is not
   * captured as an id parameter. */
  app.get("/work-orders/my", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await svc().listMyWork(request.actor!));
  });

  app.get("/work-orders/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().getWorkOrderDetail(request.actor!, id));
  });

  app.post("/work-orders/:id/assign", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { assigneeUserId } = assignSchema.parse(request.body);
    return reply.send(await svc().assignWorkOrder(request.actor!, id, assigneeUserId));
  });

  app.post("/work-orders/:id/schedule", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = scheduleSchema.parse(request.body ?? {});
    return reply.send(await svc().scheduleWorkOrder(request.actor!, id, body));
  });

  /** Generic lifecycle dispatch — the Workflow Engine validates the
   * transition; this module never encodes the Step graph (SO-CORE-004). */
  app.post("/work-orders/:id/actions/:actionCode", { preHandler: app.authenticate }, async (request, reply) => {
    const { id, actionCode } = request.params as { id: string; actionCode: string };
    const { comment } = commentSchema.parse(request.body ?? {});
    return reply.send(await svc().act(request.actor!, id, actionCode, comment ?? null));
  });

  app.post("/work-orders/:id/start", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().startWork(request.actor!, id));
  });

  app.post(
    "/work-orders/:id/checklist/:itemId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, itemId } = request.params as { id: string; itemId: string };
      const body = checklistResultSchema.parse(request.body);
      return reply.send(await svc().setChecklistItem(request.actor!, id, itemId, body));
    },
  );

  app.post("/work-orders/:id/complete", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { notes } = notesSchema.parse(request.body ?? {});
    return reply.send(await svc().completeWork(request.actor!, id, notes ?? null));
  });

  app.post("/work-orders/:id/verify", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { notes } = notesSchema.parse(request.body ?? {});
    return reply.send(await svc().verifyWork(request.actor!, id, notes ?? null));
  });

  // --- Customer Acceptance Gate (WP-OPS-01 Phase 6) ---------------------
  // The public, authless counterpart lives in
  // `interfaces/http/routes/public-work-order-acceptance.ts`.

  app.post("/work-orders/:id/acceptance-token", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = acceptanceTokenSchema.parse(request.body ?? {});
    const issued = await svc().issueAcceptanceToken(request.actor!, id, {
      expiresInDays: body.expiresInDays,
      createdBy: request.actor!.userId,
    });
    return reply.status(201).send(issued);
  });

  app.post("/work-orders/:id/customer-accept", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { comment } = commentSchema.parse(request.body ?? {});
    return reply.send(await svc().acceptWorkInternally(request.actor!, id, comment ?? null));
  });

  app.post("/work-orders/:id/customer-reject", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = rejectReasonSchema.parse(request.body ?? {});
    return reply.send(await svc().rejectWorkInternally(request.actor!, id, reason));
  });

  // --- Cost Accumulator (WP-OPS-02 Phase 6) ----------------------------

  app.post("/work-orders/:id/cost-items", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = costItemSchema.parse(request.body);
    return reply.status(201).send(await svc().addCostItem(request.actor!, id, body));
  });

  app.get("/work-orders/:id/cost-items", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().listCostItems(request.actor!, id));
  });

  app.post("/work-orders/:id/finalize-costs", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = finalizeCostsSchema.parse(request.body);
    return reply.send(await svc().finalizeCosts(request.actor!, id, body));
  });

  // --- Customer Invoice / Billing-AR (WP-OPS-03 Phase 6) ----------------

  app.post("/work-orders/:id/create-invoice", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createInvoiceSchema.parse(request.body);
    return reply.status(201).send(await svc().createInvoice(request.actor!, id, body));
  });

  app.get("/work-orders/:id/invoice", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().getInvoice(request.actor!, id));
  });

  // --- Work Order Serving Log (SO-CORE-016) --------------------------------

  app.post("/work-orders/:id/serving", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = servingLogSchema.parse(request.body);
    const result = await svc().recordServingLog(request.actor!, id, {
      ...body,
      openingTime: new Date(body.openingTime),
      closingTime: body.closingTime ? new Date(body.closingTime) : undefined,
    });
    return reply.status(201).send(result);
  });

  app.get("/work-orders/:id/serving", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // Same envelope as POST/PATCH: { servingLog }, null when none is recorded yet.
    return reply.send({ servingLog: await svc().getServingLog(request.actor!, id) });
  });

  app.patch("/work-orders/:id/serving", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = servingLogUpdateSchema.parse(request.body);
    const result = await svc().updateServingLog(request.actor!, id, {
      ...body,
      closingTime: body.closingTime ? new Date(body.closingTime) : undefined,
    });
    return reply.send(result);
  });

  // --- KPI Dashboard (SO-CORE-017) — L2 Management, 4 core KPIs ----------

  const dashboardQuerySchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/) });

  app.get("/dashboard/management", { preHandler: app.authenticate }, async (request, reply) => {
    const { period } = dashboardQuerySchema.parse(request.query);
    const actor = request.actor!;
    return reply.send(await kpiSvc().getMgmtDashboard(actor, actor.tenantId, period));
  });
}
