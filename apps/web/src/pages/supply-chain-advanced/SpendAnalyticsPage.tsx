/**
 * Wave A5 — Spend Analytics: Category, Supplier, Time & Anomaly Drilldown (SCM-ADV-008).
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ScmSpendAnalyticsSnapshot,
} from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
import {
  Alert,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Spinner,
  type Column,
} from "../../shell/components/ui";
import { formatMoney } from "../../shared/format";
import { localDateInputValue } from "../../shared/localDateTime";

export function SpendAnalyticsPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();

  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return localDateInputValue(d);
  });
  const [endDate, setEndDate] = useState(() => localDateInputValue());

  const [snapshots, setSnapshots] = useState<ScmSpendAnalyticsSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapList = await api.scmSpendSnapshots(token);
      setSnapshots(snapList);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.spend.msg.failedToLoadSpendAnalytics"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleCompute() {
    setComputing(true);
    setError(null);
    setNotice(null);
    try {
      // Compute returns the one snapshot it wrote; reload the list to show it.
      await api.computeScmSpendSnapshot(token, {
        periodType: "monthly",
        periodStart: startDate,
        periodEnd: endDate,
      });
      setSnapshots(await api.scmSpendSnapshots(token));
      setNotice(t("scm.spend.msg.recomputed"));
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.spend.msg.failedToRecomputeSpendAnalytics"));
    } finally {
      setComputing(false);
    }
  }

  // Null for viewers without the price permission; show a dash, not a misleading 0.
  const totalSpend: number | null = snapshots.some((s) => s.totalSpend === null)
    ? null
    : snapshots.reduce((sum, s) => sum + (s.totalSpend ?? 0), 0);
  const totalPOs = snapshots.reduce((sum, s) => sum + s.poCount, 0);
  const totalItems = snapshots.reduce((sum, s) => sum + s.itemsPurchasedCount, 0);

  const snapshotColumns: Column<ScmSpendAnalyticsSnapshot>[] = [
    {
      header: t("scm.spend.h.periodKey"),
      cell: (r) => <span className="font-mono font-semibold">{r.periodKey}</span>,
      mobileRole: "title",
    },
    { header: t("scm.spend.h.type"), cell: (r) => r.periodType },
    {
      header: t("scm.spend.h.poVolume"),
      cell: (r) => <span className="font-mono">{r.poCount}</span>,
    },
    {
      header: t("scm.spend.h.itemsPurchased"),
      cell: (r) => <span className="font-mono">{r.itemsPurchasedCount}</span>,
    },
    {
      header: t("scm.spend.h.avgPoValue"),
      cell: (r) => <span className="font-mono">{formatMoney(r.avgPoValue)}</span>,
    },
    {
      header: t("scm.spend.h.totalSpend"),
      cell: (r) => <span className="font-mono font-bold text-slate-900">{formatMoney(r.totalSpend)}</span>,
      mobileRole: "status",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("scm.spend.title.spendAnalytics")}
        subtitle={t("scm.spend.sub.multidimensionalSpendAnalysisAcrossSuppl")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.spend.t.analyticsDateRangeComputationEngine")}</h3>
        <div className="flex flex-wrap items-end gap-4">
          <Field label={t("scm.spend.f.periodStart")}>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={computing} />
          </Field>
          <Field label={t("scm.spend.f.periodEnd")}>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={computing} />
          </Field>
          <Button variant="primary" onClick={handleCompute} disabled={computing}>
              {t("scm.spend.t.recomputeAnalyticsSnapshot")}
              </Button>
        </div>
      </Card>

      {loading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <div className="text-xs font-bold text-slate-500r">{t("scm.spend.t.totalEvaluatedSpend")}</div>
              <div className="mt-2 text-2xl font-black text-slate-900 font-mono">{formatMoney(totalSpend)}</div>
            </Card>
            <Card>
              <div className="text-xs font-bold text-slate-500r">{t("scm.spend.t.purchaseOrdersAnalyzed")}</div>
              <div className="mt-2 text-2xl font-black text-blue-600 font-mono">{totalPOs}</div>
            </Card>
            <Card>
              <div className="text-xs font-bold text-slate-500r">{t("scm.spend.t.itemsPurchasedVolume")}</div>
              <div className="mt-2 text-2xl font-black text-emerald-600 font-mono">{totalItems}</div>
            </Card>
          </div>

          <Card>
            <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.spend.t.historicalSpendTrendByPeriod")}</h3>
            <DataTable
              columns={snapshotColumns}
              rows={snapshots}
              keyOf={(r) => r.id}
              empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.spend.n.noSpendAnalyticsSnapshotsGeneratedYetCli")}</p>}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
