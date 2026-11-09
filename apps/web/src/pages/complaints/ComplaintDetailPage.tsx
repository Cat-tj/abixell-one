/**
 * Checkpoint 1C.2 — Complaint detail: the central customer view. Composes
 * the backend's customer-safe detail (status, SLA, safe timeline, available
 * actions, reopen eligibility) with evidence from the Document Service.
 * Every action calls the real API; the backend is the authorization truth.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ComplaintDetailView,
  type DocumentRecord,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  Textarea,
  Timeline,
  type TimelineItem,
} from "../../shell/components/ui";
import { formatDate, severityTone, slaIndicator, statusTone } from "./format";

export function ComplaintDetailPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { complaintId } = useParams<{ complaintId: string }>();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<ComplaintDetailView | null>(null);
  const [evidence, setEvidence] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const [comment, setComment] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reopenStep, setReopenStep] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    if (!complaintId) return;
    setLoading(true);
    setError(null);
    try {
      const [d, docs] = await Promise.all([
        api.complaintDetail(token, complaintId),
        api.documentsForEntity(token, "complaint", complaintId),
      ]);
      setDetail(d);
      setEvidence(docs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("cmp.detail.msg.failedToLoadComplaint"));
    } finally {
      setLoading(false);
    }
  }, [token, complaintId, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(actionCode: string) {
    if (!complaintId) return;
    setBusyAction(actionCode);
    setNotice(null);
    try {
      // Customer confirmation records the confirmation note first (existing
      // /customer-confirmation endpoint), then advances the workflow via the
      // configured `confirm` transition.
      if (actionCode === "confirm" && comment.trim()) {
        await api.confirmComplaintByCustomer(token, complaintId, comment.trim());
      }
      await api.actOnComplaint(token, complaintId, actionCode, comment.trim() || null);
      setComment("");
      setNotice({ tone: "success", text: "Action completed." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : t("cmp.detail.msg.actionFailed") });
    } finally {
      setBusyAction(null);
    }
  }

  async function runReopen() {
    if (!complaintId) return;
    if (!reopenStep) {
      setNotice({ tone: "error", text: t("common.form.missing", { fields: t("cmp.detail.f.reopenToStep") }) });
      return;
    }
    setBusyAction("reopen");
    setNotice(null);
    try {
      await api.reopenComplaint(token, complaintId, reopenStep, comment.trim() || null);
      setComment("");
      setReopenStep("");
      setNotice({ tone: "success", text: "Complaint reopened." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : t("cmp.detail.msg.reopenFailed") });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !complaintId) return;
    setUploading(true);
    setNotice(null);
    try {
      await api.uploadDocument(token, "complaint", complaintId, file);
      setNotice({ tone: "success", text: "Evidence uploaded." });
      setEvidence(await api.documentsForEntity(token, "complaint", complaintId));
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : t("cmp.detail.msg.uploadFailed") });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function downloadEvidence(doc: DocumentRecord) {
    try {
      const blob = await api.downloadDocument(token, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : t("cmp.detail.msg.downloadFailed") });
    }
  }

  if (loading) return <Spinner label={t("cmp.detail.f.loadingComplaint")} />;
  if (error)
    return (
      <div className="space-y-3">
        <Alert tone="error">{error}</Alert>
        <Button variant="secondary" onClick={() => navigate("/complaints")}>
          Back to list
        </Button>
      </div>
    );
  if (!detail) return null;

  const { complaint, status, sla, timeline, availableActions, reopen } = detail;
  const slaState = slaIndicator(sla);

  const timelineItems: TimelineItem[] = timeline.map((t, i) => ({
    key: `${t.occurredAt}-${i}`,
    title: t.stepName ?? t.actionCode,
    timestamp: t.occurredAt,
  }));

  return (
    <div>
      <PageHeader
        title={complaint.complaintNumber}
        subtitle={complaint.category + (complaint.subcategory ? ` · ${complaint.subcategory}` : "")}
        actions={
          <Button variant="secondary" onClick={() => navigate("/complaints")}>
            Back to list
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill tone={statusTone(status?.instanceStatus)}>
          {status?.stepName ?? status?.instanceStatus ?? "Unknown"}
        </StatusPill>
        <StatusPill tone={severityTone(complaint.severity)}>Severity: {complaint.severity}</StatusPill>
        <Badge>{t("cmp.detail.t.priorityN", { n: complaint.priority })}</Badge>
        {slaState && <StatusPill tone={slaState.tone}>{slaState.label}</StatusPill>}
      </div>

      {notice && (
        <div className="mb-4">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">{t("cmp.detail.t.description")}</h2>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{complaint.description}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
              <Detail term="Submitted" value={formatDate(complaint.submittedAt)} />
              <Detail term="Created" value={formatDate(complaint.createdAt)} />
              {sla?.dueAt && <Detail term="SLA due" value={formatDate(sla.dueAt)} />}
              {complaint.closureDate && (
                <Detail term="Closed" value={formatDate(complaint.closureDate)} />
              )}
            </dl>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("cmp.detail.t.progress")}</h2>
            <Timeline items={timelineItems} />
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">{t("cmp.detail.t.evidence")}</h2>
              <label className="cursor-pointer text-sm font-medium text-slate-700 hover:underline">
                {uploading ? "Uploading…" : "Add file"}
                <input type="file" className="hidden" onChange={handleUpload} disabled={uploading} />
              </label>
            </div>
            {evidence.length === 0 ? (
              <p className="text-sm text-slate-500">{t("cmp.detail.n.noEvidenceAttachedYet")}</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {evidence.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between py-2">
                    <div className="min-w-0">
                      <div className="truncate text-slate-700">{doc.fileName}</div>
                      <div className="text-xs text-slate-400">
                        {(doc.sizeBytes / 1024).toFixed(1)} KB · {formatDate(doc.createdAt)}
                      </div>
                    </div>
                    <Button variant="ghost" onClick={() => downloadEvidence(doc)}>
                      Download
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("cmp.detail.t.actions")}</h2>
            {availableActions.length === 0 && !reopen.canReopen ? (
              <p className="text-sm text-slate-500">
                No actions are available to you right now. We&apos;ll notify you when your input is needed.
              </p>
            ) : (
              <div className="space-y-3">
                <Field label={t("cmp.detail.f.comment")} hint={t("cmp.detail.n.optionalAddedToYourAction")}>
                  <Textarea
                    rows={3}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder={t("cmp.detail.p.addANoteOptional")}
                  />
                </Field>
                {availableActions.map((a) => (
                  <Button
                    key={a.actionCode}
                    className="w-full"
                    disabled={busyAction !== null}
                    onClick={() => runAction(a.actionCode)}
                  >
                    {busyAction === a.actionCode ? "Working…" : a.name}
                  </Button>
                ))}

                {reopen.canReopen && (
                  <div className="space-y-2 border-t border-slate-100 pt-3">
                    <Field label={t("cmp.detail.f.reopenToStep")}>
                      <Select value={reopenStep} onChange={(e) => setReopenStep(e.target.value)}>
                        <option value="">{t("cmp.detail.t.selectAStep")}</option>
                        {reopen.targetSteps.map((s) => (
                          <option key={s.code} value={s.code}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      variant="secondary"
                      className="w-full"
                      disabled={busyAction !== null}
                      onClick={runReopen}
                    >
                      {busyAction === "reopen" ? "Working…" : "Reopen complaint"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{term}</dt>
      <dd className="text-slate-700">{value}</dd>
    </div>
  );
}
