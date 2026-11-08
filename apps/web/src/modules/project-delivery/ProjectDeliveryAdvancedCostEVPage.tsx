/**
 * Project Delivery Advanced — Cost & Earned Value page.
 *
 * Cost entries (actual, commitment, adjustment, reversal), cost position,
 * earned value analysis, and EV snapshots.
 *
 * Money fields are exact-decimal strings, never JS numbers (ADR-0026).
 */

import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
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
  Textarea,
  type Column,
} from "../../shell/components/ui";
import { formatDate, formatMoney } from "../../shared/format";
import { useAuth } from "../../auth/AuthContext";
import {
  ApiError,
  api,
  type EarnedValueResult,
  type ProjectCostEntry,
  type ProjectCostPosition,
  type ProjectEarnedValueSnapshot,
  type ScheduleActivityResult,
} from "../../lib/api";

type CostEntryForm = {
  activityId: string;
  entryType: string;
  amount: string;
  idempotencyKey: string;
  entryDate: string;
  note: string;
};

type ModalState =
  | { kind: "none" }
  | { kind: "create-cost-entry"; form: CostEntryForm }
  | { kind: "create-ev-snapshot"; snapshotDate: string };

const MONEY_2DP = /^-?\d{1,16}(\.\d{1,2})?$/;

const COST_ENTRY_TYPE_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  actual: "success",
  commitment: "info",
  adjustment: "warning",
  reversal: "danger",
};

const COST_ENTRY_TYPE_LABEL: Record<string, string> = {
  actual: "Actual",
  commitment: "Commitment",
  adjustment: "Adjustment",
  reversal: "Reversal",
};

const POSTING_STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  emitted: "success",
  skipped_duplicate: "warning",
};

const POSTING_STATUS_LABEL: Record<string, string> = {
  emitted: "Posted",
  skipped_duplicate: "Duplicate (skipped)",
};

const today = () => new Date().toISOString().split("T")[0];

