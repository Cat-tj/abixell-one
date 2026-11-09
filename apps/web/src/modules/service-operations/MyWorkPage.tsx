/**
 * Phase 2 — Field executor work list (SO-CORE-014). Shows only the work
 * assigned to this user (backend-scoped). Mobile-first: the shared DataTable
 * renders stacked cards below the `sm` breakpoint.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type WorkOrderRow } from "../../lib/api";
import {
  Alert,
  DataTable,
  EmptyState,
  PageHeader,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { dueIndicator, formatDateShort, statusTone } from "../../shared/format";
import { isFinished, sortWorkOrders } from "./workOrderListing";

export function MyWorkPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [rows, setRows] = useState<WorkOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(sortWorkOrders(await api.myWorkOrders(token)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.mw.msg.couldNotLoadYourWork"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Column<WorkOrderRow>[] = [
    {
      header: t("mo.mw.h.work"),
      cell: (row) => (
        <span className="font-medium">
          {row.workOrder.workOrderNumber} — {row.workOrder.title}
        </span>
      ),
    },
    {
      header: t("mo.mw.h.status"),
      cell: (row) => (
        <StatusPill tone={statusTone(row.status?.instanceStatus)}>
          {row.status?.stepName ?? row.status?.stepCode ?? "—"}
        </StatusPill>
      ),
    },
    {
      header: t("mo.mw.h.due"),
      cell: (row) => {
        const indicator = isFinished(row) ? null : dueIndicator(row.workOrder.dueAt);
        return (
          <span className="flex flex-wrap items-center gap-2">
            {formatDateShort(row.workOrder.dueAt)}
            {indicator ? <StatusPill tone={indicator.tone}>{indicator.label}</StatusPill> : null}
          </span>
        );
      },
    },
    {
      header: t("mo.mw.h.progress"),
      cell: (row) =>
        row.workOrder.completedAt ? (
          <StatusPill tone="success">{t("mo.mw.t.completed")}</StatusPill>
        ) : row.workOrder.startedAt ? (
          <StatusPill tone="info">{t("mo.mw.t.inProgress")}</StatusPill>
        ) : (
          <StatusPill tone="neutral">{t("mo.mw.t.notStarted")}</StatusPill>
        ),
    },
  ];

  return (
    <div>
      <PageHeader title={t("mo.mw.title.myWork")} subtitle={t("mo.mw.sub.theJobsAssignedToYouOpenOneToRecordWhatY")} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(row) => row.workOrder.id}
          onRowClick={(row) => navigate(`/my-work/${row.workOrder.id}`)}
          empty={<EmptyState title={t("mo.mw.title.nothingAssigned")} description={t("mo.mw.d.workAssignedToYouWillAppearHere")} />}
        />
      )}
    </div>
  );
}
