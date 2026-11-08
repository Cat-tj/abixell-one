/**
 * Phase 6 — Operational cashflow (FIN-CORE-007, FIN-CORE-011).
 *
 * In, out, net over a period, plus the opening and closing position and a
 * breakdown by category. Every figure comes from the backend, summed by the
 * database — this page adds nothing up.
 *
 * This is NOT a Cash Flow Statement: there is no operating / investing /
 * financing classification, no profit and loss, no balance sheet, and no
 * ratio. Only transactions that actually took effect are counted.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type CashflowResult, type FinanceAccount } from "../../lib/api";
import {
  Alert,
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
import { useT } from "../../i18n/LocaleProvider";
import { formatMoney, monthRange } from "./money";

type CategoryLine = CashflowResult["byCategory"][number];

export function CashflowPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const initial = monthRange();

  const [result, setResult] = useState<CashflowResult | null>(null);
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [categories, setCategories] = useState<{ code: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [accountCode, setAccountCode] = useState("");

  const load = useCallback(async () => {
    // Don't refetch with a half-cleared range: the API would 400 and blank the page.
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.financeCashflow(token, { from, to, accountCode: accountCode || undefined }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finCashflow.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, from, to, accountCode, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const [accountList, categoryList] = await Promise.all([
        api.financeAccounts(token).catch(() => [] as FinanceAccount[]),
        api.financeCategories(token).catch(() => [] as { code: string; label: string }[]),
      ]);
      setAccounts(accountList);
      setCategories(categoryList);
    })();
  }, [token]);

  const categoryLabel = (code: string) => categories.find((c) => c.code === code)?.label ?? code;

  const categoryColumns: Column<CategoryLine>[] = [
    { header: t("fin.common.category"), cell: (row) => categoryLabel(row.categoryCode) },
    {
      header: t("fin.common.direction"),
      cell: (row) => (
        <StatusPill tone={row.direction === "income" ? "success" : "neutral"}>
          {row.direction === "income" ? t("fin.money.in") : t("fin.money.out")}
        </StatusPill>
      ),
    },
    {
      header: t("fin.common.amount"),
      className: "text-right tabular-nums",
      cell: (row) => <span className="font-medium">{formatMoney(row.amount)}</span>,
    },
  ];

  const accountColumns: Column<FinanceAccount>[] = [
    { header: t("fin.common.account"), cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: t("fin.common.currency"), cell: (row) => row.currency },
    {
      header: t("fin.common.balance"),
      className: "text-right tabular-nums",
      cell: (row) => <span className="font-medium">{formatMoney(row.balance)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finCashflow.title")} subtitle={t("finCashflow.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("fin.common.from")} required>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("fin.common.to")} required>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label={t("fin.common.account")}>
            <Select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
              <option value="">{t("fin.common.allAccounts")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.code}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : result ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <p className="text-xs font-bold text-ink-faint">{t("finCashflow.opening")}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{formatMoney(result.opening)}</p>
            </Card>
            <Card>
              <p className="text-xs font-bold text-ink-faint">{t("fin.money.in")}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-status-ok">
                {formatMoney(result.totals.income)}
              </p>
            </Card>
            <Card>
              <p className="text-xs font-bold text-ink-faint">{t("fin.money.out")}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                {formatMoney(result.totals.expense)}
              </p>
            </Card>
            <Card>
              <p className="text-xs font-bold text-ink-faint">{t("finCashflow.closing")}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{formatMoney(result.closing)}</p>
              <p className="mt-1 text-xs text-ink-faint">
                {t("finCashflow.net", { amount: formatMoney(result.totals.net) })}
              </p>
            </Card>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finCashflow.byCategory")}</h2>
            <DataTable
              columns={categoryColumns}
              rows={result.byCategory}
              keyOf={(row) => `${row.categoryCode}-${row.direction}`}
              empty={
                <EmptyState title={t("finCashflow.emptyTitle")} description={t("finCashflow.emptyDesc")} />
              }
            />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finCashflow.accountBalances")}</h2>
            <DataTable
              columns={accountColumns}
              rows={result.accounts}
              keyOf={(row) => row.id}
              empty={
                <EmptyState title={t("finCashflow.noAccountsTitle")} description={t("finCashflow.noAccountsDesc")} />
              }
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
