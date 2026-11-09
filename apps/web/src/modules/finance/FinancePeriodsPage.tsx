/**
 * Wave A8 — Period management and closing (FIN-ADV-007).
 *
 * Write surface for the Accounting Kernel's period lifecycle: lock, request reopen,
 * close month-end, close year-end. Also: create ledgers, approve charts, and
 * reverse bank matches. The kernel owns the closing decision; this page asks it
 * to move periods through their lifecycle states.
 *
 * The legal entity is required: all operations are per-entity. Every amount is
 * typed and sent as text. No Number(), no parseFloat.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingBankAccountRecord,
  type AccountingBankMatchRecord,
  type AccountingBankReconciliationRecord,
  type AccountingChartRecord,
  type AccountingCloseAttestation,
  type AccountingLedgerRecord,
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
import { formatDate, formatMoney } from "../../shared/format";
import { useT, type Translate } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";
import { useLegalEntities, newIdempotencyKey } from "./useLegalEntities";

const PERIOD_TONES: Record<AccountingPeriodRecord["status"], "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  open: "info",
  closed: "success",
  reopenable: "warning",
  tombstone: "danger",
};

/** The stored status stays the API's; only the word on screen changes. */
const PERIOD_LABEL_KEYS: Record<AccountingPeriodRecord["status"], MessageKey> = {
  draft: "finAcct.periodDraft",
  open: "finAcct.periodOpen",
  closed: "finAcct.periodClosed",
  reopenable: "finAcct.periodReopenable",
  tombstone: "finAcct.periodTombstone",
};

const ATTESTATIONS: { key: keyof AccountingCloseAttestation; labelKey: MessageKey }[] = [
  { key: "bankReconConfirmed", labelKey: "finPeriods.attestBankRecon" },
  { key: "apArConfirmed", labelKey: "finPeriods.attestApAr" },
  { key: "depreciationConfirmed", labelKey: "finPeriods.attestDepreciation" },
  { key: "accrualsConfirmed", labelKey: "finPeriods.attestAccruals" },
];

const NO_ATTESTATION: AccountingCloseAttestation = {
  bankReconConfirmed: false,
  apArConfirmed: false,
  depreciationConfirmed: false,
  accrualsConfirmed: false,
};

function AttestationChecks({
  t,
  value,
  onChange,
}: {
  t: Translate;
  value: AccountingCloseAttestation;
  onChange: (attest: AccountingCloseAttestation) => void;
}) {
  return (
    <div className="space-y-2">
      {ATTESTATIONS.map((item) => (
        <label key={item.key} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value[item.key]}
            onChange={(e) => onChange({ ...value, [item.key]: e.target.checked })}
            className="cursor-pointer rounded border border-line bg-panel"
          />
          <span className="text-sm text-ink">{t(item.labelKey)}</span>
        </label>
      ))}
    </div>
  );
}

type ModalState =
  | { kind: "none" }
  | { kind: "lock"; period: AccountingPeriodRecord }
  | { kind: "reopen"; period: AccountingPeriodRecord }
  | { kind: "close-month"; period: AccountingPeriodRecord }
  | { kind: "close-year"; period: AccountingPeriodRecord }
  | { kind: "create-ledger" }
  | { kind: "approve-chart" }
  | { kind: "reverse-bank-match" };

export function FinancePeriodsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { entities, legalEntityId, setLegalEntityId } = useLegalEntities(token);

  const [periods, setPeriods] = useState<AccountingPeriodRecord[]>([]);
  const [charts, setCharts] = useState<AccountingChartRecord[]>([]);
  const [ledgers, setLedgers] = useState<AccountingLedgerRecord[]>([]);
  const [bankAccounts, setBankAccounts] = useState<AccountingBankAccountRecord[]>([]);
  const [bankReconciliations, setBankReconciliations] = useState<AccountingBankReconciliationRecord[]>([]);
  const [bankMatches, setBankMatches] = useState<AccountingBankMatchRecord[]>([]);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  // Validation message shown inside the open form (the page-level alert sits far above it).
  const [formMsg, setFormMsg] = useState<string | null>(null);
  useEffect(() => {
    setFormMsg(null);
  }, [modal.kind]);

  function formProblem(kind: "missing" | "invalid", fields: Array<string | null>): boolean {
    const list = fields.filter((x): x is string => x !== null);
    if (list.length === 0) return false;
    setNotice(null);
    setError(null);
    setFormMsg(t(kind === "missing" ? "common.form.missing" : "common.form.invalid", { fields: list.join(", ") }));
    return true;
  }

  // Lock modal state
  const [lockReason, setLockReason] = useState("");

  // Reopen modal state
  const [reopenReason, setReopenReason] = useState("");
  const [reopenImpactEvidence, setReopenImpactEvidence] = useState("");

  // Close month-end/year-end modal state
  const [closeAttestation, setCloseAttestation] = useState<AccountingCloseAttestation>(NO_ATTESTATION);

  // Create ledger modal state
  const [ledgerCode, setLedgerCode] = useState("");
  const [ledgerName, setLedgerName] = useState("");
  const [ledgerCurrency, setLedgerCurrency] = useState("IDR");

  // Approve chart modal state
  const [selectedChartId, setSelectedChartId] = useState("");

  // Reverse bank match modal state
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [selectedReconciliationId, setSelectedReconciliationId] = useState("");
  const [selectedMatchId, setSelectedMatchId] = useState("");
  const [matchNote, setMatchNote] = useState("");

  const load = useCallback(async () => {
    if (!legalEntityId) {
      setPeriods([]);
      setCharts([]);
      setLedgers([]);
      setBankAccounts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [periodList, chartList, ledgerList, accountList] = await Promise.all([
        api.accountingPeriods(token, { legalEntityId }),
        api.accountingCharts(token, { legalEntityId }),
        api.accountingLedgers(token, legalEntityId),
        api.accountingBankAccounts(token, { legalEntityId }),
      ]);
      setPeriods(periodList);
      setCharts(chartList);
      setLedgers(ledgerList);
      setBankAccounts(accountList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, legalEntityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load reconciliations when a bank account is selected
  useEffect(() => {
    if (modal.kind === "reverse-bank-match" && selectedBankAccountId) {
      void (async () => {
        try {
          const recs = await api.accountingBankReconciliations(token, { bankAccountId: selectedBankAccountId });
          setBankReconciliations(recs);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : t("finPeriods.reconsFailed"));
        }
      })();
    }
  }, [modal.kind, selectedBankAccountId, token, t]);

  // Load matches when a reconciliation is selected
  useEffect(() => {
    if (modal.kind === "reverse-bank-match" && selectedReconciliationId) {
      void (async () => {
        try {
          const matches = await api.accountingBankMatches(token, selectedReconciliationId);
          setBankMatches(matches);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : t("finPeriods.matchesFailed"));
        }
      })();
    }
  }, [modal.kind, selectedReconciliationId, token, t]);

  async function lockPeriod(period: AccountingPeriodRecord) {
    if (formProblem("missing", [lockReason.trim() === "" ? t("finTxDetail.reason") : null])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingLockPeriod(token, period.id, { reason: lockReason.trim() });
      setNotice(t("finPeriods.locked", { period: period.periodName }));
      setLockReason("");
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.lockFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function requestReopen(period: AccountingPeriodRecord) {
    if (
      formProblem("missing", [
        reopenReason.trim() === "" ? t("finTxDetail.reason") : null,
        reopenImpactEvidence.trim() === "" ? t("finPeriods.impactEvidence") : null,
      ])
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingRequestReopen(token, period.id, {
        reason: reopenReason.trim(),
        impactEvidence: reopenImpactEvidence.trim(),
      });
      setNotice(t("finPeriods.reopenRequested", { period: period.periodName }));
      setReopenReason("");
      setReopenImpactEvidence("");
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.reopenFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function closeMonthEnd(period: AccountingPeriodRecord) {
    if (formProblem("missing", ATTESTATIONS.filter((item) => !closeAttestation[item.key]).map((item) => t(item.labelKey)))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const closing = await api.accountingCloseMonthEnd(token, period.id, closeAttestation);
      setNotice(t("finPeriods.monthClosed", { period: period.periodName, date: formatDate(closing.closedAt) }));
      setCloseAttestation(NO_ATTESTATION);
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.closeMonthFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function closeYearEnd(period: AccountingPeriodRecord) {
    if (formProblem("missing", ATTESTATIONS.filter((item) => !closeAttestation[item.key]).map((item) => t(item.labelKey)))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const closing = await api.accountingCloseYearEnd(token, period.id, closeAttestation);
      setNotice(t("finPeriods.yearClosed", { period: period.periodName, date: formatDate(closing.closedAt) }));
      setCloseAttestation(NO_ATTESTATION);
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.closeYearFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createLedger() {
    if (
      formProblem("missing", [
        ledgerCode.trim() === "" ? t("finPeriods.ledgerCode") : null,
        ledgerName.trim() === "" ? t("finPeriods.ledgerName") : null,
        ledgerCurrency.trim() === "" ? t("fin.common.currency") : null,
      ])
    ) {
      return;
    }
    if (formProblem("invalid", [ledgerCurrency.trim().length !== 3 ? t("fin.common.currency") : null])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const ledger = await api.accountingCreateLedger(token, {
        legalEntityId,
        ledgerCode: ledgerCode.trim(),
        ledgerName: ledgerName.trim(),
        currency: ledgerCurrency.trim().toUpperCase(),
      });
      setNotice(t("finPeriods.ledgerCreated", { code: ledger.ledgerCode }));
      setLedgerCode("");
      setLedgerName("");
      setLedgerCurrency("IDR");
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.ledgerFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function approveChart() {
    if (formProblem("missing", [selectedChartId === "" ? t("finPeriods.chart") : null])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const chart = await api.accountingApproveChart(token, selectedChartId);
      setNotice(t("finPeriods.chartApproved", { code: chart.coaVersionCode }));
      setSelectedChartId("");
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.approveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function reverseBankMatch() {
    if (
      formProblem("missing", [
        selectedBankAccountId === "" ? t("finPeriods.bankAccount") : null,
        selectedReconciliationId === "" ? t("finPeriods.reconciliation") : null,
        selectedMatchId === "" ? t("finPeriods.match") : null,
      ])
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const match = await api.accountingReverseBankMatch(token, selectedMatchId, {
        idempotencyKey: newIdempotencyKey(),
        note: matchNote.trim() || null,
      });
      setNotice(t("finPeriods.matchReversed", { id: match.id }));
      setMatchNote("");
      setSelectedBankAccountId("");
      setSelectedReconciliationId("");
      setSelectedMatchId("");
      setBankMatches([]);
      setBankReconciliations([]);
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finPeriods.reverseFailed"));
    } finally {
      setBusy(false);
    }
  }

  const periodColumns: Column<AccountingPeriodRecord>[] = [
    {
      header: t("finAcct.period"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{row.periodName}</span>,
    },
    { header: t("finAcct.year"), cell: (row) => row.fiscalYearCode },
    { header: t("fin.common.type"), cell: (row) => <Badge>{row.periodType}</Badge> },
    { header: t("fin.common.from"), className: "tabular-nums", cell: (row) => formatDate(row.dateFrom) },
    { header: t("fin.common.to"), className: "tabular-nums", cell: (row) => formatDate(row.dateTo) },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) => <StatusPill tone={PERIOD_TONES[row.status]}>{t(PERIOD_LABEL_KEYS[row.status])}</StatusPill>,
    },
    {
      header: t("fin.common.actions"),
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.status === "open" ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setModal({ kind: "lock", period: row });
                setLockReason("");
              }}
            >
              {t("finPeriods.lock")}
            </Button>
          ) : null}
          {row.status === "reopenable" ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setModal({ kind: "reopen", period: row });
                setReopenReason("");
                setReopenImpactEvidence("");
              }}
            >
              {t("finPeriods.requestReopen")}
            </Button>
          ) : null}
          {row.status === "open" ? (
            <>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setModal({ kind: "close-month", period: row });
                  setCloseAttestation(NO_ATTESTATION);
                }}
              >
                {t("finPeriods.closeMonth")}
              </Button>
              {row.periodType === "annual" ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setModal({ kind: "close-year", period: row });
                    setCloseAttestation(NO_ATTESTATION);
                  }}
                >
                  {t("finPeriods.closeYear")}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ),
    },
  ];

  const chartColumns: Column<AccountingChartRecord>[] = [
    {
      header: t("finAcct.version"),
      mobileRole: "title",
      cell: (row) => <span className="font-mono text-xs text-ink">{row.coaVersionCode}</span>,
    },
    { header: t("fin.common.date"), className: "tabular-nums", cell: (row) => formatDate(row.coaVersionDate) },
    {
      header: t("finAcct.template"),
      cell: (row) => (row.templateType ? <Badge>{row.templateType}</Badge> : t("finAcct.custom")),
    },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) =>
        row.coaStatus === "approved" ? (
          <StatusPill tone="success">{t("finAcct.approved")}</StatusPill>
        ) : (
          <StatusPill tone="warning">{t("finAcct.periodDraft")}</StatusPill>
        ),
    },
  ];

  const draftCharts = charts.filter((c) => c.coaStatus === "draft");

  return (
    <div className="space-y-4">
      <PageHeader title={t("finPeriods.title")} subtitle={t("finPeriods.subtitle")} />

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
        <EmptyState title={t("fin.common.chooseLegalEntity")} description={t("finPeriods.chooseEntityDesc")} />
      ) : loading ? (
        <Spinner />
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finAcct.periods")}</h2>
            <DataTable
              columns={periodColumns}
              rows={periods}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finAcct.noPeriodsTitle")} description={t("finPeriods.noPeriodsDesc")} />}
            />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finAcct.ledgers")}</h2>
            <div className="mb-3 flex gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setModal({ kind: "create-ledger" });
                  setLedgerCode("");
                  setLedgerName("");
                  setLedgerCurrency("IDR");
                }}
              >
                {t("finPeriods.createLedger")}
              </Button>
            </div>
            {ledgers.length === 0 ? (
              <EmptyState title={t("finPeriods.noLedgersTitle")} description={t("finPeriods.noLedgersDesc")} />
            ) : (
              <Card>
                <div className="space-y-2">
                  {ledgers.map((ledger) => (
                    <div key={ledger.id} className="flex items-center justify-between border-b border-line pb-2 last:border-b-0">
                      <div>
                        <p className="font-medium text-ink">{ledger.ledgerName}</p>
                        <p className="text-xs text-ink-faint">
                          {ledger.ledgerCode} {t("finPeriods.inCurrency", { currency: ledger.currency })}
                          {ledger.isPrimary && ` (${t("finAcct.primary")})`}
                        </p>
                      </div>
                      {ledger.isActive ? (
                        <StatusPill tone="success">{t("fin.state.active")}</StatusPill>
                      ) : (
                        <StatusPill>{t("fin.state.inactive")}</StatusPill>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finAcct.chartVersions")}</h2>
            <div className="mb-3 flex gap-2">
              <Button
                variant="secondary"
                disabled={busy || draftCharts.length === 0}
                title={draftCharts.length === 0 ? t("finPeriods.noDraftCharts") : undefined}
                onClick={() => {
                  setModal({ kind: "approve-chart" });
                  setSelectedChartId("");
                }}
              >
                {t("finPeriods.approveChart")}
              </Button>
            </div>
            {charts.length === 0 ? (
              <EmptyState title={t("finAcct.noChartTitle")} description={t("finPeriods.noChartsDesc")} />
            ) : (
              <DataTable
                columns={chartColumns}
                rows={charts}
                keyOf={(row) => row.id}
                empty={<EmptyState title={t("finAcct.noChartTitle")} description={t("finAcct.noChartDesc")} />}
              />
            )}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finPeriods.bankRecon")}</h2>
            <div className="mb-3 flex gap-2">
              <Button
                variant="secondary"
                disabled={busy || bankAccounts.length === 0}
                onClick={() => {
                  setModal({ kind: "reverse-bank-match" });
                  setSelectedBankAccountId("");
                  setSelectedReconciliationId("");
                  setSelectedMatchId("");
                  setMatchNote("");
                  setBankReconciliations([]);
                  setBankMatches([]);
                }}
              >
                {t("finPeriods.reverseMatch")}
              </Button>
            </div>
            {bankAccounts.length === 0 ? (
              <EmptyState title={t("finPeriods.noBankAccountsTitle")} description={t("finPeriods.noBankAccountsDesc")} />
            ) : (
              <Card>
                <div className="space-y-2">
                  {bankAccounts.map((account) => (
                    <div key={account.id} className="border-b border-line pb-2 last:border-b-0">
                      <p className="font-medium text-ink">{account.name}</p>
                      <p className="text-xs text-ink-faint">
                        {t("finPeriods.bankAccountLine", {
                          bank: account.bankName ?? t("common.notAvailable"),
                          number: account.accountNumberMasked,
                          currency: account.currency,
                        })}
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </>
      )}

      {modal.kind === "lock" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {t("finPeriods.lockTitle", { period: modal.period.periodName })}
          </h2>
          <p className="mb-3 text-sm text-ink-dim">{t("finPeriods.lockNote")}</p>
          <Field label={t("finTxDetail.reason")} required>
            <Input
              value={lockReason}
              onChange={(e) => setLockReason(e.target.value)}
              placeholder={t("finPeriods.lockReasonPlaceholder")}
            />
          </Field>
          {formMsg ? (
            <div className="mt-3">
              <Alert tone="error">{formMsg}</Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void lockPeriod(modal.period)}>
              {t("finPeriods.lock")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("fin.common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "reopen" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {t("finPeriods.reopenTitle", { period: modal.period.periodName })}
          </h2>
          <p className="mb-3 text-sm text-ink-dim">{t("finPeriods.reopenNote")}</p>
          <Field label={t("finTxDetail.reason")} required>
            <Input
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder={t("finPeriods.reopenReasonPlaceholder")}
            />
          </Field>
          <Field label={t("finPeriods.impactEvidence")} required>
            <Textarea
              rows={3}
              value={reopenImpactEvidence}
              onChange={(e) => setReopenImpactEvidence(e.target.value)}
              placeholder={t("finPeriods.impactPlaceholder")}
            />
          </Field>
          {formMsg ? (
            <div className="mt-3">
              <Alert tone="error">{formMsg}</Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void requestReopen(modal.period)}>
              {t("finPeriods.submitRequest")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("fin.common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "close-month" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {t("finPeriods.closeMonthTitle", { period: modal.period.periodName })}
          </h2>
          <p className="mb-3 text-sm text-ink-dim">{t("finPeriods.closeMonthNote")}</p>
          <AttestationChecks t={t} value={closeAttestation} onChange={setCloseAttestation} />
          {formMsg ? (
            <div className="mt-3">
              <Alert tone="error">{formMsg}</Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void closeMonthEnd(modal.period)}>
              {t("finPeriods.confirmClose")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("fin.common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "close-year" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {t("finPeriods.closeYearTitle", { period: modal.period.periodName })}
          </h2>
          <p className="mb-3 text-sm text-ink-dim">{t("finPeriods.closeYearNote")}</p>
          <AttestationChecks t={t} value={closeAttestation} onChange={setCloseAttestation} />
          {formMsg ? (
            <div className="mt-3">
              <Alert tone="error">{formMsg}</Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void closeYearEnd(modal.period)}>
              {t("finPeriods.confirmClose")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("fin.common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "create-ledger" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("finPeriods.createLedger")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("finPeriods.ledgerCode")} required>
              <Input value={ledgerCode} onChange={(e) => setLedgerCode(e.target.value)} placeholder={t("common.form.example", { value: "GL-PRIMARY" })} />
            </Field>
            <Field label={t("finPeriods.ledgerName")} required>
              <Input
                value={ledgerName}
                onChange={(e) => setLedgerName(e.target.value)}
                placeholder={t("finPeriods.ledgerNamePlaceholder")}
              />
            </Field>
            <Field label={t("fin.common.currency")} required>
              <Input
                value={ledgerCurrency}
                onChange={(e) => setLedgerCurrency(e.target.value.toUpperCase())}
                maxLength={3}
              />
            </Field>
          </div>
          {formMsg ? (
            <div className="mt-3">
              <Alert tone="error">{formMsg}</Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void createLedger()}>
              {t("finPeriods.createLedger")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("fin.common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "approve-chart" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("finPeriods.approveChartTitle")}</h2>
          <Field label={t("finPeriods.chart")} required>
            <Select value={selectedChartId} onChange={(e) => setSelectedChartId(e.target.value)}>
              <option value="">{t("finPeriods.selectDraftChart")}</option>
              {draftCharts.map((chart) => (
                <option key={chart.id} value={chart.id}>
                  {t("finPeriods.chartOption", {
                    code: chart.coaVersionCode,
                    date: formatDate(chart.coaVersionDate),
                  })}
                </option>
              ))}
            </Select>
          </Field>
          {formMsg ? (
            <div className="mt-3">
              <Alert tone="error">{formMsg}</Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void approveChart()}>
              {t("finPeriods.approveChart")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("fin.common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "reverse-bank-match" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("finPeriods.reverseMatch")}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("finPeriods.bankAccount")} required>
              <Select
                value={selectedBankAccountId}
                onChange={(e) => {
                  setSelectedBankAccountId(e.target.value);
                  setSelectedReconciliationId("");
                  setSelectedMatchId("");
                  setBankMatches([]);
                }}
              >
                <option value="">{t("finPeriods.selectBankAccount")}</option>
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("finPeriods.reconciliation")} required>
              <Select
                value={selectedReconciliationId}
                onChange={(e) => {
                  setSelectedReconciliationId(e.target.value);
                  setSelectedMatchId("");
                  setBankMatches([]);
                }}
              >
                <option value="">{t("finPeriods.selectReconciliation")}</option>
                {bankReconciliations.map((recon) => (
                  <option key={recon.id} value={recon.id}>
                    {t("finPeriods.reconOption", {
                      status: recon.status,
                      date: recon.closedAt ? formatDate(recon.closedAt) : t("finPeriods.open"),
                    })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("finPeriods.match")} required>
              <Select value={selectedMatchId} onChange={(e) => setSelectedMatchId(e.target.value)}>
                <option value="">{t("finPeriods.selectMatch")}</option>
                {bankMatches.map((match) => (
                  <option key={match.id} value={match.id}>
                    {formatMoney(match.amount)} ({match.matchKind})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t("finPeriods.noteOptional")}>
            <Textarea
              rows={2}
              value={matchNote}
              onChange={(e) => setMatchNote(e.target.value)}
              placeholder={t("finPeriods.reverseReasonPlaceholder")}
            />
          </Field>
          {formMsg ? (
            <div className="mt-3">
              <Alert tone="error">{formMsg}</Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => void reverseBankMatch()}>
              {t("finPeriods.reverseMatch")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("fin.common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}