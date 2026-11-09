/**
 * Phase 2 — Field execution surface (SO-CORE-008 / SO-CORE-009 /
 * SO-CORE-010 / SO-CORE-014).
 *
 * Start → complete the checklist → attach evidence → complete the work.
 * Evidence uploads reuse Document Core (`entityType: work_order`), so no
 * attachment subsystem exists here. Nothing is cached offline (PWA policy).
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type WorkOrderDetail } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  StatusPill,
  Textarea,
} from "../../shell/components/ui";
import { formatDate, formatDateShort, statusTone } from "../../shared/format";

export function MyWorkDetailPage() {
  const t = useT();
  const { workOrderId } = useParams<{ workOrderId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [detail, setDetail] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completionNotes, setCompletionNotes] = useState("");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workOrderId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.workOrder(token, workOrderId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.mwd.msg.couldNotLoadThisJob"));
    } finally {
      setLoading(false);
    }
  }, [token, workOrderId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Customer / site names are a convenience; tolerate any failure.
  const customerId = detail?.workOrder.customerId ?? null;
  const siteId = detail?.workOrder.siteId ?? null;
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    api
      .customers(token)
      .then((rows) => {
        if (!cancelled) setCustomerName(rows.find((c) => c.id === customerId)?.name ?? null);
      })
      .catch(() => undefined);
    if (siteId) {
      api
        .sitesForCustomer(token, customerId)
        .then((rows) => {
          if (!cancelled) setSiteName(rows.find((s) => s.id === siteId)?.name ?? null);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [token, customerId, siteId]);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.mwd.msg.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function uploadEvidence(file: File) {
    if (!workOrderId) return;
    // Reuses Document Core exactly as other modules do — the Work Order's
    // own authorization governs the attachment (ADR-0012).
    await run(async () => {
      await api.uploadDocument(token, "work_order", workOrderId, file);
      setUploadedCount((n) => n + 1);
    }, t("mo.mwd.msg.evidenceAttached"));
  }

  if (loading && !detail) return <Spinner />;
  if (!detail) return <Alert tone="error">{error ?? t("mo.mwd.msg.notFound")}</Alert>;

  const { workOrder, serviceDefinition, checklist, status } = detail;
  const requiredOutstanding = checklist.filter((c) => c.isRequired && !c.isCompleted);
  const doneCount = checklist.filter((c) => c.isCompleted).length;
  const isStarted = Boolean(workOrder.startedAt);
  const isCompleted = Boolean(workOrder.completedAt);
  const isVerified = Boolean(workOrder.verifiedAt);
  const priorityLabel = workOrder.priority
    ? ["low", "medium", "high", "critical"].includes(workOrder.priority)
      ? t(`mo.woq.priority.${workOrder.priority as "low" | "medium" | "high" | "critical"}`)
      : workOrder.priority
    : "—";

  /** Validates what the backend requires and tells the worker what is missing instead of disabling the button. */
  function completeWork() {
    if (requiredOutstanding.length > 0) {
      setNotice(null);
      setError(t("mo.mwd.msg.requiredOpen", { items: requiredOutstanding.map((c) => c.label).join(", ") }));
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    void run(() => api.completeWorkOrder(token, workOrder.id, completionNotes || null), t("mo.mwd.msg.completed"));
  }

  const startButton = (
    <Button disabled={busy} onClick={() => run(() => api.startWorkOrder(token, workOrder.id), t("mo.mwd.msg.started"))}>
      {t("mo.mwd.act.start")}
    </Button>
  );
  const completeButton = (
    <Button disabled={busy} onClick={completeWork}>
      {t("mo.mwd.act.complete")}
    </Button>
  );

  // Exactly one "now" stage.
  let nowTitle: string;
  let nowHint: string;
  let nowAction: ReactNode = null;
  if (!isStarted) {
    nowTitle = t("mo.mwd.now.start");
    nowHint = t("mo.mwd.now.startHint");
    nowAction = startButton;
  } else if (!isCompleted && requiredOutstanding.length > 0) {
    nowTitle = t("mo.mwd.now.checklist", { n: requiredOutstanding.length });
    nowHint = t("mo.mwd.now.checklistHint");
  } else if (!isCompleted && uploadedCount === 0) {
    nowTitle = t("mo.mwd.now.photos");
    nowHint = t("mo.mwd.now.photosHint");
    nowAction = completeButton;
  } else if (!isCompleted) {
    nowTitle = t("mo.mwd.now.complete");
    nowHint = t("mo.mwd.now.completeHint");
    nowAction = completeButton;
  } else if (!isVerified) {
    nowTitle = t("mo.mwd.now.awaitVerify");
    nowHint = t("mo.mwd.now.awaitVerifyHint", { date: formatDate(workOrder.completedAt) });
  } else {
    nowTitle = t("mo.mwd.now.done");
    nowHint = t("mo.mwd.now.doneHint", { date: formatDate(workOrder.verifiedAt) });
  }
  const nowDone = isCompleted;

  const stepTitle = "mb-3 text-sm font-semibold text-ink";
  const muted = "text-sm text-ink-faint";

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${workOrder.workOrderNumber} — ${workOrder.title}`}
        subtitle={serviceDefinition?.name}
        actions={
          status ? (
            <StatusPill tone={statusTone(status.instanceStatus)}>
              {status.stepName ?? status.stepCode ?? status.instanceStatus}
            </StatusPill>
          ) : null
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className={nowDone ? "border-status-ok" : "border-accent-line bg-accent-soft"}>
        <p className="text-xs font-bold uppercase tracking-wide text-ink-dim">{t("mo.mwd.now.title")}</p>
        <h2 className="mt-1 text-lg font-extrabold text-ink">{nowTitle}</h2>
        <p className="mt-1 text-sm text-ink-dim">{nowHint}</p>
        {nowAction ? <div className="mt-3">{nowAction}</div> : null}
      </Card>

      <Card>
        <h2 className={stepTitle}>{t("mo.mwd.t.whatToDo")}</h2>
        <p className="text-sm font-semibold text-ink">{workOrder.title}</p>
        <p className="mt-1 whitespace-pre-line text-sm text-ink-dim">
          {workOrder.description ?? t("mo.mwd.n.noDescription")}
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-faint">{t("mo.mwd.f.customer")}</dt>
            <dd className="text-ink">{customerName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">{t("mo.mwd.f.site")}</dt>
            <dd className="text-ink">{siteName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">{t("mo.mwd.f.priority")}</dt>
            <dd className="text-ink">{priorityLabel}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">{t("mo.mwd.f.due")}</dt>
            <dd className="text-ink">{formatDateShort(workOrder.dueAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">{t("mo.mwd.f.plannedStart")}</dt>
            <dd className="text-ink">{formatDate(workOrder.plannedStartAt)}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className={stepTitle}>{t("mo.mwd.s.step1")}</h2>
        {isStarted ? (
          <p className="text-sm text-ink-dim">{t("mo.mwd.n.startedAt", { date: formatDate(workOrder.startedAt) })}</p>
        ) : (
          <div className="space-y-3">
            <p className={muted}>{t("mo.mwd.n.notStarted")}</p>
            {startButton}
          </div>
        )}
      </Card>

      <Card>
        <h2 className={stepTitle}>
          {t("mo.mwd.s.step2")}{" "}
          <Badge>{t("mo.mwd.n.progress", { done: doneCount, total: checklist.length })}</Badge>
        </h2>
        {!isStarted ? <p className={`mb-2 ${muted}`}>{t("mo.mwd.n.startFirst")}</p> : null}
        {checklist.length === 0 ? (
          <p className="text-sm text-ink-dim">{t("mo.mwd.n.noChecklistForThisJob")}</p>
        ) : (
          <ul className="space-y-2">
            {checklist.map((item) => {
              const interactive = isStarted && !isCompleted;
              const requiredMark = item.isRequired ? (
                <>
                  <span className="ml-1 text-status-danger" aria-hidden="true">*</span>
                  <span className="sr-only"> ({t("mo.mwd.n.required")})</span>
                </>
              ) : null;
              return (
                <li key={item.id} className="flex items-start gap-3">
                  {interactive ? (
                    <>
                      <input
                        id={`check-${item.id}`}
                        type="checkbox"
                        className="mt-1 h-5 w-5 rounded border-line"
                        checked={item.isCompleted}
                        disabled={busy}
                        onChange={(e) =>
                          run(
                            () =>
                              api.setWorkOrderChecklistItem(token, workOrder.id, item.id, {
                                isCompleted: e.target.checked,
                              }),
                            t("mo.mwd.msg.checklistUpdated"),
                          )
                        }
                      />
                      <label htmlFor={`check-${item.id}`} className="text-sm text-ink">
                        {item.label}
                        {requiredMark}
                      </label>
                    </>
                  ) : (
                    <div className="flex w-full items-start justify-between gap-3 text-sm">
                      <span className={isStarted ? "text-ink" : "text-ink-dim"}>
                        {item.label}
                        {requiredMark}
                      </span>
                      {isStarted ? (
                        <StatusPill tone={item.isCompleted ? "success" : "neutral"}>
                          {item.isCompleted ? t("mo.wod.s.done") : t("mo.wod.s.pending")}
                        </StatusPill>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className={stepTitle}>{t("mo.mwd.s.step3")}</h2>
        {!isStarted ? (
          <p className={muted}>{t("mo.mwd.n.startFirst")}</p>
        ) : isCompleted ? (
          <p className={muted}>{t("mo.mwd.n.readOnly")}</p>
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              aria-label={t("mo.mwd.f.attachEvidence")}
              className="block w-full text-sm text-ink-dim file:mr-3 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-2 file:text-sm"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadEvidence(file);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
            <p className="mt-2 text-xs text-ink-faint">{t("mo.mwd.n.photosOrDocumentsProvingTheWorkWasCarrie")}</p>
          </>
        )}
      </Card>

      <Card>
        <h2 className={stepTitle}>{t("mo.mwd.s.step4")}</h2>
        {!isStarted ? (
          <p className={muted}>{t("mo.mwd.n.startFirst")}</p>
        ) : isCompleted ? (
          <div className="space-y-1 text-sm">
            <p className="text-ink-dim">
              {isVerified ? t("mo.mwd.now.doneHint", { date: formatDate(workOrder.verifiedAt) }) : t("mo.mwd.now.awaitVerifyHint", { date: formatDate(workOrder.completedAt) })}
            </p>
            {workOrder.completionNotes ? <p className="text-ink">{workOrder.completionNotes}</p> : null}
          </div>
        ) : (
          <>
            <Field label={t("mo.mwd.f.completionNotes")}>
              <Textarea
                rows={3}
                value={completionNotes}
                onChange={(e) => setCompletionNotes(e.target.value)}
                placeholder={t("mo.mwd.p.anythingTheSupervisorShouldKnow")}
              />
            </Field>
            <div className="mt-3">{completeButton}</div>
          </>
        )}
      </Card>
    </div>
  );
}
