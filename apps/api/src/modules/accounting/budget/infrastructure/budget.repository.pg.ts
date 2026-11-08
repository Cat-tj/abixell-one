import type { Pool, PoolClient } from "pg";
import {
  type BudgetConsumption,
  type BudgetConsumptionKind,
  type BudgetControlEffect,
  type BudgetDimensionScope,
  type BudgetLine,
  type BudgetPeriodUtilization,
  type BudgetPolicy,
  type BudgetScenario,
  type BudgetUtilization,
  type BudgetVersion,
  type BudgetVersionStatus,
  type FinanceBudget,
  addAmounts,
  distributeTotal,
  fromUnits,
  policyRank,
  toUnits,
} from "../domain/budget.entity.js";

type Row = Record<string, unknown>;

/** Thrown when a budget write violates a closed invariant. */
export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

function toDateStr(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toBudget(row: Row): FinanceBudget {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    legalEntityId: String(row.legal_entity_id),
    fiscalYearCode: String(row.fiscal_year_code),
    scenario: row.scenario as BudgetScenario,
    currency: String(row.currency),
    name: String(row.name),
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    costCenterId: (row.cost_center_id as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    siteId: (row.site_id as string | null) ?? null,
    accountFrom: (row.account_from as string | null) ?? null,
    accountTo: (row.account_to as string | null) ?? null,
    activeVersionId: (row.active_version_id as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function toVersion(row: Row): BudgetVersion {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    budgetId: String(row.budget_id),
    versionNumber: Number(row.version_number),
    status: row.status as BudgetVersionStatus,
    supersedesVersionId: (row.supersedes_version_id as string | null) ?? null,
    workflowInstanceId: (row.workflow_instance_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    approvedBy: (row.approved_by as string | null) ?? null,
    approvedAt: row.approved_at ? (row.approved_at as Date).toISOString() : null,
  };
}

function toPolicy(row: Row): BudgetPolicy {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    legalEntityId: String(row.legal_entity_id),
    effect: row.effect as BudgetControlEffect,
    documentType: (row.document_type as string | null) ?? null,
    costCenterId: (row.cost_center_id as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    accountFrom: (row.account_from as string | null) ?? null,
    accountTo: (row.account_to as string | null) ?? null,
    amountThreshold: row.amount_threshold === null ? null : String(row.amount_threshold),
    effectiveFrom: toDateStr(row.effective_from),
    effectiveTo: row.effective_to ? toDateStr(row.effective_to) : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function toConsumption(row: Row): BudgetConsumption {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    budgetVersionId: String(row.budget_version_id),
    periodCode: String(row.period_code),
    kind: row.kind as BudgetConsumptionKind,
    amount: String(row.amount),
    sourceRefTable: (row.source_ref_table as string | null) ?? null,
    sourceRefId: (row.source_ref_id as string | null) ?? null,
    idempotencyKey: String(row.idempotency_key),
    reversesId: (row.reverses_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export class PgBudgetRepository {
  constructor(private readonly pool: Pool) {}

  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // Budgets
  // ------------------------------------------------------------------

  async createBudget(input: {
    tenantId: string;
    legalEntityId: string;
    fiscalYearCode: string;
    scenario: BudgetScenario;
    currency: string;
    name: string;
    ownerUserId: string | null;
    scope: BudgetDimensionScope;
    createdBy: string | null;
  }): Promise<FinanceBudget> {
    const r = await this.pool.query(
      `INSERT INTO finance_budgets
         (tenant_id, legal_entity_id, fiscal_year_code, scenario, currency, name,
          owner_user_id, cost_center_id, project_id, site_id, account_from, account_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        input.tenantId,
        input.legalEntityId,
        input.fiscalYearCode,
        input.scenario,
        input.currency,
        input.name,
        input.ownerUserId,
        input.scope.costCenterId,
        input.scope.projectId,
        input.scope.siteId,
        input.scope.accountFrom,
        input.scope.accountTo,
        input.createdBy,
      ],
    );
    return toBudget(r.rows[0]);
  }

  async findBudgetById(tenantId: string, id: string): Promise<FinanceBudget | null> {
    const r = await this.pool.query(`SELECT * FROM finance_budgets WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return r.rows.length > 0 ? toBudget(r.rows[0]) : null;
  }

  /** The Organization Unit a cost center is placed in (finance_cost_centers.org_unit_id),
   * or null. Narrow read used to stamp the owning unit on the budget approval Instance. */
  async findCostCenterOrganizationUnitId(tenantId: string, costCenterId: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT org_unit_id FROM finance_cost_centers WHERE id = $1 AND tenant_id = $2`,
      [costCenterId, tenantId],
    );
    return r.rows.length > 0 ? ((r.rows[0].org_unit_id as string | null) ?? null) : null;
  }

  async listBudgets(
    tenantId: string,
    filter: { legalEntityId?: string; fiscalYearCode?: string; scenario?: BudgetScenario },
  ): Promise<FinanceBudget[]> {
    const clauses = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (filter.legalEntityId) {
      params.push(filter.legalEntityId);
      clauses.push(`legal_entity_id = $${params.length}`);
    }
    if (filter.fiscalYearCode) {
      params.push(filter.fiscalYearCode);
      clauses.push(`fiscal_year_code = $${params.length}`);
    }
    if (filter.scenario) {
      params.push(filter.scenario);
      clauses.push(`scenario = $${params.length}`);
    }
    const r = await this.pool.query(
      `SELECT * FROM finance_budgets WHERE ${clauses.join(" AND ")} ORDER BY fiscal_year_code, name`,
      params,
    );
    return r.rows.map(toBudget);
  }

  // ------------------------------------------------------------------
  // Versions (immutable once approved)
  // ------------------------------------------------------------------

  async nextVersionNumber(budgetId: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM finance_budget_versions WHERE budget_id = $1`,
      [budgetId],
    );
    return Number(r.rows[0].next);
  }

  async createVersion(input: {
    tenantId: string;
    budgetId: string;
    supersedesVersionId: string | null;
    note: string | null;
    lines: { periodCode: string; amount: string }[];
    createdBy: string | null;
  }): Promise<BudgetVersion> {
    return this.inTransaction(async (client) => {
      const versionNumber = await this.nextVersionNumber(input.budgetId);
      const v = await client.query(
        `INSERT INTO finance_budget_versions
           (tenant_id, budget_id, version_number, status, supersedes_version_id, note, created_by)
         VALUES ($1,$2,$3,'draft',$4,$5,$6)
         RETURNING *`,
        [input.tenantId, input.budgetId, versionNumber, input.supersedesVersionId, input.note, input.createdBy],
      );
      const version = toVersion(v.rows[0]);
      for (const line of input.lines) {
        await client.query(
          `INSERT INTO finance_budget_lines (tenant_id, budget_version_id, period_code, amount)
           VALUES ($1,$2,$3,$4::numeric)`,
          [input.tenantId, version.id, line.periodCode, line.amount],
        );
      }
      return version;
    });
  }

  /** Distribute a total across weighted periods, then persist the version. */
  async createVersionDistributed(input: {
    tenantId: string;
    budgetId: string;
    supersedesVersionId: string | null;
    note: string | null;
    totalAmount: string;
    weights: { periodCode: string; weight: string }[];
    createdBy: string | null;
  }): Promise<BudgetVersion> {
    const lines = distributeTotal(input.totalAmount, input.weights);
    if (!lines) throw new BudgetError("Period weights must be non-negative and sum to a positive value");
    return this.createVersion({ ...input, lines });
  }

  async findVersionById(tenantId: string, id: string): Promise<BudgetVersion | null> {
    const r = await this.pool.query(
      `SELECT * FROM finance_budget_versions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return r.rows.length > 0 ? toVersion(r.rows[0]) : null;
  }

  async listVersions(tenantId: string, budgetId: string): Promise<BudgetVersion[]> {
    const r = await this.pool.query(
      `SELECT * FROM finance_budget_versions WHERE tenant_id = $1 AND budget_id = $2 ORDER BY version_number`,
      [tenantId, budgetId],
    );
    return r.rows.map(toVersion);
  }

  async listLines(tenantId: string, versionId: string): Promise<BudgetLine[]> {
    const r = await this.pool.query(
      `SELECT * FROM finance_budget_lines WHERE tenant_id = $1 AND budget_version_id = $2 ORDER BY period_code`,
      [tenantId, versionId],
    );
    return r.rows.map((row: Row) => ({
      id: String(row.id),
      budgetVersionId: String(row.budget_version_id),
      periodCode: String(row.period_code),
      amount: String(row.amount),
    }));
  }

  async setVersionWorkflowInstance(tenantId: string, versionId: string, instanceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE finance_budget_versions SET workflow_instance_id = $3 WHERE id = $2 AND tenant_id = $1`,
      [tenantId, versionId, instanceId],
    );
  }

  /**
   * draft → active (ADR-0020 §2). The previous active version becomes
   * `superseded` and is never edited. Fail-closed on the one-active invariant.
   */
  async activateVersion(
    tenantId: string,
    versionId: string,
    approvedBy: string | null,
  ): Promise<BudgetVersion | null> {
    return this.inTransaction(async (client) => {
      const current = await client.query(
        `SELECT * FROM finance_budget_versions WHERE id = $2 AND tenant_id = $1 FOR UPDATE`,
        [tenantId, versionId],
      );
      if (current.rows.length === 0) return null;
      const version = current.rows[0] as Row;
      if (version.status !== "draft") {
        throw new BudgetError(`Only a draft version can be approved (current status: ${String(version.status)})`);
      }
      await client.query(
        `UPDATE finance_budget_versions SET status = 'superseded'
          WHERE tenant_id = $1 AND budget_id = $2 AND status = 'active'`,
        [tenantId, version.budget_id],
      );
      const r = await client.query(
        `UPDATE finance_budget_versions
            SET status = 'active', approved_by = $3, approved_at = now()
          WHERE id = $2 AND tenant_id = $1 AND status = 'draft'
          RETURNING *`,
        [tenantId, versionId, approvedBy],
      );
      if (r.rows.length === 0) return null;
      await client.query(`UPDATE finance_budgets SET active_version_id = $3 WHERE id = $2 AND tenant_id = $1`, [
        tenantId,
        version.budget_id,
        versionId,
      ]);
      return toVersion(r.rows[0]);
    });
  }

  async rejectVersion(tenantId: string, versionId: string): Promise<BudgetVersion | null> {
    const r = await this.pool.query(
      `UPDATE finance_budget_versions SET status = 'rejected'
        WHERE id = $2 AND tenant_id = $1 AND status = 'draft'
        RETURNING *`,
      [tenantId, versionId],
    );
    return r.rows.length > 0 ? toVersion(r.rows[0]) : null;
  }

  // ------------------------------------------------------------------
  // Policies (ADR-0020 §3)
  // ------------------------------------------------------------------

  async createPolicy(input: Omit<BudgetPolicy, "id" | "createdAt">): Promise<BudgetPolicy> {
    const r = await this.pool.query(
      `INSERT INTO finance_budget_policies
         (tenant_id, legal_entity_id, effect, document_type, cost_center_id, project_id,
          account_from, account_to, amount_threshold, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::date,$11::date,$12)
       RETURNING *`,
      [
        input.tenantId,
        input.legalEntityId,
        input.effect,
        input.documentType,
        input.costCenterId,
        input.projectId,
        input.accountFrom,
        input.accountTo,
        input.amountThreshold,
        input.effectiveFrom,
        input.effectiveTo,
        input.createdBy,
      ],
    );
    return toPolicy(r.rows[0]);
  }

  async listPolicies(tenantId: string, legalEntityId: string): Promise<BudgetPolicy[]> {
    const r = await this.pool.query(
      `SELECT * FROM finance_budget_policies
        WHERE tenant_id = $1 AND legal_entity_id = $2
        ORDER BY effective_from, created_at`,
      [tenantId, legalEntityId],
    );
    return r.rows.map(toPolicy);
  }

  /** Most specific effective policy for a proposed action. */
  selectPolicy(
    policies: BudgetPolicy[],
    match: {
      documentType: string | null;
      costCenterId: string | null;
      projectId: string | null;
      accountFrom: string | null;
      accountTo: string | null;
      amount: string;
      onDate: string;
    },
  ): BudgetPolicy | null {
    const amountUnits = toUnits(match.amount) ?? 0n;
    const candidates = policies.filter((p) => {
      if (p.effectiveFrom > match.onDate) return false;
      if (p.effectiveTo !== null && p.effectiveTo < match.onDate) return false;
      if (p.documentType !== null && p.documentType !== match.documentType) return false;
      if (p.costCenterId !== null && p.costCenterId !== match.costCenterId) return false;
      if (p.projectId !== null && p.projectId !== match.projectId) return false;
      if (p.accountFrom !== null && match.accountFrom !== null && p.accountFrom > match.accountFrom) return false;
      if (p.accountTo !== null && match.accountFrom !== null && p.accountTo < match.accountFrom) return false;
      if (p.amountThreshold !== null) {
        const threshold = toUnits(p.amountThreshold);
        if (threshold !== null && amountUnits < threshold) return false;
      }
      return true;
    });
    candidates.sort((a, b) => {
      const rankDelta = policyRank(b) - policyRank(a);
      if (rankDelta !== 0) return rankDelta;
      if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    return candidates[0] ?? null;
  }

  // ------------------------------------------------------------------
  // Consumption (ADR-0020 §4) — idempotent, concurrency-safe
  // ------------------------------------------------------------------

  /**
   * Consumption rows belong to the governed BUDGET, not to one baseline
   * version (ADR-0020 §4): actuals and commitments are facts about the budget
   * scope. A revision re-plans the baseline and must not wipe that history, so
   * every aggregation below joins through `finance_budget_versions` on
   * `budget_id`. Scoping a sum to the active version alone would make the
   * hard-stop control fail OPEN the moment a revision supersedes v1.
   */
  private static readonly CONSUMED_EXPR = `
    COALESCE(SUM(CASE
      WHEN c.kind = 'actual' THEN c.amount
      WHEN c.kind = 'commitment' THEN c.amount
      WHEN c.kind = 'adjustment' THEN c.amount
      ELSE -c.amount
    END), 0)::text`;

  async recordConsumption(input: {
    tenantId: string;
    budgetVersionId: string;
    periodCode: string;
    kind: BudgetConsumptionKind;
    amount: string;
    sourceRefTable: string | null;
    sourceRefId: string | null;
    idempotencyKey: string;
    reversesId: string | null;
    note: string | null;
    createdBy: string | null;
  }): Promise<BudgetConsumption> {
    return this.inTransaction(async (client) => {
      const idem = await client.query(
        `SELECT * FROM finance_budget_consumptions WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (idem.rows.length > 0) return toConsumption(idem.rows[0]);

      const r = await client.query(
        `INSERT INTO finance_budget_consumptions
           (tenant_id, budget_version_id, period_code, kind, amount,
            source_ref_table, source_ref_id, idempotency_key, reverses_id, note, created_by)
         VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.tenantId,
          input.budgetVersionId,
          input.periodCode,
          input.kind,
          input.amount,
          input.sourceRefTable,
          input.sourceRefId,
          input.idempotencyKey,
          input.reversesId,
          input.note,
          input.createdBy,
        ],
      );
      if (r.rows.length > 0) return toConsumption(r.rows[0]);
      const again = await client.query(
        `SELECT * FROM finance_budget_consumptions WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      return toConsumption(again.rows[0]);
    });
  }

  /** Compensating release for a previous consumption row (never a delete). */
  async releaseConsumption(input: {
    tenantId: string;
    consumptionId: string;
    idempotencyKey: string;
    note: string | null;
    createdBy: string | null;
  }): Promise<BudgetConsumption> {
    return this.inTransaction(async (client) => {
      const original = await client.query(
        `SELECT * FROM finance_budget_consumptions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.consumptionId, input.tenantId],
      );
      if (original.rows.length === 0) throw new BudgetError("Consumption not found in this tenant");
      const orig = original.rows[0] as Row;
      if (orig.reverses_id) throw new BudgetError("A release cannot itself be released");

      const already = await client.query(
        `SELECT * FROM finance_budget_consumptions WHERE tenant_id = $1 AND reverses_id = $2`,
        [input.tenantId, input.consumptionId],
      );
      if (already.rows.length > 0) return toConsumption(already.rows[0]);

      const r = await client.query(
        `INSERT INTO finance_budget_consumptions
           (tenant_id, budget_version_id, period_code, kind, amount,
            source_ref_table, source_ref_id, idempotency_key, reverses_id, note, created_by)
         VALUES ($1,$2,$3,'release',$4::numeric,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          input.tenantId,
          orig.budget_version_id,
          orig.period_code,
          String(orig.amount),
          orig.source_ref_table,
          orig.source_ref_id,
          input.idempotencyKey,
          input.consumptionId,
          input.note,
          input.createdBy,
        ],
      );
      return toConsumption(r.rows[0]);
    });
  }

  /** Utilization projection per period (ADR-0020 §4). Never stored. */
  async utilization(
    tenantId: string,
    budgetId: string,
    versionId: string | null,
  ): Promise<BudgetUtilization> {
    const budget = await this.findBudgetById(tenantId, budgetId);
    if (!budget) throw new BudgetError("Budget not found in this tenant");
    let effectiveVersionId = versionId ?? budget.activeVersionId;
    if (!effectiveVersionId) {
      // No active version: baseline is zero for every period that exists on
      // the latest draft, or empty — reported honestly, never invented.
      const versions = await this.listVersions(tenantId, budgetId);
      effectiveVersionId = versions.length > 0 ? versions[versions.length - 1]!.id : null;
    }

    const periods = new Map<string, BudgetPeriodUtilization>();
    if (effectiveVersionId) {
      const lines = await this.listLines(tenantId, effectiveVersionId);
      for (const line of lines) {
        periods.set(line.periodCode, {
          periodCode: line.periodCode,
          baseline: line.amount,
          actual: "0.0000",
          committed: "0.0000",
          released: "0.0000",
          adjustments: "0.0000",
          available: line.amount,
          variance: "0.0000",
        });
      }
    }

    // Every version's rows, not just the effective one: the baseline is
    // re-planned by a revision, the facts it is measured against are not.
    const consumed = await this.pool.query(
      `SELECT c.* FROM finance_budget_consumptions c
         JOIN finance_budget_versions v
           ON v.id = c.budget_version_id AND v.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND v.budget_id = $2
        ORDER BY c.period_code, c.created_at`,
      [tenantId, budgetId],
    );

    for (const row of consumed.rows as Row[]) {
      const periodCode = String(row.period_code);
      const entry =
        periods.get(periodCode) ??
        ({
          periodCode,
          baseline: "0.0000",
          actual: "0.0000",
          committed: "0.0000",
          released: "0.0000",
          adjustments: "0.0000",
          available: "0.0000",
          variance: "0.0000",
        } satisfies BudgetPeriodUtilization);
      const amount = String(row.amount);
      const isReversal = row.reverses_id !== null;
      if (row.kind === "actual") {
        entry.actual = addAmounts(entry.actual, isReversal ? `-${amount}` : amount) ?? entry.actual;
      } else if (row.kind === "commitment") {
        entry.committed = addAmounts(entry.committed, isReversal ? `-${amount}` : amount) ?? entry.committed;
      } else if (row.kind === "adjustment") {
        entry.adjustments = addAmounts(entry.adjustments, isReversal ? `-${amount}` : amount) ?? entry.adjustments;
      } else {
        entry.released = addAmounts(entry.released, amount) ?? entry.released;
      }
      periods.set(periodCode, entry);
    }

    for (const entry of periods.values()) {
      const spent = toUnits(entry.actual) ?? 0n;
      const committed = toUnits(entry.committed) ?? 0n;
      const released = toUnits(entry.released) ?? 0n;
      const adjustments = toUnits(entry.adjustments) ?? 0n;
      const baseline = toUnits(entry.baseline) ?? 0n;
      // available = baseline + adjustments - actual - commitment + released
      const available = baseline + adjustments - spent - committed + released;
      entry.available = fromUnits(available);
      entry.variance = available < 0n ? fromUnits(-available) : "0.0000";
    }

    const entries = [...periods.values()].sort((a, b) => (a.periodCode < b.periodCode ? -1 : 1));
    const sumField = (pick: (e: BudgetPeriodUtilization) => string): string =>
      entries.reduce((acc, e) => addAmounts(acc, pick(e)) ?? acc, "0.0000");
    const total = {
      baseline: sumField((e) => e.baseline),
      actual: sumField((e) => e.actual),
      committed: sumField((e) => e.committed),
      released: sumField((e) => e.released),
      adjustments: sumField((e) => e.adjustments),
      available: sumField((e) => e.available),
      variance: sumField((e) => e.variance),
    };

    return {
      budgetId,
      versionId: effectiveVersionId,
      currency: budget.currency,
      periods: entries,
      total,
    };
  }

  /**
   * Availability check + (optionally) the commitment row, under row locks on
   * the budget version so concurrent commitments serialize (ADR-0020 §4).
   * Fail-closed: a hard_stop refuses rather than overspending.
   */
  async consumeWithCheck(input: {
    tenantId: string;
    budgetId: string;
    periodCode: string;
    amount: string;
    kind: BudgetConsumptionKind;
    policy: BudgetPolicy | null;
    sourceRefTable: string | null;
    sourceRefId: string | null;
    idempotencyKey: string;
    note: string | null;
    createdBy: string | null;
  }): Promise<{
    consumption: BudgetConsumption | null;
    decision: "ok" | "variance" | "escalate" | "blocked";
    availableBefore: string;
    availableAfter: string;
    variance: string;
  }> {
    return this.inTransaction(async (client) => {
      const budget = await client.query(
        `SELECT * FROM finance_budgets WHERE id = $2 AND tenant_id = $1 FOR UPDATE`,
        [input.tenantId, input.budgetId],
      );
      if (budget.rows.length === 0) throw new BudgetError("Budget not found in this tenant");
      const budgetRow = budget.rows[0] as Row;
      const versionId = budgetRow.active_version_id as string | null;
      if (!versionId) throw new BudgetError("Budget has no approved active version yet");

      const baselineRow = await client.query(
        `SELECT amount FROM finance_budget_lines
          WHERE tenant_id = $1 AND budget_version_id = $2 AND period_code = $3`,
        [input.tenantId, versionId, input.periodCode],
      );
      const baseline = toUnits(baselineRow.rows.length > 0 ? String(baselineRow.rows[0].amount) : "0.0000") ?? 0n;

      const consumed = await client.query(
        `SELECT ${PgBudgetRepository.CONSUMED_EXPR} AS consumed
           FROM finance_budget_consumptions c
           JOIN finance_budget_versions v
             ON v.id = c.budget_version_id AND v.tenant_id = c.tenant_id
          WHERE c.tenant_id = $1 AND v.budget_id = $2 AND c.period_code = $3`,
        [input.tenantId, input.budgetId, input.periodCode],
      );
      const consumedUnits = toUnits(String(consumed.rows[0].consumed)) ?? 0n;
      const availableBeforeUnits = baseline - consumedUnits;

      // Idempotent replay (ADR-0020 §4): the key was already consumed, so the
      // original row is inside `consumed`. Report it without re-applying the
      // amount — a retry must never double-spend or trip a hard_stop.
      const idem = await client.query(
        `SELECT * FROM finance_budget_consumptions WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey],
      );
      if (idem.rows.length > 0) {
        return {
          consumption: toConsumption(idem.rows[0]),
          decision: "ok",
          availableBefore: fromUnits(availableBeforeUnits),
          availableAfter: fromUnits(availableBeforeUnits),
          variance: "0.0000",
        };
      }

      const amountUnits = toUnits(input.amount);
      if (amountUnits === null || amountUnits <= 0n) {
        throw new BudgetError("Amount must be positive with at most 4 decimals");
      }
      const availableAfterUnits = availableBeforeUnits - amountUnits;

      const effect = input.policy?.effect ?? "advisory";
      let decision: "ok" | "variance" | "escalate" | "blocked" = "ok";
      if (availableAfterUnits < 0n) {
        if (effect === "hard_stop") {
          // Fail closed — never record the overspend (ADR-0020 §3).
          throw new BudgetError(
            `Hard-stop budget control: ${input.periodCode} available ${fromUnits(availableBeforeUnits)} is below the requested ${input.amount}`,
          );
        }
        decision = effect === "escalation" ? "escalate" : "variance";
      }

      const r = await client.query(
        `INSERT INTO finance_budget_consumptions
           (tenant_id, budget_version_id, period_code, kind, amount,
            source_ref_table, source_ref_id, idempotency_key, note, created_by)
         VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.tenantId,
          versionId,
          input.periodCode,
          input.kind,
          input.amount,
          input.sourceRefTable,
          input.sourceRefId,
          input.idempotencyKey,
          input.note,
          input.createdBy,
        ],
      );

      return {
        consumption: r.rows.length > 0 ? toConsumption(r.rows[0]) : null,
        decision,
        availableBefore: fromUnits(availableBeforeUnits),
        availableAfter: fromUnits(availableAfterUnits),
        variance: availableAfterUnits < 0n ? fromUnits(-availableAfterUnits) : "0.0000",
      };
    });
  }
}
