/**
 * Wave A6.2 — General ledger journals (FIN-ADV-001).
 *
 * Write surface for the Accounting Kernel's journal lifecycle: draft, validate,
 * post, reverse. The kernel is the only writer of the general ledger, so this
 * page never computes a balance of its own — it shows what the kernel says and
 * asks the kernel to move the journal to its next state.
 *
 * Every amount is typed and sent as text. No Number(), no parseFloat: the
 * kernel decides what is balanced, and a value that passed through a float
 * would not be the value the operator entered.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingAccountRecord,
  type AccountingJournalInput,
  type AccountingJournalRecord,
  type AccountingPeriodRecord,
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
import { formatDateShort, formatMoney } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";
import { useLegalEntities } from "./useLegalEntities";

const JOURNAL_TONES: Record<AccountingJournalRecord["status"], "neutral" | "success" | "warning" | "danger"> = {
  pending: "warning",
  posted: "success",
  failed: "danger",
  reversed: "neutral",
};

/** The stored status stays the API's; only the word on screen is translated. */
const JOURNAL_STATUS_KEYS: Record<AccountingJournalRecord["status"], MessageKey> = {
  pending: "finJournals.statusPending",
  posted: "finJournals.statusPosted",
  failed: "finJournals.statusFailed",
  reversed: "finJournals.statusReversed",
};

type DraftLine = { accountId: string; debit: string; credit: string; lineDescription: string };

const EMPTY_LINE: DraftLine = { accountId: "", debit: "", credit: "", lineDescription: "" };

