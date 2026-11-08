/**
 * Wave A6.4 — Bank reconciliation (FIN-ADV-004).
 *
 * The statement says what the bank thinks happened; the ledger says what the
 * books think happened. Reconciliation is the act of pairing them, line by
 * line, until only the genuinely unexplained differences are left.
 *
 * This page does not decide which pairing is right. `suggestMatches` proposes
 * candidates with a score and its reasons; the operator picks one, or matches a
 * ledger entry by hand. Closing a reconciliation is the service's call too — it
 * compares the two balances and refuses while unexplained differences remain.
 *
 * Statement import is CSV-first (ADR-0018 §2): the file is read as text in the
 * browser and sent as text. Nothing is parsed here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingAccountRecord,
  type AccountingBankAccountRecord,
  type AccountingBankMatchRecord,
  type AccountingBankPeriodMovement,
  type AccountingBankReconciliationRecord,
  type AccountingBankStatementLineRecord,
  type AccountingMatchCandidate,
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
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, formatMoney } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";
import { isValidAmountInput } from "./money";
import { newIdempotencyKey, useLegalEntities } from "./useLegalEntities";

/** The stored value stays the API's; only the word on screen changes. */
const DIRECTION_KEYS: Record<AccountingBankStatementLineRecord["direction"], MessageKey> = {
  debit: "finRecon.directionDebit",
  credit: "finRecon.directionCredit",
};

const RECON_STATUS_KEYS: Record<AccountingBankReconciliationRecord["status"], MessageKey> = {
  open: "finAcct.periodOpen",
  closed: "finAcct.periodClosed",
};

