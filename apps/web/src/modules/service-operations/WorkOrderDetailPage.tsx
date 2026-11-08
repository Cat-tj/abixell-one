/**
 * Phase 2 — Coordinator/supervisor work order detail (SO-CORE-013 /
 * SO-CORE-005 / SO-CORE-006 / SO-CORE-010).
 *
 * Assign, schedule, advance the lifecycle, and verify completed work.
 * Lifecycle buttons are rendered from the backend's `availableActions` —
 * never from a hardcoded `if status === X` rule.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type CreateServingLogInput,
  type MealType,
  type UpdateServingLogInput,
  type WorkOrderDetail,
  type WorkOrderServingLog,
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

const MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snack"];
import { formatDate, formatDateShort, statusTone } from "../../shared/format";

export function WorkOrderDetailPage() {
  const t = useT();
  const { workOrderId } = useParams<{ workOrderId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [detail, setDetail] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; email: string }>>([]);
  const [dueAt, setDueAt] = useState("");
  const [verificationNotes, setVerificationNotes] = useState("");

  const [servingLog, setServingLog] = useState<WorkOrderServingLog | null>(null);
  const [servingForm, setServingForm] = useState<CreateServingLogInput>({
    mealDate: "",
    mealType: "lunch",
    openingTime: "",
    receivedQty: "0",
    servedQty: "0",
    returnedQty: "0",
    wastedQty: "0",
  });
  const [servingUpdate, setServingUpdate] = useState<UpdateServingLogInput>({});

  const load = useCallback(async () => {
    if (!workOrderId) return;
    setLoading(true);
    setError(null);
    try {
      const [wo, serving] = await Promise.all([
        api.workOrder(token, workOrderId),
        api.getServingLog(token, workOrderId).catch(() => null),
      ]);
      setDetail(wo);
      const s = serving?.servingLog ?? null;
      setServingLog(s);
      if (s) {
        setServingUpdate({
          closingTime: s.closingTime ?? undefined,
          servedQty: s.servedQty,
          returnedQty: s.returnedQty,
          wastedQty: s.wastedQty,
          servingSupervisorUserId: s.servingSupervisorUserId ?? undefined,
          notes: s.notes ?? undefined,
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.wod.msg.couldNotLoadThisWorkOrder"));
    } finally {
      setLoading(false);
    }
  }, [token, workOrderId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    api
      .users(token)
      .then((rows) => {
        if (!cancelled) setUsers(rows);
      })
      .catch(() => {
        /* assign dropdown optional; leave empty */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.wod.msg.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="error">{error ?? "Work order not found."}</Alert>;

  const { workOrder, serviceDefinition, checklist, status, availableActions } = detail;
  const completedCount = checklist.filter((c) => c.isCompleted).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${workOrder.workOrderNumber} — ${workOrder.title}`}
        subtitle={serviceDefinition ? serviceDefinition.name : undefined}
        actions={
          <span className="flex items-center gap-2">
            {workOrder.woType === "back_charge" ? <Badge>{t("wo.type.backCharge")}</Badge> : null}
            {status ? (
              <StatusPill tone={statusTone(status.instanceStatus)}>
                {status.stepName ?? status.stepCode ?? status.instanceStatus}
              </StatusPill>
            ) : null}
          </span>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mo.wod.t.details")}</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">{t("mo.wod.f.description")}</dt>
            <dd className="text-slate-900">{workOrder.description ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("mo.wod.f.priority")}</dt>
            <dd className="text-slate-900">{workOrder.priority ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("mo.wod.f.plannedStart")}</dt>
            <dd className="text-slate-900">{formatDate(workOrder.plannedStartAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("mo.wod.f.due")}</dt>
            <dd className="text-slate-900">{formatDateShort(workOrder.dueAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("mo.wod.f.started")}</dt>
            <dd className="text-slate-900">{formatDate(workOrder.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("mo.wod.f.completed")}</dt>
            <dd className="text-slate-900">{formatDate(workOrder.completedAt)}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">
          Checklist{" "}
          <Badge>
            {completedCount}/{checklist.length}
          </Badge>
        </h2>
        {checklist.length === 0 ? (
          <p className="text-sm text-slate-500">{t("mo.wod.n.thisServiceTypeHasNoChecklist")}</p>
        ) : (
          <ul className="space-y-2">
            {checklist.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-slate-800">
                  {item.label}
                  {item.isRequired ? <span className="ml-1 text-rose-600">*</span> : null}
                </span>
                <StatusPill tone={item.isCompleted ? "success" : "neutral"}>
                  {item.isCompleted ? "Done" : "Pending"}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mo.wod.t.assignmentSchedule")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("mo.wod.f.assignToUserId")}>
            <Select value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)}>
              <option value="">{t("mo.wod.p.userId")}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              disabled={busy || !assigneeUserId}
              onClick={() => run(() => api.assignWorkOrder(token, workOrder.id, assigneeUserId), "Work assigned.")}
            >
              Assign
            </Button>
          </div>
          <Field label={t("mo.wod.f.dueDate")}>
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              variant="secondary"
              disabled={busy || !dueAt}
              onClick={() =>
                run(
                  () => api.scheduleWorkOrder(token, workOrder.id, { dueAt: new Date(dueAt).toISOString() }),
                  "Schedule updated.",
                )
              }
            >
              Set schedule
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mo.wod.t.servingLog")}</h2>
        {servingLog ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{servingLog.servingNumber}</Badge>
              <Badge>{servingLog.mealDate}</Badge>
              <Badge>{servingLog.mealType}</Badge>
              <span className="text-slate-600">
                {t("mo.wod.f.received")}: {servingLog.receivedQty} · {t("mo.wod.f.served")}: {servingLog.servedQty} ·{" "}
                {t("mo.wod.f.returned")}: {servingLog.returnedQty} · {t("mo.wod.f.wasted")}: {servingLog.wastedQty} ·{" "}
                {t("mo.wod.f.remaining")}: {servingLog.remainingQty}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("mo.wod.f.served")}>
                <Input
                  value={servingUpdate.servedQty ?? ""}
                  onChange={(e) => setServingUpdate((s) => ({ ...s, servedQty: e.target.value }))}
                />
              </Field>
              <Field label={t("mo.wod.f.returned")}>
                <Input
                  value={servingUpdate.returnedQty ?? ""}
                  onChange={(e) => setServingUpdate((s) => ({ ...s, returnedQty: e.target.value }))}
                />
              </Field>
              <Field label={t("mo.wod.f.wasted")}>
                <Input
                  value={servingUpdate.wastedQty ?? ""}
                  onChange={(e) => setServingUpdate((s) => ({ ...s, wastedQty: e.target.value }))}
                />
              </Field>
              <Field label={t("mo.wod.f.servingSupervisor")}>
                <Select
                  value={servingUpdate.servingSupervisorUserId ?? ""}
                  onChange={(e) => setServingUpdate((s) => ({ ...s, servingSupervisorUserId: e.target.value || null }))}
                >
                  <option value="">{t("mo.wod.p.selectUser")}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(() => api.updateServingLog(token, workOrder.id, servingUpdate), t("mo.wod.msg.servingUpdated"))
                  }
                >
                  {t("mo.wod.act.updateServing")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("mo.wod.f.mealDate")}>
              <Input
                type="date"
                value={servingForm.mealDate}
                onChange={(e) => setServingForm((f) => ({ ...f, mealDate: e.target.value }))}
              />
            </Field>
            <Field label={t("mo.wod.f.mealType")}>
              <Select value={servingForm.mealType} onChange={(e) => setServingForm((f) => ({ ...f, mealType: e.target.value as MealType }))}>
                {MEAL_TYPES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("mo.wod.f.openingTime")}>
              <Input
                type="datetime-local"
                value={servingForm.openingTime}
                onChange={(e) =>
                  setServingForm((f) => ({ ...f, openingTime: e.target.value ? new Date(e.target.value).toISOString() : "" }))
                }
              />
            </Field>
            <Field label={t("mo.wod.f.received")}>
              <Input value={servingForm.receivedQty} onChange={(e) => setServingForm((f) => ({ ...f, receivedQty: e.target.value }))} />
            </Field>
            <Field label={t("mo.wod.f.served")}>
              <Input value={servingForm.servedQty} onChange={(e) => setServingForm((f) => ({ ...f, servedQty: e.target.value }))} />
            </Field>
            <Field label={t("mo.wod.f.returned")}>
              <Input value={servingForm.returnedQty} onChange={(e) => setServingForm((f) => ({ ...f, returnedQty: e.target.value }))} />
            </Field>
            <Field label={t("mo.wod.f.wasted")}>
              <Input value={servingForm.wastedQty} onChange={(e) => setServingForm((f) => ({ ...f, wastedQty: e.target.value }))} />
            </Field>
            <Field label={t("mo.wod.f.servingSupervisor")}>
              <Select
                value={servingForm.servingSupervisorUserId ?? ""}
                onChange={(e) => setServingForm((f) => ({ ...f, servingSupervisorUserId: e.target.value || null }))}
              >
                <option value="">{t("mo.wod.p.selectUser")}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button
                disabled={busy || !servingForm.mealDate}
                onClick={() =>
                  run(
                    () =>
                      api.recordServingLog(token, workOrder.id, {
                        ...servingForm,
                        servingSupervisorUserId: servingForm.servingSupervisorUserId || null,
                      }),
                    t("mo.wod.msg.servingRecorded"),
                  )
                }
              >
                {t("mo.wod.act.recordServing")}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {availableActions.length > 0 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mo.wod.t.lifecycle")}</h2>
          <div className="flex flex-wrap gap-2">
            {availableActions.map((action) => (
              <Button
                key={action.actionCode}
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  run(() => api.actOnWorkOrder(token, workOrder.id, action.actionCode), `${action.name} recorded.`)
                }
              >
                {action.name}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      {workOrder.completedAt && !workOrder.verifiedAt ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mo.wod.t.verification")}</h2>
          <Field label={t("mo.wod.f.verificationNotes")}>
            <Textarea
              rows={3}
              value={verificationNotes}
              onChange={(e) => setVerificationNotes(e.target.value)}
              placeholder={t("mo.wod.p.whatDidYouCheck")}
            />
          </Field>
          <div className="mt-3">
            <Button
              disabled={busy}
              onClick={() =>
                run(() => api.verifyWorkOrder(token, workOrder.id, verificationNotes || null), "Work verified.")
              }
            >
              Verify work
            </Button>
          </div>
        </Card>
      ) : null}

      {workOrder.verifiedAt ? (
        <Alert tone="success">
          Verified on {formatDate(workOrder.verifiedAt)}. {workOrder.verificationNotes ?? ""}
        </Alert>
      ) : null}
    </div>
  );
}
