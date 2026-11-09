/** Wave A4 — headcount demand forecasting, budget gap analysis, simulation, and advisory actions. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type PositionRecord,
  type WorkforceManpowerGapEntry,
  type WorkforceManpowerPlan,
  type WorkforceManpowerPlanStatus,
} from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
import { PERMISSIONS } from "../../lib/capabilities";
import { useShell } from "../../shell/layout/AppShell";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, formatMoney } from "../../shared/format";

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function statusTone(status: WorkforceManpowerPlanStatus) {
  switch (status) {
    case "applied":
      return "success";
    case "computed":
      return "info";
    case "draft":
      return "neutral";
    case "dismissed":
      return "danger";
    default:
      return "neutral";
  }
}

function money(amount: number | string | null | undefined): string {
  if (amount == null) return "—";
  return formatMoney(String(amount));
}

export function WorkforcePlanningPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();

  const canManage = permissions.includes(PERMISSIONS.workforcePlanningManage);
  const canApply = permissions.includes(PERMISSIONS.workforcePlanningApply);

  const [plans, setPlans] = useState<WorkforceManpowerPlan[]>([]);
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<WorkforceManpowerPlanStatus | "">("");
  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));

  const [planTitle, setPlanTitle] = useState("");
  const [planYear, setPlanYear] = useState(String(new Date().getFullYear()));
  const [planUnitId, setPlanUnitId] = useState("");

  const [targetByPosition, setTargetByPosition] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [posList, planList] = await Promise.all([
        api.positions(token).catch(() => [] as PositionRecord[]),
        api.workforceManpowerPlans(token, {
          planYear: Number(yearFilter) || undefined,
          status: (statusFilter as WorkforceManpowerPlanStatus) || undefined,
        }),
      ]);
      setPositions(posList.filter((item) => item.isActive));
      setPlans(planList);
      if (planList.length > 0 && !selectedPlanId) {
        setSelectedPlanId(planList[0].id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.plan.msg.couldNotLoadManpowerPlanningRecords"));
    } finally {
      setLoading(false);
    }
  }, [token, yearFilter, statusFilter, selectedPlanId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedPlan = useMemo(
    () => plans.find((item) => item.id === selectedPlanId) ?? plans[0] ?? null,
    [plans, selectedPlanId],
  );

  const positionName = useMemo(
    () => (id: string | null) => {
      if (!id) return "General / Unassigned";
      return positions.find((item) => item.id === id)?.name ?? id;
    },
    [positions],
  );

  // Reports missing/invalid fields instead of silently refusing to submit.
  function requireFields(checks: Array<[unknown, string]>, invalid: Array<[boolean, string]> = []): boolean {
    const missing = checks.filter(([value]) => !value).map(([, label]) => label);
    if (missing.length > 0) {
      setNotice(null);
      setError(t("common.form.missing", { fields: missing.join(", ") }));
      return false;
    }
    const bad = invalid.filter(([isBad]) => isBad).map(([, label]) => label);
    if (bad.length > 0) {
      setNotice(null);
      setError(t("common.form.invalid", { fields: bad.join(", ") }));
      return false;
    }
    return true;
  }

  async function runAction(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.plan.msg.planningOperationFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createPlan() {
    if (!requireFields(
      [[planTitle.trim(), t("wf.plan.f.scenarioTitle")], [planYear.trim(), t("wf.plan.f.planYear")]],
      [[!(Number(planYear) >= 2000 && Number(planYear) <= 2100), t("wf.plan.f.planYear")]],
    )) return;
    await runAction(
      () => api.createWorkforceManpowerPlan(token, {
        title: planTitle.trim(),
        planYear: Number(planYear) || new Date().getFullYear(),
        organizationUnitId: planUnitId || null,
      }),
      `Manpower plan scenario ${planTitle} created.`,
    );
    setPlanTitle("");
  }

  async function computePlan(id: string) {
    const targets: Record<string, number> = {};
    for (const [posId, count] of Object.entries(targetByPosition)) {
      if (count && Number(count) >= 0) targets[posId] = Number(count);
    }
    await runAction(
      () => api.computeWorkforceManpowerPlan(token, id, targets),
      "Manpower plan demand gap and cost delta computed.",
    );
  }

  async function applyPlan(id: string) {
    await runAction(
      () => api.applyWorkforceManpowerPlan(token, id),
      "Manpower plan advisory recommendation applied.",
    );
  }

  async function dismissPlan(id: string) {
    await runAction(
      () => api.dismissWorkforceManpowerPlan(token, id),
      "Manpower plan dismissed.",
    );
  }

  const planColumns: Column<WorkforceManpowerPlan>[] = [
    {
      header: t("wf.plan.h.plan"),
      cell: (row) => (
        <div>
          <div className="font-semibold text-slate-900">{row.title}</div>
          <div className="font-mono text-xs text-slate-500">{row.planNumber} (FY {row.planYear})</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.plan.h.headcountCurrentTarget"), cell: (row) => `${row.currentHeadcount} → ${row.plannedHeadcount}` },
    {
      header: t("wf.plan.h.headcountGap"),
      cell: (row) => (
        <span className={row.varianceHeadcount >= 0 ? "text-emerald-700 font-semibold" : "text-amber-700 font-semibold"}>
          {row.varianceHeadcount >= 0 ? `+${row.varianceHeadcount}` : row.varianceHeadcount}
        </span>
      ),
    },
    { header: t("wf.plan.h.costDelta"), cell: (row) => money(row.varianceCostProjection) },
    {
      header: t("wf.plan.h.status"),
      cell: (row) => <StatusPill tone={statusTone(row.status)}>{label(row.status)}</StatusPill>,
      mobileRole: "status",
    },
    {
      header: t("wf.plan.h.actions"),
      cell: (row) => (
        <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          <Button variant="secondary" className="text-xs" onClick={() => setSelectedPlanId(row.id)}>
            Select
          </Button>
          {canApply && row.status === "computed" ? (
            <Button variant="secondary" className="text-xs" disabled={busy} onClick={() => void applyPlan(row.id)}>
              Apply
            </Button>
          ) : null}
          {canManage && (row.status === "draft" || row.status === "computed") ? (
            <Button variant="ghost" className="text-xs text-rose-700" disabled={busy} onClick={() => void dismissPlan(row.id)}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const gapColumns: Column<WorkforceManpowerGapEntry>[] = [
    { header: t("wf.plan.h.position"), cell: (row) => <span className="font-semibold">{positionName(row.positionId)}</span>, mobileRole: "title" },
    { header: t("wf.plan.h.current"), cell: (row) => row.currentHeadcount },
    { header: t("wf.plan.h.planned"), cell: (row) => row.plannedHeadcount },
    {
      header: t("wf.plan.h.variance"),
      cell: (row) => (
        <span className={row.variance >= 0 ? "text-emerald-700 font-semibold" : "text-amber-700 font-semibold"}>
          {row.variance >= 0 ? `+${row.variance}` : row.variance}
        </span>
      ),
      mobileRole: "status",
    },
    { header: t("wf.plan.h.costImpact"), cell: (row) => money(row.costImpact) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("wf.plan.title.workforcePlanning")}
        subtitle={t("wf.plan.sub.compareDemandModelsComputeHeadcountAndPa")}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? <Alert tone="info">{t("wf.plan.msg.creatingAndComputingScenariosRequirePerm", { perm: <code className="font-mono text-xs">workforce.planning.manage</code> })}</Alert> : null}
      {!canApply ? <Alert tone="info">{t("wf.plan.msg.applyingPlanningDecisionsRequiresPerm", { perm: <code className="font-mono text-xs">workforce.planning.apply</code> })}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.plan.t.scenarioFilters")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("wf.plan.f.planYear")}><Input type="number" min="2000" max="2100" value={yearFilter} onChange={(event) => setYearFilter(event.target.value)} /></Field>
          <Field label={t("wf.plan.f.status")}>
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as WorkforceManpowerPlanStatus)}>
              <option value="">{t("wf.plan.t.allStatuses")}</option>
              <option value="draft">{t("wf.plan.t.draft")}</option>
              <option value="computed">{t("wf.plan.t.computed")}</option>
              <option value="applied">{t("wf.plan.t.applied")}</option>
              <option value="dismissed">{t("wf.plan.t.dismissed")}</option>
            </Select>
          </Field>
        </div>
      </Card>

      {canManage ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.plan.t.createManpowerPlanningScenario")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("wf.plan.f.scenarioTitle")} required><Input value={planTitle} onChange={(event) => setPlanTitle(event.target.value)} placeholder={t("wf.plan.p.fy2026FieldExpansion")} /></Field>
            <Field label={t("wf.plan.f.planYear")} required><Input type="number" min="2000" max="2100" value={planYear} onChange={(event) => setPlanYear(event.target.value)} /></Field>
            <Field label={t("wf.plan.f.organizationUnitId")}><Input value={planUnitId} onChange={(event) => setPlanUnitId(event.target.value)} placeholder={t("wf.plan.p.optionalUnitScope")} /></Field>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createPlan()}>{t("wf.plan.t.createScenario")}</Button>
        </Card>
      ) : null}

      {loading ? <Spinner label={t("wf.plan.f.loadingPlanningScenarios")} /> : (
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.plan.t.planningScenarios")}</h2>
            <DataTable
              columns={planColumns}
              rows={plans}
              keyOf={(row) => row.id}
              mobileBreakpoint="md"
              empty={<EmptyState title={t("wf.plan.title.noManpowerPlansFound")} description={t("wf.plan.d.createAPlanningScenarioAboveToBeginSimul")} />}
            />
          </Card>

          {selectedPlan ? (
            <Card>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">{selectedPlan.title} ({selectedPlan.planNumber})</h3>
                  <div className="text-xs text-slate-500">FY {selectedPlan.planYear} | Status: {label(selectedPlan.status)} | Computed at: {formatDateShort(selectedPlan.computedAt)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={statusTone(selectedPlan.status)}>{label(selectedPlan.status)}</StatusPill>
                  {canApply && selectedPlan.status === "computed" ? (
                    <Button variant="primary" disabled={busy} onClick={() => void applyPlan(selectedPlan.id)}>
                      Apply plan
                    </Button>
                  ) : null}
                  {canManage && (selectedPlan.status === "draft" || selectedPlan.status === "computed") ? (
                    <Button variant="secondary" className="text-rose-700" disabled={busy} onClick={() => void dismissPlan(selectedPlan.id)}>
                      Dismiss
                    </Button>
                  ) : null}
                </div>
              </div>

              {canManage && selectedPlan.status !== "applied" ? (
                <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <h4 className="mb-2 text-sm font-semibold text-slate-800">{t("wf.plan.t.simulateTargetHeadcountByRole")}</h4>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {positions.map((position) => (
                      <Field key={position.id} label={position.name}>
                        <Input
                          type="number"
                          min="0"
                          placeholder={t("wf.plan.p.targetHeadcount")}
                          value={targetByPosition[position.id] ?? ""}
                          onChange={(event) => setTargetByPosition((current) => ({ ...current, [position.id]: event.target.value }))}
                        />
                      </Field>
                    ))}
                  </div>
                  <Button className="mt-3" disabled={busy} onClick={() => void computePlan(selectedPlan.id)}>
                    Compute headcount and cost gap
                  </Button>
                </div>
              ) : null}

              <h4 className="mb-2 text-sm font-semibold text-slate-800">{t("wf.plan.t.headcountBudgetGapBreakdown")}</h4>
              <DataTable
                columns={gapColumns}
                rows={selectedPlan.gapAnalysis ?? []}
                keyOf={(row) => `${row.positionId ?? "unassigned"}-${row.organizationUnitId ?? "all"}`}
                mobileBreakpoint="md"
                empty={<EmptyState title={t("wf.plan.title.noGapComputationRecorded")} description={t("wf.plan.d.runSimulationAboveToCalculatePositionVar")} />}
              />
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
