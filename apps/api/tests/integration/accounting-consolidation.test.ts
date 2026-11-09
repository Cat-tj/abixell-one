import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/infrastructure/persistence/db.js";
import { PgConsolidationRepository } from "../../src/modules/accounting/consolidation/infrastructure/consolidation.repository.pg.js";
import {
  CONSOLIDATION_GROUP_WORKFLOW_CODE,
  ConsolidationService,
  type JournalKernelPort,
} from "../../src/modules/accounting/consolidation/application/consolidation.service.js";
import {
  fromCents,
  resolveFsvVersion,
  resolveMembers,
  resolveRate,
  resolveRateSet,
  toCents,
  toRateUnits,
  translateAmount,
  validateFsvLines,
  type FsvVersion,
  type FxRate,
  type FxRateSet,
} from "../../src/modules/accounting/consolidation/domain/consolidation.entity.js";
import { PgRbacRepository } from "../../src/infrastructure/persistence/repositories/rbac.repository.pg.js";
import { PgAuditLogRepository } from "../../src/infrastructure/persistence/repositories/audit-log.repository.pg.js";
import { PgOrganizationUnitRepository } from "../../src/infrastructure/persistence/repositories/organization-unit.repository.pg.js";
import { PgLegalEntityRepository } from "../../src/infrastructure/persistence/repositories/legal-entity.repository.pg.js";
import { RbacService } from "../../src/application/rbac/rbac.service.js";
import { AuditService } from "../../src/application/audit/audit.service.js";
import { WorkflowService } from "../../src/application/workflow/workflow.service.js";
import type { ActorContext } from "../../src/domain/shared-kernel/audit-context.js";
import { ValidationError } from "../../src/domain/shared-kernel/errors.js";

/**
 * WP-FIN-A6-06b — Consolidation (ADR-0022 §1–§3).
 *
 * Contract under test:
 *   - a group has ONE reporting currency and is same-tenant by construction;
 *   - membership is effective dated, so a report dated before a change still
 *     resolves the perimeter it had;
 *   - an FSV is a CLOSED metamodel: lines sum accounts with a stated sign, no
 *     expression column, and the invariants are checked before anything is
 *     written;
 *   - translation stores every figure WITH the rate that produced it, and a
 *     missing rate is a refusal — never a silent 1:1;
 *   - nothing here writes the GL: an elimination becomes a real journal only
 *     through the Accounting Kernel (ADR-0023);
 *   - a group activates only through approval.
 *
 * Pattern: real DB pool, dedicated tenant, CASCADE cleanup.
 */

const TS = `ak-consol-${Date.now()}`;

