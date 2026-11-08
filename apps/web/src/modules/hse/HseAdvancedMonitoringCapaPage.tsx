/**
 * HSE Advanced — Monitoring & CAPA page.
 *
 * Monitoring points measure one parameter against a threshold; the breach flag
 * is computed and stored at write time so history keeps its verdict even if the
 * threshold is later widened (ADR-0027 §6).
 *
 * CAPA is deliberately separate from Core follow-up: it may anchor to an HSE
 * record, an investigation, an audit finding, a monitoring reading, or a Core
 * follow-up by reference only (ADR-0027 §1). At least one anchor is required.
 */

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
import { formatDate, formatDateShort } from "../../shared/format";
import { useAuth } from "../../auth/AuthContext";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";
import {
  ApiError,
  api,
  type CapaActionType,
  type CapaStatus,
  type HseCapa,
  type HseCapaDetail,
  type HseIndicatorSnapshot,
  type HseMonitoringPoint,
  type HseMonitoringReading,
} from "../../lib/api";
import { localDateTimeInputValue } from "../../shared/localDateTime";

const DECIMAL = /^-?\d{1,16}(\.\d{1,4})?$/;

const CAPA_STATUS_TONE: Record<CapaStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  open: "warning",
  in_progress: "info",
  verification: "info",
  closed: "success",
  cancelled: "neutral",
};

const CAPA_STATUS_LABEL_KEYS: Record<CapaStatus, MessageKey> = {
  open: "hse.capa.statusOpen",
  in_progress: "hse.capa.statusInProgress",
  verification: "hse.capa.statusVerification",
  closed: "hse.capa.statusClosed",
  cancelled: "hse.capa.statusCancelled",
};

const CAPA_STATUSES: CapaStatus[] = ["open", "in_progress", "verification", "closed", "cancelled"];

type ModalState =
  | { kind: "none" }
  | {
      kind: "create-point";
      code: string;
      name: string;
      parameterCode: string;
      unit: string;
      thresholdMin: string;
      thresholdMax: string;
    }
  | { kind: "point-detail"; pointId: string }
  | {
      kind: "create-capa";
      title: string;
      description: string;
      actionType: CapaActionType;
      anchorKind: "hseRecordId" | "investigationId" | "auditFindingId" | "monitoringReadingId" | "coreFollowUpId";
      anchorValue: string;
      rootCause: string;
      dueDate: string;
    }
  | { kind: "capa-detail"; capaId: string };

const nowLocal = () => localDateTimeInputValue();