export function FinanceBankReconPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { entities, legalEntityId, setLegalEntityId } = useLegalEntities(token);

  const [accounts, setAccounts] = useState<AccountingBankAccountRecord[]>([]);
  const [ledgerAccounts, setLedgerAccounts] = useState<AccountingAccountRecord[]>([]);
  const [periods, setPeriods] = useState<AccountingPeriodRecord[]>([]);
  const [bankAccountId, setBankAccountId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Registration form
  const [bankName, setBankName] = useState("");
  const [houseBankCode, setHouseBankCode] = useState("");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [masked, setMasked] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountCurrency, setAccountCurrency] = useState("IDR");
  const [ledgerAccountId, setLedgerAccountId] = useState("");
  const [policy, setPolicy] = useState<"manual" | "suggested">("manual");
  const [effectiveFrom, setEffectiveFrom] = useState("");

  // Statement import
  const fileInput = useRef<HTMLInputElement>(null);
  const [importName, setImportName] = useState("");

  const [lines, setLines] = useState<AccountingBankStatementLineRecord[]>([]);
  const [reconciliations, setReconciliations] = useState<AccountingBankReconciliationRecord[]>([]);
  const [reconId, setReconId] = useState("");
  const [matches, setMatches] = useState<AccountingBankMatchRecord[]>([]);
  const [movement, setMovement] = useState<AccountingBankPeriodMovement | null>(null);
  const [closeBalance, setCloseBalance] = useState("");

  // Matching
  const [lineId, setLineId] = useState("");
  const [candidates, setCandidates] = useState<AccountingMatchCandidate[]>([]);
  const [glEntryId, setGlEntryId] = useState("");
  const [matchAmount, setMatchAmount] = useState("");

  const loadEntities = useCallback(async () => {
    if (!legalEntityId) {
      setAccounts([]);
      setLedgerAccounts([]);
      setPeriods([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [accountList, ledgerList, periodList] = await Promise.all([
        api.accountingBankAccounts(token, { legalEntityId }),
        api.accountingAccounts(token, { legalEntityId, activeOnly: true }),
        api.accountingPeriods(token, { legalEntityId }),
      ]);
      setAccounts(accountList);
      setLedgerAccounts(ledgerList);
      setPeriods(periodList);
      setBankAccountId((current) => (accountList.some((a) => a.id === current) ? current : accountList[0]?.id ?? ""));
      setPeriodId((current) => (periodList.some((p) => p.id === current) ? current : periodList[0]?.id ?? ""));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.loadAccountsFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, legalEntityId, t]);

  useEffect(() => {
    void loadEntities();
  }, [loadEntities]);

  const loadRecon = useCallback(async () => {
    if (!bankAccountId) {
      setLines([]);
      setReconciliations([]);
      return;
    }
    try {
      const [lineList, reconList] = await Promise.all([
        api.accountingStatementLines(token, { bankAccountId }).catch(() => []),
        api.accountingBankReconciliations(token, { bankAccountId }).catch(() => []),
      ]);
      setLines(lineList);
      setReconciliations(reconList);
      setReconId((current) => (reconList.some((r) => r.id === current) ? current : reconList[0]?.id ?? ""));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.loadLinesFailed"));
    }
  }, [token, bankAccountId, t]);

  useEffect(() => {
    void loadRecon();
  }, [loadRecon]);

  const loadMatches = useCallback(async () => {
    if (!reconId) {
      setMatches([]);
      return;
    }
    try {
      setMatches(await api.accountingBankMatches(token, reconId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.matchesFailed"));
    }
  }, [token, reconId, t]);

  useEffect(() => {
    void loadMatches();
  }, [loadMatches]);

  const loadMovement = useCallback(async () => {
    if (!bankAccountId || !periodId) {
      setMovement(null);
      return;
    }
    try {
      setMovement(await api.accountingBankPeriodMovement(token, { bankAccountId, periodId }));
    } catch {
      setMovement(null);
    }
  }, [token, bankAccountId, periodId]);

  useEffect(() => {
    void loadMovement();
  }, [loadMovement]);

  async function registerAccount() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingCreateBankAccount(token, {
        legalEntityId,
        bankName: bankName.trim(),
        houseBankCode: houseBankCode.trim(),
        bankAccountId: externalAccountId.trim(),
        accountNumberMasked: masked.trim(),
        name: accountName.trim(),
        currency: accountCurrency,
        ledgerAccountId,
        reconciliationPolicy: policy,
        effectiveFrom,
      });
      setNotice(t("finRecon.accountRegistered", { name: created.name }));
      setBankName("");
      setHouseBankCode("");
      setExternalAccountId("");
      setMasked("");
      setAccountName("");
      await loadEntities();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.registerFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function importStatement(file: File) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The file is read as text and forwarded as text. No CSV parsing here:
      // the service owns the format profile.
      const content = await file.text();
      const result = await api.accountingImportStatement(token, {
        bankAccountId,
        formatProfile: "csv_v1",
        sourceFileName: file.name,
        content,
      });
      setNotice(
        result.duplicateLineCount > 0
          ? t("finRecon.importedWithDuplicates", {
              count: result.lineCount,
              file: result.sourceFileName,
              duplicates: result.duplicateLineCount,
            })
          : t("finRecon.imported", { count: result.lineCount, file: result.sourceFileName }),
      );
      setImportName(file.name);
      await loadRecon();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function openReconciliation() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingOpenReconciliation(token, { bankAccountId, periodId });
      setNotice(t("finRecon.opened"));
      setReconId(created.id);
      await loadRecon();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.openFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function suggest(line: AccountingBankStatementLineRecord) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const list = await api.accountingStatementLineCandidates(token, line.id, { dateToleranceDays: 3 });
      setLineId(line.id);
      setCandidates(list);
      setGlEntryId(list[0]?.glEntryId ?? "");
      setMatchAmount(line.amount);
      setNotice(
        list.length === 0
          ? t("finRecon.noCandidates")
          : t("finRecon.candidatesFound", { count: list.length, amount: formatMoney(line.amount) }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.candidatesFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createMatch() {
    if (!reconId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingCreateBankMatch(token, {
        reconciliationId: reconId,
        statementLineId: lineId,
        glEntryId,
        // Verbatim text at 2 decimals — ledger precision.
        amount: matchAmount.trim(),
        matchKind: "manual",
        matchReason: null,
        idempotencyKey: newIdempotencyKey(),
        note: null,
      });
      setNotice(t("finRecon.matchRecorded"));
      setLineId("");
      setCandidates([]);
      setGlEntryId("");
      await Promise.all([loadMatches(), loadMovement()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.matchFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!reconId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const closed = await api.accountingCloseReconciliation(token, reconId, {
        statementBalance: closeBalance.trim() || null,
      });
      setNotice(
        t("finRecon.closed", {
          book: formatMoney(closed.closedBookBalance),
          statement: formatMoney(closed.closedStatementBalance),
        }),
      );
      setCloseBalance("");
      await loadRecon();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finRecon.closeFailed"));
    } finally {
      setBusy(false);
    }
  }

  const activeRecon = reconciliations.find((r) => r.id === reconId) ?? null;
  const openRecon = activeRecon?.status === "open" ? activeRecon : null;

  const lineColumns: Column<AccountingBankStatementLineRecord>[] = [
    {
      header: t("finRecon.valueDate"),
      mobileRole: "title",
      className: "tabular-nums",
      cell: (row) => formatDateShort(row.valueDate),
    },
    { header: t("fin.common.reference"), cell: (row) => row.reference ?? t("fin.common.notAvailable") },
    { header: t("finRecon.counterparty"), cell: (row) => row.counterparty ?? t("fin.common.notAvailable") },
    { header: t("fin.common.direction"), cell: (row) => <Badge>{t(DIRECTION_KEYS[row.direction])}</Badge> },
    {
      header: t("fin.common.amount"),
      className: "text-right tabular-nums whitespace-nowrap",
      mobileRole: "detail",
      cell: (row) => `${formatMoney(row.amount)} ${row.currency}`,
    },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) =>
        row.duplicateStatus === "review_queue" ? (
          <StatusPill tone="warning">{t("finRecon.statusReview")}</StatusPill>
        ) : (
          <StatusPill tone="neutral">{t("finRecon.statusAccepted")}</StatusPill>
        ),
    },
    {
      header: t("fin.common.actions"),
      cell: (row) => (
        <Button variant="secondary" disabled={busy || !openRecon} onClick={() => void suggest(row)}>
          {t("finRecon.findMatch")}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finRecon.title")} subtitle={t("finRecon.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          <Field label={t("finPeriods.bankAccount")} required>
            <Select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              <option value="">{t("fin.common.select")}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {account.accountNumberMasked}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("finAcct.period")} required>
            <Select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
              <option value="">{t("fin.common.select")}</option>
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.periodName} ({period.periodCode} {period.fiscalYearCode})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {movement ? (
          <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
            <div>
              <span className="text-xs text-ink-faint">{t("finRecon.bookMovement")}</span>
              <div className="tabular-nums text-ink">{formatMoney(movement.bookMovement)}</div>
            </div>
            <div>
              <span className="text-xs text-ink-faint">{t("finRecon.statementMovement")}</span>
              <div className="tabular-nums text-ink">{formatMoney(movement.statementMovement)}</div>
            </div>
            <div>
              <span className="text-xs text-ink-faint">{t("finRecon.difference")}</span>
              <div className="tabular-nums text-ink">{formatMoney(movement.difference)}</div>
            </div>
          </div>
        ) : null}
      </Card>

      {!legalEntityId ? null : loading ? (
        <Spinner />
      ) : accounts.length === 0 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("finRecon.registerTitle")}</h2>
          <p className="mb-3 text-sm text-ink-dim">{t("finRecon.registerNote")}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("finRecon.bankName")} required>
              <Input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder={t("finRecon.bankNamePlaceholder")}
              />
            </Field>
            <Field label={t("finRecon.houseBankCode")} required hint={t("finRecon.houseBankCodeHint")}>
              <Input value={houseBankCode} onChange={(e) => setHouseBankCode(e.target.value)} placeholder="BCA-01" />
            </Field>
            <Field label={t("finRecon.accountName")} required>
              <Input
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                placeholder={t("finRecon.accountNamePlaceholder")}
              />
            </Field>
            <Field label={t("finRecon.accountNumber")} required hint={t("finRecon.accountNumberHint")}>
              <Input value={masked} onChange={(e) => setMasked(e.target.value)} placeholder="****1234" />
            </Field>
            <Field label={t("finRecon.ledgerAccount")} required>
              <Select value={ledgerAccountId} onChange={(e) => setLedgerAccountId(e.target.value)}>
                <option value="">{t("fin.common.select")}</option>
                {ledgerAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.accountCode} · {account.accountName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("fin.common.currency")} required>
              <Input
                value={accountCurrency}
                onChange={(e) => setAccountCurrency(e.target.value.toUpperCase())}
                maxLength={3}
              />
            </Field>
            <Field label={t("finRecon.effectiveFrom")} required>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </Field>
            <Field label={t("finRecon.policy")} hint={t("finRecon.policyHint")}>
              <Select value={policy} onChange={(e) => setPolicy(e.target.value as "manual" | "suggested")}>
                <option value="manual">{t("finRecon.policyManual")}</option>
                <option value="suggested">{t("finRecon.policySuggested")}</option>
              </Select>
            </Field>
            <Field label={t("finRecon.externalId")} required hint={t("finRecon.externalIdHint")}>
              <Input value={externalAccountId} onChange={(e) => setExternalAccountId(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3">
            <Button
              disabled={
                busy ||
                !bankName.trim() ||
                !houseBankCode.trim() ||
                !accountName.trim() ||
                !masked.trim() ||
                !ledgerAccountId ||
                !effectiveFrom ||
                !externalAccountId.trim()
              }
              onClick={() => void registerAccount()}
            >
              {t("finRecon.register")}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finRecon.importTitle")}</h2>
            <p className="mb-3 text-sm text-ink-dim">{t("finRecon.importNote")}</p>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importStatement(file);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" disabled={busy || !bankAccountId} onClick={() => fileInput.current?.click()}>
                {t("finRecon.chooseCsv")}
              </Button>
              <Button disabled={busy || !bankAccountId || !periodId} onClick={() => void openReconciliation()}>
                {t("finRecon.openReconciliation")}
              </Button>
              {importName ? (
                <span className="text-xs text-ink-faint">{t("finRecon.lastFile", { file: importName })}</span>
              ) : null}
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finRecon.matchTitle")}</h2>
            {lineId === "" ? (
              <p className="text-sm text-ink-dim">{t("finRecon.pickLine")}</p>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={t("finRecon.ledgerEntry")} required>
                    <Select value={glEntryId} onChange={(e) => setGlEntryId(e.target.value)}>
                      <option value="">{t("fin.common.select")}</option>
                      {candidates.map((candidate) => (
                        <option key={candidate.glEntryId} value={candidate.glEntryId}>
                          {candidate.postingDate} · {formatMoney(candidate.amount)} ({candidate.score})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label={t("fin.common.amount")}
                    required
                    hint={
                      matchAmount && !isValidAmountInput(matchAmount) ? t("finAssets.amountHint") : undefined
                    }
                  >
                    <Input
                      inputMode="decimal"
                      value={matchAmount}
                      onChange={(e) => setMatchAmount(e.target.value)}
                      aria-invalid={matchAmount !== "" && !isValidAmountInput(matchAmount)}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      disabled={busy || !glEntryId || !isValidAmountInput(matchAmount) || !openRecon}
                      onClick={() => void createMatch()}
                    >
                      {t("finRecon.recordMatch")}
                    </Button>
                  </div>
                </div>
                {candidates.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-xs text-ink-faint">
                    {candidates.slice(0, 3).map((candidate) => (
                      <li key={candidate.glEntryId}>
                        {candidate.ledgerReference} · {t("finRecon.score", { score: candidate.score })}
                        {candidate.reasons.length > 0 ? `: ${candidate.reasons.join(", ")}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Card>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finRecon.lines")}</h2>
            <DataTable
              columns={lineColumns}
              rows={lines}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finRecon.noLinesTitle")} description={t("finRecon.noLinesDesc")} />}
            />
          </div>

          {activeRecon ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink">
                {t("finRecon.activeTitle", { status: t(RECON_STATUS_KEYS[activeRecon.status]) })}
              </h2>
              <p className="mb-3 text-sm text-ink-dim">{t("finRecon.activeNote", { count: matches.length })}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label={t("finRecon.statementBalance")} hint={t("finRecon.statementBalanceHint")}>
                  <Input
                    inputMode="decimal"
                    value={closeBalance}
                    onChange={(e) => setCloseBalance(e.target.value)}
                    placeholder="0.00"
                  />
                </Field>
                <div className="flex items-end">
                  <Button disabled={busy || activeRecon.status !== "open"} onClick={() => void close()}>
                    {t("finRecon.closeReconciliation")}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}