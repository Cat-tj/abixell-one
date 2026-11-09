/** Wave A4 — leave balances, requests, overtime, and delegated approvals. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Employee,
  type WorkforceLeaveBalance,
  type WorkforceLeaveRequestRow,
  type WorkforceLeaveType,
  type WorkforceOvertimeRequestRow,
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

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function workflowLabel(status: WorkforceWorkflowStatus | null): string {
  return status?.stepName ?? status?.stepCode ?? (status ? label(status.instanceStatus) : "Submitted");
}

function toTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

export function WorkforceLeaveOvertimePage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();
  const canManage = permissions.includes(PERMISSIONS.workforceLeaveManage);
  const canApprove = permissions.includes(PERMISSIONS.workforceLeaveApprove);

  const [tab, setTab] = useState<"leave" | "overtime" | "balances" | "types">("leave");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<WorkforceLeaveType[]>([]);
  const [balances, setBalances] = useState<WorkforceLeaveBalance[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<WorkforceLeaveRequestRow[]>([]);
  const [overtimeRequests, setOvertimeRequests] = useState<WorkforceOvertimeRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [employeeFilter, setEmployeeFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [balanceYear, setBalanceYear] = useState(String(new Date().getFullYear()));

  const [typeCode, setTypeCode] = useState("");
  const [typeName, setTypeName] = useState("");
  const [allowance, setAllowance] = useState("12");
  const [typePaid, setTypePaid] = useState(true);
  const [requiresAttachment, setRequiresAttachment] = useState(false);

  const [allocationEmployee, setAllocationEmployee] = useState("");
  const [allocationType, setAllocationType] = useState("");
  const [allocatedDays, setAllocatedDays] = useState("12");

  const [leaveEmployee, setLeaveEmployee] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [leaveStart, setLeaveStart] = useState("");
  const [leaveEnd, setLeaveEnd] = useState("");
  const [leaveDays, setLeaveDays] = useState("1");
  const [leaveReason, setLeaveReason] = useState("");
  const [leaveAttachmentId, setLeaveAttachmentId] = useState("");

  const [overtimeEmployee, setOvertimeEmployee] = useState("");
  const [overtimeDate, setOvertimeDate] = useState("");
  const [overtimeStart, setOvertimeStart] = useState("17:00");
  const [overtimeEnd, setOvertimeEnd] = useState("19:00");
  const [estimatedHours, setEstimatedHours] = useState("2");
  const [overtimeReason, setOvertimeReason] = useState("");
  const [actualHoursById, setActualHoursById] = useState<Record<string, string>>({});
  const [actionCodeById, setActionCodeById] = useState<Record<string, string>>({});
  const [commentById, setCommentById] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [employeeList, typeList, leaveList, overtimeList] = await Promise.all([
        api.employees(token).catch(() => [] as Employee[]),
        api.workforceLeaveTypes(token, true),
        api.workforceLeaveRequests(token, {
          employeeId: employeeFilter || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
        api.workforceOvertimeRequests(token, {
          employeeId: employeeFilter || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
      ]);
      setEmployees(employeeList);
      setLeaveTypes(typeList);
      setLeaveRequests(leaveList);
      setOvertimeRequests(overtimeList);
      if (employeeFilter) {
        setBalances(await api.workforceLeaveBalances(token, employeeFilter, Number(balanceYear)));
      } else {
        setBalances([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.leave.msg.couldNotLoadLeaveAndOvertimeData"));
    } finally {
      setLoading(false);
    }
  }, [token, employeeFilter, fromDate, toDate, balanceYear, t]);

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
  const leaveTypeName = useMemo(
    () => (id: string) => leaveTypes.find((item) => item.id === id)?.name ?? id,
    [leaveTypes],
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

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.leave.msg.theActionCouldNotBeCompleted"));
    } finally {
      setBusy(false);
    }
  }

  async function createLeaveType() {
    if (!requireFields([[typeCode.trim(), t("wf.leave.f.code")], [typeName.trim(), t("wf.leave.f.name")]])) return;
    await run(
      () => api.createWorkforceLeaveType(token, {
        code: typeCode.trim(),
        name: typeName.trim(),
        annualAllowanceDays: Number(allowance),
        isPaid: typePaid,
        requiresAttachment,
      }),
      `Leave type ${typeName} created.`,
    );
    setTypeCode("");
    setTypeName("");
  }

  async function allocateBalance() {
    if (!requireFields(
      [
        [allocationEmployee, t("wf.leave.f.employee")],
        [allocationType, t("wf.leave.f.leaveType")],
        [balanceYear.trim(), t("wf.leave.f.year")],
        [allocatedDays.trim(), t("wf.leave.f.allocatedDays")],
      ],
      [[!(Number(allocatedDays) >= 0), t("wf.leave.f.allocatedDays")]],
    )) return;
    await run(
      () => api.setWorkforceLeaveAllocation(token, {
        employeeId: allocationEmployee,
        leaveTypeId: allocationType,
        balanceYear: Number(balanceYear),
        allocatedDays: Number(allocatedDays),
      }),
      "Leave allocation saved.",
    );
  }

  async function submitLeave() {
    if (!requireFields(
      [
        [leaveEmployee, t("wf.leave.f.employee")],
        [leaveTypeId, t("wf.leave.f.leaveType")],
        [leaveStart, t("wf.leave.f.startDate")],
        [leaveEnd, t("wf.leave.f.endDate")],
        [leaveDays.trim(), t("wf.leave.f.totalDays")],
      ],
      [
        [!(Number(leaveDays) > 0), t("wf.leave.f.totalDays")],
        [leaveEnd < leaveStart, t("wf.leave.f.endDate")],
      ],
    )) return;
    await run(
      () => api.createWorkforceLeaveRequest(token, {
        employeeId: leaveEmployee,
        leaveTypeId,
        startDate: leaveStart,
        endDate: leaveEnd,
        totalDays: Number(leaveDays),
        reason: leaveReason || null,
        attachmentDocumentId: leaveAttachmentId || null,
      }),
      "Leave request submitted to the approval workflow.",
    );
    setLeaveReason("");
    setLeaveAttachmentId("");
  }

  async function submitOvertime() {
    if (!requireFields(
      [
        [overtimeEmployee, t("wf.leave.f.employee")],
        [overtimeDate, t("wf.leave.f.overtimeDate")],
        [overtimeStart, t("wf.leave.f.startTime")],
        [overtimeEnd, t("wf.leave.f.endTime")],
        [estimatedHours.trim(), t("wf.leave.f.estimatedHours")],
      ],
      [[!(Number(estimatedHours) > 0), t("wf.leave.f.estimatedHours")]],
    )) return;
    await run(
      () => api.createWorkforceOvertimeRequest(token, {
        employeeId: overtimeEmployee,
        overtimeDate,
        startTime: toTime(overtimeStart),
        endTime: toTime(overtimeEnd),
        estimatedHours: Number(estimatedHours),
        reason: overtimeReason || null,
      }),
      "Overtime request submitted to the approval workflow.",
    );
    setOvertimeReason("");
  }

  async function act(kind: "leave" | "overtime", id: string) {
    const actionCode = actionCodeById[id]?.trim();
    if (!requireFields([[actionCode, t("wf.leave.p.actionCode")]])) return;
    await run(
      () => kind === "leave"
        ? api.actOnWorkforceLeaveRequest(token, id, actionCode, commentById[id] || null)
        : api.actOnWorkforceOvertimeRequest(token, id, actionCode, commentById[id] || null),
      `${label(actionCode)} action completed.`,
    );
  }

  async function recordActualOvertime(id: string) {
    const raw = (actualHoursById[id] ?? "").trim().replace(",", ".");
    if (!requireFields([[raw, t("wf.leave.p.actualHours")]], [[!(Number(raw) >= 0), t("wf.leave.p.actualHours")]])) return;
    await run(
      () => api.recordWorkforceActualOvertime(token, id, Number(raw)),
      "Actual overtime recorded.",
    );
  }

  const leaveColumns: Column<WorkforceLeaveRequestRow>[] = [
    {
      header: t("wf.leave.h.request"),
      cell: ({ leaveRequest }) => (
        <div>
          <div className="font-semibold text-slate-900">{leaveRequest.requestNumber}</div>
          <div className="text-xs text-slate-500">{employeeName(leaveRequest.employeeId)}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.leave.h.leaveType"), cell: ({ leaveRequest }) => <Badge>{leaveTypeName(leaveRequest.leaveTypeId)}</Badge> },
    { header: t("wf.leave.h.dates"), cell: ({ leaveRequest }) => `${formatDateShort(leaveRequest.startDate)} – ${formatDateShort(leaveRequest.endDate)}` },
    { header: t("wf.leave.h.days"), cell: ({ leaveRequest }) => leaveRequest.totalDays },
    {
      header: t("wf.leave.h.workflow"),
      cell: ({ status }) => <StatusPill tone={statusTone(status?.instanceStatus)}>{workflowLabel(status)}</StatusPill>,
      mobileRole: "status",
    },
    {
      header: t("wf.leave.h.approvalAction"),
      cell: ({ leaveRequest, status }) => canApprove && status?.instanceStatus === "in_progress" ? (
        <div className="min-w-[180px] space-y-1" onClick={(event) => event.stopPropagation()}>
          <Input
            aria-label={`Action code for ${leaveRequest.requestNumber}`}
            placeholder={t("wf.leave.p.actionCode")}
            value={actionCodeById[leaveRequest.id] ?? ""}
            onChange={(event) => setActionCodeById((current) => ({ ...current, [leaveRequest.id]: event.target.value }))}
          />
          <Input
            aria-label={`Comment for ${leaveRequest.requestNumber}`}
            placeholder={t("wf.leave.p.optionalComment")}
            value={commentById[leaveRequest.id] ?? ""}
            onChange={(event) => setCommentById((current) => ({ ...current, [leaveRequest.id]: event.target.value }))}
          />
          <Button variant="secondary" disabled={busy} onClick={() => void act("leave", leaveRequest.id)}>
            Run action
          </Button>
        </div>
      ) : <span className="text-slate-400">—</span>,
    },
  ];

  const overtimeColumns: Column<WorkforceOvertimeRequestRow>[] = [
    {
      header: t("wf.leave.h.request"),
      cell: ({ overtimeRequest }) => (
        <div>
          <div className="font-semibold text-slate-900">{overtimeRequest.requestNumber}</div>
          <div className="text-xs text-slate-500">{employeeName(overtimeRequest.employeeId)}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.leave.h.date"), cell: ({ overtimeRequest }) => formatDateShort(overtimeRequest.overtimeDate) },
    { header: t("wf.leave.h.planned"), cell: ({ overtimeRequest }) => `${overtimeRequest.startTime}–${overtimeRequest.endTime} (${overtimeRequest.estimatedHours}h)` },
    { header: t("wf.leave.h.actual"), cell: ({ overtimeRequest }) => overtimeRequest.actualHours == null ? "—" : `${overtimeRequest.actualHours}h` },
    {
      header: t("wf.leave.h.workflow"),
      cell: ({ status }) => <StatusPill tone={statusTone(status?.instanceStatus)}>{workflowLabel(status)}</StatusPill>,
      mobileRole: "status",
    },
    {
      header: t("wf.leave.h.actions"),
      cell: ({ overtimeRequest, status }) => (
        <div className="min-w-[190px] space-y-1" onClick={(event) => event.stopPropagation()}>
          {canManage && overtimeRequest.approvedAt && overtimeRequest.actualHours == null ? (
            <div className="flex items-end gap-1">
              <Input
                aria-label={`Actual hours for ${overtimeRequest.requestNumber}`}
                type="number"
                min="0"
                step="0.25"
                placeholder={t("wf.leave.p.actualHours")}
                value={actualHoursById[overtimeRequest.id] ?? ""}
                onChange={(event) => setActualHoursById((current) => ({ ...current, [overtimeRequest.id]: event.target.value }))}
              />
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void recordActualOvertime(overtimeRequest.id)}
              >
                {t("common.save")}
              </Button>
            </div>
          ) : null}
          {canApprove && status?.instanceStatus === "in_progress" ? (
            <>
              <Input
                aria-label={`Action code for ${overtimeRequest.requestNumber}`}
                placeholder={t("wf.leave.p.workflowActionCode")}
                value={actionCodeById[overtimeRequest.id] ?? ""}
                onChange={(event) => setActionCodeById((current) => ({ ...current, [overtimeRequest.id]: event.target.value }))}
              />
              <Input
                aria-label={`Comment for ${overtimeRequest.requestNumber}`}
                placeholder={t("wf.leave.p.optionalComment")}
                value={commentById[overtimeRequest.id] ?? ""}
                onChange={(event) => setCommentById((current) => ({ ...current, [overtimeRequest.id]: event.target.value }))}
              />
              <Button variant="secondary" disabled={busy} onClick={() => void act("overtime", overtimeRequest.id)}>
                Run action
              </Button>
            </>
          ) : null}
          {(!canApprove || status?.instanceStatus !== "in_progress") &&
            (!canManage || !overtimeRequest.approvedAt || overtimeRequest.actualHours != null) ? <span className="text-slate-400">—</span> : null}
        </div>
      ),
    },
  ];

  const balanceColumns: Column<WorkforceLeaveBalance>[] = [
    { header: t("wf.leave.h.employee"), cell: (row) => <span className="font-semibold">{employeeName(row.employeeId)}</span>, mobileRole: "title" },
    { header: t("wf.leave.h.leaveType"), cell: (row) => leaveTypeName(row.leaveTypeId) },
    { header: t("wf.leave.h.year"), cell: (row) => row.balanceYear },
    { header: t("wf.leave.h.allocated"), cell: (row) => row.allocatedDays },
    { header: t("wf.leave.h.used"), cell: (row) => row.usedDays },
    { header: t("wf.leave.h.pending"), cell: (row) => row.pendingDays },
    {
      header: t("wf.leave.h.available"),
      cell: (row) => <StatusPill tone={row.allocatedDays - row.usedDays - row.pendingDays > 0 ? "success" : "warning"}>
        {row.allocatedDays - row.usedDays - row.pendingDays} days
      </StatusPill>,
      mobileRole: "status",
    },
  ];

  const typeColumns: Column<WorkforceLeaveType>[] = [
    {
      header: t("wf.leave.h.leaveType"),
      cell: (row) => <div><div className="font-semibold">{row.name}</div><div className="font-mono text-xs text-slate-500">{row.code}</div></div>,
      mobileRole: "title",
    },
    { header: t("wf.leave.h.annualAllowance"), cell: (row) => `${row.annualAllowanceDays} days` },
    { header: t("wf.leave.h.paid"), cell: (row) => row.isPaid ? "Yes" : "No" },
    { header: t("wf.leave.h.attachment"), cell: (row) => row.requiresAttachment ? "Required" : "Optional" },
    { header: t("wf.leave.h.state"), cell: (row) => <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>, mobileRole: "status" },
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
      <PageHeader title={t("wf.leave.title.leaveOvertime")} subtitle={t("wf.leave.sub.keepEntitlementsAccurateAndRouteLeaveAnd")} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? <Alert tone="info">{t("wf.leave.msg.leaveSetupAndRequestSubmissionRequirePer", { perm: <code className="font-mono text-xs">workforce.leave.manage</code> })}</Alert> : null}
      {!canApprove ? <Alert tone="info">{t("wf.leave.msg.workflowDecisionsRequirePerm", { perm: <code className="font-mono text-xs">workforce.leave.approve</code> })}</Alert> : null}

      <div className="flex overflow-x-auto border-b border-slate-200">
        {tabButton("leave", t("wf.leave.t.leaveRequestsCount", { count: leaveRequests.length }))}
        {tabButton("overtime", t("wf.leave.t.overtimeCount", { count: overtimeRequests.length }))}
        {tabButton("balances", t("wf.leave.t.balancesCount", { count: balances.length }))}
        {tabButton("types", t("wf.leave.t.leaveTypesCount", { count: leaveTypes.length }))}
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.leave.t.filters")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("wf.leave.f.employee")}>
            <Select value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)}>
              <option value="">{t("wf.leave.t.allEmployees")}</option>
              {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} ({employee.employeeNumber})</option>)}
            </Select>
          </Field>
          <Field label={t("wf.leave.f.from")}><Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></Field>
          <Field label={t("wf.leave.f.to")}><Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></Field>
          <Field label={t("wf.leave.f.balanceYear")}><Input type="number" min="2000" max="2100" value={balanceYear} onChange={(event) => setBalanceYear(event.target.value)} /></Field>
        </div>
        {tab === "balances" && !employeeFilter ? <p className="mt-2 text-xs text-slate-500">{t("wf.leave.n.selectAnEmployeeToLoadScopedLeaveBalance")}</p> : null}
      </Card>

      {canManage && tab === "leave" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.leave.t.submitLeaveRequest")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("wf.leave.f.employee")} required><Select value={leaveEmployee} onChange={(event) => setLeaveEmployee(event.target.value)}><option value="">{t("wf.leave.t.selectEmployee")}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</Select></Field>
            <Field label={t("wf.leave.f.leaveType")} required><Select value={leaveTypeId} onChange={(event) => setLeaveTypeId(event.target.value)}><option value="">{t("wf.leave.t.selectLeaveType")}</option>{leaveTypes.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
            <Field label={t("wf.leave.f.startDate")} required><Input type="date" value={leaveStart} onChange={(event) => setLeaveStart(event.target.value)} /></Field>
            <Field label={t("wf.leave.f.endDate")} required><Input type="date" value={leaveEnd} onChange={(event) => setLeaveEnd(event.target.value)} /></Field>
            <Field label={t("wf.leave.f.totalDays")} required><Input type="number" min="0.5" step="0.5" value={leaveDays} onChange={(event) => setLeaveDays(event.target.value)} /></Field>
            <Field label={t("wf.leave.f.attachmentDocumentId")} hint={t("wf.leave.n.requiredWhenTheSelectedPolicyRequiresEvi")}><Input value={leaveAttachmentId} onChange={(event) => setLeaveAttachmentId(event.target.value)} /></Field>
            <div className="sm:col-span-2"><Field label={t("wf.leave.f.reason")}><Textarea rows={2} value={leaveReason} onChange={(event) => setLeaveReason(event.target.value)} /></Field></div>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void submitLeave()}>{t("wf.leave.t.submitLeaveRequest")}</Button>
        </Card>
      ) : null}

      {canManage && tab === "overtime" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.leave.t.submitOvertimeRequest")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("wf.leave.f.employee")} required><Select value={overtimeEmployee} onChange={(event) => setOvertimeEmployee(event.target.value)}><option value="">{t("wf.leave.t.selectEmployee")}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</Select></Field>
            <Field label={t("wf.leave.f.overtimeDate")} required><Input type="date" value={overtimeDate} onChange={(event) => setOvertimeDate(event.target.value)} /></Field>
            <Field label={t("wf.leave.f.startTime")} required><Input type="time" value={overtimeStart} onChange={(event) => setOvertimeStart(event.target.value)} /></Field>
            <Field label={t("wf.leave.f.endTime")} required><Input type="time" value={overtimeEnd} onChange={(event) => setOvertimeEnd(event.target.value)} /></Field>
            <Field label={t("wf.leave.f.estimatedHours")} required><Input type="number" min="0.25" step="0.25" value={estimatedHours} onChange={(event) => setEstimatedHours(event.target.value)} /></Field>
            <div className="sm:col-span-2 lg:col-span-3"><Field label={t("wf.leave.f.reason")}><Textarea rows={2} value={overtimeReason} onChange={(event) => setOvertimeReason(event.target.value)} /></Field></div>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void submitOvertime()}>{t("wf.leave.t.submitOvertimeRequest")}</Button>
        </Card>
      ) : null}

      {canManage && tab === "balances" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.leave.t.setLeaveAllocation")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label={t("wf.leave.f.employee")} required><Select value={allocationEmployee} onChange={(event) => setAllocationEmployee(event.target.value)}><option value="">{t("wf.leave.t.selectEmployee")}</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName}</option>)}</Select></Field>
            <Field label={t("wf.leave.f.leaveType")} required><Select value={allocationType} onChange={(event) => setAllocationType(event.target.value)}><option value="">{t("wf.leave.t.selectType")}</option>{leaveTypes.filter((item) => item.isActive).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
            <Field label={t("wf.leave.f.year")} required><Input type="number" min="2000" max="2100" value={balanceYear} onChange={(event) => setBalanceYear(event.target.value)} /></Field>
            <Field label={t("wf.leave.f.allocatedDays")} required><Input type="number" min="0" step="0.5" value={allocatedDays} onChange={(event) => setAllocatedDays(event.target.value)} /></Field>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void allocateBalance()}>{t("wf.leave.t.saveAllocation")}</Button>
        </Card>
      ) : null}

      {canManage && tab === "types" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.leave.t.createLeaveType")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("wf.leave.f.code")} required><Input value={typeCode} onChange={(event) => setTypeCode(event.target.value)} placeholder={t("common.form.example", { value: "ANNUAL" })} /></Field>
            <Field label={t("wf.leave.f.name")} required><Input value={typeName} onChange={(event) => setTypeName(event.target.value)} placeholder={t("wf.leave.p.annualLeave")} /></Field>
            <Field label={t("wf.leave.f.annualAllowance")}><Input type="number" min="0" step="0.5" value={allowance} onChange={(event) => setAllowance(event.target.value)} /></Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-5 text-sm text-slate-700">
            <label className="flex items-center gap-2"><input type="checkbox" checked={typePaid} onChange={(event) => setTypePaid(event.target.checked)} />{t("wf.leave.f.paidLeave")}</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={requiresAttachment} onChange={(event) => setRequiresAttachment(event.target.checked)} />{t("wf.leave.f.requiresAttachment")}</label>
          </div>
          <Button className="mt-3" disabled={busy} onClick={() => void createLeaveType()}>{t("wf.leave.t.createLeaveType")}</Button>
        </Card>
      ) : null}

      {loading ? <Spinner label={t("wf.leave.f.loadingLeaveAndOvertimeRecords")} /> : (
        <Card>
          {tab === "leave" ? <DataTable columns={leaveColumns} rows={leaveRequests} keyOf={(row) => row.leaveRequest.id} mobileBreakpoint="md" empty={<EmptyState title={t("wf.leave.title.noLeaveRequests")} description={t("wf.leave.d.submitARequestAboveOrAdjustTheFilters")} />} /> : null}
          {tab === "overtime" ? <DataTable columns={overtimeColumns} rows={overtimeRequests} keyOf={(row) => row.overtimeRequest.id} mobileBreakpoint="md" empty={<EmptyState title={t("wf.leave.title.noOvertimeRequests")} description={t("wf.leave.d.submitAnOvertimeRequestAboveOrAdjustTheF")} />} /> : null}
          {tab === "balances" ? <DataTable columns={balanceColumns} rows={balances} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.leave.title.noBalancesLoaded")} description={t("wf.leave.d.selectAnEmployeeAndYearToViewLeaveBalanc")} />} /> : null}
          {tab === "types" ? <DataTable columns={typeColumns} rows={leaveTypes} keyOf={(row) => row.id} empty={<EmptyState title={t("wf.leave.title.noLeaveTypes")} description={t("wf.leave.d.createTheFirstLeaveEntitlementPolicyAbov")} />} /> : null}
        </Card>
      )}
    </div>
  );
}
