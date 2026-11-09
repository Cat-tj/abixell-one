import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../../composition-root.js";

/**
 * HSE Advanced HTTP routes (Wave A7, HSE-ADV-001…007).
 *
 * The surface lives under `/hse/advanced/*`. Core HSE (`/hse/records/...`)
 * keeps its shape untouched, so a tenant that never grants the Advanced
 * permissions sees exactly the API it saw before this wave (ADR-0027).
 *
 * Two whole classes of route are deliberately absent: there is no permit status
 * route, because permit lifecycle is the Workflow Engine's and is advanced
 * through the existing workflow endpoints (ADR-0027 §4); and there is no route
 * that writes a Core follow-up, because CAPA only references one (ADR-0027 §1).
 */

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const dateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "expected an ISO date-time");
/** Permit validity is a timestamp: accept a plain date (start of day) or a full date-time. */
const dateOrDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}.*)?$/, "expected YYYY-MM-DD or an ISO date-time");
const decimalSchema = z.string().regex(/^-?\d{1,16}(\.\d{1,4})?$/, "expected a 4-decimal number");
const riskAssessmentTypeSchema = z.enum(["jsa", "hira"]);
const auditProgrammeTypeSchema = z.enum(["inspection", "audit"]);
const auditFindingTypeSchema = z.enum(["observation", "nonconformity", "major_nonconformity"]);
const capaActionTypeSchema = z.enum(["corrective", "preventive"]);
const capaStatusSchema = z.enum(["open", "in_progress", "verification", "closed", "cancelled"]);

const scalePointSchema = z.object({
  value: z.number().int(),
  label: z.string().min(1),
});

