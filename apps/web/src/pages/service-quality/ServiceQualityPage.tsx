/** Wave A1 — Service Quality Advanced (SQ-ADV-001…SQ-ADV-004). */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type SqCalendarRecord,
  type SqCalendarWindow,
  type SqHolidayRecord,
  type SqSlaPolicyRecord,
  type SqSlaRuleRecord,
  type SqSlaPerformanceSummary,
  type SqRcaCategoryRecord,
  type SqCapaActionRecord,
  type SqCapaEffectivenessSummary,
  type SqRecurrenceRuleRecord,
  type SqRecurrenceDetectionRecord,
  type SqAutomationRuleRecord,
  type SqAutomationProposalRecord,
} from "../../lib/api";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";

function capaStatusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "verified":
      return "success";
    case "completed":
      return "info";
    case "in_progress":
      return "warning";
    case "ineffective":
    case "cancelled":
      return "danger";
    case "open":
    default:
      return "neutral";
  }
}

function proposalStatusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "applied":
      return "success";
    case "approved":
    case "applying":
      return "info";
    case "pending":
      return "warning";
    case "rejected":
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function ServiceQualityPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [activeTab, setActiveTab] = useState<
    "sla" | "rca-capa" | "recurrence" | "automation"
  >("sla");

  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "error" | "success" | "info"; text: string } | null>(null);

  // SQ-ADV-001
  const [calendars, setCalendars] = useState<{ calendar: SqCalendarRecord; windows: SqCalendarWindow[]; holidays: SqHolidayRecord[] }[]>([]);
  const [slaPolicies, setSlaPolicies] = useState<{ policy: SqSlaPolicyRecord; calendar: SqCalendarRecord | null; rules: SqSlaRuleRecord[] }[]>([]);
  const [slaPerformance, setSlaPerformance] = useState<SqSlaPerformanceSummary[]>([]);

  // SQ-ADV-002
  const [rcaCategories, setRcaCategories] = useState<SqRcaCategoryRecord[]>([]);
  const [capaActions, setCapaActions] = useState<SqCapaActionRecord[]>([]);
  const [capaSummary, setCapaSummary] = useState<SqCapaEffectivenessSummary[]>([]);

  // SQ-ADV-003
  const [recurrenceRules, setRecurrenceRules] = useState<SqRecurrenceRuleRecord[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [detectionResult, setDetectionResult] = useState<SqRecurrenceDetectionRecord | null>(null);

  // SQ-ADV-004
  const [automationRules, setAutomationRules] = useState<SqAutomationRuleRecord[]>([]);
  const [proposals, setProposals] = useState<SqAutomationProposalRecord[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [proposalDetail, setProposalDetail] = useState<SqAutomationProposalRecord | null>(null);

  const canConfigure = permissions.includes("service_quality.configure");

  const loadData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [
        meRes,
        calRes,
        polRes,
        perfRes,
        rcaRes,
        capaRes,
        capaSumRes,
        recRes,
        autoRes,
        propRes,
      ] = await Promise.all([
        api.me(token),
        api.sqCalendars(token).catch(() => []),
        api.sqSlaPolicies(token).catch(() => []),
        api.sqSlaPerformance(token).catch(() => []),
        api.sqRcaCategories(token).catch(() => []),
        api.sqCapaActions(token).catch(() => []),
        api.sqCapaEffectivenessSummary(token).catch(() => []),
        api.sqRecurrenceRules(token).catch(() => []),
        api.sqAutomationRules(token).catch(() => []),
        api.sqAutomationProposals(token).catch(() => []),
      ]);

      setPermissions(meRes.permissions ?? []);
      setCalendars(calRes);
      setSlaPolicies(polRes);
      setSlaPerformance(perfRes);
      setRcaCategories(rcaRes);
      setCapaActions(capaRes);
      setCapaSummary(capaSumRes);
      setRecurrenceRules(recRes);
      setAutomationRules(autoRes);
      setProposals(propRes);

      if (recRes.length > 0 && !selectedRuleId) {
        setSelectedRuleId(recRes[0].id);
      }
    } catch (err) {
      const text = err instanceof ApiError ? err.message : t("sq.main.msg.failedToLoadServiceQualityData");
      setMessage({ type: "error", text });
    } finally {
      setLoading(false);
    }
  }, [token, selectedRuleId, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Trigger recurrence detection
  useEffect(() => {
    if (!selectedRuleId) {
      setDetectionResult(null);
      return;
    }
    api.detectSqRecurrence(token, selectedRuleId)
      .then((res) => setDetectionResult(res))
      .catch(() => setDetectionResult(null));
  }, [token, selectedRuleId]);

  // Load proposal detail
  useEffect(() => {
    if (!selectedProposalId) {
      setProposalDetail(null);
      return;
    }
    api.sqAutomationProposal(token, selectedProposalId)
      .then((p) => setProposalDetail(p))
      .catch(() => setProposalDetail(null));
  }, [token, selectedProposalId]);

  // Handle Create Calendar
  async function handleCreateCalendar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.createSqCalendar(token, {
        code: String(form.get("code")).trim(),
        name: String(form.get("name")).trim(),
        timeZone: String(form.get("timeZone") || "Asia/Jakarta").trim(),
        isContinuous: form.get("isContinuous") === "true",
        windows: [
          { dayOfWeek: 1, startMinute: 480, endMinute: 1020 },
          { dayOfWeek: 2, startMinute: 480, endMinute: 1020 },
          { dayOfWeek: 3, startMinute: 480, endMinute: 1020 },
          { dayOfWeek: 4, startMinute: 480, endMinute: 1020 },
          { dayOfWeek: 5, startMinute: 480, endMinute: 1020 },
        ],
      });
      setMessage({ type: "success", text: "Calendar created." });
      (e.target as HTMLFormElement).reset();
      loadData();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("sq.main.msg.failedToCreateCalendar") });
    }
  }

  // Handle Create RCA Category
  async function handleCreateRcaCategory(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.createSqRcaCategory(token, {
        code: String(form.get("code")).trim(),
        name: String(form.get("name")).trim(),
        description: form.get("description") ? String(form.get("description")).trim() : null,
      });
      setMessage({ type: "success", text: "RCA Category added." });
      (e.target as HTMLFormElement).reset();
      loadData();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("sq.main.msg.failedToCreateRcaCategory") });
    }
  }

  // Handle Verify CAPA
  const handleVerifyCapa = useCallback(async (id: string, verdict: "effective" | "ineffective") => {
    try {
      await api.verifySqCapaEffectiveness(token, id, { verdict });
      setMessage({ type: "success", text: `CAPA marked as ${verdict}.` });
      loadData();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("sq.main.msg.failedToVerifyCapa") });
    }
  }, [loadData, token, t]);

  // Handle Create Recurrence Rule
  async function handleCreateRecurrenceRule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      const created = await api.createSqRecurrenceRule(token, {
        code: String(form.get("code")).trim(),
        name: String(form.get("name")).trim(),
        groupBy: String(form.get("groupBy") || "category"),
        windowDays: Number(form.get("windowDays") || 30),
        minimumOccurrences: Number(form.get("minimumOccurrences") || 3),
      });
      setMessage({ type: "success", text: "Recurrence Rule created." });
      (e.target as HTMLFormElement).reset();
      setSelectedRuleId(created.id);
      loadData();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : t("sq.main.msg.failedToCreateRule") });
    }
  }

  // Handle Proposal Decision
  const handleProposalDecision = useCallback(async (id: string, decision: "approve" | "reject") => {
    try {
      if (decision === "approve") {
        await api.approveSqAutomationProposal(token, id);
        setMessage({ type: "success", text: "Proposal approved and applied." });
      } else {
        await api.rejectSqAutomationProposal(token, id, "Rejected by operator");
        setMessage({ type: "success", text: "Proposal rejected." });
      }
      loadData();
      if (selectedProposalId === id) {
        const updated = await api.sqAutomationProposal(token, id);
        setProposalDetail(updated);
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : `Failed to ${decision} proposal.` });
    }
  }, [loadData, selectedProposalId, token]);

  const capaColumns: Column<SqCapaActionRecord>[] = useMemo(
    () => [
      {
        header: t("sq.main.h.capaNumberTitle"),
        cell: (r: SqCapaActionRecord) => (
          <div>
            <div className="font-medium text-slate-900">{r.title}</div>
            <div className="text-xs text-slate-500">{r.actionNumber} ({r.actionType})</div>
          </div>
        ),
      },
      {
        header: t("sq.main.h.status"),
        cell: (r: SqCapaActionRecord) => (
          <StatusPill tone={capaStatusTone(r.status)}>{r.status}</StatusPill>
        ),
      },
      {
        header: t("sq.main.h.verdict"),
        cell: (r: SqCapaActionRecord) =>
          r.effectivenessVerdict ? (
            <StatusPill tone={r.effectivenessVerdict === "effective" ? "success" : "danger"}>
              {r.effectivenessVerdict}
            </StatusPill>
          ) : (
            "—"
          ),
      },
      {
        header: t("sq.main.h.dueDate"),
        cell: (r: SqCapaActionRecord) => r.dueDate || "—",
      },
      {
        header: t("sq.main.h.actions"),
        cell: (r: SqCapaActionRecord) => (
          <div className="flex gap-1">
            {canConfigure && r.status === "completed" && (
              <>
                <Button
                  variant="secondary"
                  className="text-xs py-1 text-emerald-700"
                  onClick={() => handleVerifyCapa(r.id, "effective")}
                >
                  Effective
                </Button>
                <Button
                  variant="secondary"
                  className="text-xs py-1 text-rose-700"
                  onClick={() => handleVerifyCapa(r.id, "ineffective")}
                >
                  Ineffective
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    [canConfigure, handleVerifyCapa, t],
  );

  const proposalColumns: Column<SqAutomationProposalRecord>[] = useMemo(
    () => [
      {
        header: t("sq.main.h.triggerRule"),
        cell: (r: SqAutomationProposalRecord) => (
          <div>
            <div className="font-medium text-slate-900">{r.triggerEvent}</div>
            <div className="text-xs text-slate-500">ID: {r.id.slice(0, 8)}…</div>
          </div>
        ),
      },
      {
        header: t("sq.main.h.proposedAction"),
        cell: (r: SqAutomationProposalRecord) => (
          <span className="font-mono text-xs text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
            {r.proposedAction}
          </span>
        ),
      },
      {
        header: t("sq.main.h.status"),
        cell: (r: SqAutomationProposalRecord) => (
          <StatusPill tone={proposalStatusTone(r.status)}>{r.status}</StatusPill>
        ),
      },
      {
        header: t("sq.main.h.gated"),
        cell: () => (
          <StatusPill tone="warning">{t("sq.main.t.founderGated")}</StatusPill>
        ),
      },
      {
        header: t("sq.main.h.review"),
        cell: (r: SqAutomationProposalRecord) => (
          <div className="flex gap-1">
            <Button
              variant="secondary"
              className="text-xs py-1"
              onClick={() => setSelectedProposalId(r.id)}
            >
              View
            </Button>
            {canConfigure && r.status === "pending" && (
              <>
                <Button
                  variant="primary"
                  className="text-xs py-1"
                  onClick={() => handleProposalDecision(r.id, "approve")}
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  className="text-xs py-1 text-rose-700"
                  onClick={() => handleProposalDecision(r.id, "reject")}
                >
                  Reject
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    [canConfigure, handleProposalDecision, t],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("sq.main.title.serviceQualityAdvanced")}
        subtitle={t("sq.main.sub.multidimensionalSlaMatrixStructuredRcaTa")}
      />

      {message && (
        <Alert tone={message.type === "error" ? "error" : message.type === "success" ? "success" : "info"}>
          {message.text}
        </Alert>
      )}

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex space-x-6">
          <button
            onClick={() => setActiveTab("sla")}
            className={`pb-3 text-sm font-medium border-b-2 ${
              activeTab === "sla"
                ? "border-slate-900 text-slate-900 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            SLA Policies & Performance
          </button>
          <button
            onClick={() => setActiveTab("rca-capa")}
            className={`pb-3 text-sm font-medium border-b-2 ${
              activeTab === "rca-capa"
                ? "border-slate-900 text-slate-900 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Root Cause (RCA) & CAPA
          </button>
          <button
            onClick={() => setActiveTab("recurrence")}
            className={`pb-3 text-sm font-medium border-b-2 ${
              activeTab === "recurrence"
                ? "border-slate-900 text-slate-900 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Recurrence Detection
          </button>
          <button
            onClick={() => setActiveTab("automation")}
            className={`pb-3 text-sm font-medium border-b-2 ${
              activeTab === "automation"
                ? "border-slate-900 text-slate-900 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Feedback Automation Proposals
          </button>
        </nav>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <>
          {/* TAB 1: SLA POLICIES & PERFORMANCE */}
          {activeTab === "sla" && (
            <div className="space-y-6">
              {/* Performance Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {slaPerformance.map((perf) => (
                  <Card key={perf.status} className="p-3">
                    <div className="text-xs font-bold text-slate-500r">
                      {perf.status}
                    </div>
                    <div className="text-xl font-bold text-slate-900 mt-1">
                      {perf.count} <span className="text-xs font-normal text-slate-500">{t("sq.main.t.targets")}</span>
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      Response: {perf.metResponseCount} met | Resolution: {perf.metResolutionCount} met
                    </div>
                  </Card>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Policies & Rules */}
                <div className="lg:col-span-2 space-y-4">
                  <h3 className="text-base font-semibold text-slate-900">{t("sq.main.t.slaPoliciesMatrixRules")}</h3>
                  <div className="space-y-3">
                    {slaPolicies.map(({ policy, calendar, rules }) => (
                      <Card key={policy.id} className="space-y-3">
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="font-semibold text-slate-900">{policy.name}</div>
                            <div className="text-xs text-slate-500">
                              Code: {policy.code} | Calendar: {calendar?.name ?? "Continuous 24/7"}
                            </div>
                          </div>
                          <StatusPill tone="info">{rules.length} Rules</StatusPill>
                        </div>

                        {/* Rules table */}
                        <div className="border border-slate-100 rounded overflow-hidden">
                          <table className="w-full text-xs text-left">
                            <thead className="bg-slate-50 text-slate-600 font-medium">
                              <tr>
                                <th className="p-2">{t("sq.main.h.ruleCode")}</th>
                                <th className="p-2">{t("sq.main.h.severityCategory")}</th>
                                <th className="p-2">{t("sq.main.h.responseSla")}</th>
                                <th className="p-2">{t("sq.main.h.resolutionSla")}</th>
                                <th className="p-2">{t("sq.main.h.priority")}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {rules.map((rule) => (
                                <tr key={rule.id}>
                                  <td className="p-2 font-medium text-slate-800">{rule.code}</td>
                                  <td className="p-2 text-slate-600">
                                    {rule.severityCode ?? "Any"} / {rule.categoryCode ?? "Any"}
                                  </td>
                                  <td className="p-2">
                                    {rule.responseMinutes ? `${rule.responseMinutes} mins` : "—"}
                                  </td>
                                  <td className="p-2">
                                    {rule.resolutionMinutes ? `${rule.resolutionMinutes} mins` : "—"}
                                  </td>
                                  <td className="p-2 text-slate-500">{rule.priority}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>

                {/* Calendars */}
                <div className="space-y-4">
                  <h3 className="text-base font-semibold text-slate-900">{t("sq.main.t.businessCalendars")}</h3>
                  <div className="space-y-2">
                    {calendars.map(({ calendar, windows, holidays }) => (
                      <Card key={calendar.id} className="p-3 space-y-1">
                        <div className="flex justify-between font-semibold text-slate-900 text-sm">
                          <span>{calendar.name}</span>
                          {calendar.isDefault && <StatusPill tone="success">{t("sq.main.t.default")}</StatusPill>}
                        </div>
                        <div className="text-xs text-slate-500">
                          {calendar.timeZone} ({calendar.isContinuous ? "Continuous 24/7" : `${windows.length} Work Windows`})
                        </div>
                        <div className="text-xs text-slate-600">
                          Holidays configured: {holidays.length}
                        </div>
                      </Card>
                    ))}
                  </div>

                  {canConfigure && (
                    <Card className="space-y-3">
                      <div className="font-semibold text-slate-900 text-sm">{t("sq.main.t.createWorkweekCalendar")}</div>
                      <form onSubmit={handleCreateCalendar} className="space-y-2">
                        <Input name="code" placeholder={t("sq.main.p.codeEGCalW5Jkt")} required />
                        <Input name="name" placeholder={t("sq.main.p.nameEGMonFri08001700")} required />
                        <Input name="timeZone" defaultValue="Asia/Jakarta" required />
                        <Button type="submit" variant="secondary" className="w-full text-xs">
              {t("sq.main.t.createCalendar")}
              </Button>
                      </form>
                    </Card>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: RCA & CAPA */}
          {activeTab === "rca-capa" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column: RCA Categories */}
              <div className="space-y-4">
                <h3 className="text-base font-semibold text-slate-900">{t("sq.main.t.rootCauseCategories")}</h3>
                <Card className="space-y-2 p-3">
                  {rcaCategories.length === 0 ? (
                    <div className="text-xs text-slate-400">{t("sq.main.t.noCategoriesConfigured")}</div>
                  ) : (
                    rcaCategories.map((rca) => (
                      <div key={rca.id} className="p-2 rounded bg-slate-50 border border-slate-100 text-xs">
                        <div className="font-semibold text-slate-800">{rca.name}</div>
                        <div className="text-slate-500">{rca.code}</div>
                        {rca.description && <div className="text-slate-600 mt-1">{rca.description}</div>}
                      </div>
                    ))
                  )}
                </Card>

                {canConfigure && (
                  <Card className="space-y-3">
                    <div className="font-semibold text-slate-900 text-sm">{t("sq.main.t.addRcaCategory")}</div>
                    <form onSubmit={handleCreateRcaCategory} className="space-y-2">
                      <Input name="code" placeholder={t("sq.main.p.codeEGRcaNetFiber")} required />
                      <Input name="name" placeholder={t("sq.main.p.nameEGPhysicalFiberCut")} required />
                      <Input name="description" placeholder={t("sq.main.p.descriptionOptional")} />
                      <Button type="submit" variant="secondary" className="w-full text-xs">
              {t("sq.main.t.addCategory")}
              </Button>
                    </form>
                  </Card>
                )}

                {/* CAPA Summary */}
                <Card className="p-3 space-y-2">
                  <div className="text-xs font-bold text-slate-600">{t("sq.main.t.capaEffectiveness")}</div>
                  {capaSummary.map((sum) => (
                    <div key={sum.status} className="flex justify-between text-xs py-1 border-b border-slate-100">
                      <span className="text-slate-600">{sum.status}:</span>
                      <span className="font-semibold text-slate-900">{sum.count} (met: {sum.effectiveCount})</span>
                    </div>
                  ))}
                </Card>
              </div>

              {/* Right Columns: CAPA Actions */}
              <div className="lg:col-span-2 space-y-4">
                <h3 className="text-base font-semibold text-slate-900">{t("sq.main.t.capaActions")}</h3>
                <DataTable
                  columns={capaColumns}
                  rows={capaActions}
                  keyOf={(r) => r.id}
                  empty={<div className="p-6 text-center text-sm text-slate-500">{t("sq.main.t.noCapaActionsRegistered")}</div>}
                />
              </div>
            </div>
          )}

          {/* TAB 3: RECURRENCE DETECTION */}
          {activeTab === "recurrence" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column: Rules */}
              <div className="space-y-4">
                <h3 className="text-base font-semibold text-slate-900">{t("sq.main.t.recurrenceRules")}</h3>
                <div className="space-y-2">
                  {recurrenceRules.map((rule) => (
                    <div
                      key={rule.id}
                      onClick={() => setSelectedRuleId(rule.id)}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedRuleId === rule.id
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                    >
                      <div className="font-semibold text-slate-900">{rule.name}</div>
                      <div className="text-xs text-slate-500 mt-1">
                        Group by: <span className="font-mono text-slate-700">{rule.groupBy}</span> | Window: {rule.windowDays}d | Min: {rule.minimumOccurrences}
                      </div>
                    </div>
                  ))}
                </div>

                {canConfigure && (
                  <Card className="space-y-3">
                    <div className="font-semibold text-slate-900 text-sm">{t("sq.main.t.createRecurrenceRule")}</div>
                    <form onSubmit={handleCreateRecurrenceRule} className="space-y-2">
                      <Input name="code" placeholder={t("sq.main.p.codeEGRecCat30d")} required />
                      <Input name="name" placeholder={t("sq.main.p.nameEGSameCategoryCluster")} required />
                      <Select name="groupBy" defaultValue="category">
                        <option value="category">{t("sq.main.t.category")}</option>
                        <option value="severity">{t("sq.main.t.severity")}</option>
                        <option value="customer">{t("sq.main.t.customer")}</option>
                        <option value="site">{t("sq.main.t.site")}</option>
                        <option value="service">{t("sq.main.t.service")}</option>
                        <option value="root_cause">{t("sq.main.t.rootCause")}</option>
                      </Select>
                      <div className="grid grid-cols-2 gap-2">
                        <Input type="number" name="windowDays" defaultValue="30" placeholder={t("sq.main.p.days")} required />
                        <Input type="number" name="minimumOccurrences" defaultValue="3" placeholder={t("sq.main.p.minOccurrences")} required />
                      </div>
                      <Button type="submit" variant="secondary" className="w-full text-xs">
              {t("sq.main.t.createRule")}
              </Button>
                    </form>
                  </Card>
                )}
              </div>

              {/* Right Columns: Detection Results */}
              <div className="lg:col-span-2 space-y-4">
                <h3 className="text-base font-semibold text-slate-900">{t("sq.main.t.detectedRecurrenceClusters")}</h3>

                {detectionResult ? (
                  <div className="space-y-4">
                    <Card className="p-4 bg-slate-50 border-slate-200">
                      <div className="text-sm font-semibold text-slate-900">
                        Rule: {detectionResult.rule.name}
                      </div>
                      <div className="text-xs text-slate-600 mt-1">
                        Window: {detectionResult.windowDays} days | Threshold: {detectionResult.minimumOccurrences} occurrences | Total Clusters: {detectionResult.clusters.length}
                      </div>
                    </Card>

                    <div className="space-y-3">
                      {detectionResult.clusters.length === 0 ? (
                        <EmptyState
                          title={t("sq.main.title.noRecurringPatternsDetected")}
                          description={t("sq.main.d.noGroupsExceededTheMinimumRecurrenceThre")}
                        />
                      ) : (
                        detectionResult.clusters.map((cluster, idx) => (
                          <Card key={idx} className="p-4 space-y-2">
                            <div className="flex justify-between items-center">
                              <div className="font-semibold text-slate-900">
                                Dimension: <span className="font-mono text-indigo-600">{cluster.groupValue ?? "Unknown"}</span>
                              </div>
                              <StatusPill tone="danger">{cluster.occurrences} Complaints</StatusPill>
                            </div>
                            <div className="text-xs text-slate-500">
                              First occurred: {new Date(cluster.firstOccurredAt).toLocaleDateString()} | Last occurred: {new Date(cluster.lastOccurredAt).toLocaleDateString()}
                            </div>
                            <div className="text-xs text-slate-600 pt-1">
                              Complaint IDs: <span className="font-mono">{cluster.complaintIds.slice(0, 5).join(", ")}{cluster.complaintIds.length > 5 ? "…" : ""}</span>
                            </div>
                          </Card>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  <EmptyState title={t("sq.main.title.selectARecurrenceRule")} description={t("sq.main.d.chooseARuleOnTheLeftToEvaluateRecurringP")} />
                )}
              </div>
            </div>
          )}

          {/* TAB 4: AUTOMATION PROPOSALS */}
          {activeTab === "automation" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Proposals Table */}
              <div className="lg:col-span-2 space-y-4">
                <h3 className="text-base font-semibold text-slate-900">{t("sq.main.t.automationReviewQueue")}</h3>
                <DataTable
                  columns={proposalColumns}
                  rows={proposals}
                  keyOf={(r) => r.id}
                  empty={<div className="p-6 text-center text-sm text-slate-500">{t("sq.main.t.noPendingAutomationProposals")}</div>}
                />
              </div>

              {/* Proposal Detail Card */}
              <div className="space-y-6">
                {selectedProposalId && proposalDetail ? (
                  <Card className="space-y-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-semibold text-slate-900 text-lg">
                          Proposal Detail
                        </h4>
                        <p className="text-xs font-mono text-slate-500">
                          {proposalDetail.id}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="text-xs"
                        onClick={() => setSelectedProposalId(null)}
                      >
                        Close
                      </Button>
                    </div>

                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sq.main.t.trigger")}</span>
                        <span className="font-medium text-slate-800">
                          {proposalDetail.triggerEvent}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sq.main.t.proposedAction")}</span>
                        <span className="font-mono text-slate-900">
                          {proposalDetail.proposedAction}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sq.main.t.status")}</span>
                        <StatusPill tone={proposalStatusTone(proposalDetail.status)}>
                          {proposalDetail.status}
                        </StatusPill>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sq.main.t.gating")}</span>
                        <span className="text-amber-700 font-medium">{t("sq.main.t.founderApprovalRequired")}</span>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-200">
                      <div className="text-xs font-bold text-slate-600 mb-1">
                        Action Parameters
                      </div>
                      <pre className="p-2 bg-slate-50 rounded border border-slate-200 text-xs font-mono overflow-x-auto text-slate-700">
                        {JSON.stringify(proposalDetail.actionParameters, null, 2)}
                      </pre>
                    </div>

                    {canConfigure && proposalDetail.status === "pending" && (
                      <div className="pt-3 border-t border-slate-200 flex gap-2">
                        <Button
                          variant="primary"
                          className="w-full text-xs"
                          onClick={() => handleProposalDecision(proposalDetail.id, "approve")}
                        >
                          Authorize & Apply
                        </Button>
                        <Button
                          variant="secondary"
                          className="w-full text-xs text-rose-700"
                          onClick={() => handleProposalDecision(proposalDetail.id, "reject")}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </Card>
                ) : (
                  <Card className="p-4 space-y-2">
                    <div className="font-semibold text-slate-900 text-sm">
                      Founder-Gated Feedback Loop
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      All automated feedback actions (such as auto-reopening complaints after a low survey score or escalating severity) are proposed without mutating operational state directly. A founder/authorized manager must review and explicitly authorize each proposal before it executes.
                    </p>
                  </Card>
                )}

                {/* Configured rules — read-only. Rules only ever create
                    proposals; they never mutate operational state directly. */}
                <Card className="p-4 space-y-3">
                  <div className="font-semibold text-slate-900 text-sm">
                    Configured Automation Rules
                  </div>
                  {automationRules.length === 0 ? (
                    <p className="text-xs text-slate-500">{t("sq.main.n.noAutomationRulesConfigured")}</p>
                  ) : (
                    <ul className="space-y-2">
                      {automationRules.map((rule) => (
                        <li
                          key={rule.id}
                          className="border-b border-slate-100 pb-2 last:border-b-0 last:pb-0"
                        >
                          <div className="flex justify-between items-start gap-2">
                            <span className="text-sm font-medium text-slate-800">{rule.name}</span>
                            <StatusPill tone={rule.isActive ? "success" : "neutral"}>
                              {rule.isActive ? "active" : "inactive"}
                            </StatusPill>
                          </div>
                          <div className="text-xs text-slate-500 font-mono">{rule.code}</div>
                          <div className="text-xs text-slate-600">
                            {rule.triggerEvent} → {rule.proposedAction}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