function formatIndex(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

export function ProjectDeliveryAdvancedCostEVPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session?.accessToken ?? "";

  const [projectId, setProjectId] = useState<string>("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [asOfDate, setAsOfDate] = useState<string>(today());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const [activities, setActivities] = useState<ScheduleActivityResult[]>([]);
  const [costEntries, setCostEntries] = useState<ProjectCostEntry[]>([]);
  const [costPosition, setCostPosition] = useState<ProjectCostPosition | null>(null);
  const [earnedValue, setEarnedValue] = useState<EarnedValueResult | null>(null);
  const [evSnapshots, setEvSnapshots] = useState<ProjectEarnedValueSnapshot[]>([]);

  useEffect(() => {
    if (!token) return;
    api
      .projectDeliveryProjects(token)
      .then((resp) => setProjects((resp || []).map((s) => s.project)))
      .catch(() => {
        // dropdown stays empty; the load button remains disabled
      });
  }, [token]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [scheduleResp, entriesResp, positionResp, evResp, snapshotsResp] = await Promise.all([
        api.projectDeliverySchedule(token, projectId),
        api.projectDeliveryCostEntries(token, projectId, asOfDate),
        api.projectDeliveryCostPosition(token, projectId, asOfDate),
        api.projectDeliveryEarnedValue(token, projectId, asOfDate),
        api.projectDeliveryEarnedValueSnapshots(token, projectId),
      ]);

      setActivities(scheduleResp?.activities ?? []);
      setCostEntries(entriesResp || []);
      setCostPosition(positionResp || null);
      setEarnedValue(evResp || null);
      setEvSnapshots(snapshotsResp || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.cost.msg.failedToLoadCostAndEvData"));
    } finally {
      setLoading(false);
    }
  }, [projectId, token, asOfDate, t]);

  const openCostEntryModal = () => {
    setModal({
      kind: "create-cost-entry",
      form: {
        activityId: "",
        entryType: "actual",
        amount: "",
        idempotencyKey: crypto.randomUUID(),
        entryDate: today(),
        note: "",
      },
    });
  };

  const patchCostForm = (patch: Partial<CostEntryForm>) => {
    setModal((m) => (m.kind === "create-cost-entry" ? { ...m, form: { ...m.form, ...patch } } : m));
  };

  const costFormError = (form: CostEntryForm): string | null => {
    if (!form.activityId) return "Pick an activity.";
    if (!MONEY_2DP.test(form.amount.trim())) return "Amount must be a decimal with at most 2 decimals.";
    if (!form.entryDate) return "Entry date is required.";
    return null;
  };

  const createCostEntry = async () => {
    if (modal.kind !== "create-cost-entry") return;
    const form = modal.form;
    const invalid = costFormError(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createProjectDeliveryCostEntry(token, projectId, {
        activityId: form.activityId,
        entryType: form.entryType,
        amount: form.amount.trim(),
        idempotencyKey: form.idempotencyKey,
        entryDate: form.entryDate,
        note: form.note.trim() || null,
      });
      setNotice(t("pd.cost.msg.costEntryRecorded"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.cost.msg.failedToCreateCostEntry"));
    } finally {
      setBusy(false);
    }
  };

  const reverseCostEntry = async (entryId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.reverseProjectDeliveryCostEntry(token, entryId);
      setNotice(t("pd.cost.msg.costEntryReversed"));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.cost.msg.failedToReverseCostEntry"));
    } finally {
      setBusy(false);
    }
  };

  const postCostEntry = async (entryId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.postProjectDeliveryCostEntry(token, entryId);
      setNotice(t("pd.cost.msg.costEntryPostedToAccountingKernel"));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.cost.msg.failedToPostCostEntry"));
    } finally {
      setBusy(false);
    }
  };

  const createEvSnapshot = async () => {
    if (modal.kind !== "create-ev-snapshot" || !modal.snapshotDate) {
      setError(t("pd.cost.msg.snapshotDateIsRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createProjectDeliveryEarnedValueSnapshot(token, projectId, {
        snapshotDate: modal.snapshotDate,
      });
      setNotice(t("pd.cost.msg.evSnapshotRecorded"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.cost.msg.failedToCreateEvSnapshot"));
    } finally {
      setBusy(false);
    }
  };

  const activityLabel = (activityId: string) => {
    const a = activities.find((x) => x.activityId === activityId);
    return a ? `${a.code} — ${a.name}` : activityId;
  };

  const costEntryColumns: Column<ProjectCostEntry>[] = [
    {
      header: t("pd.cost.h.type"),
      cell: (row) => (
        <StatusPill tone={COST_ENTRY_TYPE_TONE[row.entryType] ?? "neutral"}>
          {COST_ENTRY_TYPE_LABEL[row.entryType] || row.entryType}
        </StatusPill>
      ),
    },
    {
      header: t("pd.cost.h.activity"),
      cell: (row) => <span className="text-sm">{activityLabel(row.activityId)}</span>,
    },
    {
      header: t("pd.cost.h.amount"),
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.amount)}</span>,
    },
    {
      header: t("pd.cost.h.entryDate"),
      cell: (row) => <span>{formatDate(row.entryDate)}</span>,
    },
    {
      header: t("pd.cost.h.status"),
      cell: (row) =>
        row.postingStatus ? (
          <StatusPill tone={POSTING_STATUS_TONE[row.postingStatus] ?? "neutral"}>
            {POSTING_STATUS_LABEL[row.postingStatus] || row.postingStatus}
          </StatusPill>
        ) : (
          <span className="text-sm text-ink-dim">—</span>
        ),
    },
    {
      header: t("pd.cost.h.actions"),
      mobileRole: "status",
      cell: (row) => (
        <div className="space-y-1">
          {!row.postingStatus ? (
            <Button variant="secondary" disabled={busy} onClick={() => postCostEntry(row.id)}>
              Post
            </Button>
          ) : null}
          {row.entryType !== "reversal" ? (
            <Button variant="secondary" disabled={busy} onClick={() => reverseCostEntry(row.id)}>
              Reverse
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  type EvActivity = EarnedValueResult["activities"][number];
  const evActivityColumns: Column<EvActivity>[] = [
    {
      header: t("pd.cost.h.activity"),
      cell: (row) => (
        <span className="text-sm">
          <span className="font-mono">{row.code}</span> {row.name}
        </span>
      ),
    },
    {
      header: t("pd.cost.h.complete"),
      className: "text-right",
      cell: (row) => <span>{(row.percentComplete * 100).toFixed(1)}%</span>,
    },
    {
      header: t("pd.cost.h.plannedValue"),
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.plannedValue)}</span>,
    },
    {
      header: t("pd.cost.h.earnedValue"),
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.earnedValue)}</span>,
    },
    {
      header: t("pd.cost.h.actualCost"),
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.actualCost)}</span>,
    },
  ];

  const snapshotColumns: Column<ProjectEarnedValueSnapshot>[] = [
    {
      header: t("pd.cost.h.date"),
      cell: (row) => <span>{formatDate(row.snapshotDate)}</span>,
    },
    {
      header: "PV",
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.plannedValue)}</span>,
    },
    {
      header: "EV",
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.earnedValue)}</span>,
    },
    {
      header: "AC",
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatMoney(row.actualCost)}</span>,
    },
    {
      header: "SPI",
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatIndex(row.schedulePerformanceIndex)}</span>,
    },
    {
      header: "CPI",
      className: "tabular-nums text-right",
      cell: (row) => <span>{formatIndex(row.costPerformanceIndex)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("pd.cost.title.costEarnedValue")}
        subtitle={t("pd.cost.sub.trackCostEntriesAnalyzeProjectCostPerfor")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("pd.cost.t.selectProject")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("pd.cost.f.project")} required>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t("pd.cost.t.selectAProject")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("pd.cost.f.asOfDate")} required>
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </Field>
          <div className="flex items-end gap-2">
            <Button onClick={() => load()} disabled={!projectId || !asOfDate || loading}>
              {loading ? <Spinner /> : "Load"}
            </Button>
          </div>
        </div>
      </Card>

      {!projectId ? (
        <EmptyState title={t("pd.cost.title.noProjectSelected")} description={t("pd.cost.d.pickAProjectToSeeCostAndEvData")} />
      ) : loading ? (
        <div className="flex items-center justify-center p-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          {costPosition ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Card>
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.actualCost")}</div>
                <div className="mt-1 text-lg font-mono">{formatMoney(costPosition.actualCost)}</div>
              </Card>
              <Card>
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.commitment")}</div>
                <div className="mt-1 text-lg font-mono">{formatMoney(costPosition.commitmentCost)}</div>
              </Card>
              <Card>
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.budgetAtCompletion")}</div>
                <div className="mt-1 text-lg font-mono">{formatMoney(costPosition.budgetAtCompletion)}</div>
              </Card>
              <Card>
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.estimateAtCompletion")}</div>
                <div className="mt-1 text-lg font-mono">{formatMoney(costPosition.estimateAtCompletion)}</div>
              </Card>
              <Card>
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.estimateToComplete")}</div>
                <div className="mt-1 text-lg font-mono">{formatMoney(costPosition.estimateToComplete)}</div>
              </Card>
              <Card>
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.costVariance")}</div>
                <div
                  className={`mt-1 text-lg font-mono ${costPosition.costVariance.startsWith("-") ? "text-error" : "text-success"}`}
                >
                  {formatMoney(costPosition.costVariance)}
                </div>
                <div className="mt-1 text-xs text-ink-dim">CPI {formatIndex(costPosition.costPerformanceIndex)}</div>
              </Card>
            </div>
          ) : null}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("pd.cost.t.costEntries")}</h2>
              <Button
                variant="secondary"
                disabled={busy || activities.length === 0}
                onClick={openCostEntryModal}
              >
              {t("pd.cost.t.entry")}
              </Button>
            </div>
            <DataTable
              columns={costEntryColumns}
              rows={costEntries}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("pd.cost.title.noCostEntries")} description={t("pd.cost.d.recordTheFirstCostEntry")} />}
            />
          </div>

          {earnedValue ? (
            <div>
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-ink">{t("pd.cost.t.earnedValueAnalysis")}</h2>
                <p className="mt-1 text-sm text-ink-dim">
                  PV {formatMoney(earnedValue.plannedValue)} · EV {formatMoney(earnedValue.earnedValue)} · AC{" "}
                  {formatMoney(earnedValue.actualCost)} · SV {formatMoney(earnedValue.scheduleVariance)} · CV{" "}
                  {formatMoney(earnedValue.costVariance)} · SPI {formatIndex(earnedValue.schedulePerformanceIndex)} ·
                  CPI {formatIndex(earnedValue.costPerformanceIndex)} · VAC{" "}
                  {formatMoney(earnedValue.varianceAtCompletion)}
                </p>
              </div>
              <DataTable
                columns={evActivityColumns}
                rows={earnedValue.activities || []}
                keyOf={(row) => row.code}
                empty={<EmptyState title={t("pd.cost.title.noActivityData")} description={t("pd.cost.d.noActivitiesHaveProgressRecorded")} />}
              />
            </div>
          ) : null}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("pd.cost.t.evSnapshots")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setModal({ kind: "create-ev-snapshot", snapshotDate: asOfDate })}
              >
                + Snapshot
              </Button>
            </div>
            <DataTable
              columns={snapshotColumns}
              rows={evSnapshots}
              keyOf={(row) => row.snapshotDate}
              empty={<EmptyState title={t("pd.cost.title.noSnapshots")} description={t("pd.cost.d.createTheFirstEvSnapshot")} />}
            />
          </div>
        </div>
      )}

      {modal.kind === "create-cost-entry" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("pd.cost.t.recordCostEntry")}</h2>
          <div className="space-y-3">
            <Field label={t("pd.cost.f.activity")} required>
              <Select value={modal.form.activityId} onChange={(e) => patchCostForm({ activityId: e.target.value })}>
                <option value="">{t("pd.cost.t.selectActivity")}</option>
                {activities.map((a) => (
                  <option key={a.activityId} value={a.activityId}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("pd.cost.f.entryType")} required>
              <Select value={modal.form.entryType} onChange={(e) => patchCostForm({ entryType: e.target.value })}>
                <option value="actual">{t("pd.cost.t.actual")}</option>
                <option value="commitment">{t("pd.cost.t.commitment")}</option>
                <option value="adjustment">{t("pd.cost.t.adjustment")}</option>
              </Select>
            </Field>
            <Field label={t("pd.cost.f.amount")} required>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={modal.form.amount}
                onChange={(e) => patchCostForm({ amount: e.target.value })}
              />
            </Field>
            <Field label={t("pd.cost.f.entryDate")} required>
              <Input
                type="date"
                value={modal.form.entryDate}
                onChange={(e) => patchCostForm({ entryDate: e.target.value })}
              />
            </Field>
            <Field label={t("pd.cost.f.idempotencyKey")} required>
              <Input
                value={modal.form.idempotencyKey}
                onChange={(e) => patchCostForm({ idempotencyKey: e.target.value })}
              />
            </Field>
            <Field label={t("pd.cost.f.notes")}>
              <Textarea
                rows={2}
                placeholder={t("pd.cost.p.optionalNotes")}
                value={modal.form.note}
                onChange={(e) => patchCostForm({ note: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy || !modal.form.idempotencyKey} onClick={() => createCostEntry()}>
              Record
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "create-ev-snapshot" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("pd.cost.t.recordEvSnapshot")}</h2>
          <div className="space-y-3">
            <Field label={t("pd.cost.f.snapshotDate")} required>
              <Input
                type="date"
                value={modal.snapshotDate}
                onChange={(e) => setModal({ kind: "create-ev-snapshot", snapshotDate: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy || !modal.snapshotDate} onClick={() => createEvSnapshot()}>
              Record
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
