/**
 * Checkpoint 1C.3 — Operational complaint queue (internal handlers /
 * supervisors). Complaint-centric, scope-filtered by the backend. Real data;
 * the backend decides visibility, this only renders it.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type OperationalQueueItem, type OperationalQueueFilters } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, severityTone, slaIndicator, statusTone } from "../complaints/format";

const QUEUE_LIMIT = 200;

export function OperationalQueuePage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [filters, setFilters] = useState<OperationalQueueFilters>({});
  const [snapshot, setSnapshot] = useState<OperationalQueueItem[]>([]);
  const [items, setItems] = useState<OperationalQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Unfiltered snapshot for the summary counters (bounded by the actor's scope).
  const loadSnapshot = useCallback(async () => {
    try {
      const res = await api.operationalQueue(token, { limit: QUEUE_LIMIT });
      setSnapshot(res.items);
    } catch {
      /* counters are best-effort; the table below surfaces real errors */
    }
  }, [token]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.operationalQueue(token, { ...filters, limit: QUEUE_LIMIT });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ops.queue.msg.failedToLoadTheQueue"));
    } finally {
      setLoading(false);
    }
  }, [token, filters, t]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const mineCount = snapshot.filter((i) => i.assignment?.isMine).length;
  const overdueCount = snapshot.filter((i) => i.overdue).length;
  const openCount = snapshot.filter((i) => i.status?.instanceStatus === "in_progress").length;

  const columns: Column<OperationalQueueItem>[] = [
    {
      header: t("ops.queue.h.number"),
      cell: (i) => <span className="font-mono font-medium text-slate-800">{i.complaint.complaintNumber}</span>,
    },
    { header: t("ops.queue.h.customer"), cell: (i) => i.customerName ?? "—" },
    { header: t("ops.queue.h.site"), cell: (i) => i.siteName ?? "—" },
    { header: t("ops.queue.h.category"), cell: (i) => <Badge>{i.complaint.category}</Badge> },
    {
      header: t("ops.queue.h.severity"),
      cell: (i) => <StatusPill tone={severityTone(i.complaint.severity)}>{i.complaint.severity}</StatusPill>,
    },
    {
      header: t("ops.queue.h.status"),
      cell: (i) => (
        <StatusPill tone={statusTone(i.status?.instanceStatus)}>
          {i.status?.stepName ?? i.status?.instanceStatus ?? "—"}
        </StatusPill>
      ),
    },
    {
      header: "SLA",
      cell: (i) => {
        const s = slaIndicator(i.sla);
        return s ? <StatusPill tone={s.tone}>{s.label}</StatusPill> : <span className="text-slate-400">—</span>;
      },
    },
    {
      header: t("ops.queue.h.assigned"),
      cell: (i) =>
        i.assignment?.isMine ? (
          <StatusPill tone="info">{t("ops.queue.t.youYourTeam")}</StatusPill>
        ) : (
          <span className="text-slate-500">{i.assignment?.roleCode ?? "—"}</span>
        ),
    },
    { header: t("ops.queue.h.created"), cell: (i) => formatDateShort(i.complaint.createdAt) },
  ];

  function toggle(key: "assignedToMe" | "overdue") {
    setFilters((f) => ({ ...f, [key]: f[key] ? undefined : true }));
  }

  return (
    <div>
      <PageHeader title={t("ops.queue.title.complaintQueue")} subtitle={t("ops.queue.sub.complaintsWithinYourScopeNewestAndOverdu")} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="p-3">
          <div className="text-xs text-slate-400">{t("ops.queue.t.assignedToYou")}</div>
          <div className="text-2xl font-semibold text-slate-800">{mineCount}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-slate-400">{t("ops.queue.t.overdue")}</div>
          <div className="text-2xl font-semibold text-red-600">{overdueCount}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-slate-400">{t("ops.queue.t.open")}</div>
          <div className="text-2xl font-semibold text-slate-800">{openCount}</div>
        </Card>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Button variant={filters.assignedToMe ? "primary" : "secondary"} onClick={() => toggle("assignedToMe")}>
          Assigned to me
        </Button>
        <Button variant={filters.overdue ? "primary" : "secondary"} onClick={() => toggle("overdue")}>
          Overdue only
        </Button>
        <div className="w-40">
          <Field label={t("ops.queue.f.severity")}>
            <Select
              value={filters.severity ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value || undefined }))}
            >
              <option value="">{t("ops.queue.t.all")}</option>
              <option value="critical">{t("ops.queue.t.critical")}</option>
              <option value="major">{t("ops.queue.t.major")}</option>
              <option value="minor">{t("ops.queue.t.minor")}</option>
            </Select>
          </Field>
        </div>
      </div>

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : loading ? (
        <Spinner label={t("ops.queue.f.loadingQueue")} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={items}
            keyOf={(i) => i.complaint.id}
            onRowClick={(i) => navigate(`/queue/${i.complaint.id}`)}
            empty={
              <EmptyState
                title={t("ops.queue.title.noComplaintsMatch")}
                description={t("ops.queue.d.nothingInYourScopeMatchesTheCurrentFilte")}
              />
            }
          />
          <p className="mt-2 text-xs text-slate-400">{total} complaint(s) shown.</p>
        </>
      )}
    </div>
  );
}
