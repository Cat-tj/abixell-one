import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { activateAllModules, authHeader, bootstrapTenant, createReadOnlyRole, login, provisionFirstAdmin } from "./helpers.js";

/**
 * Wave A7 — HSE Advanced (HSE-ADV-001…007, ADR-0027).
 *
 * Grouped by the promise each work package makes, not by route:
 *
 * - HSE-ADV-001 an investigation is versioned methodology, one per record, and
 *   cannot conclude without a root cause.
 * - HSE-ADV-002 a matrix must resolve every combination, and the rating it
 *   produced is stored on the assessment, so a later matrix edit cannot re-rate
 *   the past.
 * - HSE-ADV-003 permit lifecycle is the Workflow Engine's alone: a permit
 *   created before publication survives unbound, and binding is a separate,
 *   retryable act.
 * - HSE-ADV-004 an inspection that skipped its mandatory questions did not
 *   establish anything, and a finding raises nothing by itself.
 * - HSE-ADV-005 a breach is decided against the thresholds as they stood at
 *   write time.
 * - HSE-ADV-006 a CAPA answers something, closes only on verified evidence, and
 *   never writes the Core follow-up it references.
 * - HSE-ADV-007 indicators are frozen snapshots; a rate with no denominator is
 *   null, not zero.
 */

const TENANT_CODE = `test-a7hse-${Date.now()}`;
const OTHER_TENANT_CODE = `test-a7hse-o-${Date.now()}`;
const PERMIT_WORKFLOW = "hse_permit_lifecycle";

