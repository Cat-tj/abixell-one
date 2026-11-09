/**
 * Customer Invoices — one place to see every invoice raised from a Work Order
 * (step 7 of the Work Order detail). Read-only: invoices are created and
 * settled elsewhere; this page only lists them and links back to the Work Order.
 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useT } from "../../i18n/LocaleProvider";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type CustomerInvoiceListItem } from "../../lib/api";
import {
  Alert,
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
import { formatDateShort, formatMoney, type Tone } from "../../shared/format";

/** Sums decimal strings exactly (scaled to 4 decimals) without float math. */
function sumDecimals(values: string[]): string {
  let total = 0n;
  for (const value of values) {
    const [whole = "0", fraction = ""] = value.split(".");
    if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) continue;
    total += BigInt(whole + (fraction + "0000").slice(0, 4));
  }
  const digits = total.toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

const STATUS_TONE: Record<string, Tone> = {
  open: "warning",
  settled: "success",
  cancelled: "neutral",
};

export function CustomerInvoicesPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [rows, setRows] = useState<CustomerInvoiceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const dateRangeInvalid = Boolean(from && to && from > to);
  const filtered = Boolean(q || status || from || to);

  const load = useCallback(async () => {
    if (dateRangeInvalid) {
      setError(t("ci.err.dateRange"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.customerInvoices(token, {
        q: q.trim() || undefined,
        arStatus: status || undefined,
        from: from || undefined,
        to: to || undefined,
      });
      setRows(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, q, status, from, to, dateRangeInvalid, t]);

  useEffect(() => {
    // Debounce typing in the search box; other filters change in single steps.
    const handle = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(handle);
  }, [load]);

  const totals = useMemo(() => {
    const live = rows.filter((r) => r.arStatus !== "cancelled");
    return {
      billed: sumDecimals(live.map((r) => r.totalAmount)),
      unpaid: sumDecimals(live.filter((r) => r.arStatus === "open").map((r) => r.totalAmount)),
    };
  }, [rows]);

  const statusLabel = (value: string) => {
    switch (value) {
      case "open":
        return t("ci.status.open");
      case "settled":
        return t("ci.status.settled");
      case "cancelled":
        return t("ci.status.cancelled");
      default:
        return value;
    }
  };

  const columns: Column<CustomerInvoiceListItem>[] = [
    {
      header: t("ci.h.number"),
      cell: (row) => <span className="font-medium">{row.invoiceNumber}</span>,
    },
    { header: t("ci.h.date"), cell: (row) => formatDateShort(row.invoiceDate) },
    {
      header: t("ci.h.customer"),
      cell: (row) => (
        <span>
          {row.customerName}
          {row.siteName ? <span className="block text-xs text-ink-faint">{row.siteName}</span> : null}
        </span>
      ),
    },
    {
      header: t("ci.h.workOrder"),
      cell: (row) => (
        <Link
          to={`/work-orders/${row.workOrderId}`}
          className="font-medium text-accent hover:underline"
          onClick={(e: MouseEvent) => e.stopPropagation()}
        >
          {row.workOrderNumber}
        </Link>
      ),
    },
    {
      header: t("ci.h.total"),
      cell: (row) => `${row.currency} ${formatMoney(row.totalAmount)}`,
    },
    {
      header: t("ci.h.status"),
      cell: (row) => <StatusPill tone={STATUS_TONE[row.arStatus] ?? "neutral"}>{statusLabel(row.arStatus)}</StatusPill>,
    },
  ];

  const currency = rows[0]?.currency ?? "IDR";

  return (
    <div className="space-y-5">
      <PageHeader title={t("ci.title")} subtitle={t("ci.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-ink-faint">{t("ci.tile.count")}</p>
          <p className="mt-1 text-2xl font-extrabold text-ink">{rows.length}</p>
        </Card>
        <Card>
          <p className="text-sm text-ink-faint">{t("ci.tile.billed")}</p>
          <p className="mt-1 text-2xl font-extrabold text-ink">
            {currency} {formatMoney(totals.billed)}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-ink-faint">{t("ci.tile.unpaid")}</p>
          <p className="mt-1 text-2xl font-extrabold text-ink">
            {currency} {formatMoney(totals.unpaid)}
          </p>
        </Card>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Field label={t("ci.f.search")}>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ci.f.searchPlaceholder")} />
            </Field>
          </div>
          <Field label={t("ci.f.status")}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t("ci.status.all")}</option>
              <option value="open">{t("ci.status.open")}</option>
              <option value="settled">{t("ci.status.settled")}</option>
              <option value="cancelled">{t("ci.status.cancelled")}</option>
            </Select>
          </Field>
          <Field label={t("ci.f.from")}>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("ci.f.to")}>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          onRowClick={(row) => navigate(`/work-orders/${row.workOrderId}`)}
          empty={
            filtered ? (
              <EmptyState
                title={t("ci.emptyFiltered.title")}
                description={t("ci.emptyFiltered.desc")}
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQ("");
                      setStatus("");
                      setFrom("");
                      setTo("");
                    }}
                  >
                    {t("ci.b.clear")}
                  </Button>
                }
              />
            ) : (
              <EmptyState title={t("ci.empty.title")} description={t("ci.empty.desc")} />
            )
          }
        />
      )}
    </div>
  );
}
