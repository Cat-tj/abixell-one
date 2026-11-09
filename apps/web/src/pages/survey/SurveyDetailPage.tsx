/**
 * Checkpoint 1D.2 + Wave A2 (SUR-ADV-003…007):
 * Survey admin detail: versions, question & matrix row authoring (draft only),
 * forward-only branching rules, distribution tokens (anonymous/public),
 * multi-language translations, cross-survey analytics & benchmarking dashboard.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type BranchConditionOperator,
  type BranchTargetAction,
  type CreatedSurveyDistributionToken,
  type SurveyAnalyticsOverview,
  type SurveyBenchmarkResult,
  type SurveyBranchingRule,
  type SurveyDetail,
  type SurveyDistributionToken,
  type SurveyMatrixRow,
  type SurveyQuestion,
  type SurveyQuestionOption,
  type SurveyScoringModel,
  type SurveyTranslation,
  type SurveyVersionDetail,
  type TokenDistributionChannel,
  type TranslationEntityType,
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
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/dictionaries/en";

/** Static option tables stay module-level; only the labels are keys, so a
 *  component renders `t(entry.labelKey)` instead of rebuilding the array. */
const TYPES: { value: string; labelKey: MessageKey }[] = [
  { value: "rating", labelKey: "surveyDetail.typeRating" },
  { value: "single_choice", labelKey: "surveyDetail.typeSingleChoice" },
  { value: "multiple_choice", labelKey: "surveyDetail.typeMultipleChoice" },
  { value: "yes_no", labelKey: "surveyDetail.typeYesNo" },
  { value: "short_text", labelKey: "surveyDetail.typeShortText" },
  { value: "long_text", labelKey: "surveyDetail.typeLongText" },
  { value: "numeric", labelKey: "surveyDetail.typeNumeric" },
  { value: "date", labelKey: "surveyDetail.typeDate" },
  { value: "matrix_single_choice", labelKey: "surveyDetail.typeMatrixSingle" },
  { value: "matrix_rating", labelKey: "surveyDetail.typeMatrixRating" },
];

const SCORING_MODELS: { value: SurveyScoringModel; labelKey: MessageKey }[] = [
  { value: "sum", labelKey: "surveyDetail.scoringSum" },
  { value: "weighted_average", labelKey: "surveyDetail.scoringWeighted" },
  { value: "percentage", labelKey: "surveyDetail.scoringPercentage" },
  { value: "nps", labelKey: "surveyDetail.scoringNps" },
];

const CONDITION_OPERATORS: { value: BranchConditionOperator; labelKey: MessageKey }[] = [
  { value: "equals", labelKey: "surveyDetail.opEquals" },
  { value: "not_equals", labelKey: "surveyDetail.opNotEquals" },
  { value: "greater_than", labelKey: "surveyDetail.opGreaterThan" },
  { value: "less_than", labelKey: "surveyDetail.opLessThan" },
  { value: "in", labelKey: "surveyDetail.opIn" },
  { value: "not_in", labelKey: "surveyDetail.opNotIn" },
  { value: "is_answered", labelKey: "surveyDetail.opAnswered" },
  { value: "is_unanswered", labelKey: "surveyDetail.opUnanswered" },
];

const TARGET_ACTIONS: { value: BranchTargetAction; labelKey: MessageKey }[] = [
  { value: "jump_to_question", labelKey: "surveyDetail.actJumpQuestion" },
  { value: "jump_to_section", labelKey: "surveyDetail.actJumpSection" },
  { value: "end_survey", labelKey: "surveyDetail.actEndSurvey" },
];

function versionTone(status: string): "neutral" | "success" | "warning" {
  if (status === "published") return "success";
  if (status === "retired") return "neutral";
  return "warning"; // draft
}

