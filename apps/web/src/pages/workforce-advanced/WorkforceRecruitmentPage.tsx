/** Wave A4 — job openings, applicants, hiring stages, and workflow lifecycle. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type PositionRecord,
  type WorkforceJobApplication,
  type WorkforceJobApplicationStage,
  type WorkforceJobPostingRow,
  type WorkforceJobPostingStatus,
  type WorkforceWorkflowStatus,
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
  Textarea,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, statusTone } from "../../shared/format";

const APPLICATION_STAGES: WorkforceJobApplicationStage[] = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "withdrawn",
];

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function workflowLabel(status: WorkforceWorkflowStatus | null, fallback: string): string {
  return status?.stepName ?? status?.stepCode ?? (status ? label(status.instanceStatus) : label(fallback));
}

function stageTone(stage: WorkforceJobApplicationStage) {
  switch (stage) {
    case "hired":
      return "success";
    case "interview":
    case "offer":
      return "info";
    case "screening":
    case "applied":
      return "neutral";
    case "rejected":
    case "withdrawn":
      return "danger";
    default:
      return "neutral";
  }
}

export function WorkforceRecruitmentPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();
  const canManage = permissions.includes(PERMISSIONS.workforceRecruitmentManage);

  const [tab, setTab] = useState<"postings" | "applications">("postings");
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [postings, setPostings] = useState<WorkforceJobPostingRow[]>([]);
  const [applications, setApplications] = useState<WorkforceJobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<WorkforceJobPostingStatus | "">("");
  const [selectedPostingId, setSelectedPostingId] = useState<string>("");
  const [stageFilter, setStageFilter] = useState<WorkforceJobApplicationStage | "">("");

  const [postingTitle, setPostingTitle] = useState("");
  const [positionId, setPositionId] = useState("");
  const [headcountTarget, setHeadcountTarget] = useState("1");
  const [employmentType, setEmploymentType] = useState("full_time");
  const [jobDescription, setJobDescription] = useState("");

  const [candidateName, setCandidateName] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [candidatePhone, setCandidatePhone] = useState("");
  const [resumeId, setResumeId] = useState("");

  const [nextStageById, setNextStageById] = useState<Record<string, WorkforceJobApplicationStage>>({});
  const [ratingById, setRatingById] = useState<Record<string, string>>({});
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [postingActionById, setPostingActionById] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [positionList, postingList, applicationList] = await Promise.all([
        api.positions(token).catch(() => [] as PositionRecord[]),
        api.workforceJobPostings(token, {
          status: (statusFilter as WorkforceJobPostingStatus) || undefined,
        }),
        api.workforceJobApplications(token, {
          jobPostingId: selectedPostingId || undefined,
          stage: (stageFilter as WorkforceJobApplicationStage) || undefined,
        }),
      ]);
      setPositions(positionList.filter((item) => item.isActive));
      setPostings(postingList);
      setApplications(applicationList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.recruit.msg.couldNotLoadRecruitmentData"));
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter, selectedPostingId, stageFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const postingTitleById = useMemo(
    () => (id: string) => postings.find((item) => item.jobPosting.id === id)?.jobPosting.title ?? id,
    [postings],
  );

  // Reports missing/invalid fields instead of silently refusing to submit.
  function requireFields(checks: Array<[unknown, string]>, invalid: Array<[boolean, string]> = []): boolean {
    const missing = checks.filter(([value]) => !value).map(([, label]) => label);
    if (missing.length > 0) {
      setNotice(null);
      setError(t("common.form.missing", { fields: missing.join(", ") }));
      return false;
    }
    const bad = invalid.filter(([isBad]) => isBad).map(([, label]) => label);
    if (bad.length > 0) {
      setNotice(null);
      setError(t("common.form.invalid", { fields: bad.join(", ") }));
      return false;
    }
    return true;
  }

  async function runAction(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.recruit.msg.recruitmentActionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createPosting() {
    if (!requireFields([[postingTitle.trim(), t("wf.recruit.f.title")]])) return;
    await runAction(
      () => api.createWorkforceJobPosting(token, {
        title: postingTitle.trim(),
        positionId: positionId || null,
        headcountTarget: Number(headcountTarget) || 1,
        employmentType: employmentType || null,
        jobDescription: jobDescription || null,
      }),
      `Job posting ${postingTitle} created.`,
    );
    setPostingTitle("");
    setJobDescription("");
  }

  async function actOnPosting(id: string) {
    const actionCode = postingActionById[id]?.trim();
    if (!requireFields([[actionCode, t("wf.recruit.p.actionCode")]])) return;
    await runAction(
      () => api.actOnWorkforceJobPosting(token, id, actionCode, null),
      `Job posting updated via action ${label(actionCode)}.`,
    );
  }

  async function createApplication() {
    if (!requireFields([[selectedPostingId, t("wf.recruit.f.opening")], [candidateName.trim(), t("wf.recruit.f.candidateFullName")]])) return;
    await runAction(
      () => api.createWorkforceJobApplication(token, {
        jobPostingId: selectedPostingId,
        candidateName: candidateName.trim(),
        candidateEmail: candidateEmail.trim() || null,
        candidatePhone: candidatePhone.trim() || null,
        resumeDocumentId: resumeId.trim() || null,
      }),
      `Candidate ${candidateName} added to the pipeline.`,
    );
    setCandidateName("");
    setCandidateEmail("");
    setCandidatePhone("");
    setResumeId("");
  }

  async function advanceStage(id: string) {
    // The select displays the current stage until changed, so fall back to it.
    const stage = nextStageById[id] ?? applications.find((item) => item.id === id)?.stage;
    if (!requireFields([[stage, t("wf.recruit.f.pipelineStage")]]) || !stage) return;
    await runAction(
      () => api.advanceWorkforceJobApplication(token, id, {
        stage,
        rating: ratingById[id] ? Number(ratingById[id]) : null,
        interviewerNotes: notesById[id] || null,
      }),
      `Application advanced to ${label(stage)}.`,
    );
  }

  const postingColumns: Column<WorkforceJobPostingRow>[] = [
    {
      header: t("wf.recruit.h.opening"),
      cell: ({ jobPosting }) => (
        <div>
          <div className="font-semibold text-slate-900">{jobPosting.title}</div>
          <div className="font-mono text-xs text-slate-500">{jobPosting.postingCode}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.recruit.h.headcountTarget"), cell: ({ jobPosting }) => jobPosting.headcountTarget },
    { header: t("wf.recruit.h.employmentType"), cell: ({ jobPosting }) => label(jobPosting.employmentType ?? "—") },
    {
      header: t("wf.recruit.h.status"),
      cell: ({ jobPosting, status }) => (
        <StatusPill tone={statusTone(status?.instanceStatus)}>{workflowLabel(status, jobPosting.status)}</StatusPill>
      ),
      mobileRole: "status",
    },
    {
      header: t("wf.recruit.h.workflowActions"),
      cell: ({ jobPosting }) => canManage ? (
        <div className="flex flex-wrap items-center gap-1" onClick={(event) => event.stopPropagation()}>
          <Input
            aria-label={`Workflow action code for ${jobPosting.title}`}
            placeholder={t("wf.recruit.p.actionCode")}
            value={postingActionById[jobPosting.id] ?? ""}
            onChange={(event) => setPostingActionById((current) => ({ ...current, [jobPosting.id]: event.target.value }))}
            className="w-32! text-xs"
          />
          <Button
            variant="secondary"
            className="text-xs"
            disabled={busy}
            onClick={() => void actOnPosting(jobPosting.id)}
          >
            Apply
          </Button>
        </div>
      ) : <span className="text-slate-400">—</span>,
    },
  ];

  const applicationColumns: Column<WorkforceJobApplication>[] = [
    {
      header: t("wf.recruit.h.candidate"),
      cell: (row) => (
        <div>
          <div className="font-semibold text-slate-900">{row.candidateName}</div>
          <div className="text-xs text-slate-500">{row.candidateEmail ?? row.candidatePhone ?? "No contact details"}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.recruit.h.opening"), cell: (row) => <Badge>{postingTitleById(row.jobPostingId)}</Badge> },
    { header: t("wf.recruit.h.applied"), cell: (row) => formatDateShort(row.appliedAt) },
    {
      header: t("wf.recruit.h.stage"),
      cell: (row) => <StatusPill tone={stageTone(row.stage)}>{label(row.stage)}</StatusPill>,
      mobileRole: "status",
    },
    { header: t("wf.recruit.h.rating"), cell: (row) => row.rating != null ? `${row.rating}/5` : "—" },
    {
      header: t("wf.recruit.h.advanceStage"),
      cell: (row) => canManage ? (
        <div className="space-y-1 min-w-[210px]" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center gap-1">
            <Select
              aria-label={`Select target stage for ${row.candidateName}`}
              value={nextStageById[row.id] ?? row.stage}
              onChange={(event) => setNextStageById((current) => ({ ...current, [row.id]: event.target.value as WorkforceJobApplicationStage }))}
            >
              {APPLICATION_STAGES.map((stage) => <option key={stage} value={stage}>{label(stage)}</option>)}
            </Select>
            <Input
              aria-label={`Rating out of 5 for ${row.candidateName}`}
              type="number"
              min="1"
              max="5"
              placeholder={t("wf.recruit.p.rating")}
              value={ratingById[row.id] ?? ""}
              onChange={(event) => setRatingById((current) => ({ ...current, [row.id]: event.target.value }))}
              className="w-20!"
            />
          </div>
          <Input
            aria-label={`Interviewer notes for ${row.candidateName}`}
            placeholder={t("wf.recruit.p.interviewerNotes")}
            value={notesById[row.id] ?? ""}
            onChange={(event) => setNotesById((current) => ({ ...current, [row.id]: event.target.value }))}
          />
          <Button variant="secondary" className="text-xs" disabled={busy} onClick={() => void advanceStage(row.id)}>
            Update stage
          </Button>
        </div>
      ) : <span className="text-slate-400">—</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("wf.recruit.title.recruitment")} subtitle={t("wf.recruit.sub.publishOpeningsSourceCandidatesRunInterv")} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? <Alert tone="info">{t("wf.recruit.msg.postingOpeningsAndAdvancingCandidatesReq", { perm: <code className="font-mono text-xs">workforce.recruitment.manage</code> })}</Alert> : null}

      <div className="flex border-b border-slate-200 text-sm">
        <button
          type="button"
          onClick={() => setTab("postings")}
          className={`px-3 py-2 border-b-2 font-medium ${tab === "postings" ? "border-slate-900 font-semibold text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"}`}
        >
          Job openings ({postings.length})
        </button>
        <button
          type="button"
          onClick={() => setTab("applications")}
          className={`px-3 py-2 border-b-2 font-medium ${tab === "applications" ? "border-slate-900 font-semibold text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"}`}
        >
          Candidate pipeline ({applications.length})
        </button>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.recruit.t.filters")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("wf.recruit.f.jobOpening")}>
            <Select value={selectedPostingId} onChange={(event) => setSelectedPostingId(event.target.value)}>
              <option value="">{t("wf.recruit.t.allOpenings")}</option>
              {postings.map(({ jobPosting }) => <option key={jobPosting.id} value={jobPosting.id}>{jobPosting.title} ({jobPosting.postingCode})</option>)}
            </Select>
          </Field>
          {tab === "postings" ? (
            <Field label={t("wf.recruit.f.postingStatus")}>
              <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as WorkforceJobPostingStatus)}>
                <option value="">{t("wf.recruit.t.allStatuses")}</option>
                <option value="draft">{t("wf.recruit.t.draft")}</option>
                <option value="published">{t("wf.recruit.t.published")}</option>
                <option value="closed">{t("wf.recruit.t.closed")}</option>
                <option value="cancelled">{t("wf.recruit.t.cancelled")}</option>
              </Select>
            </Field>
          ) : (
            <Field label={t("wf.recruit.f.pipelineStage")}>
              <Select value={stageFilter} onChange={(event) => setStageFilter(event.target.value as WorkforceJobApplicationStage)}>
                <option value="">{t("wf.recruit.t.allStages")}</option>
                {APPLICATION_STAGES.map((stage) => <option key={stage} value={stage}>{label(stage)}</option>)}
              </Select>
            </Field>
          )}
        </div>
      </Card>

      {canManage && tab === "postings" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.recruit.t.createJobOpening")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("wf.recruit.f.title")} required><Input value={postingTitle} onChange={(event) => setPostingTitle(event.target.value)} placeholder={t("wf.recruit.p.seniorSiteSupervisor")} /></Field>
            <Field label={t("wf.recruit.f.position")}><Select value={positionId} onChange={(event) => setPositionId(event.target.value)}><option value="">{t("wf.recruit.t.noneCustom")}</option>{positions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
            <Field label={t("wf.recruit.f.headcountTarget")}><Input type="number" min="1" value={headcountTarget} onChange={(event) => setHeadcountTarget(event.target.value)} /></Field>
            <Field label={t("wf.recruit.f.employmentType")}><Select value={employmentType} onChange={(event) => setEmploymentType(event.target.value)}><option value="full_time">{t("wf.recruit.t.fullTime")}</option><option value="contract">{t("wf.recruit.t.contract")}</option><option value="temporary">{t("wf.recruit.t.temporary")}</option></Select></Field>
            <div className="sm:col-span-2 lg:col-span-4"><Field label={t("wf.recruit.f.jobDescription")}><Textarea rows={2} value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} /></Field></div>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createPosting()}>{t("wf.recruit.t.publishOpening")}</Button>
        </Card>
      ) : null}

      {canManage && tab === "applications" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.recruit.t.addCandidateApplication")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("wf.recruit.f.opening")} required>
              <Select value={selectedPostingId} onChange={(event) => setSelectedPostingId(event.target.value)}>
                <option value="">{t("wf.recruit.t.selectOpening")}</option>
                {postings.map(({ jobPosting }) => <option key={jobPosting.id} value={jobPosting.id}>{jobPosting.title}</option>)}
              </Select>
            </Field>
            <Field label={t("wf.recruit.f.candidateFullName")} required><Input value={candidateName} onChange={(event) => setCandidateName(event.target.value)} /></Field>
            <Field label={t("wf.recruit.f.candidateEmail")}><Input type="email" value={candidateEmail} onChange={(event) => setCandidateEmail(event.target.value)} /></Field>
            <Field label={t("wf.recruit.f.candidatePhone")}><Input value={candidatePhone} onChange={(event) => setCandidatePhone(event.target.value)} /></Field>
            <Field label={t("wf.recruit.f.resumeDocumentId")}><Input value={resumeId} onChange={(event) => setResumeId(event.target.value)} placeholder={t("wf.recruit.p.optionalDocumentId")} /></Field>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createApplication()}>{t("wf.recruit.t.recordApplication")}</Button>
        </Card>
      ) : null}

      {loading ? <Spinner label={t("wf.recruit.f.loadingRecruitmentRecords")} /> : (
        <Card>
          {tab === "postings" ? (
            <DataTable columns={postingColumns} rows={postings} keyOf={(row) => row.jobPosting.id} mobileBreakpoint="md" empty={<EmptyState title={t("wf.recruit.title.noOpeningsFound")} description={t("wf.recruit.d.createAJobOpeningAbove")} />} />
          ) : (
            <DataTable columns={applicationColumns} rows={applications} keyOf={(row) => row.id} mobileBreakpoint="md" empty={<EmptyState title={t("wf.recruit.title.noApplicationsInPipeline")} description={t("wf.recruit.d.recordCandidatesAboveToTrackTheHiringWor")} />} />
          )}
        </Card>
      )}
    </div>
  );
}
