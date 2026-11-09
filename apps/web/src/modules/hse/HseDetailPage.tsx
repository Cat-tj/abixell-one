/**
 * Phase 7 — Health, Safety & Environment (HSE-CORE-001…010).
 *
 * Detail view with tabs:
 * - Overview: Record details, classification, responsible party
 * - Location: Organization unit, project, site, location detail
 * - Evidence: Documents (via Document Core)
 * - Follow-ups: Actions and completion tracking
 * - Timeline: Lifecycle events and workflow history
 *
 * Allows editing classification, adding persons/follow-ups, acting on workflow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type DocumentRecord,
  type HseRecordDetail,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  Textarea,
} from "../../shell/components/ui";
import { formatDate, formatDateShort } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";

/** The tab id is the state value; only the label on screen changes. */
const TABS: { id: "overview" | "location" | "evidence" | "follow-ups" | "timeline"; labelKey: MessageKey }[] = [
  { id: "overview", labelKey: "hse.common.overview" },
  { id: "location", labelKey: "hse.common.location" },
  { id: "evidence", labelKey: "hse.common.evidence" },
  { id: "follow-ups", labelKey: "hse.common.followUps" },
  { id: "timeline", labelKey: "hse.common.timeline" },
];

export function HseDetailPage() {
  const { recordId } = useParams<{ recordId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const t = useT();

  const [detail, setDetail] = useState<HseRecordDetail | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentsBlocked, setDocumentsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "location" | "evidence" | "follow-ups" | "timeline">("overview");

  const [categories, setCategories] = useState<{ code: string; label: string }[]>([]);
  const [severities, setSeverities] = useState<{ code: string; label: string }[]>([]);
  const [users, setUsers] = useState<{ id: string; email: string; fullName: string }[]>([]);

  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editSeverity, setEditSeverity] = useState("");
  const [editResponsibleUserId, setEditResponsibleUserId] = useState("");

  const [addPersonName, setAddPersonName] = useState("");
  const [addPersonRole, setAddPersonRole] = useState("");
  const [busy, setBusy] = useState(false);

  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpDueDate, setFollowUpDueDate] = useState("");
  const [followUpDescription, setFollowUpDescription] = useState("");

  const load = useCallback(async () => {
    if (!recordId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.hseRecord(token, recordId);
      setDetail(data);
      setEditTitle(data.record.title);
      setEditSummary(data.record.summary ?? "");
      setEditDescription(data.record.description ?? "");
      setEditCategory(data.record.categoryCode ?? "");
      setEditSeverity(data.record.severityCode ?? "");
      setEditResponsibleUserId(data.record.responsibleUserId ?? "");

      // HSE evidence documents need hse.documents.read or hse.manage
      try {
        setDocuments(await api.documentsForEntity(token, "hse_record", recordId));
        setDocumentsBlocked(false);
      } catch {
        setDocuments([]);
        setDocumentsBlocked(true);
      }
    } catch (error) {
      setError(error instanceof ApiError ? error.message : t("hse.detail.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, recordId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const [categoryList, severityList, userList] = await Promise.all([
          api.configReferenceDataItems(token, "hse_category").catch(() => [] as { code: string; label: string }[]),
          api.configReferenceDataItems(token, "hse_severity").catch(() => [] as { code: string; label: string }[]),
          api.users(token).catch(() => [] as { id: string; email: string; fullName: string }[]),
        ]);
        setCategories(categoryList);
        setSeverities(severityList);
        setUsers(userList);
      } catch {
        // Silent fail for reference data
      }
    })();
  }, [token]);

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="error">{error || t("hse.detail.notFound")}</Alert>;

  const { record, personsInvolved, followUps, status, availableActions } = detail;

  const categoryLabel = (code: string | null) =>
    categories.find((c) => c.code === code)?.label ?? code ?? t("hse.common.notAvailable");
  const severityLabel = (code: string | null) =>
    severities.find((s) => s.code === code)?.label ?? code ?? t("hse.common.notAvailable");
  const userLabel = (id: string | null) =>
    users.find((u) => u.id === id)?.fullName ?? t("hse.common.notAvailable");

  function missingField(label: string): void {
    setError(t("common.form.missing", { fields: label }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveEdits() {
    if (!recordId) return;
    if (!editTitle.trim()) {
      missingField(t("hse.common.title"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateHseRecord(token, recordId, {
        title: editTitle.trim(),
        summary: editSummary || null,
        description: editDescription || null,
        categoryCode: editCategory || null,
        severityCode: editSeverity || null,
        responsibleUserId: editResponsibleUserId || null,
      });
      setDetail((d) => (d ? { ...d, record: updated } : null));
      setEditMode(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.detail.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function addPerson() {
    if (!recordId) return;
    if (!addPersonName.trim()) {
      missingField(t("hse.detail.name"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addHsePersonInvolved(token, recordId, {
        personName: addPersonName.trim(),
        personRole: addPersonRole || null,
      });
      setAddPersonName("");
      setAddPersonRole("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.detail.addPersonFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createFollowUp() {
    if (!recordId) return;
    if (!followUpTitle.trim()) {
      missingField(t("hse.common.title"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHseFollowUp(token, recordId, {
        title: followUpTitle.trim(),
        description: followUpDescription || null,
        dueDate: followUpDueDate || null,
      });
      setFollowUpTitle("");
      setFollowUpDueDate("");
      setFollowUpDescription("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.detail.followUpFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function actOnRecord(actionCode: string) {
    if (!recordId) return;
    setBusy(true);
    try {
      await api.actOnHseRecord(token, recordId, actionCode);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.detail.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function uploadEvidence(file: File) {
    if (!recordId) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadDocument(token, "hse_record", recordId, file);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.detail.uploadFailed"));
    } finally {
      setBusy(false);
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
      setError(err instanceof ApiError ? err.message : t("hse.detail.downloadFailed"));
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={record.recordNumber} subtitle={record.title} />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="flex gap-2">
        {availableActions.map((action) => (
          <Button key={action.actionCode} onClick={() => void actOnRecord(action.actionCode)} disabled={busy}>
            {action.name}
          </Button>
        ))}
      </Card>

      {/* Tabs */}
      <div className="border-b border-line">
        <div className="flex gap-4">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium ${
                activeTab === tab.id
                  ? "border-b-2 border-accent text-accent"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="space-y-4">
          <Card>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs font-semibold text-ink-dim">{t("fin.common.type")}</p>
                    <Badge>
                      {record.recordType === "incident" ? t("hse.common.incident") : t("hse.common.observation")}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-ink-dim">{t("fin.common.status")}</p>
                    {status ? (
                      <StatusPill tone="info">{status.stepName}</StatusPill>
                    ) : (
                      <StatusPill tone="warning">{t("hse.common.notStarted")}</StatusPill>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-ink-dim">{t("fin.common.category")}</p>
                    <p>{categoryLabel(record.categoryCode)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-ink-dim">{t("hse.common.severity")}</p>
                    <p>{severityLabel(record.severityCode)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-ink-dim">{t("hse.detail.occurred")}</p>
                    <p>{formatDate(record.occurredAt)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-ink-dim">{t("hse.detail.reported")}</p>
                    <p>{formatDate(record.reportedAt)}</p>
                  </div>
                </div>
              </div>
              {!editMode && (
                <Button onClick={() => setEditMode(true)} variant="secondary">
                  {t("hse.common.edit")}
                </Button>
              )}
            </div>
          </Card>

          {editMode ? (
            <Card>
              <div className="space-y-3">
                <Field label={t("hse.common.title")} required>
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label={t("hse.common.summary")}>
                  <Input
                    value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label={t("fin.common.description")}>
                  <Textarea
                    rows={4}
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label={t("fin.common.category")}>
                  <Select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} disabled={busy}>
                    <option value="">{t("fin.common.none")}</option>
                    {categories.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("hse.common.severity")}>
                  <Select value={editSeverity} onChange={(e) => setEditSeverity(e.target.value)} disabled={busy}>
                    <option value="">{t("fin.common.none")}</option>
                    {severities.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("hse.detail.responsibleUser")}>
                  <Select value={editResponsibleUserId} onChange={(e) => setEditResponsibleUserId(e.target.value)} disabled={busy}>
                    <option value="">{t("fin.common.none")}</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => void saveEdits()}>
                    {t("common.save")}
                  </Button>
                  <Button variant="secondary" onClick={() => setEditMode(false)} disabled={busy}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <Card>
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-semibold text-ink-dim">{t("hse.common.summary")}</p>
                  <p>{record.summary || t("hse.common.notAvailable")}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-ink-dim">{t("fin.common.description")}</p>
                  <p className="whitespace-pre-wrap">{record.description || t("hse.common.notAvailable")}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-ink-dim">{t("hse.detail.immediateAction")}</p>
                  <p className="whitespace-pre-wrap">{record.immediateAction || t("hse.common.notAvailable")}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-ink-dim">{t("hse.detail.responsibleUser")}</p>
                  <p>{userLabel(record.responsibleUserId)}</p>
                </div>
              </div>
            </Card>
          )}

          {/* Persons Involved */}
          <Card>
            <h3 className="mb-3 text-sm font-semibold text-ink">{t("hse.detail.personsInvolved")}</h3>
            <div className="space-y-3">
              {personsInvolved.length > 0 ? (
                <div className="space-y-2">
                  {personsInvolved.map((p) => (
                    <div key={p.id} className="border-l-2 border-accent-line bg-accent-soft p-2">
                      <p className="text-sm font-medium">{p.personName || t("hse.common.notAvailable")}</p>
                      {p.personRole && <p className="text-xs text-ink-dim">{p.personRole}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-dim">{t("hse.detail.noPersons")}</p>
              )}
              <div className="border-t border-line pt-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label={t("hse.detail.name")}>
                    <Input
                      value={addPersonName}
                      onChange={(e) => setAddPersonName(e.target.value)}
                      placeholder={t("hse.detail.personNamePlaceholder")}
                      disabled={busy}
                    />
                  </Field>
                  <Field label={t("hse.detail.role")}>
                    <Input
                      value={addPersonRole}
                      onChange={(e) => setAddPersonRole(e.target.value)}
                      placeholder={t("hse.detail.personRolePlaceholder")}
                      disabled={busy}
                    />
                  </Field>
                </div>
                <Button onClick={() => void addPerson()} disabled={busy} className="mt-2">
                  {t("hse.detail.addPerson")}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Location Tab */}
      {activeTab === "location" && (
        <Card>
          <div className="space-y-2">
            <div>
              <p className="text-xs font-semibold text-ink-dim">{t("hse.detail.organizationUnit")}</p>
              <p>{record.organizationUnitId || t("hse.common.notAvailable")}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-ink-dim">{t("hse.detail.project")}</p>
              <p>{record.projectId || t("hse.common.notAvailable")}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-ink-dim">{t("hse.detail.site")}</p>
              <p>{record.siteId || t("hse.common.notAvailable")}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-ink-dim">{t("hse.report.locationDetail")}</p>
              <p>{record.locationDetail || t("hse.common.notAvailable")}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Evidence Tab */}
      {activeTab === "evidence" && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.detail.evidenceDocuments")}</h2>
          {documentsBlocked ? (
            <Alert tone="info">
              {t("hse.detail.evidenceBlocked", {
                read: <code>hse.documents.read</code>,
                manage: <code>hse.manage</code>,
              })}
            </Alert>
          ) : (
            <>
              {documents.length === 0 ? (
                <p className="mb-3 text-sm text-ink-faint">{t("hse.detail.noEvidence")}</p>
              ) : (
                <ul className="mb-3 space-y-1 text-sm text-ink">
                  {documents.map((doc) => (
                    <li key={doc.id} className="flex items-center justify-between rounded border border-line p-2">
                      <span className="font-medium">{doc.fileName}</span>
                      <button
                        type="button"
                        onClick={() => void downloadEvidence(doc)}
                        className="text-xs font-medium text-accent hover:underline"
                        disabled={busy}
                      >
                        {t("hse.common.download")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-line pt-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  aria-label={t("hse.detail.attachEvidence")}
                  className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-panel-3 file:px-3 file:py-2 file:text-sm"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      void uploadEvidence(file);
                    }
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                />
              </div>
            </>
          )}
        </Card>
      )}

      {/* Follow-ups Tab */}
      {activeTab === "follow-ups" && (
        <div className="space-y-4">
          {followUps.length > 0 && (
            <Card>
              <h3 className="mb-3 text-sm font-semibold text-ink">{t("hse.detail.followUpActions")}</h3>
              <div className="space-y-2">
                {followUps.map((fu) => (
                  <div key={fu.id} className="border-l-2 border-line bg-status-warn-soft p-3">
                    <p className="text-sm font-medium">{fu.title}</p>
                    {fu.description && <p className="text-xs text-ink-dim">{fu.description}</p>}
                    <div className="mt-2 text-xs text-ink-dim">
                      {fu.dueDate && <p>{t("hse.common.due")}: {fu.dueDate}</p>}
                      {fu.completedAt ? (
                        <p className="text-status-ok">{t("hse.common.completed")}: {formatDateShort(fu.completedAt)}</p>
                      ) : (
                        <p className="text-status-warn">{t("hse.common.pending")}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <h3 className="mb-3 text-sm font-semibold text-ink">{t("hse.detail.createFollowUp")}</h3>
            <div className="space-y-3">
              <Field label={t("hse.common.title")} required>
                <Input
                  value={followUpTitle}
                  onChange={(e) => setFollowUpTitle(e.target.value)}
                  placeholder={t("hse.detail.followUpTitlePlaceholder")}
                  disabled={busy}
                />
              </Field>
              <Field label={t("fin.common.description")}>
                <Textarea
                  rows={2}
                  value={followUpDescription}
                  onChange={(e) => setFollowUpDescription(e.target.value)}
                  placeholder={t("hse.detail.followUpDescriptionPlaceholder")}
                  disabled={busy}
                />
              </Field>
              <Field label={t("hse.detail.dueDate")}>
                <Input
                  type="date"
                  value={followUpDueDate}
                  onChange={(e) => setFollowUpDueDate(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Button disabled={busy} onClick={() => void createFollowUp()}>
                {t("hse.detail.createFollowUpButton")}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Timeline Tab */}
      {activeTab === "timeline" && (
        <Card>
          <p className="text-sm text-ink-dim">{t("hse.detail.timelineComingSoon")}</p>
        </Card>
      )}
    </div>
  );
}
