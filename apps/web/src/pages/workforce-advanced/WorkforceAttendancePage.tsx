/**
 * Wave A4 — Workforce Advanced Attendance & Rosters Page (HR-ADV-001, HR-ADV-002).
 *
 * Surfaces shift configuration, daily/weekly roster scheduling, and attendance recording.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Employee,
  type WorkforceAttendanceRecord,
  type WorkforceAttendanceSource,
  type WorkforceAttendanceStatus,
  type WorkforceRoster,
  type WorkforceShift,
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
import { formatDate, formatDateShort } from "../../shared/format";
import { localDateInputValue } from "../../shared/localDateTime";

const ATTENDANCE_STATUSES: WorkforceAttendanceStatus[] = [
  "present",
  "late",
  "absent",
  "leave",
  "holiday",
  "day_off",
];

const ATTENDANCE_SOURCES: WorkforceAttendanceSource[] = [
  "manual",
  "self_service",
  "import",
  "device",
];

function statusTone(status: WorkforceAttendanceStatus) {
  switch (status) {
    case "present":
      return "success";
    case "late":
      return "warning";
    case "absent":
      return "danger";
    case "leave":
    case "holiday":
    case "day_off":
      return "info";
    default:
      return "neutral";
  }
}

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function WorkforceAttendancePage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();

  const canManage = permissions.includes(PERMISSIONS.workforceAttendanceManage);

  const [activeTab, setActiveTab] = useState<"attendance" | "rosters" | "shifts">("attendance");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<WorkforceShift[]>([]);
  const [rosters, setRosters] = useState<WorkforceRoster[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<WorkforceAttendanceRecord[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters
  const [filterEmployeeId, setFilterEmployeeId] = useState("");
  const [filterStatus, setFilterStatus] = useState<WorkforceAttendanceStatus | "">("");
  const [filterFromDate, setFilterFromDate] = useState("");
  const [filterToDate, setFilterToDate] = useState("");

  // Shift Form
  const [shiftCode, setShiftCode] = useState("");
  const [shiftName, setShiftName] = useState("");
  const [shiftStartTime, setShiftStartTime] = useState("08:00:00");
  const [shiftEndTime, setShiftEndTime] = useState("17:00:00");
  const [shiftBreakMinutes, setShiftBreakMinutes] = useState("60");
  const [shiftIsOvernight, setShiftIsOvernight] = useState(false);

  // Roster Form
  const [rosterEmployeeId, setRosterEmployeeId] = useState("");
  const [rosterShiftId, setRosterShiftId] = useState("");
  const [rosterDate, setRosterDate] = useState(() => localDateInputValue());
  const [rosterNotes, setRosterNotes] = useState("");

  // Attendance Form
  const [attEmployeeId, setAttEmployeeId] = useState("");
  const [attDate, setAttDate] = useState(() => localDateInputValue());
  const [attShiftId, setAttShiftId] = useState("");
  const [attClockIn, setAttClockIn] = useState("");
  const [attClockOut, setAttClockOut] = useState("");
  const [attStatus, setAttStatus] = useState<WorkforceAttendanceStatus>("present");
  const [attSource, setAttSource] = useState<WorkforceAttendanceSource>("manual");
  const [attNotes, setAttNotes] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [empList, shiftList, rosterList, attendanceList] = await Promise.all([
        api.employees(token).catch(() => [] as Employee[]),
        api.workforceShifts(token, true),
        api.workforceRosters(token, {
          employeeId: filterEmployeeId || undefined,
          fromDate: filterFromDate || undefined,
          toDate: filterToDate || undefined,
        }),
        api.workforceAttendance(token, {
          employeeId: filterEmployeeId || undefined,
          status: (filterStatus as WorkforceAttendanceStatus) || undefined,
          fromDate: filterFromDate || undefined,
          toDate: filterToDate || undefined,
        }),
      ]);
      setEmployees(empList);
      setShifts(shiftList);
      setRosters(rosterList);
      setAttendanceRecords(attendanceList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.attend.msg.couldNotLoadAttendanceRosterData"));
    } finally {
      setLoading(false);
    }
  }, [token, filterEmployeeId, filterStatus, filterFromDate, filterToDate, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const employeeName = useMemo(
    () => (id: string | null) => {
      if (!id) return "—";
      const emp = employees.find((e) => e.id === id);
      return emp ? `${emp.fullName} (${emp.employeeNumber})` : id;
    },
    [employees],
  );

  const shiftLabel = useMemo(
    () => (id: string | null) => {
      if (!id) return "—";
      const s = shifts.find((x) => x.id === id);
      return s ? `${s.name} (${s.startTime}–${s.endTime})` : id;
    },
    [shifts],
  );

  async function handleCreateShift() {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.createWorkforceShift(token, {
        shiftCode,
        name: shiftName,
        startTime: shiftStartTime,
        endTime: shiftEndTime,
        breakMinutes: Number(shiftBreakMinutes) || 0,
        isOvernight: shiftIsOvernight,
      });
      setNotice(`Shift ${created.name} (${created.shiftCode}) created successfully.`);
      setShiftCode("");
      setShiftName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.attend.msg.failedToCreateShift"));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleShiftActive(shift: WorkforceShift) {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.setWorkforceShiftActive(token, shift.id, !shift.isActive);
      setNotice(`Shift ${updated.shiftCode} is now ${updated.isActive ? "active" : "inactive"}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.attend.msg.failedToUpdateShiftStatus"));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpsertRoster() {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.upsertWorkforceRoster(token, {
        employeeId: rosterEmployeeId,
        shiftId: rosterShiftId,
        rosterDate,
        notes: rosterNotes || null,
      });
      setNotice(`Roster updated for date ${rosterDate}.`);
      setRosterNotes("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.attend.msg.failedToAssignRoster"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordAttendance() {
    if (!canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.recordWorkforceAttendance(token, {
        employeeId: attEmployeeId,
        attendanceDate: attDate,
        shiftId: attShiftId || null,
        clockIn: attClockIn ? new Date(attClockIn).toISOString() : null,
        clockOut: attClockOut ? new Date(attClockOut).toISOString() : null,
        status: attStatus,
        source: attSource,
        notes: attNotes || null,
      });
      setNotice(`Attendance recorded for employee for date ${attDate}.`);
      setAttClockIn("");
      setAttClockOut("");
      setAttNotes("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("wf.attend.msg.failedToRecordAttendance"));
    } finally {
      setBusy(false);
    }
  }

  const attendanceColumns: Column<WorkforceAttendanceRecord>[] = [
    {
      header: t("wf.attend.h.date"),
      cell: (row) => (
        <div>
          <span className="font-semibold text-slate-900">{formatDateShort(row.attendanceDate)}</span>
          <div className="text-xs text-slate-500">{employeeName(row.employeeId)}</div>
        </div>
      ),
      mobileRole: "title",
    },
    {
      header: t("wf.attend.h.status"),
      cell: (row) => <StatusPill tone={statusTone(row.status)}>{label(row.status)}</StatusPill>,
      mobileRole: "status",
    },
    { header: t("wf.attend.h.shift"), cell: (row) => shiftLabel(row.shiftId) },
    {
      header: t("wf.attend.h.clockInOut"),
      cell: (row) => (
        <span className="font-mono text-xs">
          {row.clockIn ? formatDate(row.clockIn) : "—"} / {row.clockOut ? formatDate(row.clockOut) : "—"}
        </span>
      ),
    },
    {
      header: t("wf.attend.h.variances"),
      cell: (row) => (
        <div className="text-xs space-y-0.5">
          {row.lateMinutes > 0 && <Badge className="bg-amber-50 text-amber-700">{t("wf.attend.t.lateNM", { n: row.lateMinutes })}</Badge>}
          {row.earlyOutMinutes > 0 && <Badge className="bg-red-50 text-red-700">{t("wf.attend.t.earlyOutNM", { n: row.earlyOutMinutes })}</Badge>}
          {row.lateMinutes === 0 && row.earlyOutMinutes === 0 && <span className="text-slate-400">{t("wf.attend.t.onTime")}</span>}
        </div>
      ),
    },
    { header: t("wf.attend.h.source"), cell: (row) => <Badge>{label(row.source)}</Badge> },
  ];

  const rosterColumns: Column<WorkforceRoster>[] = [
    {
      header: t("wf.attend.h.employee"),
      cell: (row) => (
        <div>
          <span className="font-semibold text-slate-900">{employeeName(row.employeeId)}</span>
          <div className="text-xs text-slate-500">{row.notes || "No notes"}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("wf.attend.h.date"), cell: (row) => formatDateShort(row.rosterDate), mobileRole: "status" },
    { header: t("wf.attend.h.assignedShift"), cell: (row) => <Badge>{shiftLabel(row.shiftId)}</Badge> },
  ];

  const shiftColumns: Column<WorkforceShift>[] = [
    {
      header: t("wf.attend.h.shiftCode"),
      cell: (row) => (
        <div>
          <span className="font-semibold text-slate-900">{row.name}</span>
          <div className="font-mono text-xs text-slate-500">{row.shiftCode}</div>
        </div>
      ),
      mobileRole: "title",
    },
    {
      header: t("wf.attend.h.schedule"),
      cell: (row) => (
        <span className="font-mono text-xs">
          {row.startTime} – {row.endTime} {row.isOvernight ? "(Overnight)" : ""}
        </span>
      ),
    },
    { header: t("wf.attend.h.break"), cell: (row) => `${row.breakMinutes} mins` },
    {
      header: t("wf.attend.h.status"),
      cell: (row) => <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>,
      mobileRole: "status",
    },
    {
      header: t("wf.attend.h.actions"),
      cell: (row) =>
        canManage ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void handleToggleShiftActive(row)}
            className="text-xs"
          >
            {row.isActive ? "Deactivate" : "Activate"}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("wf.attend.title.attendanceRosters")}
        subtitle={t("wf.attend.sub.configureWorkShiftsPublishDailyEmployeeR")}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? (
        <Alert tone="info">{t("wf.attend.msg.youAreViewingInReadOnlyModeCreatingShift", { perm: <code className="font-mono text-xs">workforce.attendance.manage</code> })}</Alert>
      ) : null}

      <div className="flex border-b border-slate-200 text-sm font-medium">
        <button
          type="button"
          onClick={() => setActiveTab("attendance")}
          className={`px-4 py-2 border-b-2 transition-colors ${
            activeTab === "attendance"
              ? "border-slate-900 text-slate-900 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          Attendance Logs ({attendanceRecords.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("rosters")}
          className={`px-4 py-2 border-b-2 transition-colors ${
            activeTab === "rosters"
              ? "border-slate-900 text-slate-900 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          Rosters ({rosters.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("shifts")}
          className={`px-4 py-2 border-b-2 transition-colors ${
            activeTab === "shifts"
              ? "border-slate-900 text-slate-900 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          Work Shifts ({shifts.length})
        </button>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.attend.t.filterCriteria")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("wf.attend.f.employee")}>
            <Select value={filterEmployeeId} onChange={(e) => setFilterEmployeeId(e.target.value)}>
              <option value="">{t("wf.attend.t.allEmployees")}</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.fullName} ({emp.employeeNumber})
                </option>
              ))}
            </Select>
          </Field>
          {activeTab === "attendance" && (
            <Field label={t("wf.attend.f.status")}>
              <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as WorkforceAttendanceStatus)}>
                <option value="">{t("wf.attend.t.allStatuses")}</option>
                {ATTENDANCE_STATUSES.map((st) => (
                  <option key={st} value={st}>{label(st)}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("wf.attend.f.fromDate")}>
            <Input type="date" value={filterFromDate} onChange={(e) => setFilterFromDate(e.target.value)} />
          </Field>
          <Field label={t("wf.attend.f.toDate")}>
            <Input type="date" value={filterToDate} onChange={(e) => setFilterToDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      {canManage && (
        <>
          {activeTab === "attendance" && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.attend.t.recordDailyAttendance")}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t("wf.attend.f.employee")} required>
                  <Select value={attEmployeeId} onChange={(e) => setAttEmployeeId(e.target.value)}>
                    <option value="">{t("wf.attend.t.selectEmployee")}</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.fullName} ({emp.employeeNumber})</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("wf.attend.f.attendanceDate")} required>
                  <Input type="date" value={attDate} onChange={(e) => setAttDate(e.target.value)} />
                </Field>
                <Field label={t("wf.attend.f.shift")}>
                  <Select value={attShiftId} onChange={(e) => setAttShiftId(e.target.value)}>
                    <option value="">{t("wf.attend.t.noShiftDefault")}</option>
                    {shifts.filter((s) => s.isActive).map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.shiftCode})</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("wf.attend.f.status")}>
                  <Select value={attStatus} onChange={(e) => setAttStatus(e.target.value as WorkforceAttendanceStatus)}>
                    {ATTENDANCE_STATUSES.map((st) => (
                      <option key={st} value={st}>{label(st)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("wf.attend.f.clockInIsoTime")}>
                  <Input type="datetime-local" value={attClockIn} onChange={(e) => setAttClockIn(e.target.value)} />
                </Field>
                <Field label={t("wf.attend.f.clockOutIsoTime")}>
                  <Input type="datetime-local" value={attClockOut} onChange={(e) => setAttClockOut(e.target.value)} />
                </Field>
                <Field label={t("wf.attend.f.source")}>
                  <Select value={attSource} onChange={(e) => setAttSource(e.target.value as WorkforceAttendanceSource)}>
                    {ATTENDANCE_SOURCES.map((src) => (
                      <option key={src} value={src}>{label(src)}</option>
                    ))}
                  </Select>
                </Field>
                <div className="sm:col-span-2 lg:col-span-4">
                  <Field label={t("wf.attend.f.notes")}>
                    <Input value={attNotes} onChange={(e) => setAttNotes(e.target.value)} placeholder={t("wf.attend.p.optionalAttendanceNotes")} />
                  </Field>
                </div>
              </div>
              <div className="mt-3">
                <Button disabled={busy || !attEmployeeId || !attDate} onClick={() => void handleRecordAttendance()}>
                  Save Attendance Record
                </Button>
              </div>
            </Card>
          )}

          {activeTab === "rosters" && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.attend.t.assignEmployeeRoster")}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label={t("wf.attend.f.employee")} required>
                  <Select value={rosterEmployeeId} onChange={(e) => setRosterEmployeeId(e.target.value)}>
                    <option value="">{t("wf.attend.t.selectEmployee")}</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.fullName} ({emp.employeeNumber})</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("wf.attend.f.shift")} required>
                  <Select value={rosterShiftId} onChange={(e) => setRosterShiftId(e.target.value)}>
                    <option value="">{t("wf.attend.t.selectShift")}</option>
                    {shifts.filter((s) => s.isActive).map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.shiftCode})</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("wf.attend.f.rosterDate")} required>
                  <Input type="date" value={rosterDate} onChange={(e) => setRosterDate(e.target.value)} />
                </Field>
                <div className="sm:col-span-3">
                  <Field label={t("wf.attend.f.notes")}>
                    <Input value={rosterNotes} onChange={(e) => setRosterNotes(e.target.value)} placeholder={t("wf.attend.p.rosterAllocationNotes")} />
                  </Field>
                </div>
              </div>
              <div className="mt-3">
                <Button disabled={busy || !rosterEmployeeId || !rosterShiftId || !rosterDate} onClick={() => void handleUpsertRoster()}>
                  Save Roster Assignment
                </Button>
              </div>
            </Card>
          )}

          {activeTab === "shifts" && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.attend.t.createWorkShift")}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t("wf.attend.f.shiftCode")} required>
                  <Input value={shiftCode} onChange={(e) => setShiftCode(e.target.value)} placeholder="SHIFT_MORNING" />
                </Field>
                <Field label={t("wf.attend.f.shiftName")} required>
                  <Input value={shiftName} onChange={(e) => setShiftName(e.target.value)} placeholder={t("wf.attend.p.morningStandard")} />
                </Field>
                <Field label={t("wf.attend.f.startTimeHhMmSs")} required>
                  <Input value={shiftStartTime} onChange={(e) => setShiftStartTime(e.target.value)} placeholder="08:00:00" />
                </Field>
                <Field label={t("wf.attend.f.endTimeHhMmSs")} required>
                  <Input value={shiftEndTime} onChange={(e) => setShiftEndTime(e.target.value)} placeholder="17:00:00" />
                </Field>
                <Field label={t("wf.attend.f.breakMinutes")}>
                  <Input type="number" min="0" value={shiftBreakMinutes} onChange={(e) => setShiftBreakMinutes(e.target.value)} />
                </Field>
                <div className="flex items-center pt-6">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={shiftIsOvernight}
                      onChange={(e) => setShiftIsOvernight(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    <span>{t("wf.attend.t.isOvernightShift")}</span>
                  </label>
                </div>
              </div>
              <div className="mt-3">
                <Button disabled={busy || !shiftCode || !shiftName || !shiftStartTime || !shiftEndTime} onClick={() => void handleCreateShift()}>
                  Create Shift
                </Button>
              </div>
            </Card>
          )}
        </>
      )}

      {loading ? (
        <Spinner label={t("wf.attend.f.loadingRecords")} />
      ) : (
        <>
          {activeTab === "attendance" && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.attend.t.attendanceRecords")}</h2>
              <DataTable
                columns={attendanceColumns}
                rows={attendanceRecords}
                keyOf={(row) => row.id}
                empty={<EmptyState title={t("wf.attend.title.noAttendanceRecordsFound")} description={t("wf.attend.d.adjustYourFiltersOrRecordAttendanceAbove")} />}
              />
            </Card>
          )}

          {activeTab === "rosters" && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.attend.t.assignedRosters")}</h2>
              <DataTable
                columns={rosterColumns}
                rows={rosters}
                keyOf={(row) => row.id}
                empty={<EmptyState title={t("wf.attend.title.noRosterAssignmentsFound")} description={t("wf.attend.d.assignEmployeesToShiftsAbove")} />}
              />
            </Card>
          )}

          {activeTab === "shifts" && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("wf.attend.t.configuredWorkShifts")}</h2>
              <DataTable
                columns={shiftColumns}
                rows={shifts}
                keyOf={(row) => row.id}
                empty={<EmptyState title={t("wf.attend.title.noShiftsDefined")} description={t("wf.attend.d.createStandardOrOvernightShiftsAbove")} />}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
