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
  type GanttRow,
} from "../../lib/api";
import { localDateInputValue } from "../../shared/localDateTime";

type CostEntryForm = {
  activityId: string;
  entryType: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
  entryDate: string;
  note: string;
};

type ModalState =
  | { kind: "none" }
  | { kind: "create-cost-entry"; form: CostEntryForm }
  | { kind: "create-ev-snapshot"; asOfDate: string };

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

const today = () => localDateInputValue();

/** Indices arrive as 4dp decimal strings ("1.2500") or null when undefined. */
function formatIndex(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

/** Exact-decimal string sign check; never converts money to a JS number. */
function isNegativeMoney(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("-");
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

  const [activities, setActivities] = useState<GanttRow[]>([]);
  const [costEntries, setCostEntries] = useState<ProjectCostEntry[]>([]);
  const [costPosition, setCostPosition] = useState<ProjectCostPosition | null>(null);
  const [earnedValue, setEarnedValue] = useState<EarnedValueResult | null>(null);
  const [evUnavailable, setEvUnavailable] = useState<string | null>(null);
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
    setEvUnavailable(null);
    try {
      const [ganttResp, entriesResp, positionResp, evResp, snapshotsResp] = await Promise.all([
        api.projectDeliveryGantt(token, projectId),
        api.projectDeliveryCostEntries(token, projectId, asOfDate),
        api.projectDeliveryCostPosition(token, projectId, asOfDate),
        // Earned value needs an approved baseline; without one the API answers
        // 400. That is a normal project state, so it must not discard the
        // cost entries and position loaded alongside it.
        api.projectDeliveryEarnedValue(token, projectId, asOfDate).catch((err: unknown) => {
          setEvUnavailable(err instanceof ApiError ? err.message : null);
          return null;
        }),
        api.projectDeliveryEarnedValueSnapshots(token, projectId),
      ]);

      setActivities(ganttResp ?? []);
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
        currency: "IDR",
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
    if (!/^[A-Za-z]{3}$/.test(form.currency.trim())) return "Currency must be a 3-letter code.";
    if (!form.entryDate) return "Entry date is required.";
    if (!form.idempotencyKey.trim()) return "Idempotency key is required.";
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
        entryType: form.entryType as "actual" | "commitment" | "adjustment",
        amount: form.amount.trim(),
        currency: form.currency.trim().toUpperCase(),
        idempotencyKey: form.idempotencyKey.trim(),
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
    if (modal.kind !== "create-ev-snapshot" || !modal.asOfDate) {
      setError(t("pd.cost.msg.snapshotDateIsRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createProjectDeliveryEarnedValueSnapshot(token, projectId, {
        asOfDate: modal.asOfDate,
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

  const activityLabel = (activityId: string | null) => {
    if (!activityId) return "—";
    const a = activities.find((x) => x.activityId === activityId);
    return a ? a.title : activityId;
  };

  const reversedIds = new Set(costEntries.map((e) => e.reversesId).filter((id): id is string => !!id));

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
      header: t("pd.cost.f.currency"),
      cell: (row) => <span className="font-mono text-sm">{row.currency}</span>,
    },
    {
      header: t("pd.cost.h.actions"),
      mobileRole: "status",
      cell: (row) => (
        <div className="space-y-1">
          {row.entryType !== "commitment" ? (
            <Button variant="secondary" disabled={busy} onClick={() => postCostEntry(row.id)}>
              Post
            </Button>
          ) : null}
          {row.entryType !== "reversal" && !reversedIds.has(row.id) ? (
            <Button variant="secondary" disabled={busy} onClick={() => reverseCostEntry(row.id)}>
              Reverse
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  type EvActivity = EarnedValueResult["lines"][number];
  const evActivityColumns: Column<EvActivity>[] = [
    {
      header: t("pd.cost.h.activity"),
      cell: (row) => (
        <span className="text-sm">
          {row.title}
        </span>
      ),
    },
    {
      header: t("pd.cost.h.complete"),
      className: "text-right",
      cell: (row) => <span>{row.progressPercent.toFixed(1)}%</span>,
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
      cell: (row) => <span>{formatDate(row.asOfDate)}</span>,
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
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.adjustment")}</div>
                <div className="mt-1 text-lg font-mono">{formatMoney(costPosition.adjustmentCost)}</div>
              </Card>
              <Card>
                <div className="text-sm font-semibold text-ink">{t("pd.cost.t.totalCommitted")}</div>
                <div className="mt-1 text-lg font-mono">{formatMoney(costPosition.totalCommittedCost)}</div>
                <div className="mt-1 text-xs text-ink-dim">{costPosition.currency}</div>
              </Card>
              {earnedValue ? (
                <>
                  <Card>
                    <div className="text-sm font-semibold text-ink">{t("pd.cost.t.budgetAtCompletion")}</div>
                    <div className="mt-1 text-lg font-mono">{formatMoney(earnedValue.budgetAtCompletion)}</div>
                  </Card>
                  <Card>
                    <div className="text-sm font-semibold text-ink">{t("pd.cost.t.estimateAtCompletion")}</div>
                    <div className="mt-1 text-lg font-mono">{formatMoney(earnedValue.estimateAtCompletion)}</div>
                  </Card>
                  <Card>
                    <div className="text-sm font-semibold text-ink">{t("pd.cost.t.estimateToComplete")}</div>
                    <div className="mt-1 text-lg font-mono">{formatMoney(earnedValue.estimateToComplete)}</div>
                  </Card>
                  <Card>
                    <div className="text-sm font-semibold text-ink">{t("pd.cost.t.costVariance")}</div>
                    <div
                      className={`mt-1 text-lg font-mono ${isNegativeMoney(earnedValue.costVariance) ? "text-error" : "text-success"}`}
                    >
                      {formatMoney(earnedValue.costVariance)}
                    </div>
                    <div className="mt-1 text-xs text-ink-dim">CPI {formatIndex(earnedValue.costPerformanceIndex)}</div>
                  </Card>
                </>
              ) : null}
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

          {!earnedValue && evUnavailable ? <Alert tone="info">{evUnavailable}</Alert> : null}

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
                rows={earnedValue.lines || []}
                keyOf={(row) => row.activityId}
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
                onClick={() => setModal({ kind: "create-ev-snapshot", asOfDate })}
              >
                + Snapshot
              </Button>
            </div>
            <DataTable
              columns={snapshotColumns}
              rows={evSnapshots}
              keyOf={(row) => row.id}
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
                    {a.title}
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
            <Field label={t("pd.cost.f.currency")} required>
              <Input
                maxLength={3}
                placeholder="IDR"
                value={modal.form.currency}
                onChange={(e) => patchCostForm({ currency: e.target.value.toUpperCase() })}
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
            <Button
              disabled={
                busy ||
                !modal.form.activityId ||
                !modal.form.amount.trim() ||
                !/^[A-Za-z]{3}$/.test(modal.form.currency.trim()) ||
                !modal.form.entryDate ||
                !modal.form.idempotencyKey.trim()
              }
              onClick={() => createCostEntry()}
            >
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
                value={modal.asOfDate}
                onChange={(e) => setModal({ kind: "create-ev-snapshot", asOfDate: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy || !modal.asOfDate} onClick={() => createEvSnapshot()}>
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
