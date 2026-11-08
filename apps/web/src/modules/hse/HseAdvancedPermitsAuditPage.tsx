/**
 * HSE Advanced — Permits & Audit page.
 *
 * Work permits carry no local lifecycle state: the Workflow Engine owns it and
 * the permit only stores `workflowInstanceId` (ADR-0027 §4). This page reads the
 * engine's status and offers the actions it says are available.
 *
 * Audit programmes are scheduled templates; occurrences are the realised
 * inspections and findings are the recorded gaps (ADR-0027 §5).
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
import { formatDate, formatDateShort, statusTone } from "../../shared/format";
import { useAuth } from "../../auth/AuthContext";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";
import {
  ApiError,
  api,
  type AuditChecklistItem,
  type AuditFindingType,
  type AuditProgrammeType,
  type HseAuditFinding,
  type HseAuditOccurrence,
  type HseAuditProgramme,
  type HsePermit,
  type HsePermitDetail,
} from "../../lib/api";
import { localDateInputValue, localDateTimeInputValue } from "../../shared/localDateTime";

const PERMIT_TYPES: { code: string; labelKey: MessageKey }[] = [
  { code: "hot_work", labelKey: "hse.permit.typeHotWork" },
  { code: "confined_space", labelKey: "hse.permit.typeConfinedSpace" },
  { code: "work_at_height", labelKey: "hse.permit.typeWorkAtHeight" },
  { code: "electrical_isolation", labelKey: "hse.permit.typeElectricalIsolation" },
  { code: "excavation", labelKey: "hse.permit.typeExcavation" },
  { code: "general", labelKey: "hse.permit.typeGeneral" },
];

const FINDING_TYPE_LABEL_KEYS: Record<AuditFindingType, MessageKey> = {
  observation: "hse.permit.findingObservation",
  nonconformity: "hse.permit.findingNonconformity",
  major_nonconformity: "hse.permit.findingMajor",
};

const FINDING_TYPE_TONE: Record<AuditFindingType, "neutral" | "warning" | "danger"> = {
  observation: "neutral",
  nonconformity: "warning",
  major_nonconformity: "danger",
};

type ModalState =
  | { kind: "none" }
  | {
      kind: "create-permit";
      permitTypeCode: string;
      title: string;
      description: string;
      locationDetail: string;
      validFrom: string;
      validTo: string;
    }
  | { kind: "permit-detail"; permitId: string }
  | {
      kind: "create-programme";
      code: string;
      name: string;
      programmeType: AuditProgrammeType;
      frequencyDays: string;
      checklist: AuditChecklistItem[];
    }
  | { kind: "programme-detail"; programmeId: string }
  | { kind: "occurrence-detail"; occurrenceId: string; programmeId: string };

const today = () => localDateInputValue();
const nowLocal = () => localDateTimeInputValue();

export function HseAdvancedPermitsAuditPage() {
  const { session } = useAuth();
  const token = session?.accessToken ?? "";
  const t = useT();

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const [permits, setPermits] = useState<HsePermit[]>([]);
  const [permitDetail, setPermitDetail] = useState<HsePermitDetail | null>(null);
  const [programmes, setProgrammes] = useState<HseAuditProgramme[]>([]);
  const [occurrences, setOccurrences] = useState<HseAuditOccurrence[]>([]);
  const [findings, setFindings] = useState<HseAuditFinding[]>([]);
  const [occurrenceResults, setOccurrenceResults] = useState<Record<string, string>>({});
  const [occurrenceNotes, setOccurrenceNotes] = useState("");
  const [newFinding, setNewFinding] = useState<{ findingType: AuditFindingType; checklistItemCode: string; description: string }>({
    findingType: "observation",
    checklistItemCode: "",
    description: "",
  });

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [p, g] = await Promise.all([api.hseAdvPermits(token), api.hseAdvProgrammes(token)]);
      setPermits(p || []);
      setProgrammes(g || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.permit.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError ? err.message : fallback);

  const openPermit = async (permitId: string) => {
    setBusy(true);
    setError(null);
    try {
      setPermitDetail(await api.hseAdvPermit(token, permitId));
      setModal({ kind: "permit-detail", permitId });
    } catch (err) {
      fail(err, t("hse.permit.permitFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createPermit = async () => {
    if (modal.kind !== "create-permit") return;
    if (!modal.permitTypeCode || !modal.title.trim()) {
      setError(t("hse.permit.permitRequired"));
      return;
    }
    if (!modal.validFrom || !modal.validTo) {
      setError(t("hse.permit.validityRequired"));
      return;
    }
    if (modal.validTo <= modal.validFrom) {
      setError(t("hse.permit.validityOrder"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const permit = await api.createHseAdvPermit(token, {
        permitTypeCode: modal.permitTypeCode,
        title: modal.title.trim(),
        description: modal.description.trim() || null,
        locationDetail: modal.locationDetail.trim() || null,
        // Inputs hold local "YYYY-MM-DDTHH:mm"; send the instant so the timezone is kept.
        validFrom: new Date(modal.validFrom).toISOString(),
        validTo: new Date(modal.validTo).toISOString(),
      });
      setNotice(t("hse.permit.raised", { number: permit.permitNumber }));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.permit.raiseFailed"));
    } finally {
      setBusy(false);
    }
  };

  const startLifecycle = async (permitId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.startHseAdvPermitLifecycle(token, permitId);
      setNotice(t("hse.permit.lifecycleStarted"));
      await openPermit(permitId);
      await load();
    } catch (err) {
      fail(err, t("hse.permit.lifecycleFailed"));
    } finally {
      setBusy(false);
    }
  };

  const actOnPermit = async (permitId: string, actionCode: string) => {
    setBusy(true);
    setError(null);
    try {
      setPermitDetail(await api.actOnHseAdvPermit(token, permitId, actionCode));
      setNotice(t("hse.permit.actionApplied"));
      await load();
    } catch (err) {
      fail(err, t("hse.permit.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createProgramme = async () => {
    if (modal.kind !== "create-programme") return;
    const frequencyDays = Number(modal.frequencyDays);
    if (!modal.code.trim() || !modal.name.trim()) {
      setError(t("hse.inv.codeNameRequired"));
      return;
    }
    if (!Number.isInteger(frequencyDays) || frequencyDays <= 0) {
      setError(t("hse.permit.frequencyPositive"));
      return;
    }
    const codes = modal.checklist.map((item) => item.code.trim()).filter(Boolean);
    if (new Set(codes).size !== codes.length) {
      setError(t("hse.permit.checklistUnique"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHseAdvProgramme(token, {
        code: modal.code.trim(),
        name: modal.name.trim(),
        programmeType: modal.programmeType,
        frequencyDays,
        checklist: modal.checklist
          .filter((item) => item.code.trim() && item.question.trim())
          .map((item) => ({ code: item.code.trim(), question: item.question.trim(), isMandatory: item.isMandatory })),
      });
      setNotice(t("hse.permit.programmeCreated"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.permit.programmeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const openProgramme = async (programmeId: string) => {
    setBusy(true);
    setError(null);
    try {
      setOccurrences((await api.hseAdvOccurrences(token, programmeId)) || []);
      setModal({ kind: "programme-detail", programmeId });
    } catch (err) {
      fail(err, t("hse.permit.occurrencesFailed"));
    } finally {
      setBusy(false);
    }
  };

  const scheduleOccurrence = async (programmeId: string) => {
    const scheduledFor = window.prompt(t("hse.permit.schedulePrompt"), today());
    if (!scheduledFor) return;
    setBusy(true);
    setError(null);
    try {
      await api.scheduleHseAdvOccurrence(token, programmeId, scheduledFor);
      setNotice(t("hse.permit.scheduled"));
      await openProgramme(programmeId);
    } catch (err) {
      fail(err, t("hse.permit.scheduleFailed"));
    } finally {
      setBusy(false);
    }
  };

  const openOccurrence = async (occurrenceId: string, programmeId: string) => {
    setBusy(true);
    setError(null);
    try {
      setFindings((await api.hseAdvFindings(token, occurrenceId)) || []);
      setOccurrenceResults({});
      setOccurrenceNotes("");
      setNewFinding({ findingType: "observation", checklistItemCode: "", description: "" });
      setModal({ kind: "occurrence-detail", occurrenceId, programmeId });
    } catch (err) {
      fail(err, t("hse.permit.occurrenceLoadFailed"));
    } finally {
      setBusy(false);
    }
  };

  const completeOccurrence = async (occurrenceId: string, programmeId: string) => {
    const programme = programmes.find((p) => p.id === programmeId);
    if (!programme) return;
    const results = programme.checklist
      .filter((item) => occurrenceResults[item.code])
      .map((item) => ({ itemCode: item.code, result: occurrenceResults[item.code], note: null }));
    const unanswered = programme.checklist.filter(
      (item) => item.isMandatory && !occurrenceResults[item.code],
    );
    if (unanswered.length > 0) {
      setError(t("hse.permit.mandatoryMissing", { codes: unanswered.map((i) => i.code).join(", ") }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.completeHseAdvOccurrence(token, occurrenceId, { results, notes: occurrenceNotes.trim() || null });
      setNotice(t("hse.permit.occurrenceCompleted"));
      await openProgramme(programmeId);
    } catch (err) {
      fail(err, t("hse.permit.occurrenceCompleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  const addFinding = async (occurrenceId: string) => {
    if (!newFinding.description.trim()) {
      setError(t("hse.permit.findingDescriptionRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHseAdvFinding(token, occurrenceId, {
        findingType: newFinding.findingType,
        checklistItemCode: newFinding.checklistItemCode || null,
        description: newFinding.description.trim(),
      });
      setNotice(t("hse.permit.findingRecorded"));
      setFindings((await api.hseAdvFindings(token, occurrenceId)) || []);
      setNewFinding({ findingType: "observation", checklistItemCode: "", description: "" });
    } catch (err) {
      fail(err, t("hse.permit.findingFailed"));
    } finally {
      setBusy(false);
    }
  };

  const permitColumns: Column<HsePermit>[] = [
    { header: t("hse.register.colNumber"), cell: (row) => <span className="font-mono text-sm">{row.permitNumber}</span> },
    { header: t("hse.common.title"), mobileRole: "title", cell: (row) => <span>{row.title}</span> },
    {
      header: t("fin.common.type"),
      cell: (row) => {
        const pt = PERMIT_TYPES.find((p) => p.code === row.permitTypeCode);
        return <Badge>{pt ? t(pt.labelKey) : row.permitTypeCode}</Badge>;
      },
    },
    {
      header: t("hse.permit.colValid"),
      cell: (row) => (
        <span className="text-sm text-ink-dim">
          {formatDateShort(row.validFrom)} → {formatDateShort(row.validTo)}
        </span>
      ),
    },
    {
      header: t("hse.permit.colLifecycle"),
      mobileRole: "status",
      cell: (row) =>
        row.workflowInstanceId ? (
          <StatusPill tone="info">{t("hse.permit.inWorkflow")}</StatusPill>
        ) : (
          <StatusPill tone="neutral">{t("hse.permit.notStarted")}</StatusPill>
        ),
    },
    {
      header: t("fin.common.actions"),
      mobileRole: "detail",
      cell: (row) => (
        <Button variant="secondary" disabled={busy} onClick={() => void openPermit(row.id)}>
          {t("hse.capa.open")}
        </Button>
      ),
    },
  ];

  const programmeColumns: Column<HseAuditProgramme>[] = [
    { header: t("fin.common.code"), cell: (row) => <span className="font-mono text-sm">{row.code}</span> },
    { header: t("fin.common.name"), mobileRole: "title", cell: (row) => <span>{row.name}</span> },
    {
      header: t("fin.common.type"),
      cell: (row) => (
        <Badge>{row.programmeType === "audit" ? t("hse.permit.audit") : t("hse.permit.inspection")}</Badge>
      ),
    },
    {
      header: t("hse.permit.colFrequency"),
      className: "text-right",
      cell: (row) => <span className="text-sm">{t("hse.permit.days", { count: row.frequencyDays })}</span>,
    },
    {
      header: t("hse.permit.colLastScheduled"),
      cell: (row) => (
        <span className="text-sm text-ink-dim">
          {row.lastScheduledFor ? formatDateShort(row.lastScheduledFor) : t("hse.common.notAvailable")}
        </span>
      ),
    },
    {
      header: t("fin.common.status"),
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
        <Button variant="secondary" disabled={busy} onClick={() => void openProgramme(row.id)}>
          {t("hse.permit.colOccurrences")}
        </Button>
      ),
    },
  ];

  const currentProgramme = (programmeId: string) => programmes.find((p) => p.id === programmeId);
  const currentOccurrence = () =>
    modal.kind === "occurrence-detail" ? occurrences.find((o) => o.id === modal.occurrenceId) : undefined;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("hse.permit.title")}
        subtitle={t("hse.permit.subtitle")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.permit.permits")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  setModal({
                    kind: "create-permit",
                    permitTypeCode: "general",
                    title: "",
                    description: "",
                    locationDetail: "",
                    validFrom: nowLocal(),
                    validTo: nowLocal(),
                  })
                }
              >
                + {t("hse.permit.addPermit")}
              </Button>
            </div>
            <DataTable
              columns={permitColumns}
              rows={permits}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("hse.permit.noPermitsTitle")} description={t("hse.permit.noPermitsDescription")} />}
            />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.permit.programmes")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  setModal({
                    kind: "create-programme",
                    code: "",
                    name: "",
                    programmeType: "inspection",
                    frequencyDays: "30",
                    checklist: [],
                  })
                }
              >
                + {t("hse.permit.addProgramme")}
              </Button>
            </div>
            <DataTable
              columns={programmeColumns}
              rows={programmes}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("hse.permit.noProgrammesTitle")} description={t("hse.permit.noProgrammesDescription")} />}
            />
          </div>
        </div>
      )}

      {modal.kind === "create-permit" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.permit.raisePermit")}</h2>
          <div className="space-y-3">
            <Field label={t("hse.permit.permitType")} required>
              <Select
                value={modal.permitTypeCode}
                onChange={(e) => setModal({ ...modal, permitTypeCode: e.target.value })}
              >
                {PERMIT_TYPES.map((pt) => (
                  <option key={pt.code} value={pt.code}>
                    {t(pt.labelKey)}
                  </option>
                ))}
              </Select>
            </Field>
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
            <Field label={t("hse.permit.locationDetail")}>
              <Input
                value={modal.locationDetail}
                onChange={(e) => setModal({ ...modal, locationDetail: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("hse.permit.validFrom")} required>
                <Input
                  type="datetime-local"
                  value={modal.validFrom}
                  onChange={(e) => setModal({ ...modal, validFrom: e.target.value })}
                />
              </Field>
              <Field label={t("hse.permit.validTo")} required>
                <Input
                  type="datetime-local"
                  value={modal.validTo}
                  onChange={(e) => setModal({ ...modal, validTo: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => createPermit()}>
              {t("hse.capa.raise")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "permit-detail" && permitDetail ? (
        <Card>
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                {permitDetail.permit.permitNumber} · {permitDetail.permit.title}
              </h2>
              <p className="mt-0.5 text-sm text-ink-dim">
                {t("hse.permit.validWindow", {
                  from: formatDate(permitDetail.permit.validFrom),
                  to: formatDate(permitDetail.permit.validTo),
                })}
              </p>
            </div>
            {permitDetail.status ? (
              <StatusPill tone={statusTone(permitDetail.status.instanceStatus)}>
                {permitDetail.status.stepName ?? permitDetail.status.instanceStatus}
              </StatusPill>
            ) : (
              <StatusPill tone="neutral">{t("hse.permit.notStarted")}</StatusPill>
            )}
          </div>

          {permitDetail.permit.isolationConditions.length > 0 ? (
            <ul className="mb-3 space-y-1 text-sm text-ink-dim">
              {permitDetail.permit.isolationConditions.map((c, i) => (
                <li key={i}>
                  <span className="font-medium text-ink">{c.conditionType}</span> · {c.description}
                  {c.verifiedAt
                    ? ` (${t("hse.permit.isolationVerified", { date: formatDate(c.verifiedAt) })})`
                    : ` (${t("hse.permit.isolationUnverified")})`}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {!permitDetail.permit.workflowInstanceId ? (
              <Button disabled={busy} onClick={() => startLifecycle(permitDetail.permit.id)}>
                {t("hse.permit.startLifecycle")}
              </Button>
            ) : (
              permitDetail.availableActions.map((action) => (
                <Button
                  key={action.actionCode}
                  disabled={busy}
                  onClick={() => actOnPermit(permitDetail.permit.id, action.actionCode)}
                >
                  {action.name}
                </Button>
              ))
            )}
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.close")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "create-programme" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.permit.createProgramme")}</h2>
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
              <Field label={t("fin.common.type")} required>
                <Select
                  value={modal.programmeType}
                  onChange={(e) => setModal({ ...modal, programmeType: e.target.value as AuditProgrammeType })}
                >
                  <option value="inspection">{t("hse.permit.inspection")}</option>
                  <option value="audit">{t("hse.permit.audit")}</option>
                </Select>
              </Field>
              <Field label={t("hse.permit.frequencyDays")} required>
                <Input
                  type="number"
                  min={1}
                  value={modal.frequencyDays}
                  onChange={(e) => setModal({ ...modal, frequencyDays: e.target.value })}
                />
              </Field>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink-dim">{t("hse.permit.checklist")}</span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setModal({
                      ...modal,
                      checklist: [...modal.checklist, { code: "", question: "", isMandatory: true }],
                    })
                  }
                >
                  + {t("hse.permit.addItem")}
                </Button>
              </div>
              {modal.checklist.map((item, index) => (
                <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Input
                    placeholder={t("fin.common.code")}
                    value={item.code}
                    onChange={(e) =>
                      setModal({
                        ...modal,
                        checklist: modal.checklist.map((it, i) =>
                          i === index ? { ...it, code: e.target.value } : it,
                        ),
                      })
                    }
                  />
                  <Input
                    placeholder={t("hse.permit.question")}
                    value={item.question}
                    onChange={(e) =>
                      setModal({
                        ...modal,
                        checklist: modal.checklist.map((it, i) =>
                          i === index ? { ...it, question: e.target.value } : it,
                        ),
                      })
                    }
                  />
                  <label className="flex items-center gap-2 text-sm text-ink-dim">
                    <input
                      type="checkbox"
                      checked={item.isMandatory}
                      onChange={(e) =>
                        setModal({
                          ...modal,
                          checklist: modal.checklist.map((it, i) =>
                            i === index ? { ...it, isMandatory: e.target.checked } : it,
                          ),
                        })
                      }
                    />
                    {t("hse.permit.mandatory")}
                  </label>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => createProgramme()}>
              {t("fin.common.create")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "programme-detail" ? (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              {t("hse.permit.occurrencesFor", { name: currentProgramme(modal.programmeId)?.name ?? "" })}
            </h2>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => scheduleOccurrence(modal.programmeId)}>
                + {t("hse.permit.schedule")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
                {t("common.close")}
              </Button>
            </div>
          </div>
          {occurrences.length === 0 ? (
            <EmptyState title={t("hse.permit.noOccurrencesTitle")} description={t("hse.permit.noOccurrencesDescription")} />
          ) : (
            <ul className="divide-y divide-line">
              {occurrences.map((occurrence) => (
                <li key={occurrence.id} className="flex items-center justify-between gap-2 py-2">
                  <div>
                    <div className="text-sm text-ink">{formatDateShort(occurrence.scheduledFor)}</div>
                    <div className="text-xs text-ink-dim">
                      {occurrence.performedAt
                        ? t("hse.permit.performed", { date: formatDate(occurrence.performedAt) })
                        : t("hse.permit.notPerformed")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {occurrence.performedAt ? (
                      <StatusPill tone="success">{t("hse.permit.complete")}</StatusPill>
                    ) : (
                      <StatusPill tone="warning">{t("hse.permit.pending")}</StatusPill>
                    )}
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void openOccurrence(occurrence.id, modal.programmeId)}
                    >
                      {t("hse.capa.open")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {modal.kind === "occurrence-detail" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {t("hse.permit.occurrenceOn", {
              date: currentOccurrence() ? formatDateShort(currentOccurrence()!.scheduledFor) : "",
            })}
          </h2>

          {currentOccurrence()?.performedAt ? (
            <Alert tone="info">{t("hse.permit.frozenNotice")}</Alert>
          ) : (
            <div className="space-y-3">
              {(currentProgramme(modal.programmeId)?.checklist ?? []).map((item) => (
                <Field key={item.code} label={item.question} required={item.isMandatory} hint={item.code}>
                  <Select
                    value={occurrenceResults[item.code] ?? ""}
                    onChange={(e) => setOccurrenceResults({ ...occurrenceResults, [item.code]: e.target.value })}
                  >
                    <option value="">{t("hse.permit.notAnswered")}</option>
                    <option value="pass">{t("hse.permit.pass")}</option>
                    <option value="fail">{t("hse.permit.fail")}</option>
                    <option value="not_applicable">{t("hse.permit.notApplicable")}</option>
                  </Select>
                </Field>
              ))}
              <Field label={t("hse.permit.notes")}>
                <Textarea rows={2} value={occurrenceNotes} onChange={(e) => setOccurrenceNotes(e.target.value)} />
              </Field>
              <Button disabled={busy} onClick={() => completeOccurrence(modal.occurrenceId, modal.programmeId)}>
                {t("hse.permit.completeOccurrence")}
              </Button>
            </div>
          )}

          <div className="mt-4 space-y-3 border-t border-line pt-3">
            <h3 className="text-sm font-semibold text-ink">{t("hse.permit.findings")}</h3>
            {findings.length === 0 ? (
              <p className="text-sm text-ink-dim">{t("hse.permit.noFindings")}</p>
            ) : (
              <ul className="space-y-2">
                {findings.map((finding) => (
                  <li key={finding.id} className="text-sm">
                    <StatusPill tone={FINDING_TYPE_TONE[finding.findingType]}>
                      {t(FINDING_TYPE_LABEL_KEYS[finding.findingType])}
                    </StatusPill>{" "}
                    <span className="text-ink">{finding.description}</span>
                    {finding.checklistItemCode ? (
                      <span className="ml-1 font-mono text-xs text-ink-dim">[{finding.checklistItemCode}]</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Select
                value={newFinding.findingType}
                onChange={(e) =>
                  setNewFinding({ ...newFinding, findingType: e.target.value as AuditFindingType })
                }
              >
                <option value="observation">{t("hse.permit.findingObservation")}</option>
                <option value="nonconformity">{t("hse.permit.findingNonconformity")}</option>
                <option value="major_nonconformity">{t("hse.permit.findingMajor")}</option>
              </Select>
              <Select
                value={newFinding.checklistItemCode}
                onChange={(e) => setNewFinding({ ...newFinding, checklistItemCode: e.target.value })}
              >
                <option value="">{t("hse.permit.noChecklistItem")}</option>
                {(currentProgramme(modal.programmeId)?.checklist ?? []).map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" disabled={busy} onClick={() => addFinding(modal.occurrenceId)}>
                + {t("hse.permit.addFinding")}
              </Button>
            </div>
            <Field label={t("hse.permit.findingDescription")}>
              <Textarea
                rows={2}
                value={newFinding.description}
                onChange={(e) => setNewFinding({ ...newFinding, description: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-3">
            <Button variant="ghost" disabled={busy} onClick={() => void openProgramme(modal.programmeId)}>
              {t("hse.permit.backToOccurrences")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