export function HseAdvancedMonitoringCapaPage() {
  const { session } = useAuth();
  const token = session?.accessToken ?? "";
  const t = useT();

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const [points, setPoints] = useState<HseMonitoringPoint[]>([]);
  const [readings, setReadings] = useState<HseMonitoringReading[]>([]);
  const [capas, setCapas] = useState<HseCapa[]>([]);
  const [capaDetail, setCapaDetail] = useState<HseCapaDetail | null>(null);
  const [indicators, setIndicators] = useState<HseIndicatorSnapshot[]>([]);
  const [readingForm, setReadingForm] = useState({ measuredAt: nowLocal(), value: "", note: "" });
  const [actionForm, setActionForm] = useState({ description: "", dueDate: "" });

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [p, c, i] = await Promise.all([
        api.hseAdvMonitoringPoints(token),
        api.hseAdvCapas(token),
        api.hseAdvIndicators(token),
      ]);
      setPoints(p || []);
      setCapas(c || []);
      setIndicators(i || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.capa.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError ? err.message : fallback);

  const createPoint = async () => {
    if (modal.kind !== "create-point") return;
    if (!modal.code.trim() || !modal.name.trim() || !modal.parameterCode.trim() || !modal.unit.trim()) {
      setError(t("hse.capa.pointRequired"));
      return;
    }
    const min = modal.thresholdMin.trim();
    const max = modal.thresholdMax.trim();
    if (!min && !max) {
      setError(t("hse.capa.needThreshold"));
      return;
    }
    if ((min && !DECIMAL.test(min)) || (max && !DECIMAL.test(max))) {
      setError(t("hse.capa.thresholdFormat"));
      return;
    }
    if (min && max && Number(max) < Number(min)) {
      setError(t("hse.capa.thresholdOrder"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHseAdvMonitoringPoint(token, {
        code: modal.code.trim(),
        name: modal.name.trim(),
        parameterCode: modal.parameterCode.trim(),
        unit: modal.unit.trim(),
        thresholdMin: min || null,
        thresholdMax: max || null,
      });
      setNotice(t("hse.capa.pointCreated"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.capa.pointFailed"));
    } finally {
      setBusy(false);
    }
  };

  const openPoint = async (pointId: string) => {
    setBusy(true);
    setError(null);
    try {
      setReadings((await api.hseAdvReadings(token, pointId)) || []);
      setReadingForm({ measuredAt: nowLocal(), value: "", note: "" });
      setModal({ kind: "point-detail", pointId });
    } catch (err) {
      fail(err, t("hse.capa.readingsFailed"));
    } finally {
      setBusy(false);
    }
  };

  const recordReading = async (pointId: string) => {
    if (!readingForm.measuredAt) {
      setError(t("hse.capa.measuredAtRequired"));
      return;
    }
    if (!DECIMAL.test(readingForm.value.trim())) {
      setError(t("hse.capa.readingFormat"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.recordHseAdvReading(token, pointId, {
        measuredAt: new Date(readingForm.measuredAt).toISOString(),
        value: readingForm.value.trim(),
        note: readingForm.note.trim() || null,
      });
      setNotice(t("hse.capa.readingRecorded"));
      setReadingForm({ measuredAt: nowLocal(), value: "", note: "" });
      setReadings((await api.hseAdvReadings(token, pointId)) || []);
    } catch (err) {
      fail(err, t("hse.capa.readingFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createCapa = async () => {
    if (modal.kind !== "create-capa") return;
    if (!modal.title.trim()) {
      setError(t("hse.inv.titleRequired"));
      return;
    }
    if (!modal.anchorValue.trim()) {
      setError(t("hse.capa.anchorRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: modal.title.trim(),
        description: modal.description.trim() || null,
        actionType: modal.actionType,
        rootCause: modal.rootCause.trim() || null,
        dueDate: modal.dueDate || null,
        [modal.anchorKind]: modal.anchorValue.trim(),
      };
      await api.createHseAdvCapa(token, body);
      setNotice(t("hse.capa.raised"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.capa.raiseFailed"));
    } finally {
      setBusy(false);
    }
  };

  const openCapa = async (capaId: string) => {
    setBusy(true);
    setError(null);
    try {
      setCapaDetail(await api.hseAdvCapa(token, capaId));
      setActionForm({ description: "", dueDate: "" });
      setModal({ kind: "capa-detail", capaId });
    } catch (err) {
      fail(err, t("hse.capa.loadCapaFailed"));
    } finally {
      setBusy(false);
    }
  };

  const changeCapaStatus = async (capaId: string, status: CapaStatus) => {
    setBusy(true);
    setError(null);
    try {
      await api.changeHseAdvCapaStatus(token, capaId, { status });
      setCapaDetail(await api.hseAdvCapa(token, capaId));
      setNotice(t("hse.capa.statusChanged"));
      await load();
    } catch (err) {
      fail(err, t("hse.capa.statusFailed"));
    } finally {
      setBusy(false);
    }
  };

  const addAction = async (capaId: string) => {
    if (!actionForm.description.trim()) {
      setError(t("hse.capa.actionDescriptionRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addHseAdvCapaAction(token, capaId, {
        description: actionForm.description.trim(),
        dueDate: actionForm.dueDate || null,
      });
      setCapaDetail(await api.hseAdvCapa(token, capaId));
      setActionForm({ description: "", dueDate: "" });
      setNotice(t("hse.capa.actionAdded"));
    } catch (err) {
      fail(err, t("hse.capa.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const completeAction = async (capaId: string, actionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.completeHseAdvCapaAction(token, capaId, actionId, {});
      setCapaDetail(await api.hseAdvCapa(token, capaId));
      setNotice(t("hse.capa.actionCompleted"));
    } catch (err) {
      fail(err, t("hse.capa.actionCompleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  const pointColumns: Column<HseMonitoringPoint>[] = [
    { header: t("fin.common.code"), cell: (row) => <span className="font-mono text-sm">{row.code}</span> },
    { header: t("fin.common.name"), mobileRole: "title", cell: (row) => <span>{row.name}</span> },
    { header: t("hse.capa.colParameter"), cell: (row) => <span className="text-sm text-ink-dim">{row.parameterCode}</span> },
    {
      header: t("hse.capa.colThreshold"),
      className: "text-right",
      cell: (row) => (
        <span className="font-mono text-sm">
          {row.thresholdMin ?? "−∞"} … {row.thresholdMax ?? "+∞"} {row.unit}
        </span>
      ),
    },
    {
      header: "Status",
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={row.isActive ? "success" : "neutral"}>
          {row.isActive ? t("hse.inv.active") : t("hse.inv.inactive")}
        </StatusPill>
      ),
    },
    {
      header: t("fin.common.actions"),
      mobileRole: "detail",
      cell: (row) => (
        <Button variant="secondary" disabled={busy} onClick={() => void openPoint(row.id)}>
          {t("hse.capa.readings")}
        </Button>
      ),
    },
  ];

  const capaColumns: Column<HseCapa>[] = [
    { header: t("hse.register.colNumber"), cell: (row) => <span className="font-mono text-sm">{row.capaNumber}</span> },
    { header: t("hse.common.title"), mobileRole: "title", cell: (row) => <span>{row.title}</span> },
    { header: t("fin.common.type"),
      cell: (row) => (
        <Badge>{row.actionType === "preventive" ? t("hse.capa.preventive") : t("hse.capa.corrective")}</Badge>
      ) },
    {
      header: t("hse.common.due"),
      cell: (row) => (
        <span className="text-sm text-ink-dim">
          {row.dueDate ? formatDateShort(row.dueDate) : t("hse.common.notAvailable")}
        </span>
      ),
    },
    {
      header: "Status",
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={CAPA_STATUS_TONE[row.status]}>{t(CAPA_STATUS_LABEL_KEYS[row.status])}</StatusPill>
      ),
    },
    {
      header: t("fin.common.actions"),
      mobileRole: "detail",
      cell: (row) => (
        <Button variant="secondary" disabled={busy} onClick={() => void openCapa(row.id)}>
          {t("hse.capa.open")}
        </Button>
      ),
    },
  ];

  const indicatorColumns: Column<HseIndicatorSnapshot>[] = [
    {
      header: t("hse.capa.colWindow"),
      cell: (row) => (
        <span className="text-sm">
          {formatDateShort(row.windowStart)} → {formatDateShort(row.windowEnd)}
        </span>
      ),
    },
    {
      header: t("hse.capa.colExposure"),
      className: "text-right",
      cell: (row) => (
        <span className="font-mono text-sm">{row.exposureHours ?? t("hse.common.notAvailable")}</span>
      ),
    },
    {
      header: t("hse.capa.colIncidents"),
      className: "text-right",
      cell: (row) => <span className="font-mono text-sm">{row.incidentCount} / {row.lostTimeIncidentCount}</span>,
    },
    {
      header: t("hse.capa.colIfr"),
      className: "text-right",
      cell: (row) => (
        <span className="font-mono text-sm">{row.incidentFrequencyRate ?? t("hse.common.notAvailable")}</span>
      ),
    },
    {
      header: t("hse.capa.colSeverityRate"),
      className: "text-right",
      cell: (row) => (
        <span className="font-mono text-sm">{row.severityRate ?? t("hse.common.notAvailable")}</span>
      ),
    },
    {
      header: t("hse.capa.colClosure"),
      className: "text-right",
      cell: (row) => (
        <span className="font-mono text-sm">{row.capaClosureRate ?? t("hse.common.notAvailable")}</span>
      ),
    },
  ];

  const currentPoint = () => (modal.kind === "point-detail" ? points.find((p) => p.id === modal.pointId) : undefined);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("hse.capa.title")}
        subtitle={t("hse.capa.subtitle")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.capa.points")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  setModal({
                    kind: "create-point",
                    code: "",
                    name: "",
                    parameterCode: "",
                    unit: "",
                    thresholdMin: "",
                    thresholdMax: "",
                  })
                }
              >
                + {t("hse.capa.addPoint")}
              </Button>
            </div>
            <DataTable
              columns={pointColumns}
              rows={points}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("hse.capa.noPointsTitle")} description={t("hse.capa.noPointsDescription")} />}
            />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.capa.capa")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  setModal({
                    kind: "create-capa",
                    title: "",
                    description: "",
                    actionType: "corrective",
                    anchorKind: "hseRecordId",
                    anchorValue: "",
                    rootCause: "",
                    dueDate: "",
                  })
                }
              >
                + {t("hse.capa.addCapa")}
              </Button>
            </div>
            <DataTable
              columns={capaColumns}
              rows={capas}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("hse.capa.noCapaTitle")} description={t("hse.capa.noCapaDescription")} />}
            />
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.capa.indicators")}</h2>
            <DataTable
              columns={indicatorColumns}
              rows={indicators}
              keyOf={(row) => row.id}
              empty={
                <EmptyState
                  title={t("hse.capa.noSnapshotsTitle")}
                  description={t("hse.capa.noSnapshotsDescription")}
                />
              }
            />
          </div>
        </div>
      )}

      {modal.kind === "create-point" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.capa.createPoint")}</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("fin.common.code")} required>
                <Input value={modal.code} onChange={(e) => setModal({ ...modal, code: e.target.value })} />
              </Field>
              <Field label={t("fin.common.name")} required>
                <Input value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("hse.capa.parameterCode")} required hint={t("hse.capa.parameterHint")}>
                <Input
                  value={modal.parameterCode}
                  onChange={(e) => setModal({ ...modal, parameterCode: e.target.value })}
                />
              </Field>
              <Field label={t("hse.capa.unit")} required>
                <Input value={modal.unit} onChange={(e) => setModal({ ...modal, unit: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("hse.capa.thresholdMin")} hint={t("hse.capa.thresholdMinHint")}>
                <Input
                  inputMode="decimal"
                  value={modal.thresholdMin}
                  onChange={(e) => setModal({ ...modal, thresholdMin: e.target.value })}
                />
              </Field>
              <Field label={t("hse.capa.thresholdMax")} hint={t("hse.capa.thresholdMaxHint")}>
                <Input
                  inputMode="decimal"
                  value={modal.thresholdMax}
                  onChange={(e) => setModal({ ...modal, thresholdMax: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => createPoint()}>
              {t("fin.common.create")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "point-detail" ? (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              {t("hse.capa.readingsFor", {
                name: currentPoint()?.name ?? "",
                unit: currentPoint()?.unit ?? "",
              })}
            </h2>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.close")}
            </Button>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label={t("hse.capa.measuredAt")} required>
              <Input
                type="datetime-local"
                value={readingForm.measuredAt}
                onChange={(e) => setReadingForm({ ...readingForm, measuredAt: e.target.value })}
              />
            </Field>
            <Field label={t("hse.capa.value")} required>
              <Input
                inputMode="decimal"
                value={readingForm.value}
                onChange={(e) => setReadingForm({ ...readingForm, value: e.target.value })}
              />
            </Field>
            <Field label={t("hse.capa.note")}>
              <Input
                value={readingForm.note}
                onChange={(e) => setReadingForm({ ...readingForm, note: e.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <Button disabled={busy} onClick={() => recordReading(modal.pointId)}>
                {t("hse.capa.recordReading")}
              </Button>
            </div>
          </div>

          {readings.length === 0 ? (
            <EmptyState title={t("hse.capa.noReadingsTitle")} description={t("hse.capa.noReadingsDescription")} />
          ) : (
            <ul className="divide-y divide-line">
              {readings.map((reading) => (
                <li key={reading.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="text-ink-dim">{formatDate(reading.measuredAt)}</span>
                  <span className="font-mono text-ink">
                    {reading.value} {currentPoint()?.unit ?? ""}
                  </span>
                  {reading.isBreach ? (
                    <StatusPill tone="danger">{t("hse.capa.breach")}</StatusPill>
                  ) : (
                    <StatusPill tone="success">{t("hse.capa.within")}</StatusPill>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {modal.kind === "create-capa" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.capa.raiseCapa")}</h2>
          <div className="space-y-3">
            <Field label={t("hse.common.title")} required>
              <Input value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} />
            </Field>
            <Field label={t("fin.common.description")}>
              <Textarea
                rows={2}
                value={modal.description}
                onChange={(e) => setModal({ ...modal, description: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("hse.capa.actionType")} required>
                <Select
                  value={modal.actionType}
                  onChange={(e) => setModal({ ...modal, actionType: e.target.value as CapaActionType })}
                >
                  <option value="corrective">{t("hse.capa.corrective")}</option>
                  <option value="preventive">{t("hse.capa.preventive")}</option>
                </Select>
              </Field>
              <Field label={t("hse.capa.dueDate")}>
                <Input type="date" value={modal.dueDate} onChange={(e) => setModal({ ...modal, dueDate: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("hse.capa.anchoredTo")} required hint={t("hse.capa.anchorHint")}>
                <Select
                  value={modal.anchorKind}
                  onChange={(e) =>
                    setModal({
                      ...modal,
                      anchorKind: e.target.value as typeof modal.anchorKind,
                      anchorValue: "",
                    })
                  }
                >
                  <option value="hseRecordId">{t("hse.capa.anchorHseRecord")}</option>
                  <option value="investigationId">{t("hse.capa.anchorInvestigation")}</option>
                  <option value="auditFindingId">{t("hse.capa.anchorAuditFinding")}</option>
                  <option value="monitoringReadingId">{t("hse.capa.anchorReading")}</option>
                  <option value="coreFollowUpId">{t("hse.capa.anchorFollowUp")}</option>
                </Select>
              </Field>
              <Field label={t("hse.capa.anchorId")} required>
                <Input
                  value={modal.anchorValue}
                  onChange={(e) => setModal({ ...modal, anchorValue: e.target.value })}
                  placeholder={t("hse.capa.anchorIdPlaceholder")}
                />
              </Field>
            </div>
            <Field label={t("hse.capa.rootCause")}>
              <Textarea
                rows={2}
                value={modal.rootCause}
                onChange={(e) => setModal({ ...modal, rootCause: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => createCapa()}>
              {t("hse.capa.raise")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "capa-detail" && capaDetail ? (
        <Card>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                {capaDetail.capa.capaNumber} · {capaDetail.capa.title}
              </h2>
              <p className="mt-0.5 text-sm text-ink-dim">
                {capaDetail.capa.rootCause ?? t("hse.capa.noRootCause")}
              </p>
            </div>
            <StatusPill tone={CAPA_STATUS_TONE[capaDetail.capa.status]}>
              {t(CAPA_STATUS_LABEL_KEYS[capaDetail.capa.status])}
            </StatusPill>
          </div>

          <div className="mb-4 flex flex-wrap items-end gap-2">
            <Field label={t("hse.capa.changeStatus")}>
              <Select
                value={capaDetail.capa.status}
                disabled={busy}
                onChange={(e) => changeCapaStatus(capaDetail.capa.id, e.target.value as CapaStatus)}
              >
                {CAPA_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(CAPA_STATUS_LABEL_KEYS[status])}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="space-y-3 border-t border-line pt-3">
            <h3 className="text-sm font-semibold text-ink">{t("hse.capa.actions")}</h3>
            {capaDetail.actions.length === 0 ? (
              <p className="text-sm text-ink-dim">{t("hse.capa.noActions")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {capaDetail.actions.map((action) => (
                  <li key={action.id} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <div className="text-sm text-ink">{action.description}</div>
                      <div className="text-xs text-ink-dim">
                        {action.dueDate
                          ? `${t("hse.common.due")} ${formatDateShort(action.dueDate)}`
                          : t("hse.capa.noDueDate")}
                      </div>
                    </div>
                    {action.completedAt ? (
                      <StatusPill tone="success">{t("hse.capa.done")}</StatusPill>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => completeAction(capaDetail.capa.id, action.id)}
                      >
                        {t("hse.capa.complete")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Field label={t("hse.capa.newAction")}>
                <Input
                  value={actionForm.description}
                  onChange={(e) => setActionForm({ ...actionForm, description: e.target.value })}
                />
              </Field>
              <Field label={t("hse.capa.dueDate")}>
                <Input
                  type="date"
                  value={actionForm.dueDate}
                  onChange={(e) => setActionForm({ ...actionForm, dueDate: e.target.value })}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  variant="secondary"
                  disabled={busy || capaDetail.capa.status === "closed" || capaDetail.capa.status === "cancelled"}
                  onClick={() => addAction(capaDetail.capa.id)}
                >
                  + {t("hse.capa.addAction")}
                </Button>
              </div>
            </div>
          </div>

          <div className="mt-3">
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.close")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
