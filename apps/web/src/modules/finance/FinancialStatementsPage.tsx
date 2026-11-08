/**
 * Wave A6.1 — Financial statements.
 *
 * Read-only. Four things the kernel already holds, side by side: the aging
 * of what is still owed in each direction, the journals and their GL
 * postings, the consolidation groups with their translation runs and
 * eliminations, and the statement line versions those groups report through.
 *
 * Aging is the only view that needs a currency up front, because the kernel
 * buckets by currency rather than converting. The default is the reporting
 * currency of the first consolidation group, falling back to IDR.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingAgingResult,
  type AccountingConsolidationGroupRecord,
  type AccountingEliminationRecord,
  type AccountingFsvVersionRecord,
  type AccountingGlEntryRecord,
  type AccountingJournalRecord,
  type AccountingTranslationRunRecord,
} from "../../lib/api";
import {
  Alert,
  Badge,
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
import { formatDate, formatMoney } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";
import { monthRange } from "./money";

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

export function FinancialStatementsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [side, setSide] = useState<"AR" | "AP">("AR");
  const [asOfDate, setAsOfDate] = useState(() => monthRange().to);
  const [currency, setCurrency] = useState("IDR");

  const [aging, setAging] = useState<AccountingAgingResult | null>(null);
  const [journals, setJournals] = useState<AccountingJournalRecord[]>([]);
  const [glEntries, setGlEntries] = useState<AccountingGlEntryRecord[]>([]);
  const [groups, setGroups] = useState<AccountingConsolidationGroupRecord[]>([]);
  const [runs, setRuns] = useState<AccountingTranslationRunRecord[]>([]);
  const [eliminations, setEliminations] = useState<AccountingEliminationRecord[]>([]);
  const [fsvVersions, setFsvVersions] = useState<AccountingFsvVersionRecord[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agingResult, journalList, glList, groupList, runList, eliminationList, fsvList] = await Promise.all([
        api.accountingAging(token, { side, asOfDate, currency }),
        api.accountingJournals(token),
        api.accountingGlEntries(token),
        api.accountingConsolidationGroups(token),
        api.accountingTranslationRuns(token),
        api.accountingEliminations(token),
        api.accountingFsvVersions(token),
      ]);
      setAging(agingResult);
      setJournals(journalList);
      setGlEntries(glList);
      setGroups(groupList);
      setRuns(runList);
      setEliminations(eliminationList);
      setFsvVersions(fsvList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finStmt.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, side, asOfDate, currency, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const groupName = (groupId: string) => groups.find((g) => g.id === groupId)?.name ?? groupId;

  const agingColumns: Column<AccountingAgingResult["buckets"][number]>[] = [
    {
      header: t("finStmt.bucket"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{row.label}</span>,
    },
    {
      header: t("finStmt.days"),
      className: "tabular-nums",
      cell: (row) =>
        row.toDays === null
          ? t("finStmt.daysFrom", { from: row.fromDays })
          : t("finStmt.daysRange", { from: row.fromDays, to: row.toDays }),
    },
    { header: t("finStmt.items"), className: "text-right tabular-nums", cell: (row) => row.itemCount },
    {
      header: t("fin.common.amount"),
      className: "text-right tabular-nums",
      mobileRole: "status",
      cell: (row) => <span className="font-medium">{formatMoney(row.amount)}</span>,
    },
  ];

  const journalColumns: Column<AccountingJournalRecord>[] = [
    {
      header: t("finStmt.journal"),
      mobileRole: "title",
      cell: (row) => <span className="font-mono text-xs text-ink">{row.journalNumber}</span>,
    },
    { header: t("fin.common.date"), className: "tabular-nums", cell: (row) => formatDate(row.accountingDate) },
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
          <StatusPill tone="success">{t("finStmt.yes")}</StatusPill>
        ) : (
          <StatusPill tone="danger">{t("finStmt.no")}</StatusPill>
        ),
    },
  ];

  const glColumns: Column<AccountingGlEntryRecord>[] = [
    {
      header: t("finStmt.posted"),
      mobileRole: "title",
      className: "tabular-nums",
      cell: (row) => formatDate(row.postingDate),
    },
    {
      header: t("finJournals.debit"),
      className: "text-right tabular-nums",
      cell: (row) => (Number(row.debit) === 0 ? t("fin.common.notAvailable") : formatMoney(row.debit)),
    },
    {
      header: t("finJournals.credit"),
      className: "text-right tabular-nums",
      mobileRole: "status",
      cell: (row) => (Number(row.credit) === 0 ? t("fin.common.notAvailable") : formatMoney(row.credit)),
    },
    {
      header: t("finStmt.document"),
      className: "font-mono text-xs",
      mobileRole: "detail",
      cell: (row) => row.documentType ?? t("fin.common.notAvailable"),
    },
  ];

  const runColumns: Column<AccountingTranslationRunRecord>[] = [
    {
      header: t("finStmt.group"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{groupName(row.groupId)}</span>,
    },
    { header: t("fin.common.currency"), cell: (row) => row.reportingCurrency },
    {
      header: t("finStmt.translated"),
      className: "text-right tabular-nums",
      cell: (row) => formatMoney(row.translatedTotal),
    },
    {
      header: t("finStmt.residual"),
      className: "text-right tabular-nums",
      mobileRole: "status",
      cell: (row) => formatMoney(row.residualAmount),
    },
  ];

  const eliminationColumns: Column<AccountingEliminationRecord>[] = [
    {
      header: t("fin.common.description"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{row.description}</span>,
    },
    { header: t("finStmt.group"), cell: (row) => groupName(row.groupId) },
    {
      header: t("fin.common.amount"),
      className: "text-right tabular-nums",
      mobileRole: "status",
      cell: (row) => formatMoney(row.amount),
    },
    { header: t("fin.common.status"), cell: (row) => <Badge>{row.status}</Badge> },
  ];

  const groupColumns: Column<AccountingConsolidationGroupRecord>[] = [
    {
      header: t("finStmt.group"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{row.name}</span>,
    },
    { header: t("fin.common.code"), className: "font-mono text-xs", cell: (row) => row.groupCode },
    { header: t("fin.common.currency"), cell: (row) => row.reportingCurrency },
    { header: t("fin.common.status"), mobileRole: "status", cell: (row) => <Badge>{row.status}</Badge> },
  ];

  const fsvColumns: Column<AccountingFsvVersionRecord>[] = [
    {
      header: t("finStmt.statement"),
      mobileRole: "title",
      cell: (row) => <span className="font-mono text-xs text-ink">{row.fsvCode}</span>,
    },
    { header: t("finAcct.version"), className: "tabular-nums", cell: (row) => row.versionNumber },
    { header: t("fin.common.from"), className: "tabular-nums", cell: (row) => formatDate(row.effectiveFrom) },
    { header: t("fin.common.status"), mobileRole: "status", cell: (row) => <Badge>{row.status}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finStmt.title")} subtitle={t("finStmt.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("finStmt.side")} required>
            <Select value={side} onChange={(e) => setSide(e.target.value as "AR" | "AP")}>
              <option value="AR">{t("finStmt.sideAr")}</option>
              <option value="AP">{t("finStmt.sideAp")}</option>
            </Select>
          </Field>
          <Field label={t("finStmt.asOf")} required>
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </Field>
          <Field label={t("fin.common.currency")} required>
            <Input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <>
          {aging ? (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-ink">
                {t(aging.side === "AR" ? "finStmt.agingAr" : "finStmt.agingAp", {
                  date: formatDate(aging.asOfDate),
                })}
              </h2>
              <Card className="mb-3">
                <p className="text-xs font-bold text-ink-faint">{t("finStmt.stillOpen")}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {formatMoney(aging.totalOpen)}{" "}
                  <span className="text-sm font-normal text-ink-dim">{aging.currency}</span>
                </p>
              </Card>
              <DataTable
                columns={agingColumns}
                rows={aging.buckets}
                keyOf={(row) => row.label}
                empty={<EmptyState title={t("finStmt.noOpenTitle")} description={t("finStmt.noOpenDesc")} />}
              />
            </div>
          ) : null}

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finJournals.title")}</h2>
            <DataTable
              columns={journalColumns}
              rows={journals}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finStmt.noJournalsTitle")} description={t("finStmt.noJournalsDesc")} />}
            />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finStmt.postedEntries")}</h2>
            <DataTable
              columns={glColumns}
              rows={glEntries}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finStmt.noPostingsTitle")} description={t("finStmt.noPostingsDesc")} />}
            />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finStmt.consolidationGroups")}</h2>
            <DataTable
              columns={groupColumns}
              rows={groups}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finStmt.noGroupsTitle")} description={t("finStmt.noGroupsDesc")} />}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 text-sm font-semibold text-ink">{t("finStmt.translationRuns")}</h2>
              <DataTable
                columns={runColumns}
                rows={runs}
                keyOf={(row) => row.id}
                empty={<EmptyState title={t("finStmt.noRunsTitle")} description={t("finStmt.noRunsDesc")} />}
              />
            </div>
            <div>
              <h2 className="mb-2 text-sm font-semibold text-ink">{t("finStmt.eliminations")}</h2>
              <DataTable
                columns={eliminationColumns}
                rows={eliminations}
                keyOf={(row) => row.id}
                empty={
                  <EmptyState title={t("finStmt.noEliminationsTitle")} description={t("finStmt.noEliminationsDesc")} />
                }
              />
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finStmt.statementVersions")}</h2>
            <DataTable
              columns={fsvColumns}
              rows={fsvVersions}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("finStmt.noVersionsTitle")} description={t("finStmt.noVersionsDesc")} />}
            />
          </div>
        </>
      )}
    </div>
  );
}
