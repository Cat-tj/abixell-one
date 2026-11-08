/**
 * Project Delivery Advanced — Planning page.
 *
 * WBS hierarchy with rolled-up cost; dependencies and critical path;
 * resource loading and levelling; baselines and variance analysis.
 *
 * Money fields are exact-decimal strings, never JS numbers (ADR-0026).
 */

import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
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
  Textarea,
  type Column,
} from "../../shell/components/ui";
import { formatDate, formatDateShort, formatMoney } from "../../shared/format";
import { useAuth } from "../../auth/AuthContext";
import {
  ApiError,
  api,
  type BaselineVarianceResult,
  type ProjectBaseline,
  type ProjectResource,
  type ProjectSchedule,
  type ProjectWbsNodeView,
  type ResourceLoadingResult,
} from "../../lib/api";
import { localDateInputValue } from "../../shared/localDateTime";

interface WbsDraft {
  code?: string;
  name?: string;
  description?: string | null;
}

interface BaselineDraft {
  name?: string;
  notes?: string | null;
}

type ModalState =
  | { kind: "none" }
  | { kind: "create-wbs"; data?: WbsDraft }
  | { kind: "create-baseline"; data?: BaselineDraft };

const BASELINE_STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "info",
  approved: "success",
  superseded: "warning",
};

const BASELINE_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  superseded: "Superseded",
};

export function ProjectDeliveryAdvancedPlanningPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session?.accessToken ?? "";

  // Projects list
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string>("");

  // WBS state
  const [wbsNodes, setWbsNodes] = useState<ProjectWbsNodeView[]>([]);

  // Schedule and critical path
  const [schedule, setSchedule] = useState<ProjectSchedule | null>(null);
  const [activityTitles, setActivityTitles] = useState<Record<string, string>>({});

  // Resources
  const [resources, setResources] = useState<ProjectResource[]>([]);
  const [loadingResult, setLoadingResult] = useState<ResourceLoadingResult | null>(null);

  // Baselines
  const [baselines, setBaselines] = useState<ProjectBaseline[]>([]);
  const [variance, setVariance] = useState<BaselineVarianceResult | null>(null);

  // UI state
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [asOfDate, setAsOfDate] = useState<string>(localDateInputValue()); // YYYY-MM-DD

  // Load projects on mount
  useEffect(() => {
    const loadProjects = async () => {
      try {
        const resp = await api.projectDeliveryProjects(token);
        setProjects((resp || []).map(s => s.project));
      } catch {
        // Silent: an empty dropdown is the visible state, and the Load button
        // stays disabled until a project is chosen.
      }
    };
    if (token) loadProjects();
  }, [token]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [wbsResp, schedResp, ganttResp, resourcesResp, loadingResp, baselinesResp, varianceResp] = await Promise.all([
        api.projectDeliveryWbs(token, projectId),
        api.projectDeliverySchedule(token, projectId),
        api.projectDeliveryGantt(token, projectId),
        api.projectDeliveryResources(token),
        api.projectDeliveryResourceLoading(token, projectId, asOfDate, asOfDate),
        api.projectDeliveryBaselines(token, projectId),
        // The API refuses variance until a baseline is approved; that is an
        // expected empty state, not a load failure.
        api.projectDeliveryBaselineVariance(token, projectId, asOfDate).catch(() => null),
      ]);

      setWbsNodes(wbsResp || []);
      setSchedule(schedResp || null);
      setActivityTitles(Object.fromEntries((ganttResp || []).map((g) => [g.activityId, g.title])));
      setResources(resourcesResp || []);
      setLoadingResult(loadingResp || null);
      setBaselines(baselinesResp || []);
      setVariance(varianceResp || null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.plan.msg.failedToLoadPlanningData"));
    } finally {
      setLoading(false);
    }
  }, [projectId, token, asOfDate, t]);

  const wbsDraft = modal.kind === "create-wbs" ? modal.data : undefined;
  const canCreateWbs = !!wbsDraft?.code?.trim() && !!wbsDraft?.name?.trim();
  const baselineDraft = modal.kind === "create-baseline" ? modal.data : undefined;
  const canCreateBaseline = !!baselineDraft?.name?.trim();

  const createWbs = async () => {
    if (!canCreateWbs) return;
    setBusy(true);
    setError(null);
    try {
      const body = (modal.kind === "create-wbs" ? modal.data : undefined) ?? {};
      await api.createProjectDeliveryWbs(token, projectId, {
        code: (body.code ?? "").trim(),
        name: (body.name ?? "").trim(),
        description: body.description?.trim() || null,
      });
      setNotice(t("pd.plan.msg.wbsNodeCreated"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.plan.msg.failedToCreateWbsNode"));
    } finally {
      setBusy(false);
    }
  };

  const createBaseline = async () => {
    if (!canCreateBaseline) return;
    setBusy(true);
    setError(null);
    try {
      const body = (modal.kind === "create-baseline" ? modal.data : undefined) ?? {};
      await api.createProjectDeliveryBaseline(token, projectId, {
        name: (body.name ?? "").trim(),
        notes: body.notes?.trim() || null,
      });
      setNotice(t("pd.plan.msg.baselineCreated"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.plan.msg.failedToCreateBaseline"));
    } finally {
      setBusy(false);
    }
  };

  const approveBaseline = async (baselineId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.approveProjectDeliveryBaseline(token, baselineId);
      setNotice(t("pd.plan.msg.baselineApproved"));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.plan.msg.failedToApproveBaseline"));
    } finally {
      setBusy(false);
    }
  };

  const wbsColumns: Column<ProjectWbsNodeView>[] = [
    {
      header: t("pd.plan.h.code"),
      cell: (row) => <span className="font-mono text-sm">{row.code}</span>,
    },
    {
      header: t("pd.plan.h.name"),
      cell: (row) => (
        <span style={{ paddingLeft: `${Math.max(0, row.depth) * 16}px` }}>{row.name}</span>
      ),
    },
    {
      header: t("pd.plan.h.rolledUpCost"),
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.rolledUpCost)}</span>,
    },
    {
      header: t("pd.plan.h.activities"),
      className: "text-right",
      cell: (row) => <span>{row.activityCount}</span>,
    },
  ];

  const scheduleColumns: Column<ProjectSchedule["activities"][number]>[] = [
    {
      header: t("pd.plan.h.activity"),
      cell: (row) => <span className="text-sm">{activityTitles[row.activityId] ?? row.activityId}</span>,
    },
    {
      header: t("pd.plan.h.earliestStart"),
      cell: (row) => <span>{row.earliestStart ? formatDateShort(row.earliestStart) : "—"}</span>,
    },
    {
      header: t("pd.plan.h.earliestFinish"),
      cell: (row) => <span>{row.earliestFinish ? formatDateShort(row.earliestFinish) : "—"}</span>,
    },
    {
      header: t("pd.plan.h.criticalPath"),
      cell: (row) =>
        row.isCritical ? (
          <StatusPill tone="warning">{t("pd.plan.t.critical")}</StatusPill>
        ) : (
          <StatusPill tone="info">{t("pd.plan.t.nonCritical")}</StatusPill>
        ),
    },
  ];

  const resourceColumns: Column<ProjectResource>[] = [
    {
      header: t("pd.plan.h.resource"),
      cell: (row) => <span className="font-mono text-sm">{row.code}</span>,
    },
    {
      header: t("pd.plan.h.name"),
      cell: (row) => <span>{row.name}</span>,
    },
    {
      header: t("pd.plan.h.type"),
      cell: (row) => <Badge>{row.resourceType}</Badge>,
    },
  ];

  const baselineColumns: Column<ProjectBaseline>[] = [
    {
      header: t("pd.plan.h.baseline"),
      cell: (row) => <span className="text-sm">{`v${row.version} — ${row.name}`}</span>,
    },
    {
      header: t("pd.plan.h.status"),
      cell: (row) => (
        <StatusPill tone={BASELINE_STATUS_TONE[row.status] ?? "neutral"}>
          {BASELINE_STATUS_LABEL[row.status] || row.status}
        </StatusPill>
      ),
    },
    {
      header: t("pd.plan.h.approved"),
      cell: (row) =>
        row.approvedAt ? (
          formatDate(row.approvedAt)
        ) : (
          <span className="text-ink-dim">—</span>
        ),
    },
    {
      header: t("pd.plan.h.actions"),
      mobileRole: "status",
      cell: (row) =>
        row.status === "draft" ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => approveBaseline(row.id)}
          >
            Approve
          </Button>
        ) : null,
    },
  ];

  const varianceColumns: Column<BaselineVarianceResult["lines"][number]>[] = [
    { header: t("pd.plan.h.activity"), cell: (row) => <span className="text-sm">{row.title}</span> },
    { header: t("pd.plan.h.planned"), className: "tabular-nums", cell: (row) => <span>{formatMoney(row.baselineCost)}</span> },
    { header: t("pd.plan.h.actual"), className: "tabular-nums", cell: (row) => <span>{formatMoney(row.actualCost)}</span> },
    { header: t("pd.plan.h.variance"), className: "tabular-nums", cell: (row) => <span>{formatMoney(row.costVariance)}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("pd.plan.title.planning")} subtitle={t("pd.plan.sub.wbsScheduleResourcesBaselinesAndVariance")} />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("pd.plan.t.selectProject")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("pd.plan.f.project")} required>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t("pd.plan.t.selectAProject")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("pd.plan.f.asOfDate")} required>
            <Input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button onClick={() => load()} disabled={!projectId || loading}>
              {loading ? <Spinner /> : "Load"}
            </Button>
          </div>
        </div>
      </Card>

      {!projectId ? (
        <EmptyState title={t("pd.plan.title.noProjectSelected")} description={t("pd.plan.d.pickAProjectToSeePlanningData")} />
      ) : loading ? (
        <div className="flex items-center justify-center p-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          {/* WBS */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("pd.plan.t.workBreakdownStructure")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setModal({ kind: "create-wbs" })}
              >
                + WBS Node
              </Button>
            </div>
            <DataTable
              columns={wbsColumns}
              rows={wbsNodes}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("pd.plan.title.noWbsNodes")} description={t("pd.plan.d.createTheFirstWbsNode")} />}
            />
          </div>

          {/* Schedule & Critical Path */}
          {schedule ? (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink">{t("pd.plan.t.scheduleCriticalPath")}</h2>
                <span className="text-sm text-ink-dim">
                  Project finish: {schedule.projectFinish ? formatDateShort(schedule.projectFinish) : "—"}
                </span>
              </div>
              <DataTable
                columns={scheduleColumns}
                rows={schedule.activities || []}
                keyOf={(row) => row.activityId}
                empty={<EmptyState title={t("pd.plan.title.noScheduledActivities")} description={t("pd.plan.d.createDependenciesToGenerateASchedule")} />}
              />
            </div>
          ) : null}

          {/* Resources */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("pd.plan.t.resources")}</h2>
            </div>
            <DataTable
              columns={resourceColumns}
              rows={resources}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("pd.plan.title.noResources")} description={t("pd.plan.d.defineResourcesForTheProject")} />}
            />
            {loadingResult && loadingResult.overallocations.length > 0 ? (
              <Alert tone="warning">
                {`Resource overallocations detected: ${loadingResult.overallocations.length} period(s) over-allocated. Levelling ${loadingResult.isLevellable ? "is available." : "is not possible with current constraints."}`}
              </Alert>
            ) : null}
          </div>

          {/* Baselines */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("pd.plan.t.baselines")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setModal({ kind: "create-baseline" })}
              >
                + Baseline
              </Button>
            </div>
            <DataTable
              columns={baselineColumns}
              rows={baselines}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("pd.plan.title.noBaselines")} description={t("pd.plan.d.createTheFirstBaseline")} />}
            />
          </div>

          {/* Variance */}
          {variance ? (
            <div>
              <h2 className="mb-3 text-sm font-semibold text-ink">{t("pd.plan.t.baselineVariance")}</h2>
              <DataTable
                columns={varianceColumns}
                rows={variance.lines || []}
                keyOf={(row) => row.activityId}
                empty={<EmptyState title={t("pd.plan.title.noVarianceData")} description={t("pd.plan.d.noActivitiesWithCostRecorded")} />}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Modals */}
      {modal.kind === "create-wbs" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("pd.plan.t.createWbsNode")}</h2>
          <div className="space-y-3">
            <Field label={t("pd.plan.f.code")} required>
              <Input
                placeholder="WBS-001"
                value={modal.data?.code ?? ""}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, code: e.target.value } })}
              />
            </Field>
            <Field label={t("pd.plan.f.name")} required>
              <Input
                placeholder={t("pd.plan.p.nodeName")}
                value={modal.data?.name ?? ""}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, name: e.target.value } })}
              />
            </Field>
            <Field label={t("pd.plan.f.description")}>
              <Textarea
                rows={2}
                placeholder={t("pd.plan.p.optionalDescription")}
                value={modal.data?.description ?? ""}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, description: e.target.value || null } })}
              />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy || !canCreateWbs} onClick={() => createWbs()}>
              {t("common.create")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "create-baseline" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("pd.plan.t.createBaseline")}</h2>
          <div className="space-y-3">
            <Field label={t("pd.plan.f.name")} required>
              <Input
                placeholder="BL-001"
                value={modal.data?.name ?? ""}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, name: e.target.value } })}
              />
            </Field>
            <Field label={t("pd.plan.f.description")}>
              <Textarea
                rows={2}
                placeholder={t("pd.plan.p.optionalDescription")}
                value={modal.data?.notes ?? ""}
                onChange={(e) => setModal({ ...modal, data: { ...modal.data, notes: e.target.value || null } })}
              />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy || !canCreateBaseline} onClick={() => createBaseline()}>
              {t("common.create")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
