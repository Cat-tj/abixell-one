/** Phase 8 — Project Delivery detail and progress view. */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type DocumentRecord,
  type ProjectDeliveryActivity,
  type ProjectDeliveryDetail,
  type ProjectDeliveryMilestone,
} from "../../lib/api";
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

export function ProjectDeliveryDetailPage() {
  const t = useT();
  const { projectId } = useParams<{ projectId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [detail, setDetail] = useState<ProjectDeliveryDetail | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentEntity, setDocumentEntity] = useState<{ type: string; id: string } | null>(null);
  const [documentsBlocked, setDocumentsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activityTitle, setActivityTitle] = useState("");
  const [activityStatus, setActivityStatus] = useState("planned");
  const [activityProgress, setActivityProgress] = useState(0);
  const [activityPicUserId, setActivityPicUserId] = useState("");
  const [activityPicEmployeeId, setActivityPicEmployeeId] = useState("");
  const [activityStart, setActivityStart] = useState("");
  const [activityEnd, setActivityEnd] = useState("");
  const [activityDescription, setActivityDescription] = useState("");

  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDate, setMilestoneDate] = useState("");
  const [milestoneDescription, setMilestoneDescription] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.projectDeliveryDetail(token, projectId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.detail.msg.couldNotLoadProjectDeliveryDetail"));
    } finally {
      setLoading(false);
    }
  }, [token, projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createActivity() {
    if (!projectId || !activityTitle) return;
    setBusy(true);
    setError(null);
    try {
      await api.createProjectDeliveryActivity(token, projectId, {
        title: activityTitle,
        description: activityDescription || null,
        picUserId: activityPicUserId || null,
        picEmployeeId: activityPicEmployeeId || null,
        plannedStartDate: activityStart || null,
        plannedEndDate: activityEnd || null,
        status: activityStatus as ProjectDeliveryActivity["status"],
        // API wants a whole 0-100; a blank or fractional field must not 400.
        progressPercent: Math.min(100, Math.max(0, Math.round(activityProgress || 0))),
      });
      setActivityTitle("");
      setActivityStatus("planned");
      setActivityProgress(0);
      setActivityPicUserId("");
      setActivityPicEmployeeId("");
      setActivityStart("");
      setActivityEnd("");
      setActivityDescription("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.detail.msg.couldNotCreateActivity"));
    } finally {
      setBusy(false);
    }
  }

  async function updateActivity(activity: ProjectDeliveryActivity, status: ProjectDeliveryActivity["status"], progressPercent: number) {
    setBusy(true);
    setError(null);
    try {
      await api.updateProjectDeliveryActivity(token, activity.id, { status, progressPercent });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.detail.msg.couldNotUpdateActivity"));
    } finally {
      setBusy(false);
    }
  }

  async function createMilestone() {
    if (!projectId || !milestoneTitle) return;
    setBusy(true);
    setError(null);
    try {
      await api.createProjectDeliveryMilestone(token, projectId, {
        title: milestoneTitle,
        description: milestoneDescription || null,
        plannedDate: milestoneDate || null,
      });
      setMilestoneTitle("");
      setMilestoneDate("");
      setMilestoneDescription("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.detail.msg.couldNotCreateMilestone"));
    } finally {
      setBusy(false);
    }
  }

  async function achieveMilestone(milestone: ProjectDeliveryMilestone) {
    setBusy(true);
    setError(null);
    try {
      await api.updateProjectDeliveryMilestone(token, milestone.id, {
        status: "achieved",
        achievementNote: "Marked achieved from Project Delivery UI",
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.detail.msg.couldNotUpdateMilestone"));
    } finally {
      setBusy(false);
    }
  }

  async function openDocuments(entityType: string, entityId: string) {
    setDocumentEntity({ type: entityType, id: entityId });
    try {
      setDocuments(await api.documentsForEntity(token, entityType, entityId));
      setDocumentsBlocked(false);
    } catch {
      setDocuments([]);
      setDocumentsBlocked(true);
    }
  }

  async function uploadDocument(file: File) {
    if (!documentEntity) return;
    setBusy(true);
    try {
      await api.uploadDocument(token, documentEntity.type, documentEntity.id, file);
      await openDocuments(documentEntity.type, documentEntity.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.detail.msg.couldNotUploadDocument"));
    } finally {
      setBusy(false);
    }
  }

  async function downloadDocument(doc: DocumentRecord) {
    try {
      const blob = await api.downloadDocument(token, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("pd.detail.msg.downloadFailed"));
    }
  }

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="error">{error || "Project delivery detail not found"}</Alert>;

  const activityColumns: Column<ProjectDeliveryActivity>[] = [
    { header: t("pd.detail.h.activity"), cell: (row) => <span className="font-medium">{row.title}</span> },
    { header: t("pd.detail.h.status"), cell: (row) => <StatusPill tone={row.status === "completed" ? "success" : "info"}>{row.status}</StatusPill> },
    { header: t("pd.detail.h.planned"), cell: (row) => `${row.plannedStartDate ?? "—"} → ${row.plannedEndDate ?? "—"}` },
    { header: t("pd.detail.h.progress"), cell: (row) => `${row.progressPercent}%` },
    {
      header: t("pd.detail.h.actions"),
      cell: (row) => (
        <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => void updateActivity(row, "completed", 100)}>{t("pd.detail.t.complete")}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void openDocuments("project_delivery_activity", row.id)}>{t("pd.detail.t.docs")}</Button>
        </div>
      ),
    },
  ];

  const milestoneColumns: Column<ProjectDeliveryMilestone>[] = [
    { header: t("pd.detail.h.milestone"), cell: (row) => <span className="font-medium">{row.title}</span> },
    { header: t("pd.detail.h.planned"), cell: (row) => row.plannedDate ?? "—" },
    { header: t("pd.detail.h.status"), cell: (row) => <StatusPill tone={row.status === "achieved" ? "success" : "warning"}>{row.status}</StatusPill> },
    {
      header: t("pd.detail.h.actions"),
      cell: (row) => (
        <div className="flex gap-2">
          {row.status !== "achieved" && <Button variant="secondary" disabled={busy} onClick={() => void achieveMilestone(row)}>{t("pd.detail.t.achieve")}</Button>}
          <Button variant="ghost" disabled={busy} onClick={() => void openDocuments("project_delivery_milestone", row.id)}>{t("pd.detail.t.docs")}</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={detail.project.name} subtitle={`${detail.project.code} · Project Delivery Core`} />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-3xl font-semibold text-slate-900">{detail.progress.progressPercent}%</div>
            <div className="text-sm text-slate-500">{t("pd.detail.t.derivedFromActivityProgress")}</div>
          </div>
          <div className="flex gap-2 text-sm">
            <Badge>{detail.progress.completedActivityCount}/{detail.progress.activityCount} activities complete</Badge>
            <Badge>{detail.progress.achievedMilestoneCount}/{detail.progress.milestoneCount} milestones achieved</Badge>
          </div>
        </div>
        <div className="mt-3 h-3 rounded bg-slate-100">
          <div className="h-3 rounded bg-blue-500" style={{ width: `${detail.progress.progressPercent}%` }} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("pd.detail.t.createActivity")}</h2>
          <div className="space-y-3">
            <Field label={t("pd.detail.f.title")} required><Input value={activityTitle} onChange={(e) => setActivityTitle(e.target.value)} disabled={busy} /></Field>
            <Field label={t("pd.detail.f.description")}><Textarea rows={2} value={activityDescription} onChange={(e) => setActivityDescription(e.target.value)} disabled={busy} /></Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("pd.detail.f.picUserId")} required={!activityPicEmployeeId}><Input value={activityPicUserId} onChange={(e) => setActivityPicUserId(e.target.value)} disabled={busy || Boolean(activityPicEmployeeId)} placeholder={t("pd.detail.p.userUuid")} /></Field>
              <Field label={t("pd.detail.f.picEmployeeId")} required={!activityPicUserId}><Input value={activityPicEmployeeId} onChange={(e) => setActivityPicEmployeeId(e.target.value)} disabled={busy || Boolean(activityPicUserId)} placeholder={t("pd.detail.p.employeeUuid")} /></Field>
              <Field label={t("pd.detail.f.plannedStart")}><Input type="date" value={activityStart} onChange={(e) => setActivityStart(e.target.value)} disabled={busy} /></Field>
              <Field label={t("pd.detail.f.plannedEnd")}><Input type="date" value={activityEnd} onChange={(e) => setActivityEnd(e.target.value)} disabled={busy} /></Field>
              <Field label={t("pd.detail.f.status")}>
                <Select value={activityStatus} onChange={(e) => setActivityStatus(e.target.value)} disabled={busy}>
                  <option value="planned">{t("pd.detail.t.planned")}</option>
                  <option value="in_progress">{t("pd.detail.t.inProgress")}</option>
                  <option value="on_hold">{t("pd.detail.t.onHold")}</option>
                  <option value="completed">{t("pd.detail.t.completed")}</option>
                </Select>
              </Field>
              <Field label={t("pd.detail.f.progress")}><Input type="number" min={0} max={100} value={activityProgress} onChange={(e) => setActivityProgress(Number(e.target.value))} disabled={busy} /></Field>
            </div>
            <Button disabled={busy || !activityTitle || (!activityPicUserId && !activityPicEmployeeId)} onClick={() => void createActivity()}>{t("pd.detail.t.addActivity")}</Button>
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("pd.detail.t.createMilestone")}</h2>
          <div className="space-y-3">
            <Field label={t("pd.detail.f.title")} required><Input value={milestoneTitle} onChange={(e) => setMilestoneTitle(e.target.value)} disabled={busy} /></Field>
            <Field label={t("pd.detail.f.description")}><Textarea rows={2} value={milestoneDescription} onChange={(e) => setMilestoneDescription(e.target.value)} disabled={busy} /></Field>
            <Field label={t("pd.detail.f.plannedDate")}><Input type="date" value={milestoneDate} onChange={(e) => setMilestoneDate(e.target.value)} disabled={busy} /></Field>
            <Button disabled={busy || !milestoneTitle} onClick={() => void createMilestone()}>{t("pd.detail.t.addMilestone")}</Button>
          </div>
        </Card>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("pd.detail.t.activities")}</h2>
        <DataTable columns={activityColumns} rows={detail.activities} keyOf={(row) => row.id} empty={<EmptyState title={t("pd.detail.title.noActivitiesYet")} />} />
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("pd.detail.t.milestones")}</h2>
        <DataTable columns={milestoneColumns} rows={detail.milestones} keyOf={(row) => row.id} empty={<EmptyState title={t("pd.detail.title.noMilestonesYet")} />} />
      </Card>

      {documentEntity ? (
        <Card>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{t("pd.detail.t.documents")}</h2>
            <Button variant="ghost" onClick={() => setDocumentEntity(null)}>{t("pd.detail.t.close")}</Button>
          </div>
          {documentsBlocked ? (
            <Alert tone="info">Project Delivery documents require project_delivery.documents.read or project_delivery.manage.</Alert>
          ) : (
            <>
              {documents.length === 0 ? <p className="mb-3 text-sm text-slate-500">{t("pd.detail.n.noDocumentsAttached")}</p> : null}
              <ul className="mb-3 space-y-1 text-sm">
                {documents.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between rounded border border-slate-100 p-2">
                    <span>{doc.fileName}</span>
                    <Button variant="ghost" onClick={() => void downloadDocument(doc)}>{t("pd.detail.t.download")}</Button>
                  </li>
                ))}
              </ul>
              <input
                ref={fileInputRef}
                type="file"
                aria-label={t("pd.detail.f.attachProjectDeliveryDocument")}
                className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadDocument(file);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              />
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}