describe("Wave A7 — HSE Advanced", () => {
  const app = buildApp();

  let tenantId: string;
  let adminToken: string;
  let readerToken: string;
  let verifierToken: string;
  let approverToken: string;
  let otherAdminToken: string;

  let unitId: string;
  let otherUnitId: string;
  let projectId: string;

  let incidentRecordId: string;
  let observationRecordId: string;
  let otherRecordId: string;

  let frameworkId: string;
  let matrixId: string;
  let investigationId: string;
  let assessmentId: string;
  let programmeId: string;
  let occurrenceId: string;
  let findingId: string;
  let pointId: string;
  let breachReadingId: string;
  let capaId: string;
  let capaActionId: string;
  let unboundPermitId: string;

  const post = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers: authHeader(token), payload });
  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: authHeader(token) });
  const patch = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "PATCH", url, headers: authHeader(token), payload });

  async function report(token: string, body: Record<string, unknown>) {
    const res = await post("/hse/records", token, body);
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  async function buildPermitWorkflow(token: string, reviewerRole: string) {
    await post("/workflow/definitions", token, {
      code: PERMIT_WORKFLOW,
      name: "HSE Permit Lifecycle",
      entityType: "hse_permit",
      description: "Wave A7 permit lifecycle",
    });

    const addStep = (b: Record<string, unknown>) =>
      post(`/workflow/definitions/${PERMIT_WORKFLOW}/versions/1/steps`, token, b);

    await addStep({ code: "REVIEW", name: "Review", stepType: "approval", isInitial: true, slaHours: 24 });
    await addStep({ code: "APPROVED", name: "Approved", stepType: "end", isTerminal: true, terminalStatus: "approved" });
    await addStep({ code: "REJECTED", name: "Rejected", stepType: "end", isTerminal: true, terminalStatus: "rejected" });

    const addTransition = (b: Record<string, unknown>) =>
      post(`/workflow/definitions/${PERMIT_WORKFLOW}/versions/1/transitions`, token, b);

    await addTransition({ fromStepCode: "REVIEW", toStepCode: "APPROVED", actionCode: "approve", name: "Approve" });
    await addTransition({ fromStepCode: "REVIEW", toStepCode: "REJECTED", actionCode: "reject", name: "Reject" });

    await post(`/workflow/definitions/${PERMIT_WORKFLOW}/versions/1/assignment-rules`, token, {
      stepCode: "REVIEW",
      assignmentType: "role",
      roleCode: reviewerRole,
      organizationUnitStrategy: "tenant",
    });

    const publish = await post(`/workflow/definitions/${PERMIT_WORKFLOW}/versions/1/publish`, token);
    expect(publish.statusCode).toBe(200);
  }

  beforeAll(async () => {
    const tenant = await bootstrapTenant(app, TENANT_CODE, "A7 HSE Tenant");
    await activateAllModules(tenant.id);
    tenantId = tenant.id;
    await provisionFirstAdmin({ tenantId, email: "admin@a7hse.local", password: "Admin12345!" });
    adminToken = (await login(app, TENANT_CODE, "admin@a7hse.local", "Admin12345!")).body.accessToken;

    const legal = await post("/legal-entities", adminToken, { name: "A7HSE Legal Entity" });
    unitId = (
      await post("/organization-units", adminToken, {
        legalEntityId: legal.json().id,
        name: "A7HSE Unit",
        unitType: "Region",
        parentId: null,
      })
    ).json().id;

    const customer = await post("/customers", adminToken, { code: "A7HSE-CUST", name: "A7HSE Customer" });
    const customerId = customer.json().id;
    projectId = (
      await post("/projects", adminToken, { customerId, code: "A7HSE-PRJ", name: "A7HSE Project" })
    ).json().id;

    await post("/config/numbering/hse_record", adminToken, { pattern: "HSE-A7-{SEQ:5}" });
    await post("/config/numbering/hse_permit", adminToken, { pattern: "PTW-{SEQ:5}" });
    await post("/config/numbering/hse_capa", adminToken, { pattern: "CAPA-{SEQ:5}" });
    await post("/config/reference-data/hse_category", adminToken, { code: "near_miss", label: "Near Miss" });
    await post("/config/reference-data/hse_severity", adminToken, { code: "lost_time", label: "Lost Time" });

    await createReadOnlyRole(tenantId, "A7HSE_READER", [
      "hse.read",
      "hse.advanced.read",
      "project.read",
      "customer.read",
    ]);
    const reader = await post("/admin/users", adminToken, {
      email: "reader@a7hse.local",
      fullName: "A7HSE Reader",
      password: "Reader12345!",
      pairs: [{ roleCode: "A7HSE_READER", scopeType: "tenant" }],
    });
    expect(reader.statusCode).toBe(201);
    readerToken = (await login(app, TENANT_CODE, "reader@a7hse.local", "Reader12345!")).body.accessToken;

    // Verifier holds only the CAPA-close permission: closing is a separate
    // judgement from managing the CAPA.
    await createReadOnlyRole(tenantId, "A7HSE_VERIFIER", [
      "hse.read",
      "hse.advanced.read",
      "hse.capa.verify",
    ]);
    const verifier = await post("/admin/users", adminToken, {
      email: "verifier@a7hse.local",
      fullName: "A7HSE Verifier",
      password: "Verifier12345!",
      pairs: [{ roleCode: "A7HSE_VERIFIER", scopeType: "tenant" }],
    });
    expect(verifier.statusCode).toBe(201);
    verifierToken = (await login(app, TENANT_CODE, "verifier@a7hse.local", "Verifier12345!")).body.accessToken;

    incidentRecordId = (
      await report(adminToken, {
        recordType: "incident",
        categoryCode: "near_miss",
        severityCode: "lost_time",
        occurredAt: "2026-03-02T08:00:00.000Z",
        title: "A7HSE incident",
        organizationUnitId: unitId,
        projectId,
      })
    ).id;
    observationRecordId = (
      await report(adminToken, {
        recordType: "observation",
        occurredAt: "2026-03-03T09:00:00.000Z",
        title: "A7HSE observation",
        organizationUnitId: unitId,
      })
    ).id;

    const other = await bootstrapTenant(app, OTHER_TENANT_CODE, "A7 Other HSE Tenant");
    await activateAllModules(other.id);
    await provisionFirstAdmin({ tenantId: other.id, email: "admin@a7hse-o.local", password: "Admin12345!" });
    otherAdminToken = (await login(app, OTHER_TENANT_CODE, "admin@a7hse-o.local", "Admin12345!")).body.accessToken;
    await post("/config/numbering/hse_record", otherAdminToken, { pattern: "HSE-O-{SEQ:5}" });
    const otherLegal = await post("/legal-entities", otherAdminToken, { name: "A7HSE Other Legal" });
    otherUnitId = (
      await post("/organization-units", otherAdminToken, {
        legalEntityId: otherLegal.json().id,
        name: "A7HSE Other Unit",
        unitType: "Region",
        parentId: null,
      })
    ).json().id;
    otherRecordId = (
      await report(otherAdminToken, {
        recordType: "incident",
        occurredAt: "2026-03-02T08:00:00.000Z",
        title: "A7HSE other tenant incident",
        organizationUnitId: otherUnitId,
      })
    ).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  // ========================================================================
  // HSE-ADV-001 — versioned investigation methodology
  // ========================================================================

  it("versions a framework per code and copies the version onto the investigation", async () => {
    const v1 = await post("/hse/advanced/frameworks", adminToken, {
      code: "ICAM",
      name: "ICAM",
      causeCategories: ["human", "equipment"],
    });
    expect(v1.statusCode).toBe(201);
    expect(v1.json().version).toBe(1);
    expect(v1.json().isActive).toBe(true);
    frameworkId = v1.json().id;

    const v2 = await post("/hse/advanced/frameworks", adminToken, { code: "ICAM", name: "ICAM rev 2" });
    expect(v2.statusCode).toBe(201);
    expect(v2.json().version).toBe(2);

    const frameworks = await get("/hse/advanced/frameworks", adminToken);
    expect(frameworks.statusCode).toBe(200);
    expect(frameworks.json()).toHaveLength(2);
  });

  it("starts one investigation per record and copies its framework", async () => {
    const res = await post(`/hse/advanced/records/${incidentRecordId}/investigations`, adminToken, {
      frameworkId,
    });
    expect(res.statusCode).toBe(201);
    const investigation = res.json();
    investigationId = investigation.id;
    expect(investigation.hseRecordId).toBe(incidentRecordId);
    expect(investigation.frameworkCode).toBe("ICAM");
    expect(investigation.frameworkVersion).toBe(1);
    expect(investigation.concludedAt).toBeNull();

    const second = await post(`/hse/advanced/records/${incidentRecordId}/investigations`, adminToken, {
      frameworkId,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already has an investigation/i);
  });

  it("starts an investigation on an observation too", async () => {
    const res = await post(`/hse/advanced/records/${observationRecordId}/investigations`, adminToken, {
      frameworkId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().hseRecordId).toBe(observationRecordId);
  });

  it("refuses to conclude an investigation without a root cause", async () => {
    const res = await patch(`/hse/advanced/investigations/${investigationId}`, adminToken, {
      concluded: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/root cause/i);
  });

  it("concludes once a root cause and contributing factors are recorded", async () => {
    const res = await patch(`/hse/advanced/investigations/${investigationId}`, adminToken, {
      findings: "Guard removed before the shift",
      rootCause: "Guard interlock bypassed to speed up cleaning",
      contributingFactors: [
        { category: "human", description: "Interlock bypass routine", isRootCause: true },
        { category: "equipment", description: "Guard not lockable", isRootCause: false },
      ],
      concluded: true,
    });
    expect(res.statusCode).toBe(200);
    const investigation = res.json();
    expect(investigation.rootCause).toMatch(/interlock/i);
    expect(investigation.contributingFactors).toHaveLength(2);
    expect(investigation.concludedAt).not.toBeNull();
    // The framework it started under is untouched by the conclusion.
    expect(investigation.frameworkVersion).toBe(1);
  });

  it("keeps the investigation's framework off the update surface", async () => {
    const res = await patch(`/hse/advanced/investigations/${investigationId}`, adminToken, {
      frameworkId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().frameworkCode).toBe("ICAM");
    expect(res.json().frameworkVersion).toBe(1);
  });

  it("hides another tenant's record from investigation", async () => {
    const res = await post(`/hse/advanced/records/${otherRecordId}/investigations`, adminToken, {
      frameworkId,
    });
    expect(res.statusCode).toBe(404);
  });

  // ========================================================================
  // HSE-ADV-002 — tenant-configurable risk matrix
  // ========================================================================

  it("refuses a matrix that leaves a combination unresolved", async () => {
    const res = await post("/hse/advanced/risk-matrices", adminToken, {
      code: "INCOMPLETE",
      name: "Incomplete",
      likelihoodScale: [
        { value: 1, label: "Rare" },
        { value: 2, label: "Likely" },
      ],
      severityScale: [{ value: 1, label: "Minor" }],
      cells: [{ likelihood: 1, severity: 1, bandCode: "low", score: "1.00" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no cell for likelihood 2/i);
  });

  it("creates a complete matrix and exposes it as the active one", async () => {
    const res = await post("/hse/advanced/risk-matrices", adminToken, {
      code: "A7M",
      name: "A7 Matrix",
      likelihoodScale: [
        { value: 1, label: "Rare" },
        { value: 2, label: "Likely" },
      ],
      severityScale: [
        { value: 1, label: "Minor" },
        { value: 2, label: "Major" },
      ],
      cells: [
        { likelihood: 1, severity: 1, bandCode: "low", score: "1.00" },
        { likelihood: 1, severity: 2, bandCode: "medium", score: "4.00" },
        { likelihood: 2, severity: 1, bandCode: "medium", score: "4.00" },
        { likelihood: 2, severity: 2, bandCode: "high", score: "9.00" },
      ],
    });
    expect(res.statusCode).toBe(201);
    matrixId = res.json().id;

    const active = await get("/hse/advanced/risk-matrix", adminToken);
    expect(active.statusCode).toBe(200);
    expect(active.json().id).toBe(matrixId);
  });

  it("stores the rating the matrix produced on the assessment", async () => {
    const res = await post("/hse/advanced/risk-assessments", adminToken, {
      projectId,
      assessmentType: "jsa",
      title: "Hot work near the tank farm",
      likelihood: 2,
      severity: 2,
      controls: [{ description: "Fire watch", controlType: "administrative" }],
      residualLikelihood: 1,
      residualSeverity: 1,
    });
    expect(res.statusCode).toBe(201);
    const assessment = res.json();
    assessmentId = assessment.id;
    expect(assessment.matrixId).toBe(matrixId);
    expect(assessment.bandCode).toBe("high");
    expect(assessment.score).toBe("9.00");
    expect(assessment.residualBandCode).toBe("low");
    expect(assessment.residualScore).toBe("1.00");
  });

  it("refuses a residual expressed on half a pair", async () => {
    const res = await post("/hse/advanced/risk-assessments", adminToken, {
      projectId,
      assessmentType: "hira",
      title: "Half a residual",
      likelihood: 1,
      severity: 1,
      residualLikelihood: 2,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/together/i);
  });

  it("refuses an assessment anchored to nothing", async () => {
    const res = await post("/hse/advanced/risk-assessments", adminToken, {
      assessmentType: "jsa",
      title: "Orphan",
      likelihood: 1,
      severity: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/HSE record or a project/i);
  });

  it("refuses a combination the matrix does not cover", async () => {
    const res = await post("/hse/advanced/risk-assessments", adminToken, {
      projectId,
      assessmentType: "jsa",
      title: "Off-scale",
      likelihood: 5,
      severity: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no cell for likelihood 5/i);
  });

  // ========================================================================
  // HSE-ADV-003 — permit to work, lifecycle delegated to the Engine
  // ========================================================================

  it("creates a permit unbound while the lifecycle definition is unpublished", async () => {
    const res = await post("/hse/advanced/permits", adminToken, {
      permitTypeCode: "hot_work",
      title: "Welding on line 3",
      organizationUnitId: unitId,
      projectId,
      validFrom: "2026-03-10",
      validTo: "2026-03-11",
      isolationConditions: [{ conditionType: "lockout", description: "Line 3 isolated" }],
      riskAssessmentId: assessmentId,
    });
    expect(res.statusCode).toBe(201);
    const permit = res.json();
    unboundPermitId = permit.id;
    expect(permit.permitNumber).toMatch(/^PTW-/);
    // No published definition yet: the content is kept, the Engine binds later.
    expect(permit.workflowInstanceId).toBeNull();
  });

  it("reports no lifecycle status for an unbound permit", async () => {
    const res = await get(`/hse/advanced/permits/${unboundPermitId}`, adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBeNull();
    expect(res.json().availableActions).toEqual([]);
  });

  it("refuses to act on a permit with no instance", async () => {
    const res = await post(`/hse/advanced/permits/${unboundPermitId}/act`, adminToken, {
      actionCode: "approve",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no workflow instance/i);
  });

  it("accepts permit validity as full ISO date-times (what the web form sends)", async () => {
    const res = await post("/hse/advanced/permits", adminToken, {
      permitTypeCode: "hot_work",
      title: "Timed permit",
      validFrom: "2026-03-10T08:00:00.000Z",
      validTo: "2026-03-10T16:30:00.000Z",
    });
    expect(res.statusCode).toBe(201);
    expect(new Date(res.json().validTo).toISOString()).toBe("2026-03-10T16:30:00.000Z");
  });

  it("rejects a permit whose validity runs backwards", async () => {
    const res = await post("/hse/advanced/permits", adminToken, {
      permitTypeCode: "hot_work",
      title: "Backwards",
      validFrom: "2026-03-11",
      validTo: "2026-03-10",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/validTo must be after validFrom/i);
  });

  it("binds the lifecycle once the definition is published", async () => {
    await createReadOnlyRole(tenantId, "A7HSE_PERMIT_APPROVER", [
      "hse.read",
      "hse.advanced.read",
      "hse.advanced.manage",
      "workflow.instance.act",
    ]);
    await post("/admin/users", adminToken, {
      email: "approver@a7hse.local",
      fullName: "A7HSE Approver",
      password: "Approver12345!",
      pairs: [{ roleCode: "A7HSE_PERMIT_APPROVER", scopeType: "tenant" }],
    });
    approverToken = (await login(app, TENANT_CODE, "approver@a7hse.local", "Approver12345!")).body
      .accessToken;
    await buildPermitWorkflow(adminToken, "A7HSE_PERMIT_APPROVER");

    const res = await post(`/hse/advanced/permits/${unboundPermitId}/start-lifecycle`, adminToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().workflowInstanceId).toBeTruthy();

    const again = await post(`/hse/advanced/permits/${unboundPermitId}/start-lifecycle`, adminToken);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already has a workflow instance/i);
  });

  it("reads the permit status from the Engine, not from a local column", async () => {
    const res = await get(`/hse/advanced/permits/${unboundPermitId}`, approverToken);
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.status.stepCode).toBe("REVIEW");
    expect(view.status.instanceStatus).toBe("in_progress");
    expect(view.availableActions.map((a: { actionCode: string }) => a.actionCode)).toEqual(
      expect.arrayContaining(["approve", "reject"]),
    );
  });

  it("offers no actions to a role the step is not assigned to", async () => {
    const res = await get(`/hse/advanced/permits/${unboundPermitId}`, adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().status.stepCode).toBe("REVIEW");
    expect(res.json().availableActions).toEqual([]);
  });

  it("advances the permit through the Engine and ends the lifecycle", async () => {
    const res = await post(`/hse/advanced/permits/${unboundPermitId}/act`, approverToken, {
      actionCode: "approve",
      comment: "Isolation verified",
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.status.instanceStatus).toBe("approved");
    expect(view.availableActions).toEqual([]);
  });

  // ========================================================================
  // HSE-ADV-004 — inspection programmes, occurrences, findings
  // ========================================================================

  it("creates a programme whose checklist is the template", async () => {
    const res = await post("/hse/advanced/programmes", adminToken, {
      code: "A7-INSP",
      name: "Weekly scaffold inspection",
      programmeType: "inspection",
      frequencyDays: 7,
      organizationUnitId: unitId,
      checklist: [
        { code: "SC-01", question: "Guardrails present", isMandatory: true },
        { code: "SC-02", question: "Tags current", isMandatory: true },
        { code: "SC-03", question: "Housekeeping", isMandatory: false },
      ],
    });
    expect(res.statusCode).toBe(201);
    const programme = res.json();
    programmeId = programme.id;
    expect(programme.checklist).toHaveLength(3);
    expect(programme.lastScheduledFor).toBeNull();
  });

  it("refuses duplicate checklist codes on one programme", async () => {
    const res = await post("/hse/advanced/programmes", adminToken, {
      code: "A7-DUP",
      name: "Duplicate codes",
      frequencyDays: 7,
      checklist: [
        { code: "SC-01", question: "One" },
        { code: "SC-01", question: "Two" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unique within a programme/i);
  });

  it("schedules one occurrence per date", async () => {
    const res = await post(`/hse/advanced/programmes/${programmeId}/occurrences`, adminToken, {
      scheduledFor: "2026-04-01",
    });
    expect(res.statusCode).toBe(201);
    occurrenceId = res.json().id;
    expect(res.json().performedAt).toBeNull();

    const again = await post(`/hse/advanced/programmes/${programmeId}/occurrences`, adminToken, {
      scheduledFor: "2026-04-01",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already has an occurrence/i);
  });

  it("refuses to complete an occurrence that skipped a mandatory question", async () => {
    const res = await post(`/hse/advanced/occurrences/${occurrenceId}/complete`, adminToken, {
      results: [{ itemCode: "SC-01", result: "pass" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Mandatory checklist items have no result/i);
    expect(res.json().error).toMatch(/SC-02/);
  });

  it("refuses a result against an item the programme does not have", async () => {
    const res = await post(`/hse/advanced/occurrences/${occurrenceId}/complete`, adminToken, {
      results: [
        { itemCode: "SC-01", result: "pass" },
        { itemCode: "SC-02", result: "pass" },
        { itemCode: "SC-99", result: "pass" },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/SC-99/);
  });

  it("completes the occurrence once every mandatory item is answered", async () => {
    const res = await post(`/hse/advanced/occurrences/${occurrenceId}/complete`, adminToken, {
      results: [
        { itemCode: "SC-01", result: "pass" },
        { itemCode: "SC-02", result: "fail", note: "Two tags expired" },
      ],
      notes: "Two items checked",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().performedAt).not.toBeNull();
    expect(res.json().results).toHaveLength(2);
  });

  it("raises a finding without raising a CAPA", async () => {
    const before = (await get("/hse/advanced/capas", adminToken)).json() as unknown[];

    const res = await post(`/hse/advanced/occurrences/${occurrenceId}/findings`, adminToken, {
      findingType: "nonconformity",
      checklistItemCode: "SC-02",
      description: "Two scaffold tags expired",
    });
    expect(res.statusCode).toBe(201);
    findingId = res.json().id;
    expect(res.json().findingType).toBe("nonconformity");

    const findings = await get(`/hse/advanced/occurrences/${occurrenceId}/findings`, adminToken);
    expect(findings.json()).toHaveLength(1);
    expect(findings.json()[0].id).toBe(findingId);

    // A finding is a recorded observation, not a corrective action: nothing
    // was raised on its behalf (ADR-0027 §5).
    const after = (await get("/hse/advanced/capas", adminToken)).json() as unknown[];
    expect(after).toHaveLength(before.length);
  });

  it("refuses a finding naming an item the programme does not have", async () => {
    const res = await post(`/hse/advanced/occurrences/${occurrenceId}/findings`, adminToken, {
      checklistItemCode: "SC-99",
      description: "Ghost item",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/SC-99/);
  });

  // ========================================================================
  // HSE-ADV-005 — environmental monitoring, breach decided at write time
  // ========================================================================

  it("refuses a monitoring point with nothing declared to breach", async () => {
    const res = await post("/hse/advanced/monitoring-points", adminToken, {
      code: "A7-NOTH",
      name: "No threshold",
      parameterCode: "pH",
      unit: "pH",
      organizationUnitId: unitId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one threshold/i);
  });

  it("refuses a monitoring point whose maximum sits below its minimum", async () => {
    const res = await post("/hse/advanced/monitoring-points", adminToken, {
      code: "A7-INV",
      name: "Inverted",
      parameterCode: "pH",
      unit: "pH",
      thresholdMin: "9",
      thresholdMax: "6",
      organizationUnitId: unitId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/thresholdMax must not be below thresholdMin/i);
  });

  it("records a compliant reading against the declared band", async () => {
    const point = await post("/hse/advanced/monitoring-points", adminToken, {
      code: "A7-PH",
      name: "Effluent pH",
      parameterCode: "pH",
      unit: "pH",
      thresholdMin: "6",
      thresholdMax: "9",
      organizationUnitId: unitId,
    });
    expect(point.statusCode).toBe(201);
    pointId = point.json().id;

    const res = await post(`/hse/advanced/monitoring-points/${pointId}/readings`, adminToken, {
      measuredAt: "2026-05-01T07:00:00.000Z",
      value: "7.2500",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().isBreach).toBe(false);
    expect(res.json().value).toBe("7.2500");
  });

  it("decides the breach when the reading is written", async () => {
    const res = await post(`/hse/advanced/monitoring-points/${pointId}/readings`, adminToken, {
      measuredAt: "2026-05-01T13:00:00.000Z",
      value: "9.4000",
      note: "Upstream discharge",
    });
    expect(res.statusCode).toBe(201);
    breachReadingId = res.json().id;
    expect(res.json().isBreach).toBe(true);

    // Stored, not recomputed: the row keeps the verdict it was written with.
    const readings = await get(`/hse/advanced/monitoring-points/${pointId}/readings`, adminToken);
    const stored = (readings.json() as { id: string; isBreach: boolean }[]).find(
      (r) => r.id === breachReadingId,
    );
    expect(stored?.isBreach).toBe(true);
  });

  it("refuses two readings for the same point at the same moment", async () => {
    const res = await post(`/hse/advanced/monitoring-points/${pointId}/readings`, adminToken, {
      measuredAt: "2026-05-01T13:00:00.000Z",
      value: "9.1000",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already exists/i);
  });

  // ========================================================================
  // HSE-ADV-006 — CAPA, its own aggregate
  // ========================================================================

  it("refuses a CAPA that answers nothing", async () => {
    const res = await post("/hse/advanced/capas", adminToken, {
      title: "Orphan corrective action",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/must reference what it answers/i);
  });

  it("raises a CAPA against the investigation's root cause", async () => {
    const res = await post("/hse/advanced/capas", adminToken, {
      title: "Fit a lockable guard interlock",
      investigationId,
      rootCause: "Guard interlock bypassed",
      dueDate: "2026-06-01",
    });
    expect(res.statusCode).toBe(201);
    const capa = res.json();
    capaId = capa.id;
    expect(capa.capaNumber).toMatch(/^CAPA-/);
    expect(capa.status).toBe("open");
    expect(capa.investigationId).toBe(investigationId);
    expect(capa.closedAt).toBeNull();
  });

  it("refuses a CAPA anchored to a finding from another tenant", async () => {
    const res = await post("/hse/advanced/capas", adminToken, {
      title: "Cross-tenant",
      auditFindingId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("adds and completes an action on an open CAPA", async () => {
    const added = await post(`/hse/advanced/capas/${capaId}/actions`, adminToken, {
      description: "Replace the interlock with a keyed variant",
      dueDate: "2026-05-20",
    });
    expect(added.statusCode).toBe(201);
    capaActionId = added.json().id;
    expect(added.json().completedAt).toBeNull();

    const done = await post(
      `/hse/advanced/capas/${capaId}/actions/${capaActionId}/complete`,
      adminToken,
      { completionNotes: "Fitted and tested" },
    );
    expect(done.statusCode).toBe(200);
    expect(done.json().completedAt).not.toBeNull();

    const again = await post(
      `/hse/advanced/capas/${capaId}/actions/${capaActionId}/complete`,
      adminToken,
      {},
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already complete/i);
  });

  it("refuses to close a CAPA that is not under verification", async () => {
    const res = await patch(`/hse/advanced/capas/${capaId}/status`, verifierToken, {
      status: "closed",
      verificationNotes: "Looks fine",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/only a CAPA under verification can be closed/i);
  });

  it("refuses to close without verification notes", async () => {
    const moved = await patch(`/hse/advanced/capas/${capaId}/status`, adminToken, {
      status: "verification",
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().status).toBe("verification");

    const res = await patch(`/hse/advanced/capas/${capaId}/status`, verifierToken, {
      status: "closed",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/requires verification notes/i);
  });

  it("refuses to close for a role that may not verify", async () => {
    const res = await patch(`/hse/advanced/capas/${capaId}/status`, readerToken, {
      status: "closed",
      verificationNotes: "Self-certified",
    });
    expect(res.statusCode).toBe(403);
  });

  it("closes on verified evidence and then accepts no further action", async () => {
    const res = await patch(`/hse/advanced/capas/${capaId}/status`, verifierToken, {
      status: "closed",
      verificationNotes: "Audited the new interlock on site",
    });
    expect(res.statusCode).toBe(200);
    const capa = res.json();
    expect(capa.status).toBe("closed");
    expect(capa.verifiedAt).not.toBeNull();
    expect(capa.closedAt).not.toBeNull();
    expect(capa.verificationNotes).toMatch(/audited/i);

    const blocked = await post(`/hse/advanced/capas/${capaId}/actions`, adminToken, {
      description: "One more thing",
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/no further action can be added/i);
  });

  it("cancels a CAPA only with a reason", async () => {
    const created = await post("/hse/advanced/capas", adminToken, {
      title: "Superseded action",
      monitoringReadingId: breachReadingId,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const noReason = await patch(`/hse/advanced/capas/${id}/status`, adminToken, {
      status: "cancelled",
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toMatch(/requires a reason/i);

    const cancelled = await patch(`/hse/advanced/capas/${id}/status`, adminToken, {
      status: "cancelled",
      verificationNotes: "Discharge corrected at source",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
  });

  // ========================================================================
  // HSE-ADV-007 — indicator snapshots
  // ========================================================================

  it("computes a snapshot from recorded facts and the supplied denominators", async () => {
    const res = await post("/hse/advanced/indicators", adminToken, {
      windowStart: "2026-03-01",
      windowEnd: "2026-03-31",
      organizationUnitId: unitId,
      exposureHours: "200000",
      lostDays: 3,
      nearMissCategoryCode: "near_miss",
      lostTimeSeverityCode: "lost_time",
    });
    expect(res.statusCode).toBe(201);
    const snapshot = res.json();
    expect(snapshot.windowStart).toBe("2026-03-01");
    expect(snapshot.windowEnd).toBe("2026-03-31");
    expect(snapshot.exposureHours).toBe("200000.00");
    // One lost-time incident over 200,000 hours is 1.00 on a 200,000 base.
    expect(snapshot.incidentFrequencyRate).toBe("1.0000");
    expect(snapshot.severityRate).toBe("3.0000");
    expect(snapshot.lostDays).toBe(3);
  });

  it("stores a null rate when no denominator was supplied", async () => {
    const res = await post("/hse/advanced/indicators", adminToken, {
      windowStart: "2026-04-01",
      windowEnd: "2026-04-30",
      organizationUnitId: unitId,
    });
    expect(res.statusCode).toBe(201);
    // Not measured, not zero: nothing was declared to divide by.
    expect(res.json().incidentFrequencyRate).toBeNull();
    expect(res.json().severityRate).toBeNull();
    expect(res.json().exposureHours).toBeNull();
  });

  it("refuses a window that ends before it starts", async () => {
    const res = await post("/hse/advanced/indicators", adminToken, {
      windowStart: "2026-05-31",
      windowEnd: "2026-05-01",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/windowEnd must not be before windowStart/i);
  });

  it("keeps a stored snapshot unchanged after later activity", async () => {
    const before = (await get("/hse/advanced/indicators", adminToken)).json() as {
      id: string;
      incidentCount: number;
    }[];
    const march = before.find((s) => s.windowStart === "2026-03-01");
    expect(march).toBeTruthy();

    await report(adminToken, {
      recordType: "incident",
      categoryCode: "near_miss",
      severityCode: "lost_time",
      occurredAt: "2026-03-20T10:00:00.000Z",
      title: "A7HSE later incident",
      organizationUnitId: unitId,
    });

    const after = (await get("/hse/advanced/indicators", adminToken)).json() as {
      id: string;
      incidentCount: number;
    }[];
    const stillMarch = after.find((s) => s.id === march!.id);
    expect(stillMarch?.incidentCount).toBe(march!.incidentCount);
  });
});