describe("WP-FIN-A6-06b — Consolidation", () => {
  let tenantId: string;
  let legalEntityId: string;
  let foreignEntityId: string;
  let userId: string;
  let periodId: string;
  let foreignPeriodId: string;
  let debitAccountId: string;
  let creditAccountId: string;
  let foreignDebitAccountId: string;
  let foreignCreditAccountId: string;
  let service: ConsolidationService;
  let roleSeq = 0;
  /** What the mocked Workflow Engine reports after an action. */
  let outcomeStatus = "approved";
  /** Journals the mocked kernel was asked to draft. */
  let draftedJournals: Array<{ tenantId: string; input: { idempotencyKey: string } }> = [];
  let postedJournalIds: string[] = [];

  async function actorWith(
    permissions: string[],
    scope: { scopeType: "tenant" } | { scopeType: "legal_entity"; legalEntityId: string } = {
      scopeType: "tenant",
    },
  ): Promise<ActorContext> {
    const roleCode = `ROLE-CONSOL-${++roleSeq}-${userId.slice(0, 8)}`;
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
      sessionId: "00000000-0000-4000-8000-000000000007",
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
   *  satisfies its FKs. Orchestration is mocked below — this suite owns the
   *  consolidation contract, not the Workflow Engine's. */
  async function seedWorkflowDefinition(code: string, entityType: string) {
    const def = await pool.query(
      `INSERT INTO workflow_definitions (tenant_id, code, name, entity_type, description)
       VALUES ($1,$2,'Consolidation Approval',$3,'test') RETURNING id`,
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

  /** A group that is already active, plus one member. */
  async function activeGroupWithMember(reportingCurrency = "IDR") {
    const configure = await actorWith(["finance.accounting.configure"]);
    const group = await service.createGroup(configure, {
      groupCode: `GRP-${++roleSeq}`,
      name: "Test Group",
      reportingCurrency,
    });
    const approve = await actorWith(["finance.accounting.approve"]);
    outcomeStatus = "approved";
    await service.actOnGroup(approve, group.id, "approve", null);
    await service.addMember(configure, group.id, {
      legalEntityId,
      effectiveFrom: "2026-01-01",
    });
    return { group, configure };
  }

  /** An approved FSV version. Defaults to the two seeded accounts; pass
   *  `accounts` to map a different set (each member has its own account ids, so a
   *  cross-entity translation needs every member's account mapped). */
  async function approvedFsv(
    statementType: "balance_sheet" | "profit_loss" = "balance_sheet",
    accounts: string[] = [debitAccountId, creditAccountId],
  ) {
    const configure = await actorWith(["finance.accounting.configure"]);
    const created = await service.createFsvVersion(configure, {
      fsvCode: `FSV-${++roleSeq}`,
      effectiveFrom: "2026-01-01",
      lines: accounts.map((accountId, index) => ({
        lineCode: `L${index + 1}`,
        lineName: `Line ${index + 1}`,
        statementType,
        accountId,
      })),
    });
    const approve = await actorWith(["finance.accounting.approve"]);
    outcomeStatus = "approved";
    const approved = await service.actOnFsvVersion(approve, created.version.id, "approve", null);
    return { version: approved, configure };
  }

  beforeAll(async () => {
    const tenant = await pool.query(
      `INSERT INTO tenants (code, name) VALUES ($1, 'Consolidation Test Tenant') RETURNING id`,
      [TS],
    );
    tenantId = tenant.rows[0].id;

    const le = await pool.query(
      `INSERT INTO legal_entities (tenant_id, name, base_currency)
       VALUES ($1, 'LE Consolidation', 'IDR') RETURNING id`,
      [tenantId],
    );
    legalEntityId = le.rows[0].id;
    const foreign = await pool.query(
      `INSERT INTO legal_entities (tenant_id, name, base_currency)
       VALUES ($1, 'LE Foreign', 'USD') RETURNING id`,
      [tenantId],
    );
    foreignEntityId = foreign.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name)
       VALUES ($1,$2,'x','Consolidation Tester') RETURNING id`,
      [tenantId, `${TS}@test.local`],
    );
    userId = user.rows[0].id;

    const period = await pool.query(
      `INSERT INTO accounting_periods
         (tenant_id, legal_entity_id, fiscal_year_code, period_code, period_name,
          period_type, date_from, date_to, status)
       VALUES ($1,$2,'2026','2026-01','January 2026','monthly','2026-01-01','2026-01-31','open')
       RETURNING id`,
      [tenantId, legalEntityId],
    );
    periodId = period.rows[0].id;

    const coa = await pool.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, coa_version_code, coa_version_date)
       VALUES ($1,$2,'COA-CONSOL','2026-01-01') RETURNING id`,
      [tenantId, legalEntityId],
    );
    const debit = await pool.query(
      `INSERT INTO accounting_accounts
         (tenant_id, legal_entity_id, coa_id, account_code, account_name, account_class, normal_balance)
       VALUES ($1,$2,$3,'1100','Cash','ASSET','debit') RETURNING id`,
      [tenantId, legalEntityId, coa.rows[0].id],
    );
    debitAccountId = debit.rows[0].id;
    const credit = await pool.query(
      `INSERT INTO accounting_accounts
         (tenant_id, legal_entity_id, coa_id, account_code, account_name, account_class, normal_balance)
       VALUES ($1,$2,$3,'3100','Equity','LIABILITY','credit') RETURNING id`,
      [tenantId, legalEntityId, coa.rows[0].id],
    );
    creditAccountId = credit.rows[0].id;

    // The foreign member: its own period, its own COA and accounts, in USD. A
    // translation test that only ever sees IDR would never exercise the rate path.
    const foreignPeriod = await pool.query(
      `INSERT INTO accounting_periods
         (tenant_id, legal_entity_id, fiscal_year_code, period_code, period_name,
          period_type, date_from, date_to, status)
       VALUES ($1,$2,'2026','2026-01','January 2026','monthly','2026-01-01','2026-01-31','open')
       RETURNING id`,
      [tenantId, foreignEntityId],
    );
    foreignPeriodId = foreignPeriod.rows[0].id;

    const foreignCoa = await pool.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, coa_version_code, coa_version_date)
       VALUES ($1,$2,'COA-CONSOL-US','2026-01-01') RETURNING id`,
      [tenantId, foreignEntityId],
    );
    const foreignDebit = await pool.query(
      `INSERT INTO accounting_accounts
         (tenant_id, legal_entity_id, coa_id, account_code, account_name, account_class, normal_balance)
       VALUES ($1,$2,$3,'1100','Cash','ASSET','debit') RETURNING id`,
      [tenantId, foreignEntityId, foreignCoa.rows[0].id],
    );
    foreignDebitAccountId = foreignDebit.rows[0].id;
    const foreignCredit = await pool.query(
      `INSERT INTO accounting_accounts
         (tenant_id, legal_entity_id, coa_id, account_code, account_name, account_class, normal_balance)
       VALUES ($1,$2,$3,'3100','Equity','LIABILITY','credit') RETURNING id`,
      [tenantId, foreignEntityId, foreignCoa.rows[0].id],
    );
    foreignCreditAccountId = foreignCredit.rows[0].id;

    await seedWorkflowDefinition(CONSOLIDATION_GROUP_WORKFLOW_CODE, "finance_consolidation_group");
    await seedWorkflowDefinition("fsv_version_approval", "finance_fsv_version");
    await seedWorkflowDefinition("consolidation_elimination_approval", "finance_elimination");

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
      startInstance: async (
        _actor: ActorContext,
        input: { entityId: string; definitionCode: string; contextData?: unknown },
      ) => {
        const def = await pool.query(
          `SELECT d.id AS definition_id, v.id AS version_id, s.id AS step_id
             FROM workflow_definitions d
             JOIN workflow_versions v ON v.workflow_definition_id = d.id AND v.is_current
             JOIN workflow_steps s ON s.workflow_version_id = v.id AND s.is_initial
            WHERE d.tenant_id = $1 AND d.code = $2`,
          [tenantId, input.definitionCode],
        );
        const row = def.rows[0];
        const r = await pool.query(
          `INSERT INTO workflow_instances
             (tenant_id, workflow_definition_id, workflow_version_id, entity_type, entity_id,
              current_step_id, context_data, started_by)
           VALUES ($1,$2,$3,$4,$5,$6,$8::jsonb,$7) RETURNING id`,
          [tenantId, row.definition_id, row.version_id, input.definitionCode, input.entityId, row.step_id, userId, JSON.stringify(input.contextData ?? {})],
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

    // The kernel is a port here: this suite asserts the module posts THROUGH the
    // kernel, not that the kernel itself works (the kernel has its own suites).
    const kernel: JournalKernelPort = {
      createJournalInternal: async (tenant: string, input) => {
        draftedJournals.push({ tenantId: tenant, input: input as never });
        // A real journal id, because the module stores it in a uuid column.
        return { id: randomUUID() };
      },
      postJournalInternal: async (_tenant: string, journalId: string) => {
        postedJournalIds.push(journalId);
        return {};
      },
    };

    service = new ConsolidationService(
      new PgConsolidationRepository(pool),
      rbac,
      audit,
      workflow,
      kernel,
    );
  });

  /** Post one balanced journal straight into the ledger tables. The kernel has
   *  its own suites; here the ledger is just the fact source consolidation reads. */
  async function postJournal(
    entityId: string,
    entityPeriodId: string,
    currency: string,
    debitId: string,
    creditId: string,
    amount: string,
    suffix: string,
  ) {
    const header = await pool.query(
      `INSERT INTO journal_headers
         (tenant_id, legal_entity_id, journal_number, journal_date, accounting_date,
          period_id, description, currency, idempotency_key, status, is_balanced,
          posted_date, posted_by)
       VALUES ($1,$2,$3,'2026-01-15','2026-01-15',$4,'seed',$5,$6,'posted',true,now(),$7)
       RETURNING id`,
      [tenantId, entityId, `JRN-${suffix}`, entityPeriodId, currency, `seed-${suffix}`, userId],
    );
    const headerId = header.rows[0].id;
    await pool.query(
      `INSERT INTO journal_lines
         (tenant_id, journal_header_id, account_id, line_number, debit, credit)
       VALUES ($1,$2,$3,1,$4,0), ($1,$2,$5,2,0,$4)`,
      [tenantId, headerId, debitId, amount, creditId],
    );
    return headerId as string;
  }

  afterAll(async () => {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  });

  // ------------------------------------------------------------------
  // Domain — exact arithmetic and the closed metamodel
  // ------------------------------------------------------------------

  describe("money and rate arithmetic", () => {
    it("parses and renders 2-decimal money without going through a float", () => {
      expect(toCents("1234.56")).toBe(123456n);
      expect(toCents("-0.01")).toBe(-1n);
      expect(toCents("0")).toBe(0n);
      expect(fromCents(123456n)).toBe("1234.56");
      expect(fromCents(-1n)).toBe("-0.01");
    });

    it("refuses values that are not exactly 2-decimal money", () => {
      // A third decimal is not a rounding nuisance here — accepting it would mean
      // the stored figure is not the figure the caller sent.
      expect(toCents("1.234")).toBeNull();
      expect(toCents("abc")).toBeNull();
      expect(toCents("1,000.00")).toBeNull();
      expect(toCents("")).toBeNull();
    });

    it("parses rates at 8 decimals into integer hundred-millionths", () => {
      expect(toRateUnits("1.00000000")).toBe(100_000_000n);
      expect(toRateUnits("16000.5")).toBe(1_600_050_000_000n);
      expect(toRateUnits("1.234567890")).toBeNull();
    });

    it("translates with round-half-up on the exact product", () => {
      // 100.00 USD at 16000.50 = 1,600,050.00 IDR exactly.
      expect(translateAmount(10_000n, 1_600_050_000_000n)).toBe(160_005_000n);
      // 0.01 at 0.5 is 0.005 → 0.01, not 0.00 (half rounds away from zero).
      expect(translateAmount(1n, 50_000_000n)).toBe(1n);
      // 0.01 at 0.49999999 is below half → stays 0.00.
      expect(translateAmount(1n, 49_999_999n)).toBe(0n);
      // Sign is carried, magnitude rounded.
      expect(translateAmount(-1n, 50_000_000n)).toBe(-1n);
    });

    it("refuses a non-positive rate rather than dividing by it", () => {
      expect(() => translateAmount(100n, 0n)).toThrow(RangeError);
    });
  });

  describe("closed FSV metamodel", () => {
    it("rejects a duplicate line code", () => {
      expect(() =>
        validateFsvLines([
          { lineCode: "A", accountId: null, parentLineCode: null, statementType: "balance_sheet" },
          { lineCode: "A", accountId: null, parentLineCode: null, statementType: "balance_sheet" },
        ]),
      ).toThrow(/Duplicate/);
    });

    it("rejects a dangling parent and a self-parent", () => {
      expect(() =>
        validateFsvLines([
          { lineCode: "A", accountId: null, parentLineCode: "Z", statementType: "balance_sheet" },
        ]),
      ).toThrow(/does not exist/);
      expect(() =>
        validateFsvLines([
          { lineCode: "A", accountId: null, parentLineCode: "A", statementType: "balance_sheet" },
        ]),
      ).toThrow(/its own parent/);
    });

    it("rejects a parent cycle", () => {
      expect(() =>
        validateFsvLines([
          { lineCode: "A", accountId: null, parentLineCode: "B", statementType: "balance_sheet" },
          { lineCode: "B", accountId: null, parentLineCode: "A", statementType: "balance_sheet" },
        ]),
      ).toThrow(/cycle/);
    });

    it("accepts a well-formed hierarchy", () => {
      expect(() =>
        validateFsvLines([
          { lineCode: "A", accountId: null, parentLineCode: null, statementType: "balance_sheet" },
          { lineCode: "B", accountId: "acc-1", parentLineCode: "A", statementType: "balance_sheet" },
        ]),
      ).not.toThrow();
    });
  });

  describe("effective-dated resolution", () => {
    const member = (from: string, to: string | null) => ({
      id: `${from}-${to}`,
      tenantId: "t",
      groupId: "g",
      legalEntityId: "le",
      effectiveFrom: from,
      effectiveTo: to,
      createdAt: "2026-01-01T00:00:00Z",
    });

    it("treats a membership as [from, to) so a leaver is out on the day they leave", () => {
      const rows = [member("2026-01-01", "2026-02-01")];
      expect(resolveMembers(rows, "2026-01-31")).toHaveLength(1);
      expect(resolveMembers(rows, "2026-02-01")).toHaveLength(0);
    });

    it("keeps an open membership in force indefinitely", () => {
      expect(resolveMembers([member("2026-01-01", null)], "2099-12-31")).toHaveLength(1);
    });

    it("resolves a superseded FSV version for a date it covered", () => {
      const versions: FsvVersion[] = [
        {
          id: "v1",
          tenantId: "t",
          fsvCode: "FSV",
          versionNumber: 1,
          description: null,
          status: "superseded",
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-06-30",
          workflowInstanceId: null,
          approvedBy: null,
          approvedAt: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "v2",
          tenantId: "t",
          fsvCode: "FSV",
          versionNumber: 2,
          description: null,
          status: "approved",
          effectiveFrom: "2026-07-01",
          effectiveTo: null,
          workflowInstanceId: null,
          approvedBy: null,
          approvedAt: null,
          createdAt: "2026-07-01T00:00:00Z",
        },
      ];
      // A back-dated report must still find the version that was in force then.
      expect(resolveFsvVersion(versions, "2026-03-15")?.id).toBe("v1");
      expect(resolveFsvVersion(versions, "2026-09-15")?.id).toBe("v2");
    });

    it("never resolves a draft version", () => {
      const draft: FsvVersion[] = [
        {
          id: "v1",
          tenantId: "t",
          fsvCode: "FSV",
          versionNumber: 1,
          description: null,
          status: "draft",
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          workflowInstanceId: null,
          approvedBy: null,
          approvedAt: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      expect(resolveFsvVersion(draft, "2026-03-15")).toBeNull();
    });

    it("only resolves an active rate set", () => {
      const sets: FxRateSet[] = [
        {
          id: "s1",
          tenantId: "t",
          setCode: "S1",
          name: "Archived",
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          status: "archived",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      expect(resolveRateSet(sets, "2026-03-15")).toBeNull();
    });

    it("does not derive an inverse rate", () => {
      const rates: FxRate[] = [
        {
          id: "r1",
          tenantId: "t",
          rateSetId: "s",
          fromCurrency: "USD",
          toCurrency: "IDR",
          rateType: "closing",
          rate: "16000.00000000",
        },
      ];
      expect(resolveRate(rates, "USD", "IDR", "closing")?.id).toBe("r1");
      // ADR-0022: an inverse is a spread decision, not arithmetic.
      expect(resolveRate(rates, "IDR", "USD", "closing")).toBeNull();
      // And the rate type is part of the identity.
      expect(resolveRate(rates, "USD", "IDR", "average")).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Service — group lifecycle
  // ------------------------------------------------------------------

  describe("group lifecycle", () => {
    it("creates a group as draft and opens a Workflow Instance", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      const group = await service.createGroup(configure, {
        groupCode: "GRP-LIFECYCLE",
        name: "Lifecycle Group",
        reportingCurrency: "IDR",
      });
      expect(group.status).toBe("draft");
      expect(group.workflowInstanceId).toBeTruthy();
      expect(group.reportingCurrency).toBe("IDR");
    });

    it("leaves the Instance unstamped: a consolidation group is tenant-level (no owning unit / Legal Entity)", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      const group = await service.createGroup(configure, {
        groupCode: "GRP-TENANT-LEVEL",
        name: "Tenant-level Group",
        reportingCurrency: "IDR",
      });
      const r = await pool.query(`SELECT context_data FROM workflow_instances WHERE id = $1`, [
        group.workflowInstanceId,
      ]);
      expect(r.rows[0].context_data.organizationUnitId).toBeUndefined();
      expect(r.rows[0].context_data.legalEntityId).toBeUndefined();
      expect(r.rows[0].context_data.groupCode).toBe("GRP-TENANT-LEVEL");
    });

    it("refuses a reporting currency that is not a 3-letter ISO code", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      await expect(
        service.createGroup(configure, {
          groupCode: "GRP-BAD-CCY",
          name: "Bad",
          reportingCurrency: "idr",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("refuses membership on a group nobody approved", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      const group = await service.createGroup(configure, {
        groupCode: "GRP-UNAPPROVED",
        name: "Unapproved",
        reportingCurrency: "IDR",
      });
      await expect(
        service.addMember(configure, group.id, {
          legalEntityId,
          effectiveFrom: "2026-01-01",
        }),
      ).rejects.toThrow(/active consolidation group/);
    });

    it("activates only after approval, then accepts membership", async () => {
      const { group } = await activeGroupWithMember();
      expect(group.id).toBeTruthy();
      const read = await actorWith(["finance.accounting.read"]);
      const members = await service.listMembers(read, group.id);
      expect(members).toHaveLength(1);
      expect(members[0].legalEntityId).toBe(legalEntityId);
      expect(members[0].effectiveTo).toBeNull();
    });

    it("closes the previous membership when the same entity is added again", async () => {
      const { group, configure } = await activeGroupWithMember();
      await service.addMember(configure, group.id, {
        legalEntityId,
        effectiveFrom: "2026-04-01",
      });
      const read = await actorWith(["finance.accounting.read"]);
      const members = await service.listMembers(read, group.id);
      expect(members).toHaveLength(2);
      const open = members.filter((m) => m.effectiveTo === null);
      expect(open).toHaveLength(1);
      expect(open[0].effectiveFrom).toBe("2026-04-01");
      const closed = members.find((m) => m.effectiveTo !== null);
      // [from, to) — the old row ends the day the new one starts.
      expect(closed?.effectiveTo).toBe("2026-04-01");
    });

    it("requires approve permission to act on the workflow", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      const group = await service.createGroup(configure, {
        groupCode: "GRP-PERM",
        name: "Perm",
        reportingCurrency: "IDR",
      });
      await expect(service.actOnGroup(configure, group.id, "approve", null)).rejects.toThrow(
        /permission/i,
      );
    });
  });

  // ------------------------------------------------------------------
  // Service — FSV and rate sets
  // ------------------------------------------------------------------

  describe("FSV versions and rate sets", () => {
    it("approves an FSV version and supersedes the prior one", async () => {
      const first = await approvedFsv();
      expect(first.version.status).toBe("approved");

      const configure = await actorWith(["finance.accounting.configure"]);
      const second = await service.createFsvVersion(configure, {
        fsvCode: first.version.fsvCode,
        effectiveFrom: "2026-07-01",
        lines: [
          { lineCode: "L1", lineName: "Line one", statementType: "balance_sheet", accountId: debitAccountId },
        ],
      });
      expect(second.version.versionNumber).toBe(2);

      const approve = await actorWith(["finance.accounting.approve"]);
      outcomeStatus = "approved";
      await service.actOnFsvVersion(approve, second.version.id, "approve", null);

      const read = await actorWith(["finance.accounting.read"]);
      const versions = await service.listFsvVersions(read, first.version.fsvCode);
      const prior = versions.find((v) => v.id === first.version.id);
      expect(prior?.status).toBe("superseded");
      expect(prior?.effectiveTo).toBe("2026-07-01");
    });

    it("rejects an FSV with a duplicate line code before writing anything", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      await expect(
        service.createFsvVersion(configure, {
          fsvCode: "FSV-DUP",
          effectiveFrom: "2026-01-01",
          lines: [
            { lineCode: "X", lineName: "one", statementType: "balance_sheet", accountId: debitAccountId },
            { lineCode: "X", lineName: "two", statementType: "balance_sheet", accountId: creditAccountId },
          ],
        }),
      ).rejects.toThrow(/Duplicate/);
    });

    it("rejects a rate set that prices a currency against itself", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      await expect(
        service.createRateSet(configure, {
          setCode: "RS-SELF",
          name: "Self",
          effectiveFrom: "2026-01-01",
          rates: [
            { fromCurrency: "USD", toCurrency: "USD", rateType: "closing", rate: "1.00000000" },
          ],
        }),
      ).rejects.toThrow(/against itself/);
    });

    it("rejects a duplicate rate triple and a non-positive rate", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      await expect(
        service.createRateSet(configure, {
          setCode: "RS-DUP",
          name: "Dup",
          effectiveFrom: "2026-01-01",
          rates: [
            { fromCurrency: "USD", toCurrency: "IDR", rateType: "closing", rate: "16000.00000000" },
            { fromCurrency: "USD", toCurrency: "IDR", rateType: "closing", rate: "16001.00000000" },
          ],
        }),
      ).rejects.toThrow(/Duplicate rate/);
      await expect(
        service.createRateSet(configure, {
          setCode: "RS-ZERO",
          name: "Zero",
          effectiveFrom: "2026-01-01",
          rates: [
            { fromCurrency: "USD", toCurrency: "IDR", rateType: "closing", rate: "0.00000000" },
          ],
        }),
      ).rejects.toThrow(/positive decimal/);
    });
  });

  // ------------------------------------------------------------------
  // Service — translation
  // ------------------------------------------------------------------

  describe("translation", () => {
    it("translates each member at the rate for its statement, storing the rate used", async () => {
      const { group } = await activeGroupWithMember("IDR");
      const configure2 = await actorWith(["finance.accounting.configure"]);
      await service.addMember(configure2, group.id, {
        legalEntityId: foreignEntityId,
        effectiveFrom: "2026-01-01",
      });

      await postJournal(legalEntityId, periodId, "IDR", debitAccountId, creditAccountId, "1000.00", "idr-1");
      await postJournal(
        foreignEntityId,
        foreignPeriodId,
        "USD",
        foreignDebitAccountId,
        foreignCreditAccountId,
        "100.00",
        "usd-1",
      );

      const configure = await actorWith(["finance.accounting.configure"]);
      const rateSet = await service.createRateSet(configure, {
        setCode: "RS-TRANSLATE",
        name: "Translate",
        effectiveFrom: "2026-01-01",
        rates: [
          { fromCurrency: "USD", toCurrency: "IDR", rateType: "closing", rate: "16000.00000000" },
        ],
      });

      // Both members' debit accounts, so the translated total is a sum of two
      // different currencies rather than a balanced pair netting to zero.
      const fsv = await approvedFsv("balance_sheet", [debitAccountId, foreignDebitAccountId]);
      const run = await service.translate(configure, {
        groupId: group.id,
        periodId,
        rateSetId: rateSet.set.id,
        fsvVersionId: fsv.version.id,
        asOf: "2026-01-31",
        idempotencyKey: "tr-1",
      });

      const idrLine = run.lines.find((l) => l.legalEntityId === legalEntityId);
      const usdLine = run.lines.find((l) => l.legalEntityId === foreignEntityId);
      expect(idrLine?.sourceAmount).toBe("1000.00");
      expect(idrLine?.rate).toBe("1.00000000");
      expect(idrLine?.translatedAmount).toBe("1000.00");
      expect(usdLine?.sourceAmount).toBe("100.00");
      expect(usdLine?.rate).toBe("16000.00000000");
      expect(usdLine?.translatedAmount).toBe("1600000.00");
      // Both members' debit legs, summed in the reporting currency.
      expect(run.run.translatedTotal).toBe("1601000.00");
      expect(run.run.reportingCurrency).toBe("IDR");
    });

    it("refuses a missing rate instead of silently using 1:1", async () => {
      const { group } = await activeGroupWithMember("IDR");
      const configure2 = await actorWith(["finance.accounting.configure"]);
      await service.addMember(configure2, group.id, {
        legalEntityId: foreignEntityId,
        effectiveFrom: "2026-01-01",
      });
      await postJournal(
        foreignEntityId,
        foreignPeriodId,
        "USD",
        foreignDebitAccountId,
        foreignCreditAccountId,
        "50.00",
        "usd-2",
      );

      const configure = await actorWith(["finance.accounting.configure"]);
      // A set that prices EUR, so the USD pair this run needs is genuinely absent.
      const rateSet = await service.createRateSet(configure, {
        setCode: "RS-EUR-ONLY",
        name: "EUR only",
        effectiveFrom: "2026-01-01",
        rates: [
          { fromCurrency: "EUR", toCurrency: "IDR", rateType: "closing", rate: "17000.00000000" },
        ],
      });
      // The foreign account must be mapped, otherwise the run skips the USD fact
      // and never reaches the missing-rate check at all.
      const fsv = await approvedFsv("balance_sheet", [debitAccountId, foreignDebitAccountId]);
      await expect(
        service.translate(configure, {
          groupId: group.id,
          periodId,
          rateSetId: rateSet.set.id,
          fsvVersionId: fsv.version.id,
          asOf: "2026-01-31",
          idempotencyKey: "tr-missing-rate",
        }),
      ).rejects.toThrow(/No closing rate from USD to IDR/);
    });

    it("replays a run for the same idempotency key instead of writing a second one", async () => {
      const { group } = await activeGroupWithMember("IDR");
      await postJournal(legalEntityId, periodId, "IDR", debitAccountId, creditAccountId, "700.00", "idr-2");
      const configure = await actorWith(["finance.accounting.configure"]);
      const rateSet = await service.createRateSet(configure, {
        setCode: "RS-REPLAY",
        name: "Replay",
        effectiveFrom: "2026-01-01",
        rates: [],
      });
      const fsv = await approvedFsv("balance_sheet");
      const first = await service.translate(configure, {
        groupId: group.id,
        periodId,
        rateSetId: rateSet.set.id,
        fsvVersionId: fsv.version.id,
        asOf: "2026-01-31",
        idempotencyKey: "tr-replay",
      });
      const second = await service.translate(configure, {
        groupId: group.id,
        periodId,
        rateSetId: rateSet.set.id,
        fsvVersionId: fsv.version.id,
        asOf: "2026-01-31",
        idempotencyKey: "tr-replay",
      });
      expect(second.run.id).toBe(first.run.id);
      expect(second.lines).toHaveLength(first.lines.length);
    });

    it("refuses to translate a group that is not active", async () => {
      const configure = await actorWith(["finance.accounting.configure"]);
      const group = await service.createGroup(configure, {
        groupCode: "GRP-DRAFT-TR",
        name: "Draft",
        reportingCurrency: "IDR",
      });
      const rateSet = await service.createRateSet(configure, {
        setCode: "RS-DRAFT-TR",
        name: "x",
        effectiveFrom: "2026-01-01",
        rates: [],
      });
      const fsv = await approvedFsv("balance_sheet");
      await expect(
        service.translate(configure, {
          groupId: group.id,
          periodId,
          rateSetId: rateSet.set.id,
          fsvVersionId: fsv.version.id,
          asOf: "2026-01-31",
          idempotencyKey: "tr-draft",
        }),
      ).rejects.toThrow(/active consolidation group/);
    });
  });

  // ------------------------------------------------------------------
  // Service — eliminations go through the kernel
  // ------------------------------------------------------------------

  describe("eliminations", () => {
    it("posts the elimination journal through the kernel, never into the GL directly", async () => {
      const { group, configure } = await activeGroupWithMember("IDR");
      draftedJournals = [];
      postedJournalIds = [];

      const elimination = await service.createElimination(configure, {
        groupId: group.id,
        periodId,
        description: "Intercompany receivable/payable",
        amount: "250.00",
        currency: "IDR",
        idempotencyKey: "elim-1",
      });
      expect(elimination.status).toBe("draft");

      const approve = await actorWith(["finance.accounting.approve"]);
      outcomeStatus = "approved";
      const posted = await service.actOnElimination(approve, elimination.id, {
        actionCode: "approve",
        comment: "ok",
        debitAccountId: creditAccountId,
        creditAccountId: debitAccountId,
        legalEntityId,
        journalDate: "2026-01-31",
      });

      expect(posted.status).toBe("posted");
      expect(posted.journalId).toBeTruthy();
      // ADR-0023: the draft and the post both happened on the kernel port.
      expect(draftedJournals).toHaveLength(1);
      expect(draftedJournals[0].input.idempotencyKey).toBe(`elim-${elimination.id}`);
      expect(postedJournalIds).toEqual([posted.journalId]);
      // Nothing was written straight into journal_headers by this module.
      const direct = await pool.query(
        `SELECT count(*)::int AS n FROM journal_headers WHERE tenant_id = $1 AND journal_number LIKE 'ELIM-%'`,
        [tenantId],
      );
      expect(direct.rows[0].n).toBe(0);
    });

    it("refuses a non-positive elimination amount", async () => {
      const { group, configure } = await activeGroupWithMember("IDR");
      await expect(
        service.createElimination(configure, {
          groupId: group.id,
          periodId,
          description: "bad",
          amount: "0.00",
          currency: "IDR",
          idempotencyKey: "elim-zero",
        }),
      ).rejects.toThrow(/positive 2-decimal/);
    });

    it("does not post when the workflow rejects the elimination", async () => {
      const { group, configure } = await activeGroupWithMember("IDR");
      draftedJournals = [];
      postedJournalIds = [];
      const elimination = await service.createElimination(configure, {
        groupId: group.id,
        periodId,
        description: "rejected one",
        amount: "100.00",
        currency: "IDR",
        idempotencyKey: "elim-rejected",
      });
      const approve = await actorWith(["finance.accounting.approve"]);
      outcomeStatus = "rejected";
      const result = await service.actOnElimination(approve, elimination.id, {
        actionCode: "reject",
        comment: "no",
        debitAccountId: creditAccountId,
        creditAccountId: debitAccountId,
        legalEntityId,
        journalDate: "2026-01-31",
      });
      expect(result.status).toBe("draft");
      expect(draftedJournals).toHaveLength(0);
      expect(postedJournalIds).toHaveLength(0);
      outcomeStatus = "approved";
    });
  });
});
