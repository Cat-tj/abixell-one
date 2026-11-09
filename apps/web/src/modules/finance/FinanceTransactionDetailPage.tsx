/**
 * Phase 6 — Transaction detail (FIN-CORE-005/006/008, FIN-CORE-011).
 *
 * One record with its facts, its evidence, its approval decisions, and — if
 * it has already taken effect — the correction control. There is no edit
 * form: an approved money movement is immutable, and the only way to change
 * the outcome is a compensating transaction that goes through the same
 * approval.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type DocumentRecord,
  type FinanceTransactionDetail,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Spinner,
  StatusPill,
} from "../../shell/components/ui";
import { formatDate, formatDateShort, statusTone } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";
import { accountTypeLabel, formatSigned } from "./money";

export function FinanceTransactionDetailPage() {
  const t = useT();
  const { transactionId } = useParams<{ transactionId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [detail, setDetail] = useState<FinanceTransactionDetail | null>(null);
  const [categories, setCategories] = useState<{ code: string; label: string }[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentsBlocked, setDocumentsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [reversalReason, setReversalReason] = useState("");
  const [confirmReversal, setConfirmReversal] = useState(false);

  const load = useCallback(async () => {
    if (!transactionId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.financeTransaction(token, transactionId));
      // Financial evidence needs a dedicated capability — a denial here is
      // expected for users who only hold finance.read.
      try {
        setDocuments(await api.documentsForEntity(token, "finance_transaction", transactionId));
        setDocumentsBlocked(false);
      } catch {
        setDocuments([]);
        setDocumentsBlocked(true);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTxDetail.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, transactionId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api
      .financeCategories(token)
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [token]);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("fin.common.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="error">{error ?? t("finTxDetail.notFound")}</Alert>;

  const { transaction, account, status, availableActions, isApplied } = detail;
  const categoryLabel = categories.find((c) => c.code === transaction.categoryCode)?.label ?? transaction.categoryCode;

  return (
    <div className="space-y-4">
      <PageHeader
        title={transaction.transactionNumber}
        subtitle={categoryLabel}
        actions={
          <StatusPill tone={isApplied ? "success" : "warning"}>
            {isApplied ? t("fin.state.tookEffect") : t("fin.state.awaitingApproval")}
          </StatusPill>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {transaction.reversesTransactionId ? <Alert tone="info">{t("finTxDetail.isCorrection")}</Alert> : null}
      {transaction.reversedByTransactionId ? (
        <Alert tone="info">
          {t("finTxDetail.wasCorrected")}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => navigate(`/finance/transactions/${transaction.reversedByTransactionId}`)}
          >
            {t("finTxDetail.openCorrection")}
          </button>
        </Alert>
      ) : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("finTxDetail.details")}</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-ink-dim">{t("fin.common.amount")}</dt>
            <dd className="text-lg font-semibold tabular-nums text-ink">
              {formatSigned(transaction.amount, transaction.direction, transaction.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-dim">{t("fin.common.date")}</dt>
            <dd className="text-ink">{formatDateShort(transaction.transactionDate)}</dd>
          </div>
          <div>
            <dt className="text-ink-dim">{t("fin.common.account")}</dt>
            <dd className="text-ink">
              {account ? `${account.name} · ${accountTypeLabel(t, account.accountType)}` : t("fin.common.notAvailable")}
            </dd>
          </div>
          <div>
            <dt className="text-ink-dim">{t("fin.common.category")}</dt>
            <dd className="text-ink">{categoryLabel}</dd>
          </div>
          <div>
            <dt className="text-ink-dim">{t("fin.common.reference")}</dt>
            <dd className="text-ink">{transaction.reference ?? t("fin.common.notAvailable")}</dd>
          </div>
          <div>
            <dt className="text-ink-dim">{t("finTxDetail.tookEffectAt")}</dt>
            <dd className="text-ink">
              {transaction.appliedAt ? formatDate(transaction.appliedAt) : t("finTxDetail.notYet")}
            </dd>
          </div>
        </dl>
        {transaction.description ? <p className="mt-3 text-sm text-ink-dim">{transaction.description}</p> : null}
        {account ? (
          <p className="mt-3 text-sm text-ink-dim">
            {t("finTxDetail.balanceNow", { amount: `${account.currency} ${account.balance}` })}
          </p>
        ) : null}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {t("finTxDetail.approval")}{" "}
          {status ? (
            <StatusPill tone={statusTone(status.instanceStatus)}>
              {status.stepName ?? status.instanceStatus}
            </StatusPill>
          ) : null}
        </h2>
        {isApplied ? (
          <p className="text-sm text-ink-dim">{t("finTxDetail.appliedNote")}</p>
        ) : availableActions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {availableActions.map((action) => (
              <Button
                key={action.actionCode}
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api.actOnFinanceTransaction(token, transaction.id, action.actionCode),
                    t("finTxDetail.actionRecorded", { action: action.name }),
                  )
                }
              >
                {action.name}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-dim">{t("finTxDetail.noDecision")}</p>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("finTxDetail.evidence")}</h2>
        {documentsBlocked ? (
          <Alert tone="info">{t("finTxDetail.evidenceBlocked")}</Alert>
        ) : (
          <>
            {documents.length === 0 ? (
              <p className="mb-3 text-sm text-ink-dim">{t("finTxDetail.noEvidence")}</p>
            ) : (
              <ul className="mb-3 space-y-1 text-sm text-ink">
                {documents.map((doc) => (
                  <li key={doc.id}>{doc.fileName}</li>
                ))}
              </ul>
            )}
            <input
              ref={fileInputRef}
              type="file"
              aria-label={t("finTxDetail.attachEvidence")}
              className="block w-full text-sm text-ink-dim file:mr-3 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-2 file:text-sm"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void run(
                    () => api.uploadDocument(token, "finance_transaction", transaction.id, file),
                    t("finTxDetail.evidenceAttached"),
                  );
                }
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
          </>
        )}
      </Card>

      {isApplied && !transaction.reversedByTransactionId ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-ink">{t("finTxDetail.correctTitle")}</h2>
          <p className="mb-3 text-sm text-ink-dim">
            {t("finTxDetail.correctNote", {
              direction: (
                <Badge>
                  {transaction.direction === "income" ? t("fin.money.out") : t("fin.money.in")}
                </Badge>
              ),
            })}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Field label={t("finTxDetail.reason")}>
                <Input
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                  placeholder={t("finTxDetail.reasonPlaceholder")}
                />
              </Field>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 pb-2 text-sm text-ink-dim">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-line"
                  checked={confirmReversal}
                  onChange={(e) => setConfirmReversal(e.target.checked)}
                />
                {t("finTxDetail.confirmCorrection")}
              </label>
            </div>
          </div>
          <div className="mt-3">
            <Button
              disabled={busy}
              onClick={async () => {
                if (!confirmReversal) {
                  setNotice(null);
                  setError(t("common.form.missing", { fields: t("finTxDetail.confirmCorrection") }));
                  return;
                }
                setBusy(true);
                setError(null);
                setNotice(null);
                try {
                  const reversal = await api.reverseFinanceTransaction(token, transaction.id, {
                    reason: reversalReason || null,
                  });
                  navigate(`/finance/transactions/${reversal.transaction.id}`);
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : t("finTxDetail.correctionFailed"));
                } finally {
                  setBusy(false);
                  setConfirmReversal(false);
                }
              }}
            >
              {t("finTxDetail.createCorrection")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
