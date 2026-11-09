/**
 * Phase 6 — Income and expense (FIN-CORE-001/002/006, FIN-CORE-011).
 *
 * One compact record form and one filterable list. Deliberately not a
 * general-ledger data-entry screen: there is no debit/credit, no journal
 * line, and no account code beyond the cash or bank account the money
 * actually moved through.
 *
 * The amount is typed and sent as TEXT. It is never parsed into a
 * JavaScript number anywhere in this module, so what the user types is
 * exactly what the database stores.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Customer,
  type FinanceAccount,
  type FinanceTransactionRecord,
  type TransactionDirection,
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
  Textarea,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";
import { formatSigned, isValidAmountInput, monthRange } from "./money";

export function FinanceTransactionsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [transactions, setTransactions] = useState<FinanceTransactionRecord[]>([]);
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [categories, setCategories] = useState<{ code: string; label: string }[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [filterDirection, setFilterDirection] = useState("");
  const [filterAccount, setFilterAccount] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterState, setFilterState] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [search, setSearch] = useState("");

  const [direction, setDirection] = useState<TransactionDirection>("income");
  const [amount, setAmount] = useState("");
  const [transactionDate, setTransactionDate] = useState(monthRange().from);
  const [accountCode, setAccountCode] = useState("");
  const [categoryCode, setCategoryCode] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTransactions(
        await api.financeTransactions(token, {
          direction: filterDirection || undefined,
          accountCode: filterAccount || undefined,
          categoryCode: filterCategory || undefined,
          state: filterState || undefined,
          dateFrom: filterFrom || undefined,
          dateTo: filterTo || undefined,
          search: search || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTx.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, filterDirection, filterAccount, filterCategory, filterState, filterFrom, filterTo, search, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const [accountList, categoryList, customerList] = await Promise.all([
        api.financeAccounts(token).catch(() => [] as FinanceAccount[]),
        api.financeCategories(token).catch(() => [] as { code: string; label: string }[]),
        api.customers(token).catch(() => [] as Customer[]),
      ]);
      setAccounts(accountList);
      setCategories(categoryList);
      setCustomers(customerList);
      const firstActive = accountList.find((a) => a.isActive);
      if (firstActive) setAccountCode((current) => current || firstActive.code);
      if (categoryList[0]) setCategoryCode((current) => current || categoryList[0].code);
    })();
  }, [token]);

  const accountOf = (id: string) => accounts.find((a) => a.id === id);
  const categoryLabel = (code: string) => categories.find((c) => c.code === code)?.label ?? code;
  // A comma is accepted as the decimal separator ("12,5" -> "12.5").
  const amountNorm = amount.trim().replace(",", ".");
  const amountValid = isValidAmountInput(amountNorm);

  async function record() {
    const missing = [
      amount.trim() === "" ? t("fin.common.amount") : null,
      !transactionDate ? t("fin.common.date") : null,
      !accountCode ? t("fin.common.account") : null,
      !categoryCode ? t("fin.common.category") : null,
    ].filter((x): x is string => x !== null);
    if (missing.length > 0) {
      setNotice(null);
      setError(t("common.form.missing", { fields: missing.join(", ") }));
      return;
    }
    if (!amountValid) {
      setNotice(null);
      setError(t("common.form.invalid", { fields: `${t("fin.common.amount")} (${t("finTx.amountHint")})` }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.recordFinanceTransaction(token, {
        direction,
        // Sent verbatim as text — no Number(), no parseFloat, no rounding.
        amount: amountNorm,
        transactionDate,
        accountCode,
        categoryCode,
        customerId: customerId || null,
        reference: reference || null,
        description: description || null,
      });
      setNotice(t("finTx.recorded", { number: created.transaction.transactionNumber }));
      setAmount("");
      setReference("");
      setDescription("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTx.recordFailed"));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<FinanceTransactionRecord>[] = [
    { header: t("finTx.number"), cell: (row) => <span className="font-medium">{row.transactionNumber}</span> },
    { header: t("fin.common.date"), cell: (row) => formatDateShort(row.transactionDate) },
    { header: t("fin.common.category"), cell: (row) => categoryLabel(row.categoryCode) },
    { header: t("fin.common.account"), cell: (row) => accountOf(row.accountId)?.code ?? t("fin.common.notAvailable") },
    {
      header: t("fin.common.amount"),
      className: "text-right tabular-nums whitespace-nowrap",
      cell: (row) => (
        <span className={row.direction === "income" ? "font-medium text-status-ok" : "font-medium text-ink"}>
          {formatSigned(row.amount, row.direction, row.currency)}
        </span>
      ),
    },
    {
      header: t("fin.common.state"),
      cell: (row) =>
        row.appliedAt ? (
          <StatusPill tone="success">{t("fin.state.tookEffect")}</StatusPill>
        ) : (
          <StatusPill tone="warning">{t("fin.state.awaitingApproval")}</StatusPill>
        ),
    },
    {
      header: t("fin.state.correction"),
      cell: (row) =>
        row.reversesTransactionId ? (
          <Badge>{t("fin.state.correction")}</Badge>
        ) : row.reversedByTransactionId ? (
          <Badge>{t("fin.state.reversed")}</Badge>
        ) : (
          t("fin.common.notAvailable")
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finTx.title")} subtitle={t("finTx.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("finTx.recordTitle")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("fin.common.direction")} required>
            <Select value={direction} onChange={(e) => setDirection(e.target.value as TransactionDirection)}>
              <option value="income">{t("fin.money.in")}</option>
              <option value="expense">{t("fin.money.out")}</option>
            </Select>
          </Field>
          <Field
            label={t("fin.common.amount")}
            required
            hint={amount && !amountValid ? t("finTx.amountHint") : undefined}
          >
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={t("finTx.amountPlaceholder")}
              aria-invalid={amount !== "" && !amountValid}
            />
          </Field>
          <Field label={t("fin.common.date")} required>
            <Input type="date" value={transactionDate} onChange={(e) => setTransactionDate(e.target.value)} />
          </Field>
          <Field label={t("fin.common.account")} required>
            <Select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
              <option value="">{t("fin.common.select")}</option>
              {accounts
                .filter((a) => a.isActive)
                .map((a) => (
                  <option key={a.id} value={a.code}>
                    {a.name} ({a.currency})
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t("fin.common.category")} required>
            <Select value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
              <option value="">{t("fin.common.select")}</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fin.common.customer")}>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">{t("fin.common.none")}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fin.common.reference")}>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("finTx.referencePlaceholder")}
            />
          </Field>
          <div className="flex items-end">
            <Button disabled={busy} onClick={() => void record()}>
              {t("finTx.record")}
            </Button>
          </div>
        </div>
        <div className="mt-3">
          <Field label={t("fin.common.description")}>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("finTx.descriptionPlaceholder")}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("fin.common.search")}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("finTx.searchPlaceholder")}
            />
          </Field>
          <Field label={t("fin.common.direction")}>
            <Select value={filterDirection} onChange={(e) => setFilterDirection(e.target.value)}>
              <option value="">{t("fin.common.any")}</option>
              <option value="income">{t("fin.money.in")}</option>
              <option value="expense">{t("fin.money.out")}</option>
            </Select>
          </Field>
          <Field label={t("fin.common.account")}>
            <Select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
              <option value="">{t("fin.common.allAccounts")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.code}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fin.common.category")}>
            <Select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              <option value="">{t("fin.common.allCategories")}</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fin.common.state")}>
            <Select value={filterState} onChange={(e) => setFilterState(e.target.value)}>
              <option value="">{t("fin.common.any")}</option>
              <option value="applied">{t("fin.state.tookEffect")}</option>
              <option value="pending">{t("fin.state.awaitingApproval")}</option>
            </Select>
          </Field>
          <Field label={t("fin.common.from")}>
            <Input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </Field>
          <Field label={t("fin.common.to")}>
            <Input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          </Field>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={transactions}
          keyOf={(row) => row.id}
          onRowClick={(row) => navigate(`/finance/transactions/${row.id}`)}
          empty={<EmptyState title={t("finTx.emptyTitle")} description={t("finTx.emptyDesc")} />}
        />
      )}
    </div>
  );
}
