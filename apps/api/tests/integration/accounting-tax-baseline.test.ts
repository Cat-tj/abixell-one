import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { PgTaxRepository } from "../../src/modules/accounting/tax/infrastructure/tax.repository.pg.js";
import {
  TAX_RULE_WORKFLOW_DEFINITION_CODE,
  TaxService,
} from "../../src/modules/accounting/tax/application/tax.service.js";
import {
  computeTaxAmount,
  divideRound,
  fromCents,
  fromRateMicros,
  resolveRegistration,
  resolveRuleVersion,
  toCents,
  toRateMicros,
  type TaxRegistration,
  type TaxRuleVersion,
} from "../../src/modules/accounting/tax/domain/tax.entity.js";
import { PgRbacRepository } from "../../src/infrastructure/persistence/repositories/rbac.repository.pg.js";
import { PgAuditLogRepository } from "../../src/infrastructure/persistence/repositories/audit-log.repository.pg.js";
import { PgOrganizationUnitRepository } from "../../src/infrastructure/persistence/repositories/organization-unit.repository.pg.js";
import { PgLegalEntityRepository } from "../../src/infrastructure/persistence/repositories/legal-entity.repository.pg.js";
import { RbacService } from "../../src/application/rbac/rbac.service.js";
import { AuditService } from "../../src/application/audit/audit.service.js";
import { WorkflowService } from "../../src/application/workflow/workflow.service.js";
import { PgWorkflowRepository } from "../../src/infrastructure/persistence/repositories/workflow.repository.pg.js";
import type { ActorContext } from "../../src/domain/shared-kernel/audit-context.js";
import { ConflictError, ValidationError } from "../../src/domain/shared-kernel/errors.js";

/**
 * WP-FIN-A6-06a — Indonesia tax baseline (ADR-0019).
 *
 * Contract under test:
 *   - rates and money are exact integers end to end: no float ever decides a
 *     tax figure, and every rounding mode is deterministic;
 *   - the registration and the rule version in force on the calculation date are
 *     the ones used — a later change never restates an earlier calculation;
 *   - a PKP-only rule on a Non-PKP entity is refused, never zeroed;
 *   - a rule version is only usable once approved, and approval supersedes the
 *     version it replaces without editing it;
 *   - PPh Badan and PPh 21 are outside the baseline and refused by name;
 *   - nothing crosses a tenant or a Legal Entity boundary.
 *
 * Pattern: real DB pool, dedicated tenant, CASCADE cleanup.
 */

const TS = `ak-tax-${Date.now()}`;