export function SurveyDetailPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [survey, setSurvey] = useState<SurveyDetail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [detail, setDetail] = useState<SurveyVersionDetail | null>(null);
  const [users, setUsers] = useState<{ id: string; email: string; fullName: string }[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);

  // Wave A2 tabs
  const [activeTab, setActiveTab] = useState<"questions" | "sections" | "branching" | "tokens" | "translations" | "analytics" | "benchmark">("questions");

  // Advanced data state
  const [branchingRules, setBranchingRules] = useState<SurveyBranchingRule[]>([]);
  const [distributionTokens, setDistributionTokens] = useState<SurveyDistributionToken[]>([]);
  const [translations, setTranslations] = useState<SurveyTranslation[]>([]);
  const [analyticsOverview, setAnalyticsOverview] = useState<SurveyAnalyticsOverview | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<SurveyBenchmarkResult | null>(null);
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<CreatedSurveyDistributionToken | null>(null);

  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Question form state
  const [questionType, setQuestionType] = useState("rating");

  // Branching form state
  const [selectedSourceQuestionId, setSelectedSourceQuestionId] = useState<string>("");
  const [selectedTargetAction, setSelectedTargetAction] = useState<BranchTargetAction>("jump_to_question");

  const canManage = permissions.includes("survey.manage");
  const canReadAnalytics = permissions.includes("survey.analytics.read");

  const loadSurvey = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      const [s, meRes] = await Promise.all([
        api.survey(token, code),
        api.me(token).catch(() => ({ permissions: [] as string[] })),
      ]);
      setSurvey(s);
      setPermissions(meRes.permissions ?? []);
      setSelectedVersionId((cur) => {
        if (cur && s.versions.some((v) => v.id === cur)) return cur;
        const draft = [...s.versions].reverse().find((v) => v.status === "draft");
        const current = s.versions.find((v) => v.isCurrent);
        return (draft ?? current ?? s.versions[0])?.id ?? "";
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("surveyDetail.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, code, t]);

  useEffect(() => {
    loadSurvey();
  }, [loadSurvey]);

  const loadDetail = useCallback(async () => {
    if (!selectedVersionId) return;
    try {
      const d = await api.surveyVersionDetail(token, selectedVersionId);
      setDetail(d);
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : t("surveyDetail.detailFailed") });
    }
  }, [token, selectedVersionId, t]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // Load contextual tab data
  const loadTabData = useCallback(async () => {
    if (!code || !selectedVersionId) return;
    setTabLoading(true);
    try {
      if (activeTab === "branching") {
        const rules = await api.surveyBranchingRules(token, selectedVersionId);
        setBranchingRules(rules);
      } else if (activeTab === "tokens") {
        const tokens = await api.surveyDistributionTokens(token, selectedVersionId);
        setDistributionTokens(tokens);
      } else if (activeTab === "translations") {
        const trans = await api.surveyTranslations(token, selectedVersionId);
        setTranslations(trans);
      } else if (activeTab === "analytics" && canReadAnalytics) {
        const ov = await api.surveyAnalytics(token, code);
        setAnalyticsOverview(ov);
      } else if (activeTab === "benchmark" && canReadAnalytics) {
        const bm = await api.surveyBenchmark(token, code);
        setBenchmarkResult(bm);
      }
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : t("surveyDetail.tabDataFailed") });
    } finally {
      setTabLoading(false);
    }
  }, [token, code, selectedVersionId, activeTab, canReadAnalytics, t]);

  useEffect(() => {
    loadTabData();
  }, [loadTabData]);

  // Users for internal assignment picker
  useEffect(() => {
    api.users(token).then(setUsers).catch(() => setUsers([]));
  }, [token]);

  const selectedVersion = survey?.versions.find((v) => v.id === selectedVersionId) ?? null;
  const isDraft = selectedVersion?.status === "draft";
  const isPublished = selectedVersion?.status === "published";

  async function run(fn: () => Promise<void>, ok: MessageKey) {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: "success", text: t(ok) });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof ApiError ? err.message : t("surveyDetail.actionFailed") });
    } finally {
      setBusy(false);
    }
  }

  async function addSection(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedVersionId) return;
    const form = new FormData(e.currentTarget);
    const el = e.currentTarget;
    await run(async () => {
      await api.addSurveySection(token, selectedVersionId, {
        code: String(form.get("code")).trim(),
        title: String(form.get("title")).trim(),
        description: form.get("description") ? String(form.get("description")).trim() : null,
        sortOrder: form.get("sortOrder") ? Number(form.get("sortOrder")) : 0,
        scoringModel: (form.get("scoringModel") as SurveyScoringModel) || null,
        weight: form.get("weight") ? Number(form.get("weight")) : 1,
      });
      el.reset();
      await loadDetail();
    }, "surveyDetail.sectionAdded");
  }

  async function addQuestion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedVersionId) return;
    const form = new FormData(e.currentTarget);
    const type = String(form.get("questionType"));
    const config: Record<string, unknown> = {};
    if (type === "rating" || type === "matrix_rating") {
      config.min = Number(form.get("min") || 1);
      config.max = Number(form.get("max") || 5);
    }
    const el = e.currentTarget;
    await run(async () => {
      await api.addSurveyQuestion(token, selectedVersionId, {
        sectionId: form.get("sectionId") ? String(form.get("sectionId")) : null,
        code: String(form.get("code")).trim(),
        text: String(form.get("text")).trim(),
        questionType: type,
        isRequired: form.get("isRequired") === "on",
        config,
        sortOrder: form.get("sortOrder") ? Number(form.get("sortOrder")) : 0,
        weight: form.get("weight") ? Number(form.get("weight")) : 1,
      });
      el.reset();
      setQuestionType("rating");
      await loadDetail();
    }, "surveyDetail.questionAdded");
  }

  async function addOption(questionId: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const el = e.currentTarget;
    await run(async () => {
      await api.addSurveyOption(token, questionId, {
        code: String(form.get("code")).trim(),
        label: String(form.get("label")).trim(),
        score: form.get("score") ? Number(form.get("score")) : null,
        sortOrder: form.get("sortOrder") ? Number(form.get("sortOrder")) : 0,
      });
      el.reset();
      await loadDetail();
    }, "surveyDetail.optionAdded");
  }

  async function addMatrixRow(questionId: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const el = e.currentTarget;
    await run(async () => {
      await api.addSurveyMatrixRow(token, questionId, {
        code: String(form.get("code")).trim(),
        label: String(form.get("label")).trim(),
        sortOrder: form.get("sortOrder") ? Number(form.get("sortOrder")) : 0,
      });
      el.reset();
      await loadDetail();
    }, "surveyDetail.matrixRowAdded");
  }

  async function addBranchingRule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedVersionId) return;
    const form = new FormData(e.currentTarget);
    const rawVal = form.get("conditionValue");
    let conditionValue: unknown = rawVal ? String(rawVal).trim() : null;
    const op = form.get("conditionOperator") as BranchConditionOperator;

    if (op === "equals" || op === "greater_than" || op === "less_than") {
      const num = Number(conditionValue);
      if (!Number.isNaN(num) && String(rawVal).trim() !== "") {
        conditionValue = num;
      }
    } else if (op === "in" || op === "not_in") {
      conditionValue = String(rawVal)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const targetAction = form.get("targetAction") as BranchTargetAction;
    const el = e.currentTarget;

    await run(async () => {
      await api.addSurveyBranchingRule(token, selectedVersionId, {
        sourceQuestionId: String(form.get("sourceQuestionId")),
        conditionOperator: op,
        conditionValue,
        targetAction,
        targetQuestionId: targetAction === "jump_to_question" ? String(form.get("targetQuestionId")) : null,
        targetSectionId: targetAction === "jump_to_section" ? String(form.get("targetSectionId")) : null,
        priority: form.get("priority") ? Number(form.get("priority")) : 0,
      });
      el.reset();
      const rules = await api.surveyBranchingRules(token, selectedVersionId);
      setBranchingRules(rules);
    }, "surveyDetail.branchingAdded");
  }

  async function deleteBranchingRule(ruleId: string) {
    if (!selectedVersionId) return;
    await run(async () => {
      await api.deleteSurveyBranchingRule(token, selectedVersionId, ruleId);
      const rules = await api.surveyBranchingRules(token, selectedVersionId);
      setBranchingRules(rules);
    }, "surveyDetail.branchingDeleted");
  }

  async function createToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedVersionId) return;
    const form = new FormData(e.currentTarget);
    const el = e.currentTarget;

    await run(async () => {
      const res = await api.createSurveyDistributionToken(token, selectedVersionId, {
        channel: (form.get("channel") as TokenDistributionChannel) || "link",
        recipientLabel: form.get("recipientLabel") ? String(form.get("recipientLabel")).trim() : null,
        maxUses: form.get("maxUses") ? Number(form.get("maxUses")) : null,
        expiresAt: form.get("expiresAt") ? new Date(String(form.get("expiresAt"))).toISOString() : null,
      });
      setNewlyCreatedToken(res);
      el.reset();
      const tokens = await api.surveyDistributionTokens(token, selectedVersionId);
      setDistributionTokens(tokens);
    }, "surveyDetail.tokenMinted");
  }

  async function revokeToken(tokenId: string) {
    if (!window.confirm(t("surveyDetail.revokeConfirm"))) return;
    await run(async () => {
      await api.revokeSurveyDistributionToken(token, tokenId);
      const tokens = await api.surveyDistributionTokens(token, selectedVersionId);
      setDistributionTokens(tokens);
    }, "surveyDetail.tokenRevoked");
  }

  async function addTranslation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedVersionId) return;
    const form = new FormData(e.currentTarget);
    const el = e.currentTarget;

    await run(async () => {
      await api.upsertSurveyTranslation(token, selectedVersionId, {
        locale: String(form.get("locale")).trim(),
        entityType: form.get("entityType") as TranslationEntityType,
        entityId: String(form.get("entityId")).trim(),
        fieldName: String(form.get("fieldName")).trim(),
        translatedText: String(form.get("translatedText")).trim(),
      });
      el.reset();
      const trans = await api.surveyTranslations(token, selectedVersionId);
      setTranslations(trans);
    }, "surveyDetail.translationSaved");
  }

  async function deleteTranslation(translationId: string) {
    if (!selectedVersionId) return;
    await run(async () => {
      await api.deleteSurveyTranslation(token, selectedVersionId, translationId);
      const trans = await api.surveyTranslations(token, selectedVersionId);
      setTranslations(trans);
    }, "surveyDetail.translationRemoved");
  }

  async function publish() {
    if (!code || !selectedVersion) return;
    await run(async () => {
      await api.publishSurveyVersion(token, code, selectedVersion.versionNumber);
      await loadSurvey();
      await loadDetail();
    }, "surveyDetail.versionPublished");
  }

  async function retire() {
    if (!code || !selectedVersion) return;
    if (!window.confirm(t("surveyDetail.retireConfirm"))) return;
    await run(async () => {
      await api.retireSurveyVersion(token, code, selectedVersion.versionNumber);
      await loadSurvey();
      await loadDetail();
    }, "surveyDetail.versionRetired");
  }

  async function createDraft() {
    if (!code) return;
    await run(async () => {
      const v = await api.createSurveyVersion(token, code);
      await loadSurvey();
      setSelectedVersionId(v.id);
    }, "surveyDetail.draftCreated");
  }

  async function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!code) return;
    const form = new FormData(e.currentTarget);
    const el = e.currentTarget;
    await run(async () => {
      await api.createSurveyAssignment(token, {
        surveyDefinitionCode: code,
        respondentUserId: String(form.get("respondentUserId")),
        dueAt: form.get("dueAt") ? new Date(String(form.get("dueAt")) + "T23:59:59").toISOString() : null,
      });
      el.reset();
    }, "surveyDetail.surveyAssigned");
  }

  if (loading) return <Spinner label={t("surveyDetail.loading")} />;
  if (error) {
    return (
      <div className="space-y-3">
        <Alert tone="error">{error}</Alert>
        <Button variant="secondary" onClick={() => navigate("/surveys")}>
          {t("surveyDetail.backToSurveys")}
        </Button>
      </div>
    );
  }
  if (!survey) return null;

  const ruleColumns: Column<SurveyBranchingRule>[] = [
    {
      header: t("surveyDetail.colSourceQuestion"),
      cell: (r) => {
        const q = detail?.questions.find((x) => x.id === r.sourceQuestionId);
        return <span>{q ? `${q.code} (${q.text.slice(0, 30)}…)` : r.sourceQuestionId}</span>;
      },
    },
    {
      header: t("surveyDetail.colCondition"),
      cell: (r) => (
        <Badge>
          {r.conditionOperator} {r.conditionValue !== null && r.conditionValue !== undefined ? JSON.stringify(r.conditionValue) : ""}
        </Badge>
      ),
    },
    {
      header: t("surveyDetail.colTargetAction"),
      cell: (r) => {
        if (r.targetAction === "end_survey")
          return <StatusPill tone="danger">{t("surveyDetail.endSurvey")}</StatusPill>;
        if (r.targetAction === "jump_to_question") {
          const q = detail?.questions.find((x) => x.id === r.targetQuestionId);
          return <span>{t("surveyDetail.jumpToQuestion", { code: q?.code ?? r.targetQuestionId })}</span>;
        }
        if (r.targetAction === "jump_to_section") {
          const s = detail?.sections.find((x) => x.id === r.targetSectionId);
          return <span>{t("surveyDetail.jumpToSection", { title: s?.title ?? r.targetSectionId })}</span>;
        }
        return <span>{r.targetAction}</span>;
      },
    },
    {
      header: t("surveyDetail.colPriority"),
      cell: (r) => <span className="font-mono">{r.priority}</span>,
    },
    {
      header: t("surveyDetail.colAction"),
      cell: (r) =>
        isDraft && canManage ? (
          <Button variant="ghost" className="text-xs text-status-danger" onClick={() => deleteBranchingRule(r.id)}>
            {t("surveyDetail.delete")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={survey.definition.name}
        subtitle={t("surveyDetail.subtitle", {
          description: survey.definition.description ?? survey.definition.code,
          scoring: selectedVersion?.scoringModel?.toUpperCase() ?? "SUM",
          locale: selectedVersion?.defaultLocale ?? "id-ID",
        })}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate("/surveys")}>
              {t("surveyDetail.backToSurveys")}
            </Button>
          </div>
        }
      />

      {notice && (
        <Alert tone={notice.tone === "info" ? "info" : notice.tone}>{notice.text}</Alert>
      )}

      {/* Version selector bar */}
      <Card className="flex flex-wrap items-end justify-between gap-3 bg-panel-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Field label={t("surveyDetail.selectedVersion")}>
              <Select value={selectedVersionId} onChange={(e) => setSelectedVersionId(e.target.value)}>
                {survey.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.versionNumber} · {v.status.toUpperCase()}
                    {v.isCurrent ? t("surveyDetail.currentPublished") : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {selectedVersion && (
            <div className="pb-1.5">
              <StatusPill tone={versionTone(selectedVersion.status)}>{selectedVersion.status.toUpperCase()}</StatusPill>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button variant="secondary" disabled={busy} onClick={createDraft}>
              {t("surveyDetail.newDraft")}
            </Button>
          )}
          {isDraft && canManage && (
            <Button disabled={busy} onClick={publish}>
              {t("surveyDetail.publish")}
            </Button>
          )}
          {isPublished && canManage && (
            <Button variant="secondary" disabled={busy} onClick={retire}>
              {t("surveyDetail.retire")}
            </Button>
          )}
        </div>
      </Card>

      {/* Tab Navigation */}
      <div className="border-b border-line">
        <nav className="-mb-px flex space-x-6">
          {[
            { id: "questions", label: t("surveyDetail.tabQuestions", { count: String(detail?.questions.length ?? 0) }) },
            { id: "sections", label: t("surveyDetail.tabSections", { count: String(detail?.sections.length ?? 0) }) },
            { id: "branching", label: t("surveyDetail.tabBranching", { count: String(branchingRules.length) }) },
            { id: "tokens", label: t("surveyDetail.tabTokens") },
            { id: "translations", label: t("surveyDetail.tabTranslations") },
            { id: "analytics", label: t("surveyDetail.tabAnalytics") },
            { id: "benchmark", label: t("surveyDetail.tabBenchmark") },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`border-b-2 py-2 px-1 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-ground ${
                activeTab === tab.id
                  ? "border-accent text-ink font-semibold"
                  : "border-transparent text-ink-faint hover:border-line hover:text-ink-dim"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {tabLoading && <Spinner label={t("surveyDetail.loadingTab")} />}

      {/* TAB 1: QUESTIONS & MATRIX ROWS */}
      {activeTab === "questions" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink">{t("surveyDetail.questionsTitle")}</h2>
              {!detail || detail.questions.length === 0 ? (
                <EmptyState title={t("surveyDetail.questionsEmptyTitle")} description={t("surveyDetail.questionsEmptyDesc")} />
              ) : (
                <ol className="space-y-4">
                  {detail.questions.map((q, i) => (
                    <li key={q.id} className="rounded border border-line p-3 bg-panel shadow-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink">
                          {i + 1}. {q.text}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <Badge>{q.questionType}</Badge>
                          {q.weight !== 1 && <Badge>{t("surveyDetail.weightBadge", { weight: String(q.weight) })}</Badge>}
                          {q.isRequired && <StatusPill tone="warning">{t("surveyDetail.requiredBadge")}</StatusPill>}
                        </div>
                      </div>
                      <div className="mt-0.5 text-xs text-ink-faint font-mono">
                        {t("surveyDetail.codeLine", { code: q.code })}{" "}
            {q.sectionId ? t("surveyDetail.sectionLine", { id: q.sectionId }) : ""}
                      </div>

                      {/* Rating details */}
                      {q.questionType === "rating" && (
                        <div className="mt-1 text-xs text-ink-faint">
                          {t("surveyDetail.scaleLine", {
                min: String(q.config.min ?? 1),
                max: String(q.config.max ?? 5),
              })}
                        </div>
                      )}

                      {/* Choice Options */}
                      {(q.questionType === "single_choice" || q.questionType === "multiple_choice" || q.questionType === "matrix_single_choice") && (
                        <ChoiceOptions
                          question={q}
                          editable={!!isDraft && canManage}
                          busy={busy}
                          onAdd={(ev) => addOption(q.id, ev)}
                        />
                      )}

                      {/* Matrix Rows */}
                      {(q.questionType === "matrix_single_choice" || q.questionType === "matrix_rating") && (
                        <MatrixRows
                          question={q}
                          editable={!!isDraft && canManage}
                          busy={busy}
                          onAdd={(ev) => addMatrixRow(q.id, ev)}
                        />
                      )}
                    </li>
                  ))}
                </ol>
              )}

              {isDraft && canManage && (
                <form onSubmit={addQuestion} className="mt-6 space-y-3 border-t border-line pt-4">
                  <h3 className="text-xs font-semiboldr text-ink-faint">
                    {t("surveyDetail.addQuestion")}
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Input name="code" placeholder={t("surveyDetail.codePlaceholder")} required />
                    <Select name="questionType" value={questionType} onChange={(e) => setQuestionType(e.target.value)}>
                      {TYPES.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </Select>
                    <Select name="sectionId" defaultValue="">
                      <option value="">{t("surveyDetail.noSectionOption")}</option>
                      {detail?.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title} ({s.code})
                        </option>
                      ))}
                    </Select>
                  </div>

                  <Input name="text" placeholder={t("surveyDetail.questionTextPlaceholder")} required />

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Input name="weight" type="number" step="0.1" defaultValue="1" placeholder={t("surveyDetail.weightPlaceholder")} />
                    <Input name="sortOrder" type="number" defaultValue={detail?.questions.length ?? 0} placeholder={t("surveyDetail.sortPlaceholder")} />
                    <label className="flex items-center gap-2 text-sm text-ink-dim pt-2">
                      <input type="checkbox" name="isRequired" defaultChecked /> {t("surveyDetail.requiredField")}
                    </label>
                  </div>

                  {(questionType === "rating" || questionType === "matrix_rating") && (
                    <div className="grid grid-cols-2 gap-2 max-w-xs">
                      <Input name="min" type="number" defaultValue="1" placeholder={t("surveyDetail.minPlaceholder")} />
                      <Input name="max" type="number" defaultValue="5" placeholder={t("surveyDetail.maxPlaceholder")} />
                    </div>
                  )}

                  <Button type="submit" disabled={busy}>
                    {t("surveyDetail.addQuestion")}
                  </Button>
                </form>
              )}
            </Card>
          </div>

          {/* Internal Assignment Sidebar */}
          <div className="space-y-4">
            <Card>
              <h2 className="mb-2 text-sm font-semibold text-ink">{t("surveyDetail.assignTitle")}</h2>
              <p className="mb-3 text-xs text-ink-faint">
                {t("surveyDetail.assignDesc")}
              </p>
              {!survey.versions.some((v) => v.status === "published") ? (
                <p className="text-xs text-status-warn">{t("surveyDetail.assignNeedsPublish")}</p>
              ) : (
                <form onSubmit={assign} className="space-y-3">
                  <Field label={t("surveyDetail.respondentUser")} required>
                    <Select name="respondentUserId" required defaultValue="">
                      <option value="" disabled>{t("surveyDetail.selectUser")}</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.fullName} ({u.email})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("surveyDetail.dueDate")} hint={t("surveyDetail.dueDateHint")}>
                    <Input name="dueAt" type="date" />
                  </Field>
                  <Button type="submit" disabled={busy} className="w-full">
                    {t("surveyDetail.assignAction")}
                  </Button>
                </form>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* TAB 2: SECTIONS */}
      {activeTab === "sections" && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{t("surveyDetail.sectionsTitle")}</h2>
          </div>
          {!detail?.sections || detail.sections.length === 0 ? (
            <EmptyState title={t("surveyDetail.sectionsEmptyTitle")} description={t("surveyDetail.sectionsEmptyDesc")} />
          ) : (
            <div className="space-y-2">
              {detail.sections.map((s) => (
                <div key={s.id} className="flex items-center justify-between p-3 rounded border border-line bg-panel">
                  <div>
                    <span className="font-semibold text-ink text-sm">{s.title}</span>
                    <span className="ml-2 font-mono text-xs text-ink-faint">({s.code})</span>
                    {s.description && <p className="text-xs text-ink-faint mt-0.5">{s.description}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge>{t("surveyDetail.scoringBadge", { model: s.scoringModel ?? t("surveyDetail.inherit") })}</Badge>
                    <Badge>{t("surveyDetail.weightOnlyBadge", { weight: String(s.weight) })}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}

          {isDraft && canManage && (
            <form onSubmit={addSection} className="space-y-3 border-t border-line pt-4">
              <h3 className="text-xs font-semiboldr text-ink-faint">
                {t("surveyDetail.addSection")}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input name="code" placeholder={t("surveyDetail.sectionCodePlaceholder")} required />
                <Input name="title" placeholder={t("surveyDetail.sectionTitlePlaceholder")} required />
              </div>
              <Input name="description" placeholder={t("surveyDetail.descriptionPlaceholder")} />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Select name="scoringModel" defaultValue="">
                  <option value="">{t("surveyDetail.inheritOption")}</option>
                  {SCORING_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {t(m.labelKey)}
                    </option>
                  ))}
                </Select>
                <Input name="weight" type="number" step="0.1" defaultValue="1" placeholder={t("surveyDetail.weightPlaceholder")} />
                <Input name="sortOrder" type="number" defaultValue={detail?.sections.length ?? 0} placeholder={t("surveyDetail.sortPlaceholder")} />
              </div>
              <Button type="submit" disabled={busy}>
                {t("surveyDetail.addSection")}
              </Button>
            </form>
          )}
        </Card>
      )}

      {/* TAB 3: BRANCHING RULES */}
      {activeTab === "branching" && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t("surveyDetail.branchingTitle")}</h2>
              <p className="text-xs text-ink-faint">
                {t("surveyDetail.branchingDesc")}
              </p>
            </div>
          </div>

          <DataTable
            columns={ruleColumns}
            rows={branchingRules}
            keyOf={(r) => r.id}
            empty={<EmptyState title={t("surveyDetail.branchingEmptyTitle")} description={t("surveyDetail.branchingEmptyDesc")} />}
          />

          {isDraft && canManage && (
            <form onSubmit={addBranchingRule} className="space-y-3 border-t border-line pt-4">
              <h3 className="text-xs font-semiboldr text-ink-faint">
                {t("surveyDetail.addBranching")}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label={t("surveyDetail.sourceQuestion")} required>
                  <Select
                    name="sourceQuestionId"
                    value={selectedSourceQuestionId}
                    onChange={(e) => setSelectedSourceQuestionId(e.target.value)}
                    required
                  >
                    <option value="" disabled>{t("surveyDetail.selectSource")}</option>
                    {detail?.questions.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.code} · {q.text.slice(0, 30)}…
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label={t("surveyDetail.conditionOperator")} required>
                  <Select name="conditionOperator" required defaultValue="equals">
                    {CONDITION_OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {t(op.labelKey)}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label={t("surveyDetail.conditionValue")} hint={t("surveyDetail.conditionValueHint")}>
                  <Input name="conditionValue" placeholder={t("surveyDetail.conditionValuePlaceholder")} />
                </Field>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label={t("surveyDetail.targetAction")} required>
                  <Select
                    name="targetAction"
                    value={selectedTargetAction}
                    onChange={(e) => setSelectedTargetAction(e.target.value as BranchTargetAction)}
                    required
                  >
                    {TARGET_ACTIONS.map((action) => (
                      <option key={action.value} value={action.value}>
                        {t(action.labelKey)}
                      </option>
                    ))}
                  </Select>
                </Field>

                {selectedTargetAction === "jump_to_question" && (
                  <Field label={t("surveyDetail.targetQuestion")} required>
                    <Select name="targetQuestionId" required defaultValue="">
                      <option value="" disabled>{t("surveyDetail.selectTargetQuestion")}</option>
                      {detail?.questions.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.code} · {q.text.slice(0, 30)}…
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}

                {selectedTargetAction === "jump_to_section" && (
                  <Field label={t("surveyDetail.targetSection")} required>
                    <Select name="targetSectionId" required defaultValue="">
                      <option value="" disabled>{t("surveyDetail.selectTargetSection")}</option>
                      {detail?.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title} ({s.code})
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}

                <Field label={t("surveyDetail.priority")} hint={t("surveyDetail.priorityHint")}>
                  <Input name="priority" type="number" defaultValue="10" />
                </Field>
              </div>

              <Button type="submit" disabled={busy}>
                {t("surveyDetail.addBranching")}
              </Button>
            </form>
          )}
        </Card>
      )}

      {/* TAB 4: DISTRIBUTION TOKENS */}
      {activeTab === "tokens" && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-ink">{t("surveyDetail.tokensTitle")}</h2>
              <p className="text-xs text-ink-faint">
                {t("surveyDetail.tokensDesc")}
              </p>
            </div>
          </div>

          {newlyCreatedToken && (
            <Alert tone="success">
              <div className="space-y-1">
                <p className="font-semibold">{t("surveyDetail.tokenCreatedTitle")}</p>
                <p className="text-xs font-mono break-all bg-panel p-2 rounded border border-status-ok">
                  {t("surveyDetail.publicUrl", {
                    url: `${window.location.origin}/public/surveys/${newlyCreatedToken.rawToken}`,
                  })}
                </p>
                <p className="text-xs text-ink-dim">{t("surveyDetail.tokenSaveWarning")}</p>
              </div>
            </Alert>
          )}

          <div className="space-y-2">
            {distributionTokens.length === 0 ? (
              <EmptyState title={t("surveyDetail.tokensEmptyTitle")} description={t("surveyDetail.tokensEmptyDesc")} />
            ) : (
              distributionTokens.map((tok) => (
                <div key={tok.id} className="flex flex-wrap items-center justify-between p-3 rounded border border-line bg-panel">
                  <div>
                    <span className="font-medium text-ink text-sm">
                      {tok.recipientLabel ?? t("surveyDetail.anonymousLink")}
                    </span>
                    <span className="ml-2">
                      <Badge>{tok.channel.toUpperCase()}</Badge>
                    </span>
                    <div className="text-xs text-ink-faint mt-0.5">
                      {t("surveyDetail.tokenUsage", {
                        used: String(tok.usedCount),
                        max: tok.maxUses !== null && tok.maxUses !== undefined
                          ? String(tok.maxUses)
                          : t("surveyDetail.unlimited"),
                      })}{" · "}
                      {t("surveyDetail.tokenExpiry", {
                        date: tok.expiresAt
                          ? new Date(tok.expiresAt).toLocaleDateString()
                          : t("surveyDetail.never"),
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {tok.revokedAt ? (
                      <StatusPill tone="danger">{t("surveyDetail.revoked")}</StatusPill>
                    ) : (
                      <>
                        <StatusPill tone="success">{t("surveyDetail.active")}</StatusPill>
                        {canManage && (
                          <Button variant="ghost" className="text-xs text-status-danger" onClick={() => revokeToken(tok.id)}>
                            {t("surveyDetail.revoke")}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {canManage && (
            <form onSubmit={createToken} className="space-y-3 border-t border-line pt-4">
              <h3 className="text-xs font-semiboldr text-ink-faint">
                {t("surveyDetail.mintToken")}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label={t("surveyDetail.channel")}>
                  <Select name="channel" defaultValue="link">
                    <option value="link">{t("surveyDetail.channelLink")}</option>
                    <option value="email">{t("surveyDetail.channelEmail")}</option>
                    <option value="sms">{t("surveyDetail.channelSms")}</option>
                    <option value="qr">{t("surveyDetail.channelQr")}</option>
                  </Select>
                </Field>
                <Field label={t("surveyDetail.recipientLabel")}>
                  <Input name="recipientLabel" placeholder={t("surveyDetail.recipientPlaceholder")} />
                </Field>
                <Field label={t("surveyDetail.maxUses")}>
                  <Input name="maxUses" type="number" placeholder={t("surveyDetail.maxUsesPlaceholder")} />
                </Field>
              </div>
              <Field label={t("surveyDetail.expiryDate")}>
                <Input name="expiresAt" type="date" />
              </Field>
              <Button type="submit" disabled={busy}>
                {t("surveyDetail.generateToken")}
              </Button>
            </form>
          )}
        </Card>
      )}

      {/* TAB 5: TRANSLATIONS */}
      {activeTab === "translations" && (
        <Card className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{t("surveyDetail.translationsTitle")}</h2>
            <p className="text-xs text-ink-faint">
              {t("surveyDetail.translationsDesc")}
            </p>
          </div>

          <div className="space-y-2">
            {translations.length === 0 ? (
              <EmptyState title={t("surveyDetail.translationsEmptyTitle")} description={t("surveyDetail.translationsEmptyDesc")} />
            ) : (
              translations.map((tr) => (
                <div key={tr.id} className="flex items-center justify-between p-3 rounded border border-line bg-panel">
                  <div>
                    <span className="font-semibold text-ink text-sm">[{tr.locale}] {tr.fieldName}:</span>{" "}
                    <span className="text-sm text-ink-dim">"{tr.translatedText}"</span>
                    <div className="text-xs text-ink-faint font-mono mt-0.5">
                      {t("surveyDetail.translationEntity", { type: tr.entityType, id: tr.entityId })}
                    </div>
                  </div>
                  {isDraft && canManage && (
                    <Button variant="ghost" className="text-xs text-status-danger" onClick={() => deleteTranslation(tr.id)}>
                      {t("surveyDetail.remove")}
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>

          {isDraft && canManage && (
            <form onSubmit={addTranslation} className="space-y-3 border-t border-line pt-4">
              <h3 className="text-xs font-semiboldr text-ink-faint">
                {t("surveyDetail.upsertTranslation")}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label={t("surveyDetail.locale")} required>
                  <Select name="locale" defaultValue="en-US">
                    <option value="en-US">{t("surveyPublic.localeEn")}</option>
                    <option value="id-ID">{t("surveyPublic.localeId")}</option>
                  </Select>
                </Field>
                <Field label={t("surveyDetail.entityType")} required>
                  <Select name="entityType" defaultValue="question">
                    <option value="definition">{t("surveyDetail.entityDefinition")}</option>
                    <option value="section">{t("surveyDetail.entitySection")}</option>
                    <option value="question">{t("surveyDetail.entityQuestion")}</option>
                    <option value="option">{t("surveyDetail.entityOption")}</option>
                    <option value="matrix_row">{t("surveyDetail.entityMatrixRow")}</option>
                  </Select>
                </Field>
                <Field label={t("surveyDetail.fieldName")} required>
                  <Select name="fieldName" defaultValue="text">
                    <option value="name">{t("surveyDetail.fieldNameTitle")}</option>
                    <option value="description">{t("surveyDetail.fieldDescription")}</option>
                    <option value="text">{t("surveyDetail.fieldText")}</option>
                    <option value="label">{t("surveyDetail.fieldLabel")}</option>
                  </Select>
                </Field>
              </div>
              <Field label={t("surveyDetail.entityId")} required>
                <Input name="entityId" placeholder={t("surveyDetail.entityIdPlaceholder")} required />
              </Field>
              <Field label={t("surveyDetail.translatedText")} required>
                <Textarea name="translatedText" rows={2} placeholder={t("surveyDetail.translatedPlaceholder")} required />
              </Field>
              <Button type="submit" disabled={busy}>
                {t("surveyDetail.saveTranslation")}
              </Button>
            </form>
          )}
        </Card>
      )}

      {/* TAB 6: ANALYTICS */}
      {activeTab === "analytics" && (
        <div className="space-y-4">
          {!analyticsOverview ? (
            <EmptyState title={t("surveyDetail.analyticsEmptyTitle")} description={t("surveyDetail.analyticsEmptyDesc")} />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <p className="text-xs font-bold text-ink-faint">{t("surveyDetail.completionRate")}</p>
                  <p className="mt-1 text-2xl font-bold text-ink">{analyticsOverview.completionRatePercent}%</p>
                </Card>
                <Card>
                  <p className="text-xs font-bold text-ink-faint">{t("surveyDetail.totalAssignments")}</p>
                  <p className="mt-1 text-2xl font-bold text-ink">{analyticsOverview.totalAssignments}</p>
                </Card>
                <Card>
                  <p className="text-xs font-bold text-ink-faint">{t("surveyDetail.submittedResponses")}</p>
                  <p className="mt-1 text-2xl font-bold text-ink">{analyticsOverview.submittedCount}</p>
                </Card>
                <Card>
                  <p className="text-xs font-bold text-ink-faint">{t("surveyDetail.averageScore")}</p>
                  <p className="mt-1 text-2xl font-bold text-ink">
                    {analyticsOverview.averageScore ?? t("surveyDetail.notAvailable")}
                  </p>
                </Card>
              </div>

              {analyticsOverview.smallCellSuppressed && (
                <Card>
                  <p className="text-sm text-status-warn">{t("surveyDetail.smallCellNotice")}</p>
                </Card>
              )}

              {analyticsOverview.nps.totalNpsResponses > 0 && (
                <Card>
                  <h3 className="text-sm font-semibold text-ink mb-3">{t("surveyDetail.npsTitle")}</h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 items-center">
                    <div className="text-center p-4 bg-panel-2 rounded">
                      <p className="text-xs text-ink-faint">{t("surveyDetail.npsScore")}</p>
                      <p className="text-3xl font-extrabold text-ink">
                        {analyticsOverview.nps.netPromoterScore ?? t("surveyDetail.notAvailable")}
                      </p>
                    </div>
                    <div className="text-center p-4 bg-status-ok-soft rounded">
                      <p className="text-xs text-status-ok">{t("surveyDetail.promoters")}</p>
                      <p className="text-xl font-bold text-status-ok">{analyticsOverview.nps.promoterCount}</p>
                    </div>
                    <div className="text-center p-4 bg-status-warn-soft rounded">
                      <p className="text-xs text-status-warn">{t("surveyDetail.passives")}</p>
                      <p className="text-xl font-bold text-status-warn">{analyticsOverview.nps.passiveCount}</p>
                    </div>
                    <div className="text-center p-4 bg-status-danger-soft rounded">
                      <p className="text-xs text-status-danger">{t("surveyDetail.detractors")}</p>
                      <p className="text-xl font-bold text-status-danger">{analyticsOverview.nps.detractorCount}</p>
                    </div>
                  </div>
                </Card>
              )}

              <Card>
                <h3 className="text-sm font-semibold text-ink mb-3">{t("surveyDetail.sectionPerformance")}</h3>
                <div className="space-y-2">
                  {analyticsOverview.sectionAverages.map((sec, idx) => (
                    <div key={idx} className="flex items-center justify-between p-2 rounded bg-panel-2 text-sm">
                      <span className="font-medium text-ink">{sec.sectionTitle || sec.sectionCode || t("surveyDetail.overall")}</span>
                      <div className="flex gap-3 text-xs">
                        <span>
                          {t("surveyDetail.avgScore", {
                            value: String(sec.averageWeightedScore ?? t("surveyDetail.notAvailable")),
                          })}
                        </span>
                        <span>
                          {t("surveyDetail.percentage", {
                            value:
                              sec.averagePercentageScore === null
                                ? t("surveyDetail.notAvailable")
                                : `${sec.averagePercentageScore}%`,
                          })}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {/* TAB 7: BENCHMARKING */}
      {activeTab === "benchmark" && (
        <Card className="space-y-4">
          <h2 className="text-sm font-semibold text-ink">{t("surveyDetail.benchmarkTitle")}</h2>
          {!benchmarkResult || benchmarkResult.items.length === 0 ? (
            <EmptyState title={t("surveyDetail.benchmarkEmptyTitle")} description={t("surveyDetail.benchmarkEmptyDesc")} />
          ) : (
            <div className="space-y-3">
              {benchmarkResult.items.map((bm, idx) => (
                <div key={idx} className="p-3 rounded border border-line bg-panel flex items-center justify-between">
                  <div>
                    <span className="font-semibold text-ink text-sm">{bm.contextLabel}</span>
                    <span className="ml-2"><Badge>{bm.contextEntityType}</Badge></span>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <span>{t("surveyDetail.responsesCount", { count: String(bm.responseCount) })}</span>
                    <span>{t("surveyDetail.completionValue", { value: `${bm.completionRatePercent}%` })}</span>
                    <span>
                      {t("surveyDetail.avgScore", {
                        value: String(bm.averageScore ?? t("surveyDetail.notAvailable")),
                      })}
                    </span>
                    {bm.npsScore !== null && (
                      <span>{t("surveyDetail.npsScore")}: <strong>{bm.npsScore}</strong></span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function ChoiceOptions({
  question,
  editable,
  busy,
  onAdd,
}: {
  question: SurveyQuestion & { options: SurveyQuestionOption[] };
  editable: boolean;
  busy: boolean;
  onAdd: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const t = useT();
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="text-xs font-medium text-ink-faint mb-1">{t("surveyDetail.choicesTitle")}</div>
      {question.options.length === 0 ? (
        <p className="text-xs text-ink-faint">{t("surveyDetail.choicesEmpty")}</p>
      ) : (
        <ul className="space-y-1 text-xs text-ink-dim">
          {question.options.map((o) => (
            <li key={o.id} className="flex items-center gap-2">
              <span className="font-semibold">• {o.label}</span>
              <span className="text-ink-faint font-mono">[{o.code}]</span>
              {o.score !== null && (
                <Badge className="text-[10px]">
                  {t("surveyDetail.optionScore", { score: String(o.score) })}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form onSubmit={onAdd} className="mt-2 flex flex-wrap items-center gap-1">
          <input name="code" placeholder={t("surveyDetail.optionCodePlaceholder")} required className="w-24 rounded border border-line px-2 py-1 text-xs" />
          <input name="label" placeholder={t("surveyDetail.optionLabelPlaceholder")} required className="w-36 rounded border border-line px-2 py-1 text-xs" />
          <input name="score" type="number" placeholder={t("surveyDetail.scorePlaceholder")} className="w-16 rounded border border-line px-2 py-1 text-xs" />
          <Button type="submit" variant="ghost" disabled={busy} className="text-xs">
            {t("surveyDetail.addOption")}
          </Button>
        </form>
      )}
    </div>
  );
}

function MatrixRows({
  question,
  editable,
  busy,
  onAdd,
}: {
  question: SurveyQuestion & { matrixRows: SurveyMatrixRow[] };
  editable: boolean;
  busy: boolean;
  onAdd: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const t = useT();
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="text-xs font-medium text-ink-faint mb-1">{t("surveyDetail.matrixRowsTitle")}</div>
      {!question.matrixRows || question.matrixRows.length === 0 ? (
        <p className="text-xs text-ink-faint">{t("surveyDetail.matrixRowsEmpty")}</p>
      ) : (
        <ul className="space-y-1 text-xs text-ink-dim">
          {question.matrixRows.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="font-semibold">{r.label}</span>
              <span className="text-ink-faint font-mono">[{r.code}]</span>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form onSubmit={onAdd} className="mt-2 flex flex-wrap items-center gap-1">
          <input name="code" placeholder={t("surveyDetail.rowCodePlaceholder")} required className="w-28 rounded border border-line px-2 py-1 text-xs" />
          <input name="label" placeholder={t("surveyDetail.rowLabelPlaceholder")} required className="w-48 rounded border border-line px-2 py-1 text-xs" />
          <Button type="submit" variant="ghost" disabled={busy} className="text-xs">
            {t("surveyDetail.addMatrixRow")}
          </Button>
        </form>
      )}
    </div>
  );
}
