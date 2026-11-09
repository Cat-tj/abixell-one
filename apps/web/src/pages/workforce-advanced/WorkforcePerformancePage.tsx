/** Wave A4 — competency framework, training catalog, performance cycles, and career paths. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Employee,
  type PositionRecord,
  type WorkforceCareerPath,
  type WorkforceCompetency,
  type WorkforceEmployeeCompetency,
  type WorkforcePerformanceReviewRow,
  type WorkforceTrainingCourse,
  type WorkforceTrainingEnrollment,
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
import { localDateInputValue } from "../../shared/localDateTime";

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function workflowLabel(status: WorkforceWorkflowStatus | null): string {
  return status?.stepName ?? status?.stepCode ?? (status ? label(status.instanceStatus) : "Draft");
}

export function WorkforcePerformancePage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();
  const canManage = permissions.includes(PERMISSIONS.workforcePerformanceManage);

  const [tab, setTab] = useState<"reviews" | "competencies" | "training" | "career">("reviews");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [competencies, setCompetencies] = useState<WorkforceCompetency[]>([]);
  const [employeeCompetencies, setEmployeeCompetencies] = useState<WorkforceEmployeeCompetency[]>([]);
  const [courses, setCourses] = useState<WorkforceTrainingCourse[]>([]);
  const [enrollments, setEnrollments] = useState<WorkforceTrainingEnrollment[]>([]);
  const [reviews, setReviews] = useState<WorkforcePerformanceReviewRow[]>([]);
  const [careerPaths, setCareerPaths] = useState<WorkforceCareerPath[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));

  const [compCode, setCompCode] = useState("");
  const [compName, setCompName] = useState("");
  const [compCategory, setCompCategory] = useState("core");
  const [scaleMin, setScaleMin] = useState("1");
  const [scaleMax, setScaleMax] = useState("5");

  const [assessEmployeeId, setAssessEmployeeId] = useState("");
  const [assessCompetencyId, setAssessCompetencyId] = useState("");
  const [assessLevel, setAssessLevel] = useState("3");
  const [assessNotes, setAssessNotes] = useState("");

  const [courseCode, setCourseCode] = useState("");
  const [courseTitle, setCourseTitle] = useState("");
  const [courseProvider, setCourseProvider] = useState("");
  const [durationHours, setDurationHours] = useState("8");
  const [courseCompetencyId, setCourseCompetencyId] = useState("");

  const [enrollEmployeeId, setEnrollEmployeeId] = useState("");
  const [enrollCourseId, setEnrollCourseId] = useState("");

  const [reviewEmployeeId, setReviewEmployeeId] = useState("");
  const [reviewStart, setReviewStart] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [reviewEnd, setReviewEnd] = useState(() => `${new Date().getFullYear()}-12-31`);
  const [goalsScore, setGoalsScore] = useState("80");
  const [competencyScore, setCompetencyScore] = useState("85");
  const [overallRating, setOverallRating] = useState("4");
  const [reviewNotes, setReviewNotes] = useState("");
  const [developmentPlan, setDevelopmentPlan] = useState("");
  const [reviewActionById, setReviewActionById] = useState<Record<string, string>>({});

  const [fromPositionId, setFromPositionId] = useState("");
  const [toPositionId, setToPositionId] = useState("");
  const [tenureMonths, setTenureMonths] = useState("12");
  const [careerGuidelines, setCareerGuidelines] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [empList, posList, compList, courseList, reviewList, careerList] = await Promise.all([
        api.employees(token).catch(() => [] as Employee[]),
        api.positions(token).catch(() => [] as PositionRecord[]),
        api.workforceCompetencies(token, true),
        api.workforceTrainingCourses(token, true),
        api.workforcePerformanceReviews(token, {
          employeeId: selectedEmployeeId || undefined,
          periodYear: Number(yearFilter) || undefined,
        }),
        api.workforceCareerPaths(token),
      ]);
      setEmployees(empList);
      setPositions(posList.filter((item) => item.isActive));
      setCompetencies(compList);
      setCourses(courseList);
      setReviews(reviewList);
      setCareerPaths(careerList);

      if (selectedEmployeeId) {
        const [empComps, empEnrollments] = await Promise.all([
          api.workforceEmployeeCompetencies(token, selectedEmployeeId).catch(() => []),
          api.workforceTrainingEnrollments(token, selectedEmployeeId).catch(() => []),
        ]);
        setEmployeeCompetencies(empComps);
        setEnrollments(empEnrollments);
      } else {
        setEmployeeCompetencies([]);
        setEnrollments([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.perf.msg.couldNotLoadPerformanceAndTalentRecords"));
    } finally {
      setLoading(false);
    }
  }, [token, selectedEmployeeId, yearFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const employeeName = useMemo(
    () => (id: string) => {
      const employee = employees.find((item) => item.id === id);
      return employee ? `${employee.fullName} (${employee.employeeNumber})` : id;
    },
    [employees],
  );

  const positionName = useMemo(
    () => (id: string) => positions.find((item) => item.id === id)?.name ?? id,
    [positions],
  );

  const competencyName = useMemo(
    () => (id: string) => competencies.find((item) => item.id === id)?.name ?? id,
    [competencies],
  );

  const courseTitleById = useMemo(
    () => (id: string) => courses.find((item) => item.id === id)?.title ?? id,
    [courses],
  );

  // Reports missing required fields instead of silently refusing to submit.
  function requireFields(checks: Array<[unknown, string]>): boolean {
    const missing = checks.filter(([value]) => !value).map(([, label]) => label);
    if (missing.length === 0) return true;
    setNotice(null);
    setError(t("common.form.missing", { fields: missing.join(", ") }));
    return false;
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
      setError(err instanceof ApiError ? err.message : t("wf.perf.msg.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createCompetency() {
    if (!requireFields([[compCode.trim(), t("wf.perf.f.code")], [compName.trim(), t("wf.perf.f.name")]])) return;
    await runAction(
      () => api.createWorkforceCompetency(token, {
        code: compCode.trim(),
        name: compName.trim(),
        category: compCategory || null,
        scaleMin: Number(scaleMin) || 1,
        scaleMax: Number(scaleMax) || 5,
      }),
      `Competency ${compName} created.`,
    );
    setCompCode("");
    setCompName("");
  }

  async function assessCompetency() {
    if (!requireFields([
      [assessEmployeeId, t("wf.perf.f.employee")],
      [assessCompetencyId, t("wf.perf.f.competency")],
      [assessLevel.trim(), t("wf.perf.f.proficiencyLevel")],
    ])) return;
    await runAction(
      () => api.assessWorkforceEmployeeCompetency(token, {
        employeeId: assessEmployeeId,
        competencyId: assessCompetencyId,
        proficiencyLevel: Number(assessLevel),
        notes: assessNotes || null,
      }),
      "Employee competency assessed.",
    );
    setAssessNotes("");
  }

  async function createCourse() {
    if (!requireFields([[courseCode.trim(), t("wf.perf.f.courseCode")], [courseTitle.trim(), t("wf.perf.f.title")]])) return;
    await runAction(
      () => api.createWorkforceTrainingCourse(token, {
        courseCode: courseCode.trim(),
        title: courseTitle.trim(),
        provider: courseProvider || null,
        durationHours: Number(durationHours) || 1,
        competencyId: courseCompetencyId || null,
      }),
      `Training course ${courseTitle} added.`,
    );
    setCourseCode("");
    setCourseTitle("");
    setCourseProvider("");
  }

  async function enrollEmployee() {
    if (!requireFields([[enrollEmployeeId, t("wf.perf.f.employee")], [enrollCourseId, t("wf.perf.f.course")]])) return;
    await runAction(
      () => api.enrollWorkforceTraining(token, {
        trainingCourseId: enrollCourseId,
        employeeId: enrollEmployeeId,
      }),
      "Employee enrolled in training.",
    );
  }

  async function completeTraining(id: string) {
    await runAction(
      () => api.completeWorkforceTraining(token, id, {
        status: "completed",
        completionDate: localDateInputValue(),
      }),
      "Training marked as completed.",
    );
  }

  async function createReview() {
    if (!requireFields([
      [reviewEmployeeId, t("wf.perf.f.employee")],
      [reviewStart, t("wf.perf.f.periodStart")],
      [reviewEnd, t("wf.perf.f.periodEnd")],
    ])) return;
    await runAction(
      () => api.createWorkforcePerformanceReview(token, {
        employeeId: reviewEmployeeId,
        periodStart: reviewStart,
        periodEnd: reviewEnd,
        goalsScore: Number(goalsScore) || null,
        competencyScore: Number(competencyScore) || null,
        overallRating: Number(overallRating) || null,
        reviewNotes: reviewNotes || null,
        developmentPlan: developmentPlan || null,
      }),
      "Performance review recorded and dispatched to workflow.",
    );
    setReviewNotes("");
    setDevelopmentPlan("");
  }

  async function actOnReview(id: string) {
    const actionCode = reviewActionById[id]?.trim();
    if (!requireFields([[actionCode, t("wf.perf.p.action")]])) return;
    await runAction(
      () => api.actOnWorkforcePerformanceReview(token, id, actionCode, null),
      `Performance review updated via ${label(actionCode)}.`,
    );
  }

  async function createCareerPath() {
    if (!requireFields([[fromPositionId, t("wf.perf.f.fromPosition")], [toPositionId, t("wf.perf.f.toTargetPosition")]])) return;
    await runAction(
      () => api.createWorkforceCareerPath(token, {
        fromPositionId,
        toPositionId,
        requiredTenureMonths: Number(tenureMonths) || 0,
        guidelines: careerGuidelines || null,
      }),
      "Career pathway configured.",
    );
    setCareerGuidelines("");
  }

  const reviewColumns: Column<WorkforcePerformanceReviewRow>[] = [
    {
      header: t("wf.perf.h.review"),
      cell: ({ review }) => (
        <div>
          <div className="font-semibold text-slate-900">{review.reviewCode}</div>
          <div className="text-xs text-slate-500">{employeeName(review.employeeId)}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.perf.h.period"), cell: ({ review }) => `${formatDateShort(review.periodStart)} – ${formatDateShort(review.periodEnd)}` },
    { header: t("wf.perf.h.goals"), cell: ({ review }) => review.goalsScore != null ? `${review.goalsScore}%` : "—" },
    { header: t("wf.perf.h.competency"), cell: ({ review }) => review.competencyScore != null ? `${review.competencyScore}%` : "—" },
    { header: t("wf.perf.h.rating"), cell: ({ review }) => review.overallRating != null ? `${review.overallRating}/5` : "—" },
    {
      header: t("wf.perf.h.workflow"),
      cell: ({ status }) => <StatusPill tone={statusTone(status?.instanceStatus)}>{workflowLabel(status)}</StatusPill>,
      mobileRole: "status",
    },
    {
      header: t("wf.perf.h.actions"),
      cell: ({ review }) => canManage ? (
        <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          <Input
            aria-label={`Workflow action code for ${review.reviewCode}`}
            placeholder={t("wf.perf.p.action")}
            value={reviewActionById[review.id] ?? ""}
            onChange={(event) => setReviewActionById((current) => ({ ...current, [review.id]: event.target.value }))}
            className="w-28! text-xs"
          />
          <Button
            variant="secondary"
            className="text-xs"
            disabled={busy}
            onClick={() => void actOnReview(review.id)}
          >
            Run
          </Button>
        </div>
      ) : <span className="text-slate-400">—</span>,
    },
  ];

  const competencyColumns: Column<WorkforceCompetency>[] = [
    {
      header: t("wf.perf.h.competency"),
      cell: (row) => (
        <div>
          <div className="font-semibold text-slate-900">{row.name}</div>
          <div className="font-mono text-xs text-slate-500">{row.code}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.perf.h.category"), cell: (row) => <Badge>{label(row.category ?? "General")}</Badge> },
    { header: t("wf.perf.h.scale"), cell: (row) => `${row.scaleMin} to ${row.scaleMax}` },
    { header: t("wf.perf.h.state"), cell: (row) => <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>, mobileRole: "status" },
  ];

  const employeeCompColumns: Column<WorkforceEmployeeCompetency>[] = [
    { header: t("wf.perf.h.competency"), cell: (row) => <span className="font-semibold">{competencyName(row.competencyId)}</span>, mobileRole: "title" },
    { header: t("wf.perf.h.proficiencyLevel"), cell: (row) => <Badge>{row.proficiencyLevel}</Badge>, mobileRole: "status" },
    { header: t("wf.perf.h.lastAssessed"), cell: (row) => formatDateShort(row.lastAssessedDate) },
    { header: t("wf.perf.h.notes"), cell: (row) => row.notes ?? "—" },
  ];

  const courseColumns: Column<WorkforceTrainingCourse>[] = [
    {
      header: t("wf.perf.h.course"),
      cell: (row) => (
        <div>
          <div className="font-semibold text-slate-900">{row.title}</div>
          <div className="font-mono text-xs text-slate-500">{row.courseCode}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.perf.h.provider"), cell: (row) => row.provider ?? "Internal" },
    { header: t("wf.perf.h.duration"), cell: (row) => `${row.durationHours} hours` },
    { header: t("wf.perf.h.linkedCompetency"), cell: (row) => row.competencyId ? competencyName(row.competencyId) : "None" },
    { header: t("wf.perf.h.status"), cell: (row) => <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>, mobileRole: "status" },
  ];

  const enrollmentColumns: Column<WorkforceTrainingEnrollment>[] = [
    { header: t("wf.perf.h.trainingCourse"), cell: (row) => <span className="font-semibold">{courseTitleById(row.trainingCourseId)}</span>, mobileRole: "title" },
    { header: t("wf.perf.h.enrolled"), cell: (row) => formatDateShort(row.enrolledAt) },
    { header: t("wf.perf.h.status"), cell: (row) => <StatusPill tone={statusTone(row.status)}>{label(row.status)}</StatusPill>, mobileRole: "status" },
    {
      header: t("wf.perf.h.completion"),
      cell: (row) => canManage && row.status !== "completed" ? (
        <Button variant="secondary" className="text-xs" disabled={busy} onClick={() => void completeTraining(row.id)}>
          Mark completed
        </Button>
      ) : <span className="text-xs text-slate-500">{row.completionDate ? formatDateShort(row.completionDate) : "—"}</span>,
    },
  ];

  const careerColumns: Column<WorkforceCareerPath>[] = [
    { header: t("wf.perf.h.fromPosition"), cell: (row) => <span className="font-semibold">{positionName(row.fromPositionId)}</span>, mobileRole: "title" },
    { header: t("wf.perf.h.toPosition"), cell: (row) => <span className="font-semibold text-slate-900">{positionName(row.toPositionId)}</span> },
    { header: t("wf.perf.h.requiredTenure"), cell: (row) => `${row.requiredTenureMonths} months` },
    { header: t("wf.perf.h.guidelines"), cell: (row) => row.guidelines ?? "Standard career progression" },
  ];

  const tabButton = (value: typeof tab, text: string) => (
    <button
      type="button"
      onClick={() => setTab(value)}
      className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === value ? "border-slate-900 font-semibold text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"}`}
    >
      {text}
    </button>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t("wf.perf.title.talentPerformance")} subtitle={t("wf.perf.sub.maintainCompetenciesTrainingCatalogsStru")} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? <Alert tone="info">{t("wf.perf.msg.performanceEvaluationsAndCatalogMaintena", { perm: <code className="font-mono text-xs">workforce.performance.manage</code> })}</Alert> : null}

      <div className="flex overflow-x-auto border-b border-slate-200">
        {tabButton("reviews", t("wf.perf.t.appraisalsCount", { count: reviews.length }))}
        {tabButton("competencies", t("wf.perf.t.competenciesCount", { count: competencies.length }))}
        {tabButton("training", t("wf.perf.t.trainingCoursesCount", { count: courses.length }))}
        {tabButton("career", t("wf.perf.t.careerPathwaysCount", { count: careerPaths.length }))}
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.perf.t.scopedFilters")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("wf.perf.f.employeeContext")}>
            <Select value={selectedEmployeeId} onChange={(event) => setSelectedEmployeeId(event.target.value)}>
              <option value="">{t("wf.perf.t.allEmployees")}</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} ({employee.employeeNumber})</option>)}
            </Select>
          </Field>
          <Field label={t("wf.perf.f.year")}><Input type="number" min="2000" max="2100" value={yearFilter} onChange={(event) => setYearFilter(event.target.value)} /></Field>
        </div>
      </Card>

      {canManage && tab === "reviews" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.perf.t.createPerformanceReview")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("wf.perf.f.employee")} required><Select value={reviewEmployeeId} onChange={(event) => setReviewEmployeeId(event.target.value)}><option value="">{t("wf.perf.t.selectEmployee")}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</Select></Field>
            <Field label={t("wf.perf.f.periodStart")} required><Input type="date" value={reviewStart} onChange={(event) => setReviewStart(event.target.value)} /></Field>
            <Field label={t("wf.perf.f.periodEnd")} required><Input type="date" value={reviewEnd} onChange={(event) => setReviewEnd(event.target.value)} /></Field>
            <Field label={t("wf.perf.f.overallRating15")}><Input type="number" min="1" max="5" value={overallRating} onChange={(event) => setOverallRating(event.target.value)} /></Field>
            <Field label={t("wf.perf.f.goalsScore")}><Input type="number" min="0" max="100" value={goalsScore} onChange={(event) => setGoalsScore(event.target.value)} /></Field>
            <Field label={t("wf.perf.f.competencyScore")}><Input type="number" min="0" max="100" value={competencyScore} onChange={(event) => setCompetencyScore(event.target.value)} /></Field>
            <div className="sm:col-span-2 lg:col-span-4"><Field label={t("wf.perf.f.reviewNotes")}><Textarea rows={2} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} /></Field></div>
            <div className="sm:col-span-2 lg:col-span-4"><Field label={t("wf.perf.f.developmentPlan")}><Textarea rows={2} value={developmentPlan} onChange={(event) => setDevelopmentPlan(event.target.value)} /></Field></div>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createReview()}>{t("wf.perf.t.submitPerformanceAppraisal")}</Button>
        </Card>
      ) : null}

      {canManage && tab === "competencies" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.perf.t.addCompetencyDefinition")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("wf.perf.f.code")} required><Input value={compCode} onChange={(event) => setCompCode(event.target.value)} placeholder={t("common.form.example", { value: "LEADERSHIP" })} /></Field>
              <Field label={t("wf.perf.f.name")} required><Input value={compName} onChange={(event) => setCompName(event.target.value)} placeholder={t("wf.perf.p.teamLeadership")} /></Field>
              <Field label={t("wf.perf.f.category")}><Input value={compCategory} onChange={(event) => setCompCategory(event.target.value)} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("wf.perf.f.min")}><Input type="number" min="1" value={scaleMin} onChange={(event) => setScaleMin(event.target.value)} /></Field>
                <Field label={t("wf.perf.f.max")}><Input type="number" min="1" value={scaleMax} onChange={(event) => setScaleMax(event.target.value)} /></Field>
              </div>
            </div>
            <Button className="mt-3" disabled={busy} onClick={() => void createCompetency()}>{t("wf.perf.t.saveCompetency")}</Button>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.perf.t.assessEmployeeCompetency")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("wf.perf.f.employee")} required><Select value={assessEmployeeId} onChange={(event) => setAssessEmployeeId(event.target.value)}><option value="">{t("wf.perf.t.selectEmployee")}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</Select></Field>
              <Field label={t("wf.perf.f.competency")} required><Select value={assessCompetencyId} onChange={(event) => setAssessCompetencyId(event.target.value)}><option value="">{t("wf.perf.t.selectCompetency")}</option>{competencies.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
              <Field label={t("wf.perf.f.proficiencyLevel")} required><Input type="number" min="1" max="10" value={assessLevel} onChange={(event) => setAssessLevel(event.target.value)} /></Field>
              <Field label={t("wf.perf.f.assessmentNotes")}><Input value={assessNotes} onChange={(event) => setAssessNotes(event.target.value)} /></Field>
            </div>
            <Button className="mt-3" disabled={busy} onClick={() => void assessCompetency()}>{t("wf.perf.t.saveAssessment")}</Button>
          </Card>
        </div>
      ) : null}

      {canManage && tab === "training" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.perf.t.addTrainingCourse")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("wf.perf.f.courseCode")} required><Input value={courseCode} onChange={(event) => setCourseCode(event.target.value)} placeholder={t("common.form.example", { value: "SAFE_001" })} /></Field>
              <Field label={t("wf.perf.f.title")} required><Input value={courseTitle} onChange={(event) => setCourseTitle(event.target.value)} placeholder={t("wf.perf.p.fieldSafetyProtocol")} /></Field>
              <Field label={t("wf.perf.f.provider")}><Input value={courseProvider} onChange={(event) => setCourseProvider(event.target.value)} /></Field>
              <Field label={t("wf.perf.f.durationHours")}><Input type="number" min="1" value={durationHours} onChange={(event) => setDurationHours(event.target.value)} /></Field>
              <div className="sm:col-span-2">
                <Field label={t("wf.perf.f.linkedCompetency")}>
                  <Select value={courseCompetencyId} onChange={(event) => setCourseCompetencyId(event.target.value)}>
                    <option value="">{t("wf.perf.t.none")}</option>
                    {competencies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </Select>
                </Field>
              </div>
            </div>
            <Button className="mt-3" disabled={busy} onClick={() => void createCourse()}>{t("wf.perf.t.saveCourse")}</Button>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.perf.t.enrollEmployee")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("wf.perf.f.employee")} required><Select value={enrollEmployeeId} onChange={(event) => setEnrollEmployeeId(event.target.value)}><option value="">{t("wf.perf.t.selectEmployee")}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</Select></Field>
              <Field label={t("wf.perf.f.course")} required><Select value={enrollCourseId} onChange={(event) => setEnrollCourseId(event.target.value)}><option value="">{t("wf.perf.t.selectCourse")}</option>{courses.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field>
            </div>
            <Button className="mt-3" disabled={busy} onClick={() => void enrollEmployee()}>{t("wf.perf.t.enrollInTraining")}</Button>
          </Card>
        </div>
      ) : null}

      {canManage && tab === "career" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.perf.t.createCareerPathway")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("wf.perf.f.fromPosition")} required><Select value={fromPositionId} onChange={(event) => setFromPositionId(event.target.value)}><option value="">{t("wf.perf.t.selectCurrentPosition")}</option>{positions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
            <Field label={t("wf.perf.f.toTargetPosition")} required><Select value={toPositionId} onChange={(event) => setToPositionId(event.target.value)}><option value="">{t("wf.perf.t.selectTargetPosition")}</option>{positions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
            <Field label={t("wf.perf.f.requiredTenureMonths")}><Input type="number" min="0" value={tenureMonths} onChange={(event) => setTenureMonths(event.target.value)} /></Field>
            <div className="sm:col-span-3"><Field label={t("wf.perf.f.careerMobilityGuidelines")}><Textarea rows={2} value={careerGuidelines} onChange={(event) => setCareerGuidelines(event.target.value)} /></Field></div>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createCareerPath()}>{t("wf.perf.t.saveCareerPath")}</Button>
        </Card>
      ) : null}

      {loading ? <Spinner label={t("wf.perf.f.loadingPerformanceRecords")} /> : (
        <Card>
          {tab === "reviews" ? <DataTable columns={reviewColumns} rows={reviews} keyOf={(row) => row.review.id} mobileBreakpoint="md" empty={<EmptyState title={t("wf.perf.title.noAppraisalsFound")} description={t("wf.perf.d.createAPerformanceReviewAbove")} />} /> : null}
          {tab === "competencies" ? (
            <div className="space-y-4">
              <DataTable columns={competencyColumns} rows={competencies} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.perf.title.noCompetenciesDefined")} description={t("wf.perf.d.createACompetencyModelAbove")} />} />
              {selectedEmployeeId ? (
                <>
                  <h3 className="text-sm font-semibold text-slate-800">{t("wf.perf.t.assessedCompetenciesForSelectedEmployee")}</h3>
                  <DataTable columns={employeeCompColumns} rows={employeeCompetencies} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.perf.title.noAssessmentsRecorded")} description={t("wf.perf.d.assessCompetencyLevelsAbove")} />} />
                </>
              ) : null}
            </div>
          ) : null}
          {tab === "training" ? (
            <div className="space-y-4">
              <DataTable columns={courseColumns} rows={courses} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.perf.title.noTrainingCourses")} description={t("wf.perf.d.addTrainingCoursesAbove")} />} />
              {selectedEmployeeId ? (
                <>
                  <h3 className="text-sm font-semibold text-slate-800">{t("wf.perf.t.enrollmentsForSelectedEmployee")}</h3>
                  <DataTable columns={enrollmentColumns} rows={enrollments} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.perf.title.noEnrollmentsRecorded")} description={t("wf.perf.d.enrollThisEmployeeInCoursesAbove")} />} />
                </>
              ) : null}
            </div>
          ) : null}
          {tab === "career" ? <DataTable columns={careerColumns} rows={careerPaths} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.perf.title.noCareerPathways")} description={t("wf.perf.d.defineRoleToRoleProgressionPathsAbove")} />} /> : null}
        </Card>
      )}
    </div>
  );
}