describe("WP-FIN-A6-06a — Indonesia tax baseline", () => {
  let tenantId: string;
  let legalEntityId: string;
  let otherLegalEntityId: string;
  let userId: string;
  let accountId: string;
  let service: TaxService;
  let roleSeq = 0;
  let ruleSeq = 0;
  /** What the mocked Workflow Engine reports after an action. */
  let outcomeStatus = "approved";

  async function actorWith(
    permissions: string[],
    scope: { scopeType: "tenant" } | { scopeType: "legal_entity"; legalEntityId: string } = {
      scopeType: "tenant",
    },
  ): Promise<ActorContext> {
    const roleCode = `ROLE-TAX-${++roleSeq}-${userId.slice(0, 8)}`;
    const roleRes = await pool.query(
      `INSERT INTO roles (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
      [tenantId, roleCode],
    );
    const roleId = roleRes.rows[0].id;
    if (permissions.length > 0) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, p.id FROM permissions p WHERE p.code = ANY($2)`,
        [roleId, permissions],
      );
    }
    const assignRes = await pool.query(
      `INSERT INTO user_role_assignments (user_id, role_id, scope_type, scope_legal_entity_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        userId,
        roleId,
        scope.scopeType,
        scope.scopeType === "legal_entity" ? scope.legalEntityId : null,
      ],
    );
    return {
      userId,
      tenantId,
      sessionId: "00000000-0000-4000-8000-000000000006",
      assignmentId: assignRes.rows[0].id,
      roleId,
      roleCode,
      scopeType: scope.scopeType,
      scopeLegalEntityId: scope.scopeType === "legal_entity" ? scope.legalEntityId : null,
      scopeOrganizationUnitId: null,
      scopeCustomerId: null,
    };
  }

  /** Seed a workflow definition + published version so a started instance
   *  satisfies its FKs. Orchestration itself is mocked below — this suite owns
   *  the tax contract, not the Workflow Engine's. */
  async function seedWorkflowDefinition(code: string, entityType: string) {
    const def = await pool.query(
      `INSERT INTO workflow_definitions (tenant_id, code, name, entity_type, description)
       VALUES ($1,$2,'Tax Rule Version Approval',$3,'test') RETURNING id`,
      [tenantId, code, entityType],
    );
    const version = await pool.query(
      `INSERT INTO workflow_versions
         (workflow_definition_id, version_number, status, is_current)
       VALUES ($1,1,'published',true) RETURNING id`,
      [def.rows[0].id],
    );
    const step = await pool.query(
      `INSERT INTO workflow_steps (workflow_version_id, code, name, step_type, is_initial, sequence_order)
       VALUES ($1,'initial','Initial Submission','task',true,0) RETURNING id`,
      [version.rows[0].id],
    );
    return {
      definitionId: def.rows[0].id as string,
      versionId: version.rows[0].id as string,
      initialStepId: step.rows[0].id as string,
    };
  }

  /** Create a rule and a draft version, returning both. */
  async function ruleWithDraft(overrides: Record<string, unknown> = {}) {
    const configure = await actorWith(["finance.accounting.configure"]);
    const rule = await service.createRule(configure, {
      legalEntityId,
      ruleCode: `PPN-OUT-${++ruleSeq}`,
      taxType: "ppn",
      description: "PPN keluaran",
    });
    const version = await service.createVersion(configure, rule.id, {
      rate: "0.110000",
      basis: "gross",
      requiresPkp: true,
      accountId,
      effectiveFrom: "2026-01-01",
      ...overrides,
    } as Parameters<TaxService["createVersion"]>[2]);
    return { rule, version };
  }

  async function registerPkp(from = "2026-01-01", status: "pkp" | "non_pkp" = "pkp") {
    const actor = await actorWith(["finance.accounting.configure"]);
    return service.registerTaxpayer(actor, {
      legalEntityId,
      taxpayerStatus: status,
      effectiveFrom: from,
    });
  }

  beforeAll(async () => {
    const tenant = await pool.query(
      `INSERT INTO tenants (code, name) VALUES ($1, 'Tax Baseline Test Tenant') RETURNING id`,
      [TS],
    );
    tenantId = tenant.rows[0].id;

    const le = await pool.query(
      `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, 'LE Tax') RETURNING id`,
      [tenantId],
    );
    legalEntityId = le.rows[0].id;
    const otherLe = await pool.query(
      `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, 'LE Tax Other') RETURNING id`,
      [tenantId],
    );
    otherLegalEntityId = otherLe.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1,$2,'x','Tax Tester') RETURNING id`,
      [tenantId, `${TS}@test.local`],
    );
    userId = user.rows[0].id;

    const coa = await pool.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, coa_version_code, coa_version_date)
       VALUES ($1,$2,'COA-TAX','2026-01-01') RETURNING id`,
      [tenantId, legalEntityId],
    );
    const account = await pool.query(
      `INSERT INTO accounting_accounts
         (tenant_id, legal_entity_id, coa_id, account_code, account_name, account_class, normal_balance)
       VALUES ($1,$2,$3,'2150','PPN Keluaran','LIABILITY','credit') RETURNING id`,
      [tenantId, legalEntityId, coa.rows[0].id],
    );
    accountId = account.rows[0].id;

    const wf = await seedWorkflowDefinition(
      TAX_RULE_WORKFLOW_DEFINITION_CODE,
      "finance_tax_rule_version",
    );

    // The Data Scope guard reads Legal Entity lifecycle, so the service needs
    // the same repositories production wires — a 1-arg stub would let a scope
    // violation pass silently.
    const rbac = new RbacService(
      new PgRbacRepository(pool),
      new PgOrganizationUnitRepository(pool),
      new PgLegalEntityRepository(pool),
    );
    const audit = new AuditService(new PgAuditLogRepository(pool));
    const workflow = {
      startInstance: async (_actor: ActorContext, input: { entityId: string; contextData?: unknown }) => {
        const r = await pool.query(
          `INSERT INTO workflow_instances
             (tenant_id, workflow_definition_id, workflow_version_id, entity_type, entity_id,
              current_step_id, context_data, started_by)
           VALUES ($1,$2,$3,'finance_tax_rule_version',$4,$5,$7::jsonb,$6) RETURNING id`,
          [tenantId, wf.definitionId, wf.versionId, input.entityId, wf.initialStepId, userId, JSON.stringify(input.contextData ?? {})],
        );
        return { instance: { id: r.rows[0].id } };
      },
      getInstanceForEntityOwner: async () => ({
        instance: { id: "x" },
        assignments: [{ id: "a1", status: "pending" }],
        currentStep: null,
        history: [],
      }),
      actOnAssignment: async () => undefined,
      getEntityStatus: async () => ({ instanceStatus: outcomeStatus }),
    } as unknown as WorkflowService;

    service = new TaxService(new PgTaxRepository(pool), rbac, audit, workflow);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  });

  // =========================================================================
  // Exact arithmetic (pure)
  // =========================================================================

  describe("exact decimal arithmetic", () => {
    it("parses money and rates into integers without a float", () => {
      expect(toCents("1234.56")).toBe(123456n);
      expect(fromCents(123456n)).toBe("1234.56");
      expect(toRateMicros("0.110000")).toBe(110000n);
      expect(fromRateMicros(110000n)).toBe("0.110000");
      // A rate written without decimals is still exact.
      expect(toRateMicros("0.02")).toBe(20000n);
    });

    it("rejects malformed money and rates instead of coercing them", () => {
      expect(toCents("12.345")).toBeNull();
      expect(toCents("abc")).toBeNull();
      expect(toRateMicros("1e-1")).toBeNull();
      expect(toRateMicros("0.1234567")).toBeNull();
    });

    it("applies 11% PPN exactly", () => {
      // 100.00 × 11% = 11.00, no rounding involved.
      expect(computeTaxAmount(10000n, 110000n, "half_up")).toBe(1100n);
      // 1000.00 × 11% = 110.00
      expect(computeTaxAmount(100000n, 110000n, "half_up")).toBe(11000n);
    });

    it("rounds deterministically under each mode", () => {
      // 333 cents × 11% = 36.63 cents → 37 half_up, 37 half_even (36 is even →
      // no: 36.63 rounds up under both), 36 truncate.
      expect(computeTaxAmount(333n, 110000n, "half_up")).toBe(37n);
      expect(computeTaxAmount(333n, 110000n, "truncate")).toBe(36n);
      // An exact tie: 50 × 5% = 2.5 cents. half_up → 3, half_even → 2, truncate → 2.
      expect(computeTaxAmount(50n, 50000n, "half_up")).toBe(3n);
      expect(computeTaxAmount(50n, 50000n, "half_even")).toBe(2n);
      expect(computeTaxAmount(50n, 50000n, "truncate")).toBe(2n);
      // half_even bumps an odd quotient at a tie: 150 × 5% = 7.5 → 8.
      expect(computeTaxAmount(150n, 50000n, "half_even")).toBe(8n);
    });

    it("refuses a non-positive denominator", () => {
      expect(() => divideRound(10n, 0n, "half_up")).toThrow(RangeError);
    });
  });

  // =========================================================================
  // Effective-date resolution (pure)
  // =========================================================================

  describe("effective-date resolution", () => {
    const reg = (
      id: string,
      status: "pkp" | "non_pkp",
      from: string,
      to: string | null,
    ): TaxRegistration => ({
      id,
      tenantId: "t",
      legalEntityId: "le",
      taxpayerStatus: status,
      registrationNumber: null,
      effectiveFrom: from,
      effectiveTo: to,
      evidenceDocumentId: null,
      status: to === null ? "active" : "superseded",
      workflowInstanceId: null,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    it("picks the registration in force and treats effective_to as exclusive", () => {
      const rows = [reg("a", "non_pkp", "2026-01-01", "2026-07-01"), reg("b", "pkp", "2026-07-01", null)];
      expect(resolveRegistration(rows, "2026-03-15")?.id).toBe("a");
      // The end date belongs to the NEXT row, not the closing one.
      expect(resolveRegistration(rows, "2026-07-01")?.id).toBe("b");
      // Before any registration there is no status — never a default.
      expect(resolveRegistration(rows, "2025-12-31")).toBeNull();
    });

    it("resolves a superseded version inside its own window and never a draft", () => {
      const version = (
        id: string,
        number: number,
        status: "draft" | "approved" | "superseded",
        from: string,
        to: string | null = null,
      ): TaxRuleVersion => ({
        id,
        tenantId: "t",
        taxRuleId: "r",
        versionNumber: number,
        rate: "0.110000",
        basis: "gross",
        roundingMode: "half_up",
        requiresPkp: false,
        accountId: "acc",
        effectiveFrom: from,
        effectiveTo: to,
        status,
        workflowInstanceId: null,
        approvedBy: null,
        approvedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const versions = [
        version("v1", 1, "superseded", "2025-01-01", "2026-01-01"),
        version("v2", 2, "approved", "2026-01-01"),
        version("v3", 3, "draft", "2026-06-01"),
      ];
      expect(resolveRuleVersion(versions, "2026-03-01")?.id).toBe("v2");
      // Superseded is not withdrawn: a calculation dated inside its window
      // still resolves to the version that was in force then.
      expect(resolveRuleVersion(versions, "2025-06-01")?.id).toBe("v1");
      // A draft was never in force, and before the first window nothing was.
      expect(resolveRuleVersion(versions, "2024-06-01")).toBeNull();
      expect(resolveRuleVersion([version("d", 1, "draft", "2026-01-01")], "2026-03-01")).toBeNull();
    });
  });

  // =========================================================================
  // Registrations
  // =========================================================================

  describe("taxpayer registration", () => {
    it("records PKP status and supersedes it without rewriting history", async () => {
      await registerPkp("2026-01-01", "non_pkp");
      const later = await registerPkp("2026-07-01", "pkp");
      expect(later.taxpayerStatus).toBe("pkp");
      expect(later.effectiveFrom).toBe("2026-07-01");

      const read = await actorWith(["finance.accounting.read"]);
      const rows = await service.listRegistrations(read, legalEntityId);
      const earlier = rows.find((r) => r.effectiveFrom === "2026-01-01");
      expect(earlier?.taxpayerStatus).toBe("non_pkp");
      expect(earlier?.status).toBe("superseded");
      // The closing date is the new row's start — no gap, no overlap.
      expect(earlier?.effectiveTo).toBe("2026-07-01");
    });

    it("refuses a back-dated change that would restate history", async () => {
      await expect(registerPkp("2025-06-01", "pkp")).rejects.toBeInstanceOf(ValidationError);
    });

    it("reports the status in force on a date, and refuses before any registration", async () => {
      const read = await actorWith(["finance.accounting.read"]);
      const march = await service.taxpayerStatusAt(read, legalEntityId, "2026-03-15");
      expect(march.taxpayerStatus).toBe("non_pkp");
      const august = await service.taxpayerStatusAt(read, legalEntityId, "2026-08-15");
      expect(august.taxpayerStatus).toBe("pkp");
      await expect(
        service.taxpayerStatusAt(read, legalEntityId, "2025-01-01"),
      ).rejects.toThrow(/TaxRegistration/);
    });

    it("refuses a Legal Entity outside the actor's Data Scope", async () => {
      const scoped = await actorWith(["finance.accounting.configure"], {
        scopeType: "legal_entity",
        legalEntityId: otherLegalEntityId,
      });
      await expect(
        service.registerTaxpayer(scoped, {
          legalEntityId,
          taxpayerStatus: "pkp",
          effectiveFrom: "2027-01-01",
        }),
      ).rejects.toThrow(/Data Scope/);
    });
  });

  // =========================================================================
  // Rules + versions
  // =========================================================================

  describe("rule versions", () => {
    it("refuses PPh Badan and PPh 21 by name", async () => {
      const actor = await actorWith(["finance.accounting.configure"]);
      await expect(
        service.createRule(actor, { legalEntityId, ruleCode: "BADAN-X", taxType: "pph_badan" }),
      ).rejects.toThrow(/separate authorization/);
      await expect(
        service.createRule(actor, { legalEntityId, ruleCode: "P21-X", taxType: "pph21" }),
      ).rejects.toThrow(/separate authorization/);
    });

    it("drafts a version that is not usable until approved", async () => {
      const { rule, version } = await ruleWithDraft({ effectiveFrom: "2026-02-01" });
      expect(version.status).toBe("draft");
      expect(version.versionNumber).toBe(1);
      expect(version.workflowInstanceId).not.toBeNull();

      const configure = await actorWith(["finance.accounting.configure"]);
      await expect(
        service.calculate(configure, {
          legalEntityId,
          ruleCode: rule.ruleCode,
          basisAmount: "100.00",
          calculationDate: "2026-03-01",
          idempotencyKey: `draft-${rule.id}`,
        }),
      ).rejects.toThrow(/No approved version/);
    });

    it("stamps the rule's Legal Entity on the approval Instance (no owning unit exists) for read visibility", async () => {
      const { version } = await ruleWithDraft({ effectiveFrom: "2026-04-01" });
      const r = await pool.query(`SELECT context_data FROM workflow_instances WHERE id = $1`, [
        version.workflowInstanceId,
      ]);
      expect(r.rows[0].context_data.legalEntityId).toBe(legalEntityId);
      expect(r.rows[0].context_data.organizationUnitId).toBeUndefined();
    });

    it("rejects a rate that is not a fraction", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      const rule = await service.createRule(configure, {
        legalEntityId,
        ruleCode: `BAD-RATE-${++ruleSeq}`,
        taxType: "ppn",
      });
      await expect(
        service.createVersion(configure, rule.id, {
          rate: "11",
          basis: "gross",
          accountId,
          effectiveFrom: "2026-01-01",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("supersedes the previous approved version on approval", async () => {
      const { rule, version: v1 } = await ruleWithDraft({ effectiveFrom: "2026-01-01" });
      const approve = await actorWith(["finance.accounting.approve"]);
      const approved1 = await service.actOnVersion(approve, v1.id, "approve", "ok");
      expect(approved1.status).toBe("approved");

      const configure = await actorWith(["finance.accounting.configure"]);
      const v2 = await service.createVersion(configure, rule.id, {
        rate: "0.120000",
        basis: "gross",
        requiresPkp: true,
        accountId,
        effectiveFrom: "2026-06-01",
      });
      const approved2 = await service.actOnVersion(approve, v2.id, "approve", "ok");
      expect(approved2.status).toBe("approved");
      expect(approved2.versionNumber).toBe(2);

      const read = await actorWith(["finance.accounting.read"]);
      const versions = await service.listVersions(read, rule.id);
      const first = versions.find((v) => v.versionNumber === 1);
      expect(first?.status).toBe("superseded");
      // The superseded version keeps its own rate — nothing rewrote it.
      expect(first?.rate).toBe("0.110000");
      expect(first?.effectiveTo).toBe("2026-06-01");
    });

    it("refuses a second approval of an already-approved version", async () => {
      const { version } = await ruleWithDraft({ effectiveFrom: "2026-01-01" });
      const approve = await actorWith(["finance.accounting.approve"]);
      await service.actOnVersion(approve, version.id, "approve", "ok");
      await expect(
        service.actOnVersion(approve, version.id, "approve", "again"),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  // =========================================================================
  // Calculation
  // =========================================================================

  describe("calculation", () => {
    /** A rule approved from `from`, ready to calculate against. */
    async function approvedRule(from: string, rate: string, requiresPkp = true) {
      const { rule, version } = await ruleWithDraft({
        effectiveFrom: from,
        rate,
        requiresPkp,
      });
      const approve = await actorWith(["finance.accounting.approve"]);
      await service.actOnVersion(approve, version.id, "approve", "ok");
      return rule;
    }

    it("stores the basis, rate, mode, result and exact rule version", async () => {
      const rule = await approvedRule("2026-01-01", "0.110000");
      const actor = await actorWith(["finance.accounting.configure"]);
      const calc = await service.calculate(actor, {
        legalEntityId,
        ruleCode: rule.ruleCode,
        basisAmount: "1000.00",
        calculationDate: "2026-08-15",
        idempotencyKey: `calc-${rule.id}`,
      });
      expect(calc.taxAmount).toBe("110.00");
      expect(calc.basisAmount).toBe("1000.00");
      expect(calc.rate).toBe("0.110000");
      expect(calc.roundingMode).toBe("half_up");
      expect(calc.taxpayerStatus).toBe("pkp");
      expect(calc.ruleVersionId).toBeTruthy();
    });

    it("uses the version in force on the calculation date, not the current one", async () => {
      // Not PKP-gated: this case is about which version applies, and the shared
      // entity is Non-PKP before 2026-07-01 (see the registration suite).
      const { rule, version: v1 } = await ruleWithDraft({
        effectiveFrom: "2026-01-01",
        rate: "0.110000",
        requiresPkp: false,
      });
      const approve = await actorWith(["finance.accounting.approve"]);
      await service.actOnVersion(approve, v1.id, "approve", "ok");

      const configure = await actorWith(["finance.accounting.configure"]);
      const v2 = await service.createVersion(configure, rule.id, {
        rate: "0.120000",
        basis: "gross",
        requiresPkp: false,
        accountId,
        effectiveFrom: "2026-06-01",
      });
      await service.actOnVersion(approve, v2.id, "approve", "ok");

      // Dated BEFORE the change: the 11% version applies.
      const early = await service.calculate(configure, {
        legalEntityId,
        ruleCode: rule.ruleCode,
        basisAmount: "1000.00",
        calculationDate: "2026-03-01",
        idempotencyKey: `early-${rule.id}`,
      });
      expect(early.rate).toBe("0.110000");
      expect(early.taxAmount).toBe("110.00");
      expect(early.ruleVersionId).toBe(v1.id);

      // Dated AFTER it: the 12% version applies, and the earlier row is untouched.
      const late = await service.calculate(configure, {
        legalEntityId,
        ruleCode: rule.ruleCode,
        basisAmount: "1000.00",
        calculationDate: "2026-08-01",
        idempotencyKey: `late-${rule.id}`,
      });
      expect(late.rate).toBe("0.120000");
      expect(late.taxAmount).toBe("120.00");
      expect(late.ruleVersionId).toBe(v2.id);
    });

    it("refuses a PKP-only rule on a Non-PKP entity instead of zeroing it", async () => {
      // A dedicated entity that stays Non-PKP throughout.
      const nonPkpLe = await pool.query(
        `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, 'LE Non PKP') RETURNING id`,
        [tenantId],
      );
      const nonPkpEntityId = nonPkpLe.rows[0].id as string;

      const configure = await actorWith(["finance.accounting.configure"]);
      await service.registerTaxpayer(configure, {
        legalEntityId: nonPkpEntityId,
        taxpayerStatus: "non_pkp",
        effectiveFrom: "2026-01-01",
      });
      const rule = await service.createRule(configure, {
        legalEntityId: nonPkpEntityId,
        ruleCode: `PPN-PKP-ONLY-${++ruleSeq}`,
        taxType: "ppn",
      });
      const draft = await service.createVersion(configure, rule.id, {
        rate: "0.110000",
        basis: "gross",
        requiresPkp: true,
        accountId,
        effectiveFrom: "2026-01-01",
      });
      const approve = await actorWith(["finance.accounting.approve"]);
      await service.actOnVersion(approve, draft.id, "approve", "ok");

      await expect(
        service.calculate(configure, {
          legalEntityId: nonPkpEntityId,
          ruleCode: rule.ruleCode,
          basisAmount: "1000.00",
          calculationDate: "2026-03-01",
          idempotencyKey: `non-pkp-${rule.id}`,
        }),
      ).rejects.toThrow(/requires PKP status/);
    });

    it("is idempotent on the caller's key", async () => {
      const rule = await approvedRule("2026-01-01", "0.110000");
      const actor = await actorWith(["finance.accounting.configure"]);
      const input = {
        legalEntityId,
        ruleCode: rule.ruleCode,
        basisAmount: "500.00",
        calculationDate: "2026-08-15",
        idempotencyKey: `idem-${rule.id}`,
      };
      const first = await service.calculate(actor, input);
      const second = await service.calculate(actor, input);
      expect(second.id).toBe(first.id);
      expect(second.taxAmount).toBe(first.taxAmount);
    });

    it("refuses an unknown document table", async () => {
      const rule = await approvedRule("2026-01-01", "0.110000");
      const actor = await actorWith(["finance.accounting.configure"]);
      await expect(
        service.calculate(actor, {
          legalEntityId,
          ruleCode: rule.ruleCode,
          basisAmount: "10.00",
          calculationDate: "2026-08-15",
          documentRefTable: "some_other_table",
          documentRefId: "00000000-0000-4000-8000-000000000001",
          idempotencyKey: `badtbl-${rule.id}`,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
