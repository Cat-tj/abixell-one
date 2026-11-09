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
  type LegalEntityRow,
  type MealType,
  type UpdateServingLogInput,
  type WorkOrderCostItem,
  type WorkOrderCostType,
  type WorkOrderCustomerInvoice,
  type WorkOrderDetail,
  type WorkOrderServingLog,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  Textarea,
} from "../../shell/components/ui";

const MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snack"];
const COST_TYPES: WorkOrderCostType[] = ["material", "labor", "overhead"];
import { formatDate, formatDateShort, formatMoney, statusTone } from "../../shared/format";

const COST_AMOUNT_RE = /^\d{1,14}(\.\d{1,4})?$/;
/** Accept "12,5" as "12.5" and drop stray spaces. */
const dec = (v: string) => v.replace(/\s/g, "").replace(",", ".");

/** Percentage typed by the user ("15", "11,5") -> API fraction string ("0.15").
 * Done on the digit string so no float rounding sneaks in. Returns null when
 * the input is not a valid 0-100 percentage with up to 4 decimals. */
function percentToFraction(input: string): string | null {
  const v = input.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(v)) return null;
  const [whole = "0", frac = ""] = v.split(".");
  const scaled = BigInt(whole + frac.padEnd(4, "0")); // percent x 10^4
  if (scaled > 1_000_000n) return null;
  const padded = scaled.toString().padStart(7, "0"); // fraction x 10^6
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`;
}

/** Fraction string ("0.150000") -> display percent ("15"), digit-string based. */
function fractionToPercent(fraction: string | null | undefined): string {
  const [w = "0", f = ""] = (fraction ?? "0").split(".");
  const scaled = BigInt(w + f.padEnd(6, "0").slice(0, 6)); // x 10^6
  const pct = scaled.toString().padStart(5, "0"); // percent x 10^4
  return `${pct.slice(0, -4)}.${pct.slice(-4)}`.replace(/\.?0+$/, "");
}

function scale4(v: string): bigint {
  const [w = "0", f = ""] = v.split(".");
  return BigInt(w + f.padEnd(4, "0").slice(0, 4));
}

function fromScale4(n: bigint): string {
  const str = n.toString().padStart(5, "0");
  return `${str.slice(0, -4)}.${str.slice(-4)}`;
}

function sumDecimals(values: string[]): string {
  return fromScale4(values.reduce((acc, v) => acc + scale4(v), 0n));
}

/** Decimal-string line total, 4dp, computed with BigInt (no float math). */
function lineTotal(qty: string, unit: string): string {
  return fromScale4((scale4(qty) * scale4(unit) + 5000n) / 10000n); // product has 8 decimals
}

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

  const [acceptDays, setAcceptDays] = useState("30");
  const [issuedLink, setIssuedLink] = useState<{ token: string; expiresAt: string } | null>(null);
  const [acceptComment, setAcceptComment] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const [legalEntities, setLegalEntities] = useState<LegalEntityRow[]>([]);
  const [legalEntityId, setLegalEntityId] = useState("");
  const [costItems, setCostItems] = useState<WorkOrderCostItem[]>([]);
  const [costForm, setCostForm] = useState<{ costType: WorkOrderCostType; description: string; quantity: string; unitCost: string }>({
    costType: "material",
    description: "",
    quantity: "1",
    unitCost: "",
  });
  const [invoice, setInvoice] = useState<WorkOrderCustomerInvoice | null>(null);
  const [markupPct, setMarkupPct] = useState("0");
  const [isTaxable, setIsTaxable] = useState(true);
  const [taxPct, setTaxPct] = useState("11");

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
      // Cost items exist only after acceptance; the invoice only after costs
      // are finalized. Invoice lookup answers 404 when none exists yet — the
      // client maps that to null, so it never surfaces as a page error.
      const accepted = Boolean(wo.workOrder.customerAcceptedAt);
      const [items, inv] = await Promise.all([
        accepted ? api.workOrderCostItems(token, workOrderId).catch(() => []) : Promise.resolve([]),
        wo.workOrder.costsFinalizedAt ? api.workOrderInvoice(token, workOrderId).catch(() => null) : Promise.resolve(null),
      ]);
      setCostItems(items);
      setInvoice(inv);
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

  useEffect(() => {
    let cancelled = false;
    api
      .legalEntities(token)
      .then((rows) => {
        if (cancelled) return;
        const active = rows.filter((r) => r.isActive);
        setLegalEntities(active);
        setLegalEntityId((cur) => cur || (active.length === 1 ? active[0]!.id : ""));
      })
      .catch(() => {
        /* picker stays empty; actions that need it remain disabled */
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

  /** Returns true when the form is complete; otherwise shows what is missing/invalid and returns false. */
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

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="error">{error ?? t("mo.wod.msg.notFound")}</Alert>;

  const { workOrder, serviceDefinition, checklist, status, availableActions } = detail;
  const costsGrandTotal = sumDecimals(costItems.map((i) => i.totalCost));
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
            <dd className="text-slate-900">{workOrder.priority
                ? ["low", "medium", "high", "critical"].includes(workOrder.priority)
                  ? t(`mo.woq.priority.${workOrder.priority as "low" | "medium" | "high" | "critical"}`)
                  : workOrder.priority
                : "—"}</dd>
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
          {t("mo.wod.t.checklist")}{" "}
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
                  {item.isCompleted ? t("mo.wod.s.done") : t("mo.wod.s.pending")}
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
              disabled={busy}
              onClick={() => {
                if (!formOk([assigneeUserId ? null : t("mo.wod.f.assignToUserId")])) return;
                void run(() => api.assignWorkOrder(token, workOrder.id, assigneeUserId), t("mo.wod.msg.assigned"));
              }}
            >
              {t("mo.wod.act.assign")}
            </Button>
          </div>
          <Field label={t("mo.wod.f.dueDate")}>
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (!formOk([dueAt ? null : t("mo.wod.f.dueDate")])) return;
                void run(
                  () => api.scheduleWorkOrder(token, workOrder.id, { dueAt: new Date(dueAt).toISOString() }),
                  t("mo.wod.msg.scheduleUpdated"),
                );
              }}
            >
              {t("mo.wod.act.setSchedule")}
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
        ) : !workOrder.customerAcceptedAt ? (
          <p className="text-sm text-ink-faint">{t("mo.wod.n.servingNeedsAcceptance")}</p>
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
                onChange={(e) => setServingForm((f) => ({ ...f, openingTime: e.target.value }))}
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
                disabled={busy}
                onClick={() => {
                  if (
                    !formOk([
                      servingForm.mealDate ? null : t("mo.wod.f.mealDate"),
                      servingForm.openingTime ? null : t("mo.wod.f.openingTime"),
                    ])
                  )
                    return;
                  void run(
                    () =>
                      api.recordServingLog(token, workOrder.id, {
                        ...servingForm,
                        // The input holds local "YYYY-MM-DDTHH:mm"; the API wants a full ISO instant.
                        openingTime: new Date(servingForm.openingTime).toISOString(),
                        servingSupervisorUserId: servingForm.servingSupervisorUserId || null,
                      }),
                    t("mo.wod.msg.servingRecorded"),
                  );
                }}
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
                  run(() => api.actOnWorkOrder(token, workOrder.id, action.actionCode), t("mo.wod.msg.actionRecorded", { name: action.name }))
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
                run(() => api.verifyWorkOrder(token, workOrder.id, verificationNotes || null), t("mo.wod.msg.verified"))
              }
            >
              {t("mo.wod.act.verify")}
            </Button>
          </div>
        </Card>
      ) : null}

      {workOrder.verifiedAt ? (
        <Alert tone="success">
          {t("mo.wod.msg.verifiedOn", { date: formatDate(workOrder.verifiedAt) })} {workOrder.verificationNotes ?? ""}
        </Alert>
      ) : null}

      {workOrder.verifiedAt ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-slate-800">{t("mo.wod.t.acceptance")}</h2>
          {workOrder.customerAcceptedAt ? (
            <div className="space-y-1 text-sm">
              <StatusPill tone="success">{t("mo.wod.s.accepted")}</StatusPill>
              <p className="text-slate-600">
                {formatDate(workOrder.customerAcceptedAt)}
                {workOrder.customerAcceptedVia
                  ? ` · ${workOrder.customerAcceptedVia === "token" ? t("mo.wod.s.viaLink") : t("mo.wod.s.viaInternal")}`
                  : ""}
              </p>
              {workOrder.customerAcceptanceComment ? (
                <p className="text-slate-600">{workOrder.customerAcceptanceComment}</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-ink-faint">{t("mo.wod.n.acceptanceHint")}</p>
              {workOrder.customerRejectedAt ? (
                <Alert tone="warning">
                  {t("mo.wod.msg.rejectedOn", { date: formatDate(workOrder.customerRejectedAt) })}
                </Alert>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label={t("mo.wod.f.linkValidDays")}>
                  <Input inputMode="numeric" value={acceptDays} onChange={(e) => setAcceptDays(e.target.value)} />
                </Field>
                <div className="flex items-end">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      const days = Number(acceptDays.replace(/\D/g, ""));
                      if (acceptDays.replace(/\D/g, "") === "") {
                        formOk([t("mo.wod.f.linkValidDays")]);
                        return;
                      }
                      if (!formOk([], [days >= 1 && days <= 365 ? null : t("mo.wod.f.linkValidDays")])) return;
                      void run(async () => {
                        setIssuedLink(await api.issueWorkOrderAcceptanceToken(token, workOrder.id, days));
                      }, t("mo.wod.msg.linkIssued"));
                    }}
                  >
                    {t("mo.wod.act.issueLink")}
                  </Button>
                </div>
              </div>
              {issuedLink ? (
                <div className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
                  <Field label={t("mo.wod.f.acceptanceLink")}>
                    <Input
                      readOnly
                      value={`${window.location.origin}/api/public/work-orders/acceptance/${issuedLink.token}`}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </Field>
                  <p className="text-slate-600">
                    {t("mo.wod.n.linkForCustomer", { date: formatDate(issuedLink.expiresAt) })}
                  </p>
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Field label={t("mo.wod.f.acceptComment")}>
                    <Textarea rows={2} value={acceptComment} onChange={(e) => setAcceptComment(e.target.value)} />
                  </Field>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => api.customerAcceptWorkOrder(token, workOrder.id, acceptComment.trim() || null),
                        t("mo.wod.msg.accepted"),
                      )
                    }
                  >
                    {t("mo.wod.act.recordAcceptance")}
                  </Button>
                </div>
                <div className="space-y-2">
                  <Field label={t("mo.wod.f.rejectReason")}>
                    <Textarea rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                  </Field>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (!formOk([rejectReason.trim() ? null : t("mo.wod.f.rejectReason")])) return;
                      void run(
                        () => api.customerRejectWorkOrder(token, workOrder.id, rejectReason.trim()),
                        t("mo.wod.msg.rejected"),
                      );
                    }}
                  >
                    {t("mo.wod.act.recordRejection")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {workOrder.verifiedAt ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-slate-800">{t("mo.wod.t.costs")}</h2>
          {!workOrder.customerAcceptedAt ? (
            <p className="text-sm text-ink-faint">{t("mo.wod.n.costsNeedAcceptance")}</p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-ink-faint">
                {workOrder.costsFinalizedAt ? t("mo.wod.n.costsFinalized") : t("mo.wod.n.costsHint")}
              </p>
              <DataTable
                columns={[
                  { header: t("mo.wod.f.costType"), cell: (i: WorkOrderCostItem) => t(`mo.wod.costType.${i.costType}`), mobileRole: "title" },
                  { header: t("mo.wod.f.description"), cell: (i) => i.description ?? "—" },
                  { header: t("mo.wod.f.quantity"), cell: (i) => i.quantity, className: "text-right" },
                  { header: t("mo.wod.f.unitCost"), cell: (i) => formatMoney(i.unitCost), className: "text-right" },
                  { header: t("mo.wod.f.lineTotal"), cell: (i) => formatMoney(i.totalCost), className: "text-right" },
                ]}
                rows={costItems}
                keyOf={(i) => i.id}
                empty={<p className="text-sm text-slate-500">{t("mo.wod.n.noCostItems")}</p>}
              />
              {costItems.length > 0 ? (
                <p className="text-right text-sm font-semibold text-slate-900">
                  {t("mo.wod.f.grandTotal")}: {formatMoney(workOrder.costsTotal ?? costsGrandTotal)}
                </p>
              ) : null}

              {!workOrder.costsFinalizedAt ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                    <Field label={t("mo.wod.f.costType")}>
                      <Select
                        value={costForm.costType}
                        onChange={(e) => setCostForm((f) => ({ ...f, costType: e.target.value as WorkOrderCostType }))}
                      >
                        {COST_TYPES.map((c) => (
                          <option key={c} value={c}>
                            {t(`mo.wod.costType.${c}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("mo.wod.f.description")}>
                      <Input
                        value={costForm.description}
                        onChange={(e) => setCostForm((f) => ({ ...f, description: e.target.value }))}
                      />
                    </Field>
                    <Field label={t("mo.wod.f.quantity")}>
                      <Input
                        inputMode="decimal"
                        value={costForm.quantity}
                        onChange={(e) => setCostForm((f) => ({ ...f, quantity: e.target.value }))}
                      />
                    </Field>
                    <Field label={t("mo.wod.f.unitCost")}>
                      <Input
                        inputMode="decimal"
                        value={costForm.unitCost}
                        onChange={(e) => setCostForm((f) => ({ ...f, unitCost: e.target.value }))}
                      />
                    </Field>
                  </div>
                  {costForm.unitCost !== "" &&
                  (!COST_AMOUNT_RE.test(dec(costForm.quantity)) || !COST_AMOUNT_RE.test(dec(costForm.unitCost))) ? (
                    <p className="text-sm text-rose-600">{t("mo.wod.n.amountFormat")}</p>
                  ) : null}
                  {COST_AMOUNT_RE.test(dec(costForm.quantity)) && COST_AMOUNT_RE.test(dec(costForm.unitCost)) ? (
                    <p className="text-sm text-slate-600">
                      {t("mo.wod.f.lineTotal")}: {formatMoney(lineTotal(dec(costForm.quantity), dec(costForm.unitCost)))}
                    </p>
                  ) : null}
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const qty = dec(costForm.quantity);
                      const unit = dec(costForm.unitCost);
                      const qtyOk = COST_AMOUNT_RE.test(qty) && Number(qty) > 0;
                      const unitOk = COST_AMOUNT_RE.test(unit) && Number(unit) > 0;
                      const missing = [
                        costForm.quantity.trim() === "" ? t("mo.wod.f.quantity") : null,
                        costForm.unitCost.trim() === "" ? t("mo.wod.f.unitCost") : null,
                      ];
                      const invalid = [
                        costForm.quantity.trim() !== "" && !qtyOk ? t("mo.wod.f.quantity") : null,
                        costForm.unitCost.trim() !== "" && !unitOk ? t("mo.wod.f.unitCost") : null,
                      ];
                      if (!formOk(missing, invalid)) return;
                      void run(async () => {
                        await api.addWorkOrderCostItem(token, workOrder.id, {
                          costType: costForm.costType,
                          description: costForm.description.trim() || null,
                          quantity: qty,
                          unitCost: unit,
                        });
                        setCostForm((f) => ({ ...f, description: "", quantity: "1", unitCost: "" }));
                      }, t("mo.wod.msg.costAdded"));
                    }}
                  >
                    {t("mo.wod.act.addCost")}
                  </Button>

                  <div className="grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 sm:grid-cols-3">
                    <Field label={t("mo.wod.f.legalEntity")}>
                      <Select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
                        <option value="">{t("mo.wod.p.selectLegalEntity")}</option>
                        {legalEntities.map((le) => (
                          <option key={le.id} value={le.id}>
                            {le.displayName ?? le.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <div className="flex items-end">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !formOk([
                              legalEntityId ? null : t("mo.wod.f.legalEntity"),
                              costItems.length > 0 ? null : t("mo.wod.t.costs"),
                            ])
                          )
                            return;
                          void run(() => api.finalizeWorkOrderCosts(token, workOrder.id, legalEntityId), t("mo.wod.msg.costsFinalized"));
                        }}
                      >
                        {t("mo.wod.act.finalizeCosts")}
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          )}
        </Card>
      ) : null}

      {workOrder.verifiedAt ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-slate-800">{t("mo.wod.t.invoice")}</h2>
          {invoice ? (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">{t("mo.wod.f.invoiceNumber")}</dt>
                <dd className="text-slate-900">
                  {invoice.invoiceNumber} <StatusPill tone="info">{invoice.arStatus}</StatusPill>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("mo.wod.f.costBasis")}</dt>
                <dd className="text-slate-900">{formatMoney(invoice.costBasis)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("mo.wod.f.markup")}</dt>
                <dd className="text-slate-900">
                  {formatMoney(invoice.baseAmount)} ({fractionToPercent(invoice.markupRate)}%)
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("mo.wod.f.tax")}</dt>
                <dd className="text-slate-900">
                  {invoice.isTaxable
                    ? `${formatMoney(invoice.taxAmount)} (${fractionToPercent(invoice.taxRate)}%)`
                    : t("mo.wod.s.notTaxable")}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("mo.wod.f.invoiceTotal")}</dt>
                <dd className="font-semibold text-slate-900">
                  {invoice.currency} {formatMoney(invoice.totalAmount)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("mo.wod.f.issuedAt")}</dt>
                <dd className="text-slate-900">{formatDate(invoice.issuedAt)}</dd>
              </div>
            </dl>
          ) : !workOrder.costsFinalizedAt ? (
            <p className="text-sm text-ink-faint">{t("mo.wod.n.invoiceNeedsFinalize")}</p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-ink-faint">{t("mo.wod.n.invoiceHint")}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <Field label={t("mo.wod.f.legalEntity")}>
                  <Select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
                    <option value="">{t("mo.wod.p.selectLegalEntity")}</option>
                    {legalEntities.map((le) => (
                      <option key={le.id} value={le.id}>
                        {le.displayName ?? le.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("mo.wod.f.markupPct")}>
                  <Input inputMode="decimal" value={markupPct} onChange={(e) => setMarkupPct(e.target.value)} />
                </Field>
                <Field label={t("mo.wod.f.taxable")}>
                  <Select value={isTaxable ? "yes" : "no"} onChange={(e) => setIsTaxable(e.target.value === "yes")}>
                    <option value="yes">{t("mo.wod.s.taxableYes")}</option>
                    <option value="no">{t("mo.wod.s.notTaxable")}</option>
                  </Select>
                </Field>
                {isTaxable ? (
                  <Field label={t("mo.wod.f.taxPct")}>
                    <Input inputMode="decimal" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
                  </Field>
                ) : null}
              </div>
              {(markupPct.trim() !== "" && percentToFraction(markupPct) === null) ||
              (isTaxable && percentToFraction(taxPct) === null) ? (
                <p className="text-sm text-rose-600">{t("mo.wod.n.percentFormat")}</p>
              ) : null}
              <Button
                disabled={busy}
                onClick={() => {
                  if (
                    !formOk(
                      [legalEntityId ? null : t("mo.wod.f.legalEntity")],
                      [
                        markupPct.trim() !== "" && percentToFraction(markupPct) === null ? t("mo.wod.f.markupPct") : null,
                        isTaxable && percentToFraction(taxPct) === null ? t("mo.wod.f.taxPct") : null,
                      ],
                    )
                  )
                    return;
                  void run(
                    () =>
                      api.createWorkOrderInvoice(token, workOrder.id, {
                        legalEntityId,
                        markupRate: markupPct.trim() === "" ? undefined : (percentToFraction(markupPct) ?? undefined),
                        isTaxable,
                        taxRate: isTaxable ? (percentToFraction(taxPct) ?? undefined) : undefined,
                      }),
                    t("mo.wod.msg.invoiceCreated"),
                  );
                }}
              >
                {t("mo.wod.act.createInvoice")}
              </Button>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