export function registerHseAdvancedRoutes(app: FastifyInstance, container: Container) {
  const advanced = () => container.hseAdvanced;
  const assurance = () => container.hseAssurance;
  const capa = () => container.hseCapa;

  // --- Investigations (HSE-ADV-001) ---------------------------------------

  app.get("/hse/advanced/frameworks", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await advanced().listFrameworks(request.actor!));
  });

  app.post("/hse/advanced/frameworks", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        causeCategories: z.array(z.string().min(1)).optional(),
      })
      .parse(request.body);
    return reply.status(201).send(await advanced().createFramework(request.actor!, body));
  });

  app.get("/hse/advanced/investigations", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await advanced().listInvestigations(request.actor!));
  });

  app.post(
    "/hse/advanced/records/:recordId/investigations",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { recordId } = request.params as { recordId: string };
      const body = z
        .object({
          frameworkId: z.string().uuid(),
          leadInvestigatorUserId: z.string().uuid().nullable().optional(),
        })
        .parse(request.body);
      return reply
        .status(201)
        .send(await advanced().createInvestigation(request.actor!, recordId, body));
    },
  );

  app.get(
    "/hse/advanced/investigations/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await advanced().getInvestigation(request.actor!, id));
    },
  );

  app.patch(
    "/hse/advanced/investigations/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          leadInvestigatorUserId: z.string().uuid().nullable().optional(),
          findings: z.string().nullable().optional(),
          rootCause: z.string().nullable().optional(),
          contributingFactors: z
            .array(
              z.object({
                category: z.string().min(1),
                description: z.string().min(1),
                isRootCause: z.boolean().default(false),
              }),
            )
            .optional(),
          concluded: z.boolean().optional(),
        })
        .parse(request.body);
      return reply.send(await advanced().updateInvestigation(request.actor!, id, body));
    },
  );

  // --- Risk matrix and assessments (HSE-ADV-002) --------------------------

  app.get("/hse/advanced/risk-matrix", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await advanced().getActiveMatrix(request.actor!));
  });

  app.post("/hse/advanced/risk-matrices", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        likelihoodScale: z.array(scalePointSchema).min(1),
        severityScale: z.array(scalePointSchema).min(1),
        cells: z
          .array(
            z.object({
              likelihood: z.number().int(),
              severity: z.number().int(),
              bandCode: z.string().min(1),
              score: decimalSchema,
            }),
          )
          .min(1),
      })
      .parse(request.body);
    return reply.status(201).send(await advanced().createMatrix(request.actor!, body));
  });

  app.get(
    "/hse/advanced/risk-assessments",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { hseRecordId, projectId } = request.query as {
        hseRecordId?: string;
        projectId?: string;
      };
      return reply.send(
        await advanced().listRiskAssessments(request.actor!, { hseRecordId, projectId }),
      );
    },
  );

  app.post(
    "/hse/advanced/risk-assessments",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = z
        .object({
          hseRecordId: z.string().uuid().nullable().optional(),
          projectId: z.string().uuid().nullable().optional(),
          assessmentType: riskAssessmentTypeSchema,
          title: z.string().min(1),
          taskDescription: z.string().nullable().optional(),
          matrixId: z.string().uuid().optional(),
          likelihood: z.number().int(),
          severity: z.number().int(),
          controls: z
            .array(
              z.object({
                description: z.string().min(1),
                controlType: z.string().min(1),
                residualLikelihood: z.number().int().nullable().default(null),
                residualSeverity: z.number().int().nullable().default(null),
              }),
            )
            .optional(),
          residualLikelihood: z.number().int().nullable().optional(),
          residualSeverity: z.number().int().nullable().optional(),
        })
        .parse(request.body);
      return reply.status(201).send(await advanced().createRiskAssessment(request.actor!, body));
    },
  );

  app.get(
    "/hse/advanced/risk-assessments/:id",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await advanced().getRiskAssessment(request.actor!, id));
    },
  );

  // --- Permit to Work (HSE-ADV-003) ---------------------------------------

  app.get("/hse/advanced/permits", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await advanced().listPermits(request.actor!));
  });

  app.post("/hse/advanced/permits", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        permitTypeCode: z.string().min(1),
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        organizationUnitId: z.string().uuid().nullable().optional(),
        projectId: z.string().uuid().nullable().optional(),
        siteId: z.string().uuid().nullable().optional(),
        locationDetail: z.string().nullable().optional(),
        validFrom: dateOrDateTimeSchema,
        validTo: dateOrDateTimeSchema,
        isolationConditions: z
          .array(
            z.object({
              conditionType: z.string().min(1),
              description: z.string().min(1),
              verifiedAt: z.string().nullable().default(null),
            }),
          )
          .optional(),
        riskAssessmentId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body);
    return reply.status(201).send(await advanced().createPermit(request.actor!, body));
  });

  app.get("/hse/advanced/permits/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await advanced().getPermit(request.actor!, id));
  });

  app.patch("/hse/advanced/permits/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        permitTypeCode: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        organizationUnitId: z.string().uuid().nullable().optional(),
        projectId: z.string().uuid().nullable().optional(),
        siteId: z.string().uuid().nullable().optional(),
        locationDetail: z.string().nullable().optional(),
        validFrom: dateOrDateTimeSchema.optional(),
        validTo: dateOrDateTimeSchema.optional(),
        isolationConditions: z
          .array(
            z.object({
              conditionType: z.string().min(1),
              description: z.string().min(1),
              verifiedAt: z.string().nullable().default(null),
            }),
          )
          .optional(),
        riskAssessmentId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body);
    return reply.send(await advanced().updatePermit(request.actor!, id, body));
  });

  /** Advance the Engine instance. The action code means whatever the Engine says. */
  app.post(
    "/hse/advanced/permits/:id/act",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({ actionCode: z.string().min(1), comment: z.string().nullable().optional() })
        .parse(request.body);
      return reply.send(await advanced().actOnPermit(request.actor!, id, body));
    },
  );

  /** Bind the Engine instance for a permit created before the definition was published. */
  app.post(
    "/hse/advanced/permits/:id/start-lifecycle",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.status(201).send(await advanced().startPermitLifecycle(request.actor!, id));
    },
  );

  // --- Inspection / audit programmes (HSE-ADV-004) ------------------------

  app.get("/hse/advanced/programmes", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await assurance().listProgrammes(request.actor!));
  });

  app.post("/hse/advanced/programmes", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        programmeType: auditProgrammeTypeSchema.optional(),
        frequencyDays: z.number().int().positive(),
        checklist: z
          .array(
            z.object({
              code: z.string().min(1),
              question: z.string().min(1),
              isMandatory: z.boolean().optional(),
            }),
          )
          .optional(),
        organizationUnitId: z.string().uuid().nullable().optional(),
        siteId: z.string().uuid().nullable().optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body);
    return reply.status(201).send(await assurance().createProgramme(request.actor!, body));
  });

  app.get(
    "/hse/advanced/programmes/:id/occurrences",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await assurance().listOccurrences(request.actor!, id));
    },
  );

  app.post(
    "/hse/advanced/programmes/:id/occurrences",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ scheduledFor: dateSchema }).parse(request.body);
      return reply
        .status(201)
        .send(await assurance().scheduleOccurrence(request.actor!, id, body.scheduledFor));
    },
  );

  app.post(
    "/hse/advanced/occurrences/:id/complete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          results: z.array(
            z.object({
              itemCode: z.string().min(1),
              result: z.string().min(1),
              note: z.string().nullable().default(null),
            }),
          ),
          notes: z.string().nullable().optional(),
        })
        .parse(request.body);
      return reply.send(await assurance().completeOccurrence(request.actor!, id, body));
    },
  );

  app.get(
    "/hse/advanced/occurrences/:id/findings",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await assurance().listFindings(request.actor!, id));
    },
  );

  app.post(
    "/hse/advanced/occurrences/:id/findings",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          findingType: auditFindingTypeSchema.optional(),
          checklistItemCode: z.string().nullable().optional(),
          description: z.string().min(1),
        })
        .parse(request.body);
      return reply.status(201).send(await assurance().createFinding(request.actor!, id, body));
    },
  );

  // --- Environmental monitoring (HSE-ADV-005) -----------------------------

  app.get("/hse/advanced/monitoring-points", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await assurance().listMonitoringPoints(request.actor!));
  });

  app.post("/hse/advanced/monitoring-points", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(1),
        name: z.string().min(1),
        parameterCode: z.string().min(1),
        unit: z.string().min(1),
        thresholdMin: decimalSchema.nullable().optional(),
        thresholdMax: decimalSchema.nullable().optional(),
        organizationUnitId: z.string().uuid().nullable().optional(),
        siteId: z.string().uuid().nullable().optional(),
      })
      .parse(request.body);
    return reply.status(201).send(await assurance().createMonitoringPoint(request.actor!, body));
  });

  app.get(
    "/hse/advanced/monitoring-points/:id/readings",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };
      return reply.send(
        await assurance().listReadings(request.actor!, id, limit ? Number(limit) : 50),
      );
    },
  );

  app.post(
    "/hse/advanced/monitoring-points/:id/readings",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          measuredAt: dateTimeSchema,
          value: decimalSchema,
          note: z.string().nullable().optional(),
        })
        .parse(request.body);
      return reply.status(201).send(await assurance().recordReading(request.actor!, id, body));
    },
  );

  // --- CAPA (HSE-ADV-006) -------------------------------------------------

  app.get("/hse/advanced/capas", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await capa().listCapas(request.actor!));
  });

  app.post("/hse/advanced/capas", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        hseRecordId: z.string().uuid().nullable().optional(),
        investigationId: z.string().uuid().nullable().optional(),
        auditFindingId: z.string().uuid().nullable().optional(),
        monitoringReadingId: z.string().uuid().nullable().optional(),
        coreFollowUpId: z.string().uuid().nullable().optional(),
        rootCause: z.string().nullable().optional(),
        actionType: capaActionTypeSchema.optional(),
        ownerUserId: z.string().uuid().nullable().optional(),
        dueDate: dateSchema.nullable().optional(),
      })
      .parse(request.body);
    return reply.status(201).send(await capa().createCapa(request.actor!, body));
  });

  app.get("/hse/advanced/capas/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await capa().getCapa(request.actor!, id));
  });

  app.patch(
    "/hse/advanced/capas/:id/status",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          status: capaStatusSchema,
          verificationNotes: z.string().nullable().optional(),
        })
        .parse(request.body);
      return reply.send(await capa().changeStatus(request.actor!, id, body));
    },
  );

  app.post(
    "/hse/advanced/capas/:id/actions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          description: z.string().min(1),
          ownerUserId: z.string().uuid().nullable().optional(),
          dueDate: dateSchema.nullable().optional(),
        })
        .parse(request.body);
      return reply.status(201).send(await capa().addAction(request.actor!, id, body));
    },
  );

  app.post(
    "/hse/advanced/capas/:id/actions/:actionId/complete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, actionId } = request.params as { id: string; actionId: string };
      const body = z
        .object({ completionNotes: z.string().nullable().optional() })
        .parse(request.body ?? {});
      return reply.send(await capa().completeAction(request.actor!, id, actionId, body));
    },
  );

  // --- Indicators (HSE-ADV-007) -------------------------------------------

  app.get("/hse/advanced/indicators", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await capa().listSnapshots(request.actor!));
  });

  app.post("/hse/advanced/indicators", { preHandler: app.authenticate }, async (request, reply) => {
    const body = z
      .object({
        windowStart: dateSchema,
        windowEnd: dateSchema,
        organizationUnitId: z.string().uuid().nullable().optional(),
        exposureHours: decimalSchema.nullable().optional(),
        lostDays: z.number().int().nonnegative().optional(),
        nearMissCategoryCode: z.string().nullable().optional(),
        lostTimeSeverityCode: z.string().nullable().optional(),
      })
      .parse(request.body);
    return reply.status(201).send(await capa().computeSnapshot(request.actor!, body));
  });
}