/**
 * Wave A6.5 — Fixed assets and depreciation (FIN-ADV-005).
 *
 * An asset book is one asset's value under one book code — the same asset can
 * sit in a tax book and a management book with different lives. A book starts
 * as a draft and only depreciates once it is active; activating it is a
 * deliberate step because from then on the monthly run picks it up.
 *
 * Depreciation is a run, not a per-asset action: one call for a legal entity,
 * a book code, and a period, and the service posts a single journal covering
 * every active book in it. That is why the page asks for a period rather than
 * an asset. Reversing a run is its own operation with a reason — the original
 * run keeps its history.
 *
 * Amounts are 2 decimals (ledger precision), sent as text.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingAccountRecord,
  type AccountingAssetBookRecord,
  type AccountingDepreciationRunRecord,
  type AccountingLedgerRecord,
  type AccountingPeriodRecord,
  type AssetRecord,
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

const BOOK_TONES: Record<AccountingAssetBookRecord["status"], "neutral" | "success" | "warning"> = {
  draft: "warning",
  active: "success",
  disposed: "neutral",
};

/** The stored status stays the API's; only the word on screen changes. */
const BOOK_STATUS_KEYS: Record<AccountingAssetBookRecord["status"], MessageKey> = {
  draft: "finAcct.periodDraft",
  active: "fin.state.active",
  disposed: "finAssets.statusDisposed",
};

const RUN_STATUS_KEYS: Record<AccountingDepreciationRunRecord["status"], MessageKey> = {
  posted: "finAssets.statusPosted",
  reversed: "finAssets.statusReversed",
};

