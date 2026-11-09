import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../composition-root.js";

const conditionExpressionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in"]),
  value: z.unknown(),
});

/** z.unknown() makes Zod infer `value` as optional (it accepts undefined),
 * but the domain ConditionExpression requires `value` to be present
 * (possibly `undefined` itself as a legitimate condition value, just not
 * an absent key). This narrows the parsed shape back to the domain type
 * without weakening runtime validation. */
function toConditionExpression(
  parsed: { field: string; operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in"; value?: unknown } | null | undefined,
): import("../../../domain/workflow/workflow.entity.js").ConditionExpression | null {
  if (!parsed) return null;
  return { field: parsed.field, operator: parsed.operator, value: parsed.value };
}

const createDefinitionSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  entityType: z.string().min(1),
  description: z.string().min(1),
});

const addStepSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  stepType: z.enum(["task", "approval", "end"]),
  isInitial: z.boolean().optional(),
  isTerminal: z.boolean().optional(),
  terminalStatus: z.enum(["approved", "rejected", "cancelled"]).nullable().optional(),
  slaHours: z.number().int().positive().nullable().optional(),
  sequenceOrder: z.number().int().optional(),
});

const addTransitionSchema = z.object({
  fromStepCode: z.string().min(1),
  toStepCode: z.string().min(1),
  actionCode: z.string().min(1),
  name: z.string().min(1),
  conditionExpression: conditionExpressionSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const addAssignmentRuleSchema = z.object({
  stepCode: z.string().min(1),
  assignmentType: z.enum(["role", "specific_user"]),
  roleCode: z.string().nullable().optional(),
  organizationUnitStrategy: z.enum(["submitter_unit", "tenant"]).nullable().optional(),
  specificUserSource: z.enum(["submitter", "fixed"]).nullable().optional(),
  fixedUserId: z.string().uuid().nullable().optional(),
  conditionExpression: conditionExpressionSchema.nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const addEscalationRuleSchema = z.object({
  stepCode: z.string().min(1),
  escalateAfterHours: z.number().int().positive(),
  escalateToRoleCode: z.string().min(1),
  escalateToOrganizationUnitStrategy: z.enum(["submitter_unit", "tenant"]).optional(),
  note: z.string().nullable().optional(),
});

const createDemoTransactionSchema = z.object({ title: z.string().min(1) });

const startInstanceSchema = z.object({
  definitionCode: z.string().min(1),
  entityId: z.string().uuid(),
  contextData: z.record(z.string(), z.unknown()).optional(),
});

const actOnAssignmentSchema = z.object({
  actionCode: z.string().min(1),
  comment: z.string().nullable().optional(),
});

export function registerWorkflowRoutes(app: FastifyInstance, container: Container) {
  // --- Design-time: Definitions & Versions ------------------------------
  app.post("/workflow/definitions", { preHandler: app.authenticate }, async (request, reply) => {
    const body = createDefinitionSchema.parse(request.body);
    const result = await container.workflow.createDefinition(request.actor!, body);
    return reply.status(201).send(result);
  });

  app.get("/workflow/definitions", { preHandler: app.authenticate }, async (request, reply) => {
    const list = await container.workflow.listDefinitions(request.actor!);
    return reply.send(list);
  });

  app.get(
    "/workflow/definitions/:code/versions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const list = await container.workflow.listVersions(request.actor!, code);
      return reply.send(list);
    },
  );

  app.post(
    "/workflow/definitions/:code/versions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const version = await container.workflow.createVersion(request.actor!, code);
      return reply.status(201).send(version);
    },
  );

  app.post(
    "/workflow/definitions/:code/versions/:versionNumber/steps",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code, versionNumber } = request.params as { code: string; versionNumber: string };
      const body = addStepSchema.parse(request.body);
      const step = await container.workflow.addStep(request.actor!, code, Number(versionNumber), body);
      return reply.status(201).send(step);
    },
  );

  app.post(
    "/workflow/definitions/:code/versions/:versionNumber/transitions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code, versionNumber } = request.params as { code: string; versionNumber: string };
      const body = addTransitionSchema.parse(request.body);
      const transition = await container.workflow.addTransition(
        request.actor!,
        code,
        Number(versionNumber),
        { ...body, conditionExpression: toConditionExpression(body.conditionExpression) },
      );
      return reply.status(201).send(transition);
    },
  );

  app.post(
    "/workflow/definitions/:code/versions/:versionNumber/assignment-rules",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code, versionNumber } = request.params as { code: string; versionNumber: string };
      const body = addAssignmentRuleSchema.parse(request.body);
      const rule = await container.workflow.addAssignmentRule(
        request.actor!,
        code,
        Number(versionNumber),
        { ...body, conditionExpression: toConditionExpression(body.conditionExpression) },
      );
      return reply.status(201).send(rule);
    },
  );

  app.post(
    "/workflow/definitions/:code/versions/:versionNumber/escalation-rules",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code, versionNumber } = request.params as { code: string; versionNumber: string };
      const body = addEscalationRuleSchema.parse(request.body);
      const rule = await container.workflow.addEscalationRule(
        request.actor!,
        code,
        Number(versionNumber),
        body,
      );
      return reply.status(201).send(rule);
    },
  );

  app.post(
    "/workflow/definitions/:code/versions/:versionNumber/publish",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { code, versionNumber } = request.params as { code: string; versionNumber: string };
      const version = await container.workflow.publishVersion(request.actor!, code, Number(versionNumber));
      return reply.send(version);
    },
  );

  // --- Runtime: generic dummy object + Instances --------------------------
  app.post("/workflow/demo-transactions", { preHandler: app.authenticate }, async (request, reply) => {
    const body = createDemoTransactionSchema.parse(request.body);
    const tx = await container.workflow.createDemoTransaction(request.actor!, body.title);
    return reply.status(201).send(tx);
  });

  app.post("/workflow/instances", { preHandler: app.authenticate }, async (request, reply) => {
    const body = startInstanceSchema.parse(request.body);
    const result = await container.workflow.startInstanceFromRequest(request.actor!, body);
    return reply.status(201).send(result);
  });

  app.get("/workflow/instances", { preHandler: app.authenticate }, async (request, reply) => {
    const list = await container.workflow.listInstances(request.actor!);
    return reply.send(list);
  });

  app.get("/workflow/instances/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await container.workflow.getInstance(request.actor!, id);
    return reply.send(result);
  });

  app.get(
    "/workflow/instances/:id/history",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const history = await container.workflow.getHistory(request.actor!, id);
      return reply.send(history);
    },
  );

  app.get("/workflow/my-assignments", { preHandler: app.authenticate }, async (request, reply) => {
    const list = await container.workflow.listMyAssignments(request.actor!);
    return reply.send(list);
  });

  // ADR-0008: opt-in claim/lock on top of the Role+Scope queue.
  app.post(
    "/workflow/assignments/:assignmentId/claim",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { assignmentId } = request.params as { assignmentId: string };
      const result = await container.workflow.claimAssignment(request.actor!, assignmentId);
      return reply.send(result);
    },
  );

  app.post(
    "/workflow/assignments/:assignmentId/release-claim",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { assignmentId } = request.params as { assignmentId: string };
      const result = await container.workflow.releaseClaim(request.actor!, assignmentId);
      return reply.send(result);
    },
  );

  app.post(
    "/workflow/assignments/:assignmentId/act",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { assignmentId } = request.params as { assignmentId: string };
      const body = actOnAssignmentSchema.parse(request.body);
      const result = await container.workflow.actOnAssignment(
        request.actor!,
        assignmentId,
        body.actionCode,
        body.comment ?? null,
      );
      return reply.send(result);
    },
  );

  app.post(
    "/workflow/escalation-sweep",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const escalated = await container.workflow.escalateOverdueAssignments(request.actor!);
      return reply.send({ escalatedCount: escalated.length, escalated });
    },
  );
}
