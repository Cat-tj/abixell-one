/**
 * Wave A3 — Route, Roster & Workload Optimization (SO-ADV-002…005).
 *
 * Provides capacity analysis, explainable assignment proposals, and explicit
 * human-action apply / dismiss workflow. Generated runs are always advisory
 * until explicitly applied.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ApplyOptimizationResponse,
  type OptimizationRun,
  type OptimizationRunStatus,
} from "../../lib/api";
import { PERMISSIONS } from "../../lib/capabilities";
import { useShell } from "../../shell/layout/AppShell";
import {
  Alert,
  Badge,
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
import { formatDate } from "../../shared/format";
import { localDateInputValue } from "../../shared/localDateTime";

function optimizationStatusTone(
  status: OptimizationRunStatus,
): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "applied":
      return "success";
    case "dismissed":
      return "neutral";
    case "proposed":
      return "info";
    default:
      return "neutral";
  }
}

export function ServiceOptimizationPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { permissions } = useShell();
  const navigate = useNavigate();

  const canApply = permissions.includes(PERMISSIONS.serviceOperationsOptimizationApply);

  const [runs, setRuns] = useState<OptimizationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form state
  const [targetDate, setTargetDate] = useState(() => localDateInputValue());
  const [maxOrders, setMaxOrders] = useState("8");
  const [maxMinutes, setMaxMinutes] = useState("480");
  const [prioritizeSla, setPrioritizeSla] = useState(true);
  const [groupDistanceNear, setGroupDistanceNear] = useState(false);
  const [orgUnits, setOrgUnits] = useState<{ id: string; name: string }[]>([]);
  const [selectedOrgUnit, setSelectedOrgUnit] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, unitList] = await Promise.all([
        api.optimizationRuns(token, 50),
        api.organizationUnits(token).catch(() => [] as { id: string; name: string }[]),
      ]);
      setRuns(list);
      setOrgUnits(unitList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("so.opt.msg.couldNotLoadOptimizationRuns"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleGenerate() {
    if (!targetDate) {
      setNotice(null);
      setError(t("common.form.missing", { fields: t("so.opt.f.targetScheduleDate") }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const generated = await api.generateOptimizationRun(token, {
        targetDate,
        organizationUnitId: selectedOrgUnit || null,
        parameters: {
          maxWorkOrdersPerWorker: maxOrders ? Number(maxOrders) : undefined,
          maxMinutesPerWorker: maxMinutes ? Number(maxMinutes) : undefined,
          prioritizeSla,
          groupDistanceNear,
        },
      });
      setNotice(
        `Optimization run ${generated.runNumber} generated with ${generated.proposals.length} proposed assignments.`,
      );
      await load();
      navigate(`/service-optimization/${generated.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("so.opt.msg.couldNotGenerateOptimizationRun"));
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(runId: string) {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res: ApplyOptimizationResponse = await api.applyOptimizationRun(token, runId);
      setNotice(
        `Optimization applied: ${res.appliedCount} work orders assigned (${res.skippedCount} skipped / already assigned).`,
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("so.opt.msg.couldNotApplyOptimizationProposals"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss(runId: string) {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const dismissed = await api.dismissOptimizationRun(token, runId);
      setNotice(`Optimization run ${dismissed.runNumber} dismissed.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("so.opt.msg.couldNotDismissOptimizationRun"));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<OptimizationRun>[] = [
    {
      header: t("so.opt.h.runNumber"),
      cell: (row) => (
        <Link
          to={`/service-optimization/${row.id}`}
          className="font-semibold text-slate-900 underline hover:text-slate-700"
        >
          {row.runNumber}
        </Link>
      ),
      mobileRole: "title",
    },
    {
      header: t("so.opt.h.targetDate"),
      cell: (row) => row.targetDate,
    },
    {
      header: t("so.opt.h.proposals"),
      cell: (row) => <Badge>{row.proposals.length} orders</Badge>,
    },
    {
      header: t("so.opt.h.status"),
      cell: (row) => (
        <StatusPill tone={optimizationStatusTone(row.status)}>
          {row.status.toUpperCase()}
        </StatusPill>
      ),
      mobileRole: "status",
    },
    {
      header: t("so.opt.h.created"),
      cell: (row) => formatDate(row.createdAt),
    },
    {
      header: t("so.opt.h.actions"),
      cell: (row) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            onClick={() => navigate(`/service-optimization/${row.id}`)}
          >
            Inspect
          </Button>
          {row.status === "proposed" && canApply ? (
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void handleApply(row.id)}
              >
                Apply
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void handleDismiss(row.id)}
              >
                Dismiss
              </Button>
            </>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("so.opt.title.serviceOperationsOptimization")}
        subtitle={t("so.opt.sub.advisoryDispatchAndWorkloadOptimizationR")}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("so.opt.t.generateAdvisoryOptimizationRun")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("so.opt.f.targetScheduleDate")} required>
            <Input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </Field>
          <Field label={t("so.opt.f.organizationUnit")}>
            <Select
              value={selectedOrgUnit}
              onChange={(e) => setSelectedOrgUnit(e.target.value)}
            >
              <option value="">{t("so.opt.t.tenantWideAllUnits")}</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("so.opt.f.maxOrdersPerWorker")}>
            <Input
              type="number"
              min="1"
              max="50"
              value={maxOrders}
              onChange={(e) => setMaxOrders(e.target.value)}
            />
          </Field>
          <Field label={t("so.opt.f.maxMinutesPerWorker")}>
            <Input
              type="number"
              min="30"
              max="1440"
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={prioritizeSla}
              onChange={(e) => setPrioritizeSla(e.target.checked)}
            />
            Prioritize earlier SLA due dates
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={groupDistanceNear}
              onChange={(e) => setGroupDistanceNear(e.target.checked)}
            />
            Cluster assignments by site location
          </label>
        </div>

        <div className="mt-4">
          <Button disabled={busy} onClick={() => void handleGenerate()}>
            {busy ? "Analyzing workload…" : "Generate Optimization Run"}
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("so.opt.t.recentOptimizationRuns")}</h2>
        {loading ? (
          <Spinner label={t("so.opt.f.loadingOptimizationHistory")} />
        ) : (
          <DataTable
            columns={columns}
            rows={runs}
            keyOf={(row) => row.id}
            onRowClick={(row) => navigate(`/service-optimization/${row.id}`)}
            empty={
              <EmptyState
                title={t("so.opt.title.noOptimizationRunsRecorded")}
                description={t("so.opt.d.generateAnOptimizationRunAboveToAnalyzeP")}
              />
            }
          />
        )}
      </Card>
    </div>
  );
}
