/**
 * Wave A3 — Asset Advanced Performance & Reliability (AST-ADV-003…007).
 *
 * Dedicated surface for meter tracking, downtime recording, deterministic
 * reliability calculations (MTBF, MTTR, Availability), and advisory snapshots.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AssetDetail,
  type AssetDowntimeRecord,
  type AssetMeterReading,
  type AssetPredictiveSnapshot,
  type DowntimeReasonCategory,
  type MeterReadingType,
  type ReliabilityMetrics,
} from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
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
import { formatDate, formatDateShort } from "../../shared/format";

const METER_TYPES: MeterReadingType[] = ["hours", "km", "cycles"];
const DOWNTIME_REASONS: DowntimeReasonCategory[] = [
  "breakdown",
  "scheduled_maintenance",
  "power_failure",
  "operator_error",
  "other",
];

function label(v: string | null | undefined): string {
  return v ? v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—";
}

export function AssetPerformancePage() {
  const { assetId } = useParams<{ assetId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();

  const canManageMeters = permissions.includes(PERMISSIONS.assetMeterManage);
  const canManageDowntime = permissions.includes(PERMISSIONS.assetDowntimeManage);
  const canReadAnalytics = permissions.includes(PERMISSIONS.assetAnalyticsRead);

  const [assetDetail, setAssetDetail] = useState<AssetDetail | null>(null);
  const [meterReadings, setMeterReadings] = useState<AssetMeterReading[]>([]);
  const [downtimeRecords, setDowntimeRecords] = useState<AssetDowntimeRecord[]>([]);
  const [reliability, setReliability] = useState<ReliabilityMetrics | null>(null);
  const [snapshots, setSnapshots] = useState<AssetPredictiveSnapshot[]>([]);
  const [latestSnapshot, setLatestSnapshot] = useState<AssetPredictiveSnapshot | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Meter form
  const [readingType, setReadingType] = useState<MeterReadingType>("hours");
  const [readingValue, setReadingValue] = useState("");
  const [readingDate, setReadingDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [meterNotes, setMeterNotes] = useState("");

  // Downtime form
  const [downtimeStart, setDowntimeStart] = useState(() => new Date().toISOString().slice(0, 16));
  const [downtimeEnd, setDowntimeEnd] = useState("");
  const [downtimeReason, setDowntimeReason] = useState<DowntimeReasonCategory>("breakdown");
  const [downtimeNotes, setDowntimeNotes] = useState("");
  const [closeEndTimes, setCloseEndTimes] = useState<Record<string, string>>({});

  // Reliability period controls
  const [periodStart, setPeriodStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    if (!assetId) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, readings, downtime] = await Promise.all([
        api.asset(token, assetId),
        api.assetMeterReadings(token, assetId),
        api.assetDowntime(token, assetId),
      ]);
      setAssetDetail(detail);
      setMeterReadings(readings);
      setDowntimeRecords(downtime);

      if (canReadAnalytics) {
        try {
          const [rel, snaps, latest] = await Promise.all([
            api.assetReliability(token, assetId, periodStart, periodEnd),
            api.assetPredictiveSnapshots(token, assetId, 10),
            api.latestAssetPredictiveSnapshot(token, assetId),
          ]);
          setReliability(rel);
          setSnapshots(snaps);
          setLatestSnapshot(latest);
        } catch {
          // Analytics might be denied or uncalculated
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.perf.msg.couldNotLoadAssetPerformanceData"));
    } finally {
      setLoading(false);
    }
  }, [token, assetId, canReadAnalytics, periodStart, periodEnd, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function recordMeter() {
    if (!assetId || !canManageMeters) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.recordAssetMeterReading(token, assetId, {
        readingType,
        readingValue: Number(readingValue),
        readingDate: readingDate ? new Date(readingDate).toISOString() : undefined,
        notes: meterNotes || null,
      });
      setNotice(t("sca.perf.msg.meterReadingRecorded"));
      setReadingValue("");
      setMeterNotes("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.perf.msg.couldNotRecordMeterReading"));
    } finally {
      setBusy(false);
    }
  }

  async function recordDowntime() {
    if (!assetId || !canManageDowntime) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.recordAssetDowntime(token, assetId, {
        startTime: new Date(downtimeStart).toISOString(),
        endTime: downtimeEnd ? new Date(downtimeEnd).toISOString() : null,
        reasonCategory: downtimeReason,
        notes: downtimeNotes || null,
      });
      setNotice(t("sca.perf.msg.downtimeRecordCreated"));
      setDowntimeNotes("");
      setDowntimeEnd("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.perf.msg.couldNotRecordDowntime"));
    } finally {
      setBusy(false);
    }
  }

  async function closeDowntime(id: string) {
    if (!canManageDowntime) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const chosen = closeEndTimes[id];
      await api.closeAssetDowntime(
        token,
        id,
        chosen ? new Date(chosen).toISOString() : new Date().toISOString(),
      );
      setNotice(t("sca.perf.msg.downtimeRecordClosed"));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.perf.msg.couldNotCloseDowntime"));
    } finally {
      setBusy(false);
    }
  }

  async function generateSnapshot() {
    if (!assetId || !canReadAnalytics) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const snap = await api.generateAssetPredictiveSnapshot(token, assetId);
      setNotice(`Predictive snapshot generated with Health Score ${snap.healthScore}/100.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.perf.msg.couldNotGenerateSnapshot"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label={t("sca.perf.f.loadingAssetPerformance")} />;
  if (!assetDetail) return <Alert tone="error">{error ?? "Asset not found."}</Alert>;

  const { asset } = assetDetail;

  const meterColumns: Column<AssetMeterReading>[] = [
    { header: t("sca.perf.h.type"), cell: (row) => <Badge>{label(row.readingType)}</Badge>, mobileRole: "title" },
    { header: t("sca.perf.h.value"), cell: (row) => <span className="font-semibold text-slate-900">{row.readingValue.toLocaleString()} {row.readingType}</span>, mobileRole: "status" },
    { header: t("sca.perf.h.date"), cell: (row) => formatDate(row.readingDate) },
    { header: t("sca.perf.h.notes"), cell: (row) => row.notes ?? "—" },
  ];

  const downtimeColumns: Column<AssetDowntimeRecord>[] = [
    { header: t("sca.perf.h.reason"), cell: (row) => <span className="font-semibold text-slate-900">{label(row.reasonCategory)}</span>, mobileRole: "title" },
    { header: t("sca.perf.h.start"), cell: (row) => formatDate(row.startTime) },
    { header: t("sca.perf.h.end"), cell: (row) => row.endTime ? formatDate(row.endTime) : <Badge className="bg-amber-100 text-amber-800">Ongoing</Badge>, mobileRole: "status" },
    { header: t("sca.perf.h.duration"), cell: (row) => row.durationMinutes != null ? `${row.durationMinutes} min` : "—" },
    { header: t("sca.perf.h.notes"), cell: (row) => row.notes ?? "—" },
    {
      header: t("sca.perf.h.action"),
      cell: (row) =>
        !row.endTime && canManageDowntime ? (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Input
              type="datetime-local"
              className="w-44 text-xs"
              value={closeEndTimes[row.id] ?? ""}
              onChange={(e) => setCloseEndTimes((prev) => ({ ...prev, [row.id]: e.target.value }))}
            />
            <Button variant="secondary" disabled={busy} onClick={() => void closeDowntime(row.id)}>
              Close
            </Button>
          </div>
        ) : null,
    },
  ];

  const snapshotColumns: Column<AssetPredictiveSnapshot>[] = [
    { header: t("sca.perf.h.analysisDate"), cell: (row) => formatDateShort(row.analysisDate), mobileRole: "title" },
    {
      header: t("sca.perf.h.healthScore"),
      cell: (row) => (
        <StatusPill tone={row.healthScore >= 75 ? "success" : row.healthScore >= 50 ? "warning" : "danger"}>
          {row.healthScore}/100
        </StatusPill>
      ),
      mobileRole: "status",
    },
    { header: "MTBF", cell: (row) => row.mtbfHours != null ? `${row.mtbfHours}h` : "—" },
    { header: "MTTR", cell: (row) => row.mttrHours != null ? `${row.mttrHours}h` : "—" },
    { header: t("sca.perf.h.availability"), cell: (row) => row.availabilityPct != null ? `${row.availabilityPct}%` : "—" },
    { header: t("sca.perf.h.predictedFailure"), cell: (row) => row.predictedFailureDate ? formatDateShort(row.predictedFailureDate) : "None" },
    { header: t("sca.perf.h.confidence"), cell: (row) => row.confidencePct != null ? `${row.confidencePct}%` : "—" },
    { header: t("sca.perf.h.recommendation"), cell: (row) => <p className="max-w-xs text-xs text-slate-600">{row.recommendation ?? "—"}</p> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${asset.assetNumber} — ${asset.name}`}
        subtitle={t("sca.perf.sub.metersDowntimeTrackingReliabilityAnalyti")}
        actions={
          <div className="flex items-center gap-2">
            <Link to={`/assets/${asset.id}`}>
              <Button variant="secondary">{t("sca.perf.t.assetDetail")}</Button>
            </Link>
            <Link to="/asset-maintenance">
              <Button variant="ghost">{t("sca.perf.t.maintenanceCenter")}</Button>
            </Link>
          </div>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {/* Reliability & Predictive Section */}
      {canReadAnalytics ? (
        <Card className="border-slate-300">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{t("sca.perf.t.reliabilityAmpPredictiveAnalytics")}</h2>
              <p className="text-xs text-slate-500">
                Deterministic MTBF/MTTR metrics and advisory health scoring based on downtime &amp; failure history.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Field label={t("sca.perf.f.from")}>
                <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </Field>
              <Field label={t("sca.perf.f.to")}>
                <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button disabled={busy} onClick={() => void generateSnapshot()}>
                  {busy ? "Analyzing…" : "Generate Predictive Snapshot"}
                </Button>
              </div>
            </div>
          </div>

          {reliability ? (
            <div className="mt-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4 lg:grid-cols-6">
              <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-mediumr text-slate-400">{t("sca.perf.t.availability")}</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{reliability.availabilityPct}%</div>
              </div>
              <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-mediumr text-slate-400">MTBF</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{reliability.mtbfHours} hrs</div>
              </div>
              <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-mediumr text-slate-400">MTTR</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{reliability.mttrHours} hrs</div>
              </div>
              <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-mediumr text-slate-400">{t("sca.perf.t.failures")}</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{reliability.correctiveFailureCount}</div>
              </div>
              <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-mediumr text-slate-400">{t("sca.perf.t.downtime")}</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{reliability.downtimeHours} hrs</div>
              </div>
              <div className="rounded-md border border-slate-100 bg-slate-50 p-3">
                <div className="text-xs font-mediumr text-slate-400">{t("sca.perf.t.operating")}</div>
                <div className="mt-1 text-lg font-bold text-slate-900">{reliability.operationalHours} hrs</div>
              </div>
            </div>
          ) : null}

          {latestSnapshot ? (
            <div className="mt-4 rounded-md border border-blue-100 bg-blue-50/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-blue-950">{t("sca.perf.t.latestPredictiveAdvisory")}</span>
                  <StatusPill tone={latestSnapshot.healthScore >= 75 ? "success" : latestSnapshot.healthScore >= 50 ? "warning" : "danger"}>
                    Health Score {latestSnapshot.healthScore}/100
                  </StatusPill>
                </div>
                <span className="text-xs text-blue-700">
                  Confidence: {latestSnapshot.confidencePct}% · Predicted Failure:{" "}
                  {latestSnapshot.predictedFailureDate ? formatDateShort(latestSnapshot.predictedFailureDate) : "None projected"}
                </span>
              </div>
              <p className="mt-2 text-sm text-blue-900">{latestSnapshot.recommendation}</p>
            </div>
          ) : null}

          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semiboldr text-slate-500">{t("sca.perf.t.historicalSnapshots")}</h3>
            <DataTable
              columns={snapshotColumns}
              rows={snapshots}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("sca.perf.title.noPredictiveSnapshots")} description={t("sca.perf.d.generateASnapshotAboveToEvaluateThisAsse")} />}
            />
          </div>
        </Card>
      ) : null}

      {/* Meter Readings and Downtime Tracking side-by-side */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Meter Readings */}
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">{t("sca.perf.t.meterReadings")}</h2>
            <Badge>{meterReadings.length} readings</Badge>
          </div>

          {canManageMeters ? (
            <div className="mb-4 grid grid-cols-1 gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3">
              <Field label={t("sca.perf.f.meterType")}>
                <Select value={readingType} onChange={(e) => setReadingType(e.target.value as MeterReadingType)}>
                  {METER_TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}
                </Select>
              </Field>
              <Field label={t("sca.perf.f.value")} required>
                <Input type="number" min="0" step="0.01" value={readingValue} onChange={(e) => setReadingValue(e.target.value)} />
              </Field>
              <Field label={t("sca.perf.f.readingDate")}>
                <Input type="datetime-local" value={readingDate} onChange={(e) => setReadingDate(e.target.value)} />
              </Field>
              <div className="sm:col-span-3">
                <Field label={t("sca.perf.f.notes")}>
                  <Input value={meterNotes} onChange={(e) => setMeterNotes(e.target.value)} />
                </Field>
              </div>
              <div className="sm:col-span-3">
                <Button disabled={busy || !readingValue} onClick={() => void recordMeter()}>
                  Record Monotonic Reading
                </Button>
              </div>
            </div>
          ) : null}

          <DataTable
            columns={meterColumns}
            rows={meterReadings}
            keyOf={(row) => row.id}
            empty={<EmptyState title={t("sca.perf.title.noMeterReadings")} description={t("sca.perf.d.recordUsageHoursKilometersOrCyclesToTrig")} />}
          />
        </Card>

        {/* Downtime Records */}
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">{t("sca.perf.t.downtimeRecords")}</h2>
            <Badge>{downtimeRecords.length} records</Badge>
          </div>

          {canManageDowntime ? (
            <div className="mb-4 grid grid-cols-1 gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
              <Field label={t("sca.perf.f.reasonCategory")}>
                <Select value={downtimeReason} onChange={(e) => setDowntimeReason(e.target.value as DowntimeReasonCategory)}>
                  {DOWNTIME_REASONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                </Select>
              </Field>
              <Field label={t("sca.perf.f.startTime")} required>
                <Input type="datetime-local" value={downtimeStart} onChange={(e) => setDowntimeStart(e.target.value)} />
              </Field>
              <Field label={t("sca.perf.f.endTimeOptional")}>
                <Input type="datetime-local" value={downtimeEnd} onChange={(e) => setDowntimeEnd(e.target.value)} />
              </Field>
              <Field label={t("sca.perf.f.notes")}>
                <Input value={downtimeNotes} onChange={(e) => setDowntimeNotes(e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <Button disabled={busy || !downtimeStart} onClick={() => void recordDowntime()}>
                  Record Downtime
                </Button>
              </div>
            </div>
          ) : null}

          <DataTable
            columns={downtimeColumns}
            rows={downtimeRecords}
            keyOf={(row) => row.id}
            empty={<EmptyState title={t("sca.perf.title.noDowntimeRecorded")} description={t("sca.perf.d.recordBreakdownOrMaintenanceDowntimeForM")} />}
          />
        </Card>
      </div>
    </div>
  );
}
