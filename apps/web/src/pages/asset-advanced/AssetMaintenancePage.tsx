/**
 * Wave A3 — Asset Advanced maintenance center (AST-ADV-001…002).
 *
 * Surfaces preventive schedules and maintenance work orders while keeping
 * lifecycle state delegated to the backend Workflow Engine.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AssetMaintenanceSchedule,
  type AssetMaintenanceWorkOrderRow,
  type AssetRecord,
  type MaintenanceFrequencyType,
  type MaintenancePriority,
  type MaintenanceType,
  type MeterReadingType,
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

const MAINTENANCE_TYPES: MaintenanceType[] = ["preventive", "corrective", "emergency"];
const PRIORITIES: MaintenancePriority[] = ["low", "medium", "high", "critical"];
const METER_TYPES: MeterReadingType[] = ["hours", "km", "cycles"];

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function workOrderDisplayState(row: AssetMaintenanceWorkOrderRow): string {
  if (row.status) return row.status.stepName ?? row.status.stepCode ?? row.status.instanceStatus;
  if (row.workOrder.verifiedAt) return "Verified";
  if (row.workOrder.completedAt) return "Completed";
  if (row.workOrder.startedAt) return "In progress";
  if (row.workOrder.assignedAt) return "Assigned";
  return "Created";
}

export function AssetMaintenancePage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const navigate = useNavigate();
  const { permissions } = useShell();

  const canManage = permissions.includes(PERMISSIONS.assetMaintenanceManage);

  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [schedules, setSchedules] = useState<AssetMaintenanceSchedule[]>([]);
  const [dueSchedules, setDueSchedules] = useState<AssetMaintenanceSchedule[]>([]);
  const [workOrders, setWorkOrders] = useState<AssetMaintenanceWorkOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [assetFilter, setAssetFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [asOfDate, setAsOfDate] = useState(() => localDateInputValue());

  const [scheduleAssetId, setScheduleAssetId] = useState("");
  const [scheduleCode, setScheduleCode] = useState("");
  const [scheduleTitle, setScheduleTitle] = useState("");
  const [scheduleDescription, setScheduleDescription] = useState("");
  const [frequencyType, setFrequencyType] = useState<MaintenanceFrequencyType>("calendar");
  const [intervalDays, setIntervalDays] = useState("30");
  const [meterInterval, setMeterInterval] = useState("");
  const [meterType, setMeterType] = useState<MeterReadingType>("hours");
  const [nextDueDate, setNextDueDate] = useState("");
  const [nextDueMeter, setNextDueMeter] = useState("");

  const [woAssetId, setWoAssetId] = useState("");
  const [woScheduleId, setWoScheduleId] = useState("");
  const [woType, setWoType] = useState<MaintenanceType>("preventive");
  const [woPriority, setWoPriority] = useState<MaintenancePriority>("medium");
  const [woTitle, setWoTitle] = useState("");
  const [woDescription, setWoDescription] = useState("");
  const [costEstimate, setCostEstimate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [assetResult, scheduleList, dueList, orderList] = await Promise.all([
        api.assets(token, { includeTerminal: false }).catch(() => ({ assets: [] as AssetRecord[], custodians: [] })),
        api.assetMaintenanceSchedules(token, assetFilter || undefined),
        api.dueAssetMaintenanceSchedules(token, asOfDate || undefined),
        api.assetMaintenanceWorkOrders(token, {
          assetId: assetFilter || undefined,
          maintenanceType: typeFilter ? (typeFilter as MaintenanceType) : undefined,
        }),
      ]);
      setAssets(assetResult.assets);
      setSchedules(scheduleList);
      setDueSchedules(dueList);
      setWorkOrders(orderList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.maint.msg.couldNotLoadAssetMaintenanceData"));
    } finally {
      setLoading(false);
    }
  }, [token, assetFilter, typeFilter, asOfDate, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const assetName = useMemo(
    () => (id: string | null) => {
      if (!id) return "—";
      const asset = assets.find((a) => a.id === id);
      return asset ? `${asset.assetNumber} — ${asset.name}` : id;
    },
    [assets],
  );

  const availableSchedulesForWorkOrder = schedules.filter(
    (schedule) => !woAssetId || schedule.assetId === woAssetId,
  );

  /** Shows what is missing/invalid and returns false when the form cannot be sent. */
  function formOk(missing: Array<string | null>, invalid: Array<string | null> = []): boolean {
    const m = missing.filter((x): x is string => x !== null);
    const i = invalid.filter((x): x is string => x !== null);
    if (m.length === 0 && i.length === 0) return true;
    setNotice(null);
    setError(
      m.length > 0
        ? t("common.form.missing", { fields: m.join(", ") })
        : t("common.form.invalid", { fields: i.join(", ") }),
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
    return false;
  }

  const num = (v: string) => Number(v.replace(/\s/g, "").replace(",", "."));
  const badNum = (v: string) => v.trim() !== "" && Number.isNaN(num(v));

  async function createSchedule() {
    if (!canManage) return;
    const days = Number(intervalDays.replace(/\D/g, ""));
    if (
      !formOk(
        [
          scheduleAssetId ? null : t("sca.maint.f.asset"),
          scheduleCode.trim() ? null : t("sca.maint.f.scheduleCode"),
          scheduleTitle.trim() ? null : t("sca.maint.f.title"),
          frequencyType === "calendar" && intervalDays.trim() === "" ? t("sca.maint.f.intervalDays") : null,
          frequencyType === "meter" && meterInterval.trim() === "" ? t("sca.maint.f.meterInterval") : null,
        ],
        [
          frequencyType === "calendar" && intervalDays.trim() !== "" && !(days >= 1) ? t("sca.maint.f.intervalDays") : null,
          frequencyType === "meter" && meterInterval.trim() !== "" && !(num(meterInterval) > 0) ? t("sca.maint.f.meterInterval") : null,
          badNum(nextDueMeter) ? t("sca.maint.f.nextDueMeter") : null,
        ],
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.createAssetMaintenanceSchedule(token, {
        assetId: scheduleAssetId,
        scheduleCode,
        title: scheduleTitle,
        description: scheduleDescription || null,
        frequencyType,
        intervalDays: frequencyType === "calendar" ? days : null,
        meterInterval: frequencyType === "meter" ? num(meterInterval) : null,
        meterType: frequencyType === "meter" ? meterType : null,
        nextDueDate: nextDueDate || null,
        nextDueMeter: nextDueMeter.trim() ? num(nextDueMeter) : null,
      });
      setNotice(`Maintenance schedule ${created.scheduleCode} created.`);
      setScheduleCode("");
      setScheduleTitle("");
      setScheduleDescription("");
      setNextDueDate("");
      setNextDueMeter("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.maint.msg.couldNotCreateMaintenanceSchedule"));
    } finally {
      setBusy(false);
    }
  }

  async function createWorkOrder() {
    if (!canManage) return;
    if (
      !formOk(
        [woAssetId ? null : t("sca.maint.f.asset"), woTitle.trim() ? null : t("sca.maint.f.title")],
        [badNum(costEstimate) ? t("sca.maint.f.costEstimate") : null],
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.createAssetMaintenanceWorkOrder(token, {
        assetId: woAssetId,
        scheduleId: woScheduleId || null,
        maintenanceType: woType,
        priority: woPriority,
        title: woTitle,
        description: woDescription || null,
        costEstimate: costEstimate.trim() ? num(costEstimate) : null,
      });
      setNotice(`Maintenance work order ${created.orderNumber} created.`);
      setWoTitle("");
      setWoDescription("");
      setCostEstimate("");
      await load();
      navigate(`/asset-maintenance/work-orders/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("sca.maint.msg.couldNotCreateMaintenanceWorkOrder"));
    } finally {
      setBusy(false);
    }
  }

  const scheduleColumns: Column<AssetMaintenanceSchedule>[] = [
    {
      header: t("sca.maint.h.schedule"),
      cell: (row) => (
        <div>
          <span className="font-semibold text-slate-900">{row.title}</span>
          <div className="font-mono text-[11px] text-slate-400">{row.scheduleCode}</div>
        </div>
      ),
      mobileRole: "title",
    },
    { header: t("sca.maint.h.asset"), cell: (row) => assetName(row.assetId) },
    { header: t("sca.maint.h.frequency"), cell: (row) => label(row.frequencyType) },
    {
      header: t("sca.maint.h.nextDue"),
      cell: (row) =>
        row.frequencyType === "calendar"
          ? formatDateShort(row.nextDueDate)
          : row.nextDueMeter
            ? `${row.nextDueMeter} ${row.meterType ?? ""}`
            : "—",
      mobileRole: "status",
    },
    {
      header: t("sca.maint.h.state"),
      cell: (row) => <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>,
    },
  ];

  const dueScheduleColumns: Column<AssetMaintenanceSchedule>[] = [
    { header: t("sca.maint.h.dueSchedule"), cell: (row) => <span className="font-semibold">{row.title}</span>, mobileRole: "title" },
    { header: t("sca.maint.h.asset"), cell: (row) => assetName(row.assetId) },
    { header: t("sca.maint.h.due"), cell: (row) => row.nextDueDate ? formatDateShort(row.nextDueDate) : `${row.nextDueMeter ?? "—"} ${row.meterType ?? ""}` },
    { header: t("sca.maint.h.type"), cell: (row) => <Badge>{label(row.frequencyType)}</Badge>, mobileRole: "status" },
  ];

  const workOrderColumns: Column<AssetMaintenanceWorkOrderRow>[] = [
    {
      header: t("sca.maint.h.workOrder"),
      cell: (row) => (
        <Link
          to={`/asset-maintenance/work-orders/${row.workOrder.id}`}
          className="font-semibold text-slate-900 underline hover:text-slate-700"
        >
          {row.workOrder.orderNumber}
        </Link>
      ),
      mobileRole: "title",
    },
    { header: t("sca.maint.h.title"), cell: (row) => row.workOrder.title },
    { header: t("sca.maint.h.asset"), cell: (row) => assetName(row.workOrder.assetId) },
    { header: t("sca.maint.h.type"), cell: (row) => <Badge>{label(row.workOrder.maintenanceType)}</Badge> },
    { header: t("sca.maint.h.priority"), cell: (row) => <Badge>{label(row.workOrder.priority)}</Badge> },
    {
      header: t("sca.maint.h.lifecycle"),
      cell: (row) => (
        <StatusPill tone={statusTone(row.status?.instanceStatus)}>{workOrderDisplayState(row)}</StatusPill>
      ),
      mobileRole: "status",
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("sca.maint.title.assetMaintenance")}
        subtitle={t("sca.maint.sub.preventiveSchedulesMaintenanceWorkOrders")}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {!canManage ? (
        <Alert tone="info">{t("sca.maint.msg.youCanViewMaintenanceRecordsCreatingSche", { perm: <code className="font-mono text-xs">asset.maintenance.manage</code> })}</Alert>
      ) : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("sca.maint.t.filters")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("sca.maint.f.asset")}>
            <Select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
              <option value="">{t("sca.maint.t.allAssets")}</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.assetNumber} — {asset.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("sca.maint.f.maintenanceType")}>
            <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">{t("sca.maint.t.allTypes")}</option>
              {MAINTENANCE_TYPES.map((type) => (
                <option key={type} value={type}>{label(type)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("sca.maint.f.dueAsOf")}>
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </Field>
        </div>
      </Card>

      {canManage ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("sca.maint.t.createMaintenanceSchedule")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("sca.maint.f.asset")} required>
                <Select value={scheduleAssetId} onChange={(e) => setScheduleAssetId(e.target.value)}>
                  <option value="">{t("sca.maint.t.selectAsset")}</option>
                  {assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.assetNumber} — {asset.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("sca.maint.f.scheduleCode")} required>
                <Input value={scheduleCode} onChange={(e) => setScheduleCode(e.target.value)} placeholder={t("sca.maint.p.pmGenerator30d")} />
              </Field>
              <Field label={t("sca.maint.f.title")} required>
                <Input value={scheduleTitle} onChange={(e) => setScheduleTitle(e.target.value)} placeholder={t("sca.maint.p.30DayPreventiveInspection")} />
              </Field>
              <Field label={t("sca.maint.f.frequencyType")}>
                <Select value={frequencyType} onChange={(e) => setFrequencyType(e.target.value as MaintenanceFrequencyType)}>
                  <option value="calendar">{t("sca.maint.t.calendar")}</option>
                  <option value="meter">{t("sca.maint.t.meter")}</option>
                </Select>
              </Field>
              {frequencyType === "calendar" ? (
                <>
                  <Field label={t("sca.maint.f.intervalDays")} required>
                    <Input type="number" min="1" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} />
                  </Field>
                  <Field label={t("sca.maint.f.nextDueDate")}>
                    <Input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label={t("sca.maint.f.meterInterval")} required>
                    <Input type="number" min="0" step="0.01" value={meterInterval} onChange={(e) => setMeterInterval(e.target.value)} />
                  </Field>
                  <Field label={t("sca.maint.f.meterType")}>
                    <Select value={meterType} onChange={(e) => setMeterType(e.target.value as MeterReadingType)}>
                      {METER_TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}
                    </Select>
                  </Field>
                  <Field label={t("sca.maint.f.nextDueMeter")}>
                    <Input type="number" min="0" step="0.01" value={nextDueMeter} onChange={(e) => setNextDueMeter(e.target.value)} />
                  </Field>
                </>
              )}
              <div className="sm:col-span-2">
                <Field label={t("sca.maint.f.description")}>
                  <Textarea rows={2} value={scheduleDescription} onChange={(e) => setScheduleDescription(e.target.value)} />
                </Field>
              </div>
            </div>
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={() => void createSchedule()}
              >
                Create Schedule
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("sca.maint.t.createMaintenanceWorkOrder")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("sca.maint.f.asset")} required>
                <Select value={woAssetId} onChange={(e) => { setWoAssetId(e.target.value); setWoScheduleId(""); }}>
                  <option value="">{t("sca.maint.t.selectAsset")}</option>
                  {assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.assetNumber} — {asset.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("sca.maint.f.schedule")}>
                <Select value={woScheduleId} onChange={(e) => setWoScheduleId(e.target.value)}>
                  <option value="">{t("sca.maint.t.noLinkedSchedule")}</option>
                  {availableSchedulesForWorkOrder.map((schedule) => (
                    <option key={schedule.id} value={schedule.id}>{schedule.scheduleCode} — {schedule.title}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("sca.maint.f.maintenanceType2")}>
                <Select value={woType} onChange={(e) => setWoType(e.target.value as MaintenanceType)}>
                  {MAINTENANCE_TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}
                </Select>
              </Field>
              <Field label={t("sca.maint.f.priority")}>
                <Select value={woPriority} onChange={(e) => setWoPriority(e.target.value as MaintenancePriority)}>
                  {PRIORITIES.map((priority) => <option key={priority} value={priority}>{label(priority)}</option>)}
                </Select>
              </Field>
              <Field label={t("sca.maint.f.title")} required>
                <Input value={woTitle} onChange={(e) => setWoTitle(e.target.value)} placeholder={t("sca.maint.p.inspectPumpSeal")} />
              </Field>
              <Field label={t("sca.maint.f.costEstimate")}>
                <Input type="number" min="0" step="0.01" value={costEstimate} onChange={(e) => setCostEstimate(e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <Field label={t("sca.maint.f.description")}>
                  <Textarea rows={2} value={woDescription} onChange={(e) => setWoDescription(e.target.value)} />
                </Field>
              </div>
            </div>
            <div className="mt-3">
              <Button disabled={busy} onClick={() => void createWorkOrder()}>
                Create Work Order
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {loading ? (
        <Spinner label={t("sca.maint.f.loadingMaintenanceRecords")} />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("sca.maint.t.dueMaintenanceSchedules")}</h2>
            <DataTable
              columns={dueScheduleColumns}
              rows={dueSchedules}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("sca.maint.title.noSchedulesCurrentlyDue")} description={t("sca.maint.d.dueSchedulesAppearHereWhenTheirDateOrMet")} />}
            />
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("sca.maint.t.maintenanceSchedules")}</h2>
            <DataTable
              columns={scheduleColumns}
              rows={schedules}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("sca.maint.title.noMaintenanceSchedules")} description={t("sca.maint.d.createCalendarOrMeterBasedPreventiveSche")} />}
            />
          </Card>
          <Card className="xl:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("sca.maint.t.maintenanceWorkOrders")}</h2>
            <DataTable
              columns={workOrderColumns}
              rows={workOrders}
              keyOf={(row) => row.workOrder.id}
              onRowClick={(row) => navigate(`/asset-maintenance/work-orders/${row.workOrder.id}`)}
              mobileBreakpoint="md"
              empty={<EmptyState title={t("sca.maint.title.noMaintenanceWorkOrders")} description={t("sca.maint.d.createPreventiveCorrectiveOrEmergencyMai")} />}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