export function FinanceJournalsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { entities, legalEntityId, setLegalEntityId } = useLegalEntities(token);

  const [periods, setPeriods] = useState<AccountingPeriodRecord[]>([]);
  const [accounts, setAccounts] = useState<AccountingAccountRecord[]>([]);
  const [journals, setJournals] = useState<AccountingJournalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [journalNumber, setJournalNumber] = useState("");
  const [journalDate, setJournalDate] = useState("");
  const [accountingDate, setAccountingDate] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [currency, setCurrency] = useState("IDR");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);

  const [selected, setSelected] = useState<AccountingJournalRecord | null>(null);
  const [reversalReason, setReversalReason] = useState("");

  const load = useCallback(async () => {
    if (!legalEntityId) {
      setPeriods([]);
      setAccounts([]);
      setJournals([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [periodList, accountList] = await Promise.all([
        api.accountingPeriods(token, { legalEntityId }),
        api.accountingAccounts(token, { legalEntityId, activeOnly: true }),
      ]);
      setPeriods(periodList);
      setAccounts(accountList);
      // Journals are listed per period: the route takes `periodId`, not an
      // entity, so the open periods are the filter the page can offer.
      const openPeriods = periodList.filter((p) => p.status === "open" || p.status === "draft");
      const perPeriod = await Promise.all(
        openPeriods.map((p) => api.accountingJournals(token, { periodId: p.id }).catch(() => [])),
      );
      setJournals(perPeriod.flat());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finJournals.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, legalEntityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const periodLabel = (id: string) => {
    const period = periods.find((p) => p.id === id);
    return period ? `${period.periodCode} ${period.fiscalYearCode}` : id;
  };

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function createJournal() {
    const missing = [
      !legalEntityId ? t("fin.common.legalEntity") : null,
      journalNumber.trim() === "" ? t("finJournals.journalNumber") : null,
      !journalDate ? t("finJournals.journalDate") : null,
      !periodId ? t("finJournals.period") : null,
      currency.trim() === "" ? t("fin.common.currency") : null,
      !lines.some((line) => line.accountId) ? t("finJournals.lines") : null,
    ].filter((x): x is string => x !== null);
    if (missing.length > 0) {
      setNotice(null);
      setError(t("common.form.missing", { fields: missing.join(", ") }));
      return;
    }
    // A comma is accepted as the decimal separator ("12,5" -> "12.5").
    const decimal = (v: string) => v.trim().replace(",", ".");
    const badLines = lines
      .map((line, index) => ({ line, n: index + 1 }))
      .filter(
        ({ line }) =>
          (!line.accountId && (line.debit.trim() !== "" || line.credit.trim() !== "")) ||
          [line.debit, line.credit].some((v) => v.trim() !== "" && !/^\d+(\.\d+)?$/.test(decimal(v))),
      )
      .map(({ n }) => `${t("finJournals.lines")} #${n}`);
    if (badLines.length > 0) {
      setNotice(null);
      setError(t("common.form.invalid", { fields: badLines.join(", ") }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: AccountingJournalInput = {
        legalEntityId,
        journalNumber: journalNumber.trim(),
        journalDate,
        accountingDate: accountingDate || journalDate,
        periodId,
        description: description || null,
        currency,
        lines: lines
          .filter((line) => line.accountId)
          .map((line, index) => ({
            accountId: line.accountId,
            lineNumber: index + 1,
            // Verbatim text, exactly as typed.
            debit: decimal(line.debit) || "0",
            credit: decimal(line.credit) || "0",
            lineDescription: line.lineDescription || null,
            projectId: null,
            siteId: null,
          })),
      };
      const created = await api.accountingCreateJournal(token, body);
      setNotice(t("finJournals.draftCreated", { number: created.journalNumber }));
      setJournalNumber("");
      setDescription("");
      setLines([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finJournals.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function validate(row: AccountingJournalRecord) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.accountingValidateJournal(token, row.id);
      setNotice(
        t(result.balanced ? "finJournals.balances" : "finJournals.doesNotBalance", {
          number: row.journalNumber,
          debit: formatMoney(result.debitTotal),
          credit: formatMoney(result.creditTotal),
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finJournals.validateFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function post(row: AccountingJournalRecord) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingPostJournal(token, row.id);
      setNotice(t("finJournals.posted", { number: row.journalNumber }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finJournals.postFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function reverse(row: AccountingJournalRecord) {
    if (reversalReason.trim() === "") {
      setNotice(null);
      setError(t("common.form.missing", { fields: t("finTxDetail.reason") }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const reversal = await api.accountingReverseJournal(token, row.id, {
        type: "reverse_correct",
        reason: reversalReason.trim(),
      });
      setNotice(
        t("finJournals.reversed", { reversal: reversal.journalNumber, original: row.journalNumber }),
      );
      setReversalReason("");
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finJournals.reverseFailed"));
    } finally {
      setBusy(false);
    }
  }

  const openPeriods = periods.filter((p) => p.status === "open" || p.status === "draft");

  const columns: Column<AccountingJournalRecord>[] = [
    {
      header: t("finJournals.journalNumber"),
      mobileRole: "title",
      cell: (row) => <span className="font-mono text-xs font-medium text-ink">{row.journalNumber}</span>,
    },
    { header: t("fin.common.date"), className: "tabular-nums", cell: (row) => formatDateShort(row.journalDate) },
    { header: t("finJournals.period"), cell: (row) => periodLabel(row.periodId) },
    { header: t("fin.common.currency"), cell: (row) => row.currency },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={JOURNAL_TONES[row.status]}>{t(JOURNAL_STATUS_KEYS[row.status])}</StatusPill>
      ),
    },
    {
      header: t("finJournals.balanced"),
      mobileRole: "detail",
      cell: (row) =>
        row.isBalanced ? (
          <Badge>{t("finJournals.balanced")}</Badge>
        ) : (
          <Badge>{t("finJournals.outOfBalance")}</Badge>
        ),
    },
    {
      header: t("fin.common.actions"),
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.status === "pending" ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => void validate(row)}>
                {t("finJournals.validate")}
              </Button>
              <Button disabled={busy} onClick={() => void post(row)}>
                {t("finJournals.post")}
              </Button>
            </>
          ) : null}
          {row.status === "posted" ? (
            <Button variant="secondary" disabled={busy} onClick={() => setSelected(row)}>
              {t("finJournals.reverse")}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finJournals.title")} subtitle={t("finJournals.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <Field label={t("fin.common.legalEntity")} required>
          <Select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
            <option value="">{t("fin.common.chooseLegalEntity")}</option>
            {entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.name}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      {!legalEntityId ? (
        <EmptyState title={t("finJournals.chooseEntityTitle")} description={t("finJournals.chooseEntityDesc")} />
      ) : (
        <>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finJournals.newJournal")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("finJournals.journalNumber")} required>
                <Input
                  value={journalNumber}
                  onChange={(e) => setJournalNumber(e.target.value)}
                  placeholder="JV-2026-0001"
                />
              </Field>
              <Field label={t("finJournals.journalDate")} required>
                <Input type="date" value={journalDate} onChange={(e) => setJournalDate(e.target.value)} />
              </Field>
              <Field label={t("finJournals.accountingDate")} hint={t("finJournals.accountingDateHint")}>
                <Input type="date" value={accountingDate} onChange={(e) => setAccountingDate(e.target.value)} />
              </Field>
              <Field label={t("finJournals.period")} required>
                <Select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {openPeriods.map((period) => (
                    <option key={period.id} value={period.id}>
                      {period.periodName} ({period.periodCode} {period.fiscalYearCode})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("fin.common.currency")} required>
                <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
              </Field>
            </div>
            <div className="mt-3">
              <Field label={t("fin.common.description")}>
                <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
            </div>

            <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">{t("finJournals.lines")}</h3>
            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-5">
                    <Select
                      aria-label={t("finJournals.accountForLine", { n: index + 1 })}
                      value={line.accountId}
                      onChange={(e) => updateLine(index, { accountId: e.target.value })}
                    >
                      <option value="">{t("finJournals.accountPlaceholder")}</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.accountCode} · {account.accountName}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      aria-label={t("finJournals.debitForLine", { n: index + 1 })}
                      inputMode="decimal"
                      placeholder={t("finJournals.debit")}
                      value={line.debit}
                      onChange={(e) => updateLine(index, { debit: e.target.value, credit: "" })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      aria-label={t("finJournals.creditForLine", { n: index + 1 })}
                      inputMode="decimal"
                      placeholder={t("finJournals.credit")}
                      value={line.credit}
                      onChange={(e) => updateLine(index, { credit: e.target.value, debit: "" })}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <Input
                      aria-label={t("finJournals.descriptionForLine", { n: index + 1 })}
                      placeholder={t("finJournals.lineNote")}
                      value={line.lineDescription}
                      onChange={(e) => updateLine(index, { lineDescription: e.target.value })}
                    />
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-2 text-xs text-ink-faint">{t("finJournals.linesNote")}</p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}>
                {t("finJournals.addLine")}
              </Button>
              <Button disabled={busy} onClick={() => void createJournal()}>
                {t("finJournals.createDraft")}
              </Button>
            </div>
          </Card>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finJournals.openPeriods")}</h2>
            {loading ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                rows={journals}
                keyOf={(row) => row.id}
                empty={<EmptyState title={t("finJournals.emptyTitle")} description={t("finJournals.emptyDesc")} />}
              />
            )}
          </div>

          {selected ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink">
                {t("finJournals.reverseTitle", { number: selected.journalNumber })}
              </h2>
              <p className="mb-3 text-sm text-ink-dim">{t("finJournals.reverseNote")}</p>
              <Field label={t("finTxDetail.reason")} required>
                <Input value={reversalReason} onChange={(e) => setReversalReason(e.target.value)} />
              </Field>
              <div className="mt-3 flex gap-2">
                <Button disabled={busy} onClick={() => void reverse(selected)}>
                  {t("finJournals.createReversal")}
                </Button>
                <Button variant="ghost" onClick={() => setSelected(null)}>
                  {t("fin.common.cancel")}
                </Button>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