export function FinanceAssetsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { entities, legalEntityId, setLegalEntityId } = useLegalEntities(token);

  const [books, setBooks] = useState<AccountingAssetBookRecord[]>([]);
  const [runs, setRuns] = useState<AccountingDepreciationRunRecord[]>([]);
  const [ledgers, setLedgers] = useState<AccountingLedgerRecord[]>([]);
  const [accounts, setAccounts] = useState<AccountingAccountRecord[]>([]);
  const [periods, setPeriods] = useState<AccountingPeriodRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Book form
  const [ledgerId, setLedgerId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [bookCode, setBookCode] = useState("TAX");
  const [assetClass, setAssetClass] = useState("");
  const [capitalizationDate, setCapitalizationDate] = useState("");
  const [inServiceDate, setInServiceDate] = useState("");
  const [acquisitionCost, setAcquisitionCost] = useState("");
  const [residualValue, setResidualValue] = useState("0.00");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("60");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [accumulatedAccountId, setAccumulatedAccountId] = useState("");

  // Run form
  const [runBookCode, setRunBookCode] = useState("TAX");
  const [runPeriodId, setRunPeriodId] = useState("");

  const [disposeTarget, setDisposeTarget] = useState<AccountingAssetBookRecord | null>(null);
  const [disposeDate, setDisposeDate] = useState("");
  const [disposeEvidence, setDisposeEvidence] = useState("");
  const [disposeProceeds, setDisposeProceeds] = useState("");

  const [reverseTarget, setReverseTarget] = useState<AccountingDepreciationRunRecord | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  const load = useCallback(async () => {
    if (!legalEntityId) {
      setBooks([]);
      setRuns([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [bookList, runList, ledgerList, accountList, periodList, assetList] = await Promise.all([
        api.accountingAssetBooks(token, { legalEntityId }),
        api.accountingDepreciationRuns(token, { legalEntityId }),
        api.accountingLedgers(token, legalEntityId).catch(() => []),
        api.accountingAccounts(token, { legalEntityId, activeOnly: true }),
        api.accountingPeriods(token, { legalEntityId }),
        api
          .assets(token)
          .then((result) => result.assets)
          .catch(() => [] as AssetRecord[]),
      ]);
      setBooks(bookList);
      setRuns(runList);
      setLedgers(ledgerList);
      setAccounts(accountList);
      setPeriods(periodList);
      setAssets(assetList);
      setLedgerId((current) => (ledgerList.some((l) => l.id === current) ? current : ledgerList[0]?.id ?? ""));
      setRunPeriodId((current) => (periodList.some((p) => p.id === current) ? current : periodList[0]?.id ?? ""));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finAssets.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, legalEntityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBook() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingCreateAssetBook(token, {
        legalEntityId,
        ledgerId,
        assetId,
        bookCode: bookCode.trim().toUpperCase(),
        assetClass: assetClass.trim(),
        capitalizationDate,
        inServiceDate,
        // Verbatim text at 2 decimals.
        acquisitionCost: acquisitionCost.trim(),
        residualValue: residualValue.trim() || "0.00",
        usefulLifeMonths: Number(usefulLifeMonths),
        depreciationExpenseAccountId: expenseAccountId,
        accumulatedDepreciationAccountId: accumulatedAccountId,
      });
      setNotice(t("finAssets.created", { code: created.bookCode }));
      setAssetClass("");
      setAcquisitionCost("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finAssets.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function activate(book: AccountingAssetBookRecord) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingActivateAssetBook(token, book.id);
      setNotice(t("finAssets.activated", { code: book.bookCode }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finAssets.activateFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function runDepreciation() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingRunDepreciation(token, {
        legalEntityId,
        bookCode: runBookCode.trim().toUpperCase(),
        periodId: runPeriodId,
        idempotencyKey: newIdempotencyKey(),
        description: null,
      });
      setNotice(
        t("finAssets.runPosted", {
          code: created.bookCode,
          amount: `${formatMoney(created.totalAmount)} ${created.currency}`,
        }),
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finAssets.runFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function dispose() {
    if (!disposeTarget) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingDisposeAssetBook(token, disposeTarget.id, {
        disposalDate: disposeDate,
        evidenceDocumentId: disposeEvidence.trim(),
        proceeds: disposeProceeds.trim() || null,
        note: null,
        idempotencyKey: newIdempotencyKey(),
      });
      setNotice(t("finAssets.disposed", { code: disposeTarget.bookCode }));
      setDisposeTarget(null);
      setDisposeDate("");
      setDisposeEvidence("");
      setDisposeProceeds("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finAssets.disposeFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function reverseRun() {
    if (!reverseTarget) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingReverseDepreciationRun(token, reverseTarget.id, {
        idempotencyKey: newIdempotencyKey(),
        reason: reverseReason.trim(),
      });
      setNotice(t("finAssets.runReversed"));
      setReverseTarget(null);
      setReverseReason("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finAssets.reverseFailed"));
    } finally {
      setBusy(false);
    }
  }

  const assetLabel = (id: string) => {
    const asset = assets.find((a) => a.id === id);
    return asset ? `${asset.assetNumber} · ${asset.name}` : id;
  };
  const periodLabel = (id: string) => {
    const period = periods.find((p) => p.id === id);
    return period ? `${period.periodCode} ${period.fiscalYearCode}` : id;
  };

  const bookColumns: Column<AccountingAssetBookRecord>[] = [
    {
      header: t("finAssets.asset"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{assetLabel(row.assetId)}</span>,
    },
    { header: t("finAssets.book"), cell: (row) => <Badge>{row.bookCode}</Badge> },
    { header: t("finAssets.assetClass"), cell: (row) => row.assetClass },
    { header: t("finAssets.inService"), className: "tabular-nums", cell: (row) => formatDateShort(row.inServiceDate) },
    {
      header: t("finAssets.cost"),
      className: "text-right tabular-nums whitespace-nowrap",
      mobileRole: "detail",
      cell: (row) => formatMoney(row.acquisitionCost),
    },
    {
      header: t("finAssets.accumulated"),
      className: "text-right tabular-nums whitespace-nowrap",
      cell: (row) => formatMoney(row.accumulatedDepreciation),
    },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) => <StatusPill tone={BOOK_TONES[row.status]}>{t(BOOK_STATUS_KEYS[row.status])}</StatusPill>,
    },
    {
      header: t("fin.common.actions"),
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.status === "draft" ? (
            <Button disabled={busy} onClick={() => void activate(row)}>
              {t("finAssets.activate")}
            </Button>
          ) : null}
          {row.status === "active" ? (
            <Button variant="secondary" disabled={busy} onClick={() => setDisposeTarget(row)}>
              {t("finAssets.dispose")}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const runColumns: Column<AccountingDepreciationRunRecord>[] = [
    {
      header: t("finAssets.book"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{row.bookCode}</span>,
    },
    { header: t("finAcct.period"), cell: (row) => periodLabel(row.periodId) },
    {
      header: t("fin.common.amount"),
      className: "text-right tabular-nums whitespace-nowrap",
      mobileRole: "detail",
      cell: (row) => `${formatMoney(row.totalAmount)} ${row.currency}`,
    },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={row.status === "posted" ? "success" : "neutral"}>
          {t(RUN_STATUS_KEYS[row.status])}
        </StatusPill>
      ),
    },
    {
      header: t("fin.common.actions"),
      cell: (row) =>
        row.status === "posted" ? (
          <Button variant="secondary" disabled={busy} onClick={() => setReverseTarget(row)}>
            {t("finAssets.reverse")}
          </Button>
        ) : (
          <span className="text-ink-faint">{t("fin.common.notAvailable")}</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finAssets.title")} subtitle={t("finAssets.subtitle")} />

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
        <EmptyState title={t("fin.common.chooseLegalEntity")} description={t("finAssets.chooseEntityDesc")} />
      ) : loading ? (
        <Spinner />
      ) : (
        <>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finAssets.newBook")}</h2>
            <p className="mb-3 text-sm text-ink-dim">{t("finAssets.newBookNote")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("finAssets.asset")} required>
                <Select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.assetNumber} · {asset.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("finAssets.ledger")} required>
                <Select value={ledgerId} onChange={(e) => setLedgerId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {ledgers.map((ledger) => (
                    <option key={ledger.id} value={ledger.id}>
                      {ledger.ledgerCode} · {ledger.ledgerName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("finAssets.bookCode")} required hint={t("finAssets.bookCodeHint")}>
                <Input value={bookCode} onChange={(e) => setBookCode(e.target.value)} />
              </Field>
              <Field label={t("finAssets.assetClass")} required>
                <Input
                  value={assetClass}
                  onChange={(e) => setAssetClass(e.target.value)}
                  placeholder={t("finAssets.assetClassPlaceholder")}
                />
              </Field>
              <Field label={t("finAssets.capitalizedOn")} required>
                <Input type="date" value={capitalizationDate} onChange={(e) => setCapitalizationDate(e.target.value)} />
              </Field>
              <Field label={t("finAssets.inServiceOn")} required>
                <Input type="date" value={inServiceDate} onChange={(e) => setInServiceDate(e.target.value)} />
              </Field>
              <Field
                label={t("finAssets.acquisitionCost")}
                required
                hint={
                  acquisitionCost && !isValidAmountInput(acquisitionCost)
                    ? t("finAssets.amountHint")
                    : undefined
                }
              >
                <Input
                  inputMode="decimal"
                  value={acquisitionCost}
                  onChange={(e) => setAcquisitionCost(e.target.value)}
                  placeholder="250000000.00"
                  aria-invalid={acquisitionCost !== "" && !isValidAmountInput(acquisitionCost)}
                />
              </Field>
              <Field label={t("finAssets.residualValue")} hint={t("finAssets.residualHint")}>
                <Input inputMode="decimal" value={residualValue} onChange={(e) => setResidualValue(e.target.value)} />
              </Field>
              <Field label={t("finAssets.usefulLife")} required>
                <Input
                  inputMode="numeric"
                  value={usefulLifeMonths}
                  onChange={(e) => setUsefulLifeMonths(e.target.value)}
                />
              </Field>
              <Field label={t("finAssets.expenseAccount")} required>
                <Select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.accountCode} · {account.accountName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("finAssets.accumulatedAccount")} required>
                <Select value={accumulatedAccountId} onChange={(e) => setAccumulatedAccountId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.accountCode} · {account.accountName}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="mt-3">
              <Button
                disabled={
                  busy ||
                  !assetId ||
                  !ledgerId ||
                  !bookCode.trim() ||
                  // API: usefulLifeMonths is a positive whole number.
                  !/^[1-9]\d*$/.test(usefulLifeMonths.trim()) ||
                  !assetClass.trim() ||
                  !capitalizationDate ||
                  !inServiceDate ||
                  !isValidAmountInput(acquisitionCost) ||
                  !expenseAccountId ||
                  !accumulatedAccountId
                }
                onClick={() => void createBook()}
              >
                {t("finAssets.createBook")}
              </Button>
            </div>
          </Card>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finAssets.books")}</h2>
            <DataTable
              columns={bookColumns}
              rows={books}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finAssets.noBooksTitle")} description={t("finAssets.noBooksDesc")} />}
            />
          </div>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finAssets.runTitle")}</h2>
            <p className="mb-3 text-sm text-ink-dim">{t("finAssets.runNote")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("finAssets.bookCode")} required>
                <Input value={runBookCode} onChange={(e) => setRunBookCode(e.target.value)} />
              </Field>
              <Field label={t("finAcct.period")} required>
                <Select value={runPeriodId} onChange={(e) => setRunPeriodId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {periods.map((period) => (
                    <option key={period.id} value={period.id}>
                      {period.periodName} ({period.periodCode} {period.fiscalYearCode})
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button
                  disabled={busy || !runBookCode.trim() || !runPeriodId || !books.some((b) => b.status === "active")}
                  onClick={() => void runDepreciation()}
                >
                  {t("finAssets.run")}
                </Button>
              </div>
            </div>
            {!books.some((b) => b.status === "active") ? (
              <p className="mt-2 text-xs text-ink-faint">{t("finAssets.nothingActive")}</p>
            ) : null}
          </Card>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finAssets.runs")}</h2>
            <DataTable
              columns={runColumns}
              rows={runs}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finAssets.noRunsTitle")} description={t("finAssets.noRunsDesc")} />}
            />
          </div>

          {disposeTarget ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink">
                {t("finAssets.disposeTitle", { code: disposeTarget.bookCode })}
              </h2>
              <p className="mb-3 text-sm text-ink-dim">{t("finAssets.disposeNote")}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label={t("finAssets.disposalDate")} required>
                  <Input type="date" value={disposeDate} onChange={(e) => setDisposeDate(e.target.value)} />
                </Field>
                <Field label={t("finAssets.evidenceId")} required>
                  <Input
                    value={disposeEvidence}
                    onChange={(e) => setDisposeEvidence(e.target.value)}
                    placeholder="UUID"
                  />
                </Field>
                <Field label={t("finAssets.proceeds")}>
                  <Input
                    inputMode="decimal"
                    value={disposeProceeds}
                    onChange={(e) => setDisposeProceeds(e.target.value)}
                    placeholder="0.00"
                  />
                </Field>
              </div>
              <div className="mt-3 flex gap-2">
                <Button disabled={busy || !disposeDate || !disposeEvidence.trim()} onClick={() => void dispose()}>
                  {t("finAssets.dispose")}
                </Button>
                <Button variant="ghost" onClick={() => setDisposeTarget(null)}>
                  {t("fin.common.cancel")}
                </Button>
              </div>
            </Card>
          ) : null}

          {reverseTarget ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink">
                {t("finAssets.reverseTitle", {
                  code: reverseTarget.bookCode,
                  period: periodLabel(reverseTarget.periodId),
                })}
              </h2>
              <p className="mb-3 text-sm text-ink-dim">{t("finAssets.reverseNote")}</p>
              <Field label={t("finTxDetail.reason")} required>
                <Input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} />
              </Field>
              <div className="mt-3 flex gap-2">
                <Button disabled={busy || reverseReason.trim() === ""} onClick={() => void reverseRun()}>
                  {t("finAssets.reverseRun")}
                </Button>
                <Button variant="ghost" onClick={() => setReverseTarget(null)}>
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