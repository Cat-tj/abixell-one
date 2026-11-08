/**
 * Phase 2 — Coordinator/supervisor work queue (SO-CORE-013).
 *
 * First frontend module under the frozen target architecture
 * (`modules/<module>/`). Presentation only: every status, SLA value, and
 * available action comes from the backend's authoritative Workflow state —
 * this page never recomputes lifecycle or SLA rules.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Customer,
  type ServiceDefinition,
  type WorkOrderType,
  type WorkOrderRow,
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
  type Column,
} from "../../shell/components/ui";
import { dueIndicator, formatDateShort, statusTone } from "../../shared/format";

export function WorkOrderQueuePage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [rows, setRows] = useState<WorkOrderRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [serviceTypes, setServiceTypes] = useState<ServiceDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [serviceCode, setServiceCode] = useState("");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [woType, setWoType] = useState<WorkOrderType>("regular");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orders, customerList, definitions] = await Promise.all([
        api.workOrders(token),
        api.customers(token).catch(() => [] as Customer[]),
        api.serviceDefinitions(token).catch(() => [] as ServiceDefinition[]),
      ]);
      setRows(orders);
      setCustomers(customerList);
      setServiceTypes(definitions.filter((d) => d.isActive));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.woq.msg.couldNotLoadWorkOrders"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  async function createWorkOrder() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createWorkOrder(token, {
        customerId,
        serviceDefinitionCode: serviceCode,
        title,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        // Back-charge WOs never carry a contractId; the form has no contract
        // field, so it is simply omitted from the payload.
        woType,
      });
      setNotice(t("mo.woq.msg.workOrderCreated"));
      setTitle("");
      setDueAt("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.woq.msg.couldNotCreateTheWorkOrder"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Column<WorkOrderRow>[] = [
    {
      header: t("mo.woq.h.number"),
      cell: (row) => <span className="font-medium">{row.workOrder.workOrderNumber}</span>,
    },
    {
      header: t("mo.woq.h.work"),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          {row.workOrder.title}
          {row.workOrder.woType === "back_charge" ? <Badge>{t("wo.type.backCharge")}</Badge> : null}
        </span>
      ),
    },
    {
      header: t("mo.woq.h.status"),
      cell: (row) => (
        <StatusPill tone={statusTone(row.status?.instanceStatus)}>
          {row.status?.stepName ?? row.status?.stepCode ?? "—"}
        </StatusPill>
      ),
    },
    {
      header: t("mo.woq.h.assignment"),
      cell: (row) => <Badge>{row.workOrder.assignedToUserId ? "Assigned" : "Unassigned"}</Badge>,
    },
    {
      header: t("mo.woq.h.due"),
      cell: (row) => {
        const indicator = dueIndicator(row.workOrder.dueAt);
        return (
          <span className="flex flex-wrap items-center gap-2">
            {formatDateShort(row.workOrder.dueAt)}
            {indicator ? <StatusPill tone={indicator.tone}>{indicator.label}</StatusPill> : null}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("mo.woq.title.workOrders")}
        subtitle={t("mo.woq.sub.planAssignAndFollowTheWorkYourTeamsAreDe")}
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="mb-4">
        <h2 className="mb-3 text-base font-extrabold text-ink">{t("mo.woq.t.createWorkOrder")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("mo.woq.f.customer")} required>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">{t("mo.woq.t.select")}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("mo.woq.f.serviceType")} required>
            <Select value={serviceCode} onChange={(e) => setServiceCode(e.target.value)}>
              <option value="">{t("mo.woq.t.select")}</option>
              {serviceTypes.map((d) => (
                <option key={d.id} value={d.code}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("wo.type.label")}>
            <Select value={woType} onChange={(e) => setWoType(e.target.value as WorkOrderType)}>
              <option value="regular">{t("wo.type.regular")}</option>
              <option value="back_charge">{t("wo.type.backCharge")}</option>
            </Select>
          </Field>
          <Field label={t("mo.woq.f.title")} required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("mo.woq.p.whatNeedsDoing")} />
          </Field>
          <div className="flex items-end gap-3">
            <Field label={t("mo.woq.f.due")}>
              <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </Field>
            <Button disabled={busy || !customerId || !serviceCode || !title} onClick={() => void createWorkOrder()}>
              {t("mo.woq.b.create")}
            </Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(row) => row.workOrder.id}
          onRowClick={(row) => navigate(`/work-orders/${row.workOrder.id}`)}
          empty={
            <EmptyState
              title={t("mo.woq.title.noWorkOrdersYet")}
              description={t("mo.woq.d.workOrdersAppearHereOnceARequestIsAccept")}
            />
          }
        />
      )}
    </div>
  );
}
