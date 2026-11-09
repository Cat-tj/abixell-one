/** Wave A4 — statutory policies, employee salary profiles, payroll runs, calculation, and payslips. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Employee,
  type WorkforceEmployeeSalaryProfile,
  type WorkforcePayrollCalculation,
  type WorkforcePayrollRunDetail,
  type WorkforcePayrollRunRow,
  type WorkforcePayslip,
  type WorkforcePtkpStatus,
  type WorkforceStatutoryPolicy,
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
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, formatMoney, statusTone } from "../../shared/format";

const PTKP_OPTIONS: WorkforcePtkpStatus[] = [
  "TK/0",
  "TK/1",
  "TK/2",
  "TK/3",
  "K/0",
  "K/1",
  "K/2",
  "K/3",
];

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function workflowLabel(status: WorkforceWorkflowStatus | null): string {
  return status?.stepName ?? status?.stepCode ?? (status ? label(status.instanceStatus) : "Draft");
}

function money(amount: number | string | null | undefined): string {
  if (amount == null) return "—";
  return formatMoney(String(amount));
}

export function WorkforcePayrollPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();
  const canManage = permissions.includes(PERMISSIONS.workforcePayrollManage);
  const canApprove = permissions.includes(PERMISSIONS.workforcePayrollApprove);

  const [tab, setTab] = useState<"runs" | "profiles" | "policies">("runs");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [policies, setPolicies] = useState<WorkforceStatutoryPolicy[]>([]);
  const [runs, setRuns] = useState<WorkforcePayrollRunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<WorkforcePayrollRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [yearFilter, setYearFilter] = useState(String(new Date().getFullYear()));
  const [unitFilter, setUnitFilter] = useState("");

  const [policyCode, setPolicyCode] = useState("");
  const [policyName, setPolicyName] = useState("");
  const [effectiveFromPolicy, setEffectiveFromPolicy] = useState(() => `${new Date().getFullYear()}-01-01`);

  const [profileEmployee, setProfileEmployee] = useState("");
  const [baseSalary, setBaseSalary] = useState("5000000");
  const [fixedAllowance, setFixedAllowance] = useState("0");
  const [overtimeRate, setOvertimeRate] = useState("");
  const [ptkpStatus, setPtkpStatus] = useState<WorkforcePtkpStatus>("TK/0");
  const [hasNpwp, setHasNpwp] = useState(true);
  const [bpjsKesNumber, setBpjsKesNumber] = useState("");
  const [bpjsTkNumber, setBpjsTkNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [profileEffectiveFrom, setProfileEffectiveFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [savedProfiles, setSavedProfiles] = useState<Record<string, WorkforceEmployeeSalaryProfile>>({});

  const [runMonth, setRunMonth] = useState(String(new Date().getMonth() + 1));
  const [runYear, setRunYear] = useState(String(new Date().getFullYear()));
  const [runUnit, setRunUnit] = useState("");
  const [actionComment, setActionComment] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [employeeList, policyList, runList] = await Promise.all([
        api.employees(token).catch(() => [] as Employee[]),
        api.workforceStatutoryPolicies(token),
        api.workforcePayrollRuns(token, {
          periodYear: Number(yearFilter) || undefined,
          organizationUnitId: unitFilter || undefined,
        }),
      ]);
      setEmployees(employeeList);
      setPolicies(policyList);
      setRuns(runList);
      if (selectedRunId) {
        try {
          setRunDetail(await api.workforcePayrollRun(token, selectedRunId));
        } catch {
          setRunDetail(null);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.payroll.msg.couldNotLoadPayrollRecords"));
    } finally {
      setLoading(false);
    }
  }, [token, yearFilter, unitFilter, selectedRunId, t]);

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
      setError(err instanceof ApiError ? err.message : t("wf.payroll.msg.payrollOperationFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createPolicy() {
    if (!requireFields([
      [policyCode.trim(), t("wf.payroll.f.policyCode")],
      [policyName.trim(), t("wf.payroll.f.policyName")],
      [effectiveFromPolicy, t("wf.payroll.f.effectiveFrom")],
    ])) return;
    await runAction(
      () => api.createWorkforceStatutoryPolicy(token, {
        policyCode: policyCode.trim(),
        name: policyName.trim(),
        effectiveFrom: effectiveFromPolicy,
      }),
      `Statutory policy ${policyName} created.`,
    );
    setPolicyCode("");
    setPolicyName("");
  }

  async function saveProfile() {
    if (!requireFields(
      [
        [profileEmployee, t("wf.payroll.f.employee")],
        [baseSalary.trim(), t("wf.payroll.f.baseSalary")],
        [profileEffectiveFrom, t("wf.payroll.f.effectiveFrom")],
      ],
      [[!(Number(baseSalary) > 0), t("wf.payroll.f.baseSalary")]],
    )) return;
    await runAction(async () => {
      const saved = await api.setWorkforceSalaryProfile(token, {
        employeeId: profileEmployee,
        baseSalary: Number(baseSalary),
        fixedAllowance: Number(fixedAllowance) || 0,
        overtimeHourlyRate: overtimeRate ? Number(overtimeRate) : null,
        ptkpStatus,
        hasNpwp,
        bpjsKesehatanNumber: bpjsKesNumber || null,
        bpjsTkNumber: bpjsTkNumber || null,
        bankName: bankName || null,
        bankAccountNumber: bankAccount || null,
        effectiveFrom: profileEffectiveFrom,
      });
      setSavedProfiles((current) => ({ ...current, [profileEmployee]: saved }));
    }, "Salary profile saved.");
  }

  async function createRun() {
    if (!requireFields(
      [[runMonth.trim(), t("wf.payroll.f.month")], [runYear.trim(), t("wf.payroll.f.year")]],
      [
        [!(Number(runMonth) >= 1 && Number(runMonth) <= 12), t("wf.payroll.f.month")],
        [!(Number(runYear) >= 2000 && Number(runYear) <= 2100), t("wf.payroll.f.year")],
      ],
    )) return;
    await runAction(
      () => api.createWorkforcePayrollRun(token, {
        periodMonth: Number(runMonth),
        periodYear: Number(runYear),
        organizationUnitId: runUnit || null,
      }),
      "Payroll period created.",
    );
  }

  async function calculateRun(id: string) {
    await runAction(async () => {
      const result: WorkforcePayrollCalculation = await api.calculateWorkforcePayrollRun(token, id);
      setSelectedRunId(id);
      setRunDetail(await api.workforcePayrollRun(token, id));
      return result;
    }, "Payroll calculation finished.");
  }

  async function executeWorkflow(actionCode: string) {
    if (!selectedRunId) return;
    await runAction(
      () => api.actOnWorkforcePayrollRun(token, selectedRunId, actionCode, actionComment || null),
      `Workflow action ${label(actionCode)} executed.`,
    );
    setActionComment("");
  }

  const runColumns: Column<WorkforcePayrollRunRow>[] = [
    {
      header: t("wf.payroll.h.payrollRun"),
      cell: ({ payrollRun }) => (
        <div>
          <div className="font-semibold text-slate-900">{payrollRun.runNumber}</div>
          <div className="text-xs text-slate-500">{payrollRun.periodMonth}/{payrollRun.periodYear}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.payroll.h.employees"), cell: ({ payrollRun }) => payrollRun.employeeCount },
    { header: t("wf.payroll.h.totalGross"), cell: ({ payrollRun }) => money(payrollRun.totalGross) },
    { header: t("wf.payroll.h.totalDeductions"), cell: ({ payrollRun }) => money(payrollRun.totalDeductions) },
    { header: t("wf.payroll.h.totalNet"), cell: ({ payrollRun }) => <span className="font-semibold text-slate-900">{money(payrollRun.totalNet)}</span> },
    {
      header: t("wf.payroll.h.status"),
      cell: ({ status, payrollRun }) => (
        <StatusPill tone={statusTone(status?.instanceStatus)}>
          {payrollRun.closedAt ? "Closed" : workflowLabel(status)}
        </StatusPill>
      ),
      mobileRole: "status",
    },
    {
      header: t("wf.payroll.h.actions"),
      cell: ({ payrollRun }) => (
        <div className="flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
          <Button
            variant="secondary"
            className="text-xs"
            onClick={async () => {
              setSelectedRunId(payrollRun.id);
              try {
                setRunDetail(await api.workforcePayrollRun(token, payrollRun.id));
              } catch {
                setRunDetail(null);
              }
            }}
          >
            Details
          </Button>
          {canManage && !payrollRun.closedAt ? (
            <Button variant="secondary" className="text-xs" disabled={busy} onClick={() => void calculateRun(payrollRun.id)}>
              Calculate
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const payslipColumns: Column<WorkforcePayslip>[] = [
    { header: t("wf.payroll.h.employee"), cell: (row) => <span className="font-semibold">{employeeName(row.employeeId)}</span>, mobileRole: "title" },
    { header: "PTKP", cell: (row) => <Badge>{row.ptkpStatus ?? "TK/0"}</Badge> },
    { header: t("wf.payroll.h.baseSalary"), cell: (row) => money(row.baseSalary) },
    { header: t("wf.payroll.h.allowances"), cell: (row) => money(row.allowances) },
    { header: t("wf.payroll.h.gross"), cell: (row) => money(row.grossSalary) },
    { header: t("wf.payroll.h.pph21"), cell: (row) => money(row.pph21Withheld) },
    { header: t("wf.payroll.h.deductions"), cell: (row) => money(row.totalDeductions) },
    { header: t("wf.payroll.h.netPayout"), cell: (row) => <span className="font-bold text-slate-900">{money(row.netSalary)}</span>, mobileRole: "status" },
  ];

  const policyColumns: Column<WorkforceStatutoryPolicy>[] = [
    {
      header: t("wf.payroll.h.policy"),
      cell: (row) => (
        <div>
          <div className="font-semibold text-slate-900">{row.name}</div>
          <div className="font-mono text-xs text-slate-500">{row.policyCode}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.payroll.h.method"), cell: (row) => label(row.pph21Method) },
    { header: t("wf.payroll.h.bpjsKesEeEr"), cell: (row) => `${(row.bpjsKesehatanRateEmployee * 100).toFixed(1)}% / ${(row.bpjsKesehatanRateEmployer * 100).toFixed(1)}%` },
    { header: t("wf.payroll.h.bpjsTkJhtEeEr"), cell: (row) => `${(row.bpjsTkJhtRateEmployee * 100).toFixed(1)}% / ${(row.bpjsTkJhtRateEmployer * 100).toFixed(1)}%` },
    { header: t("wf.payroll.h.effectiveFrom"), cell: (row) => formatDateShort(row.effectiveFrom) },
    { header: t("wf.payroll.h.status"), cell: (row) => <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>, mobileRole: "status" },
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
      <PageHeader title={t("wf.payroll.title.payroll")} subtitle={t("wf.payroll.sub.manageIndonesianStatutoryPayrollPolicies")} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? <Alert tone="info">{t("wf.payroll.msg.settingProfilesRunningPayrollAndRecalcul", { perm: <code className="font-mono text-xs">workforce.payroll.manage</code> })}</Alert> : null}
      {!canApprove ? <Alert tone="info">{t("wf.payroll.msg.payrollApprovalsAndClosingPeriodsRequire", { perm: <code className="font-mono text-xs">workforce.payroll.approve</code> })}</Alert> : null}

      <div className="flex overflow-x-auto border-b border-slate-200">
        {tabButton("runs", t("wf.payroll.t.payrollRunsCount", { count: runs.length }))}
        {tabButton("profiles", t("wf.payroll.t.salaryProfiles"))}
        {tabButton("policies", t("wf.payroll.t.statutoryPoliciesCount", { count: policies.length }))}
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.payroll.t.scopeFilters")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("wf.payroll.f.periodYear")}><Input type="number" min="2000" max="2100" value={yearFilter} onChange={(event) => setYearFilter(event.target.value)} /></Field>
          <Field label={t("wf.payroll.f.organizationUnitId")}><Input value={unitFilter} onChange={(event) => setUnitFilter(event.target.value)} placeholder={t("wf.payroll.p.allOrganizationUnits")} /></Field>
        </div>
      </Card>

      {canManage && tab === "runs" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.payroll.t.createPayrollRun")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("wf.payroll.f.month")} required><Input type="number" min="1" max="12" value={runMonth} onChange={(event) => setRunMonth(event.target.value)} /></Field>
            <Field label={t("wf.payroll.f.year")} required><Input type="number" min="2000" max="2100" value={runYear} onChange={(event) => setRunYear(event.target.value)} /></Field>
            <Field label={t("wf.payroll.f.organizationUnitId")}><Input value={runUnit} onChange={(event) => setRunUnit(event.target.value)} placeholder={t("wf.payroll.p.optionalScope")} /></Field>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createRun()}>{t("wf.payroll.t.createPayrollPeriod")}</Button>
        </Card>
      ) : null}

      {canManage && tab === "profiles" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.payroll.t.configureEmployeeSalaryProfile")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("wf.payroll.f.employee")} required><Select value={profileEmployee} onChange={(event) => setProfileEmployee(event.target.value)}><option value="">{t("wf.payroll.t.selectEmployee")}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</Select></Field>
            <Field label={t("wf.payroll.f.baseSalary")} required><Input type="number" min="0" step="1000" value={baseSalary} onChange={(event) => setBaseSalary(event.target.value)} /></Field>
            <Field label={t("wf.payroll.f.fixedAllowance")}><Input type="number" min="0" step="1000" value={fixedAllowance} onChange={(event) => setFixedAllowance(event.target.value)} /></Field>
            <Field label={t("wf.payroll.f.overtimeHourlyRate")}><Input type="number" min="0" step="1000" value={overtimeRate} onChange={(event) => setOvertimeRate(event.target.value)} placeholder={t("wf.payroll.p.autoCalculatedIfBlank")} /></Field>
            <Field label={t("wf.payroll.f.ptkpStatus")} required><Select value={ptkpStatus} onChange={(event) => setPtkpStatus(event.target.value as WorkforcePtkpStatus)}>{PTKP_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}</Select></Field>
            <Field label={t("wf.payroll.f.bpjsKesehatanNumber")}><Input value={bpjsKesNumber} onChange={(event) => setBpjsKesNumber(event.target.value)} /></Field>
            <Field label={t("wf.payroll.f.bpjsKetenagakerjaanNumber")}><Input value={bpjsTkNumber} onChange={(event) => setBpjsTkNumber(event.target.value)} /></Field>
            <Field label={t("wf.payroll.f.effectiveFrom")} required><Input type="date" value={profileEffectiveFrom} onChange={(event) => setProfileEffectiveFrom(event.target.value)} /></Field>
            <Field label={t("wf.payroll.f.bankName")}><Input value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder={t("wf.payroll.p.bcaMandiriBni")} /></Field>
            <Field label={t("wf.payroll.f.bankAccountNumber")}><Input value={bankAccount} onChange={(event) => setBankAccount(event.target.value)} /></Field>
            <div className="flex items-center pt-6"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hasNpwp} onChange={(event) => setHasNpwp(event.target.checked)} />{t("wf.payroll.f.hasRegisteredNpwp")}</label></div>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void saveProfile()}>{t("wf.payroll.t.saveSalaryProfile")}</Button>
          {profileEmployee && savedProfiles[profileEmployee] ? (
            <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <span className="font-semibold">{t("wf.payroll.t.lastSavedProfile")}</span> Base {money(savedProfiles[profileEmployee].baseSalary)} | Allowance {money(savedProfiles[profileEmployee].fixedAllowance)} | PTKP {savedProfiles[profileEmployee].ptkpStatus}
            </div>
          ) : null}
        </Card>
      ) : null}

      {canManage && tab === "policies" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.payroll.t.createStatutoryPolicy")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("wf.payroll.f.policyCode")} required><Input value={policyCode} onChange={(event) => setPolicyCode(event.target.value)} placeholder={t("common.form.example", { value: "ID_STATUTORY_2026" })} /></Field>
            <Field label={t("wf.payroll.f.policyName")} required><Input value={policyName} onChange={(event) => setPolicyName(event.target.value)} placeholder={t("wf.payroll.p.indonesiaStandard2026")} /></Field>
            <Field label={t("wf.payroll.f.effectiveFrom")} required><Input type="date" value={effectiveFromPolicy} onChange={(event) => setEffectiveFromPolicy(event.target.value)} /></Field>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createPolicy()}>{t("wf.payroll.t.createStatutoryPolicy")}</Button>
        </Card>
      ) : null}

      {loading ? <Spinner label={t("wf.payroll.f.loadingPayrollData")} /> : (
        <>
          {tab === "runs" ? (
            <div className="space-y-4">
              <Card>
                <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.payroll.t.payrollRuns")}</h2>
                <DataTable columns={runColumns} rows={runs} keyOf={(row) => row.payrollRun.id} mobileBreakpoint="md" empty={<EmptyState title={t("wf.payroll.title.noPayrollRuns")} description={t("wf.payroll.d.createAMonthlyPeriodAboveToStartCalculat")} />} />
              </Card>

              {runDetail ? (
                <Card>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">{runDetail.payrollRun.runNumber} — Period {runDetail.payrollRun.periodMonth}/{runDetail.payrollRun.periodYear}</h3>
                      <div className="text-xs text-slate-500">Gross {money(runDetail.payrollRun.totalGross)} | Deductions {money(runDetail.payrollRun.totalDeductions)} | Net payout {money(runDetail.payrollRun.totalNet)}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={statusTone(runDetail.status?.instanceStatus)}>{runDetail.payrollRun.closedAt ? "Closed" : workflowLabel(runDetail.status)}</StatusPill>
                      {canApprove && runDetail.availableActions.map((action) => (
                        <Button key={action.actionCode} variant="secondary" className="text-xs" disabled={busy} onClick={() => void executeWorkflow(action.actionCode)}>
                          {action.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {canApprove && runDetail.availableActions.length > 0 ? (
                    <div className="mb-4 max-w-md">
                      <Field label={t("wf.payroll.f.approvalComment")}><Input value={actionComment} onChange={(event) => setActionComment(event.target.value)} placeholder={t("wf.payroll.p.reasonOrSignOffComment")} /></Field>
                    </div>
                  ) : null}
                  <h4 className="mb-2 text-sm font-semibold text-slate-800">Generated Payslips ({runDetail.payslips.length})</h4>
                  <DataTable columns={payslipColumns} rows={runDetail.payslips} keyOf={(row) => row.id} mobileBreakpoint="md" empty={<EmptyState title={t("wf.payroll.title.noPayslipsGenerated")} description={t("wf.payroll.d.clickCalculateOnThePayrollRunToComputePa")} />} />
                </Card>
              ) : null}
            </div>
          ) : null}

          {tab === "policies" ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.payroll.t.configuredStatutoryPolicies")}</h2>
              <DataTable columns={policyColumns} rows={policies} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.payroll.title.noStatutoryPolicies")} description={t("wf.payroll.d.createTheBaselinePolicyAbove")} />} />
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
