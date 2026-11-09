/**
 * Wave A6.3 — Budgeting and budget control (FIN-ADV-003).
 *
 * A budget is a baseline you measure against, not a spending limit the system
 * enforces on its own. Three things happen here:
 *
 *   1. a budget is created for one legal entity and fiscal year;
 *   2. a draft version is filled in — one total, spread across periods by
 *      weight, which the service turns into period lines;
 *   3. the version goes through its approval, and once approved it becomes the
 *      active baseline. Consumptions are then recorded against it.
 *
 * The page never decides whether a spend is allowed. `accountingConsumeBudget`
 * returns the kernel's decision; the utilization table shows what the kernel
 * reports. Weights and amounts are 4 decimals, sent as text.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingBudgetRecord,
  type AccountingBudgetUtilization,
  type AccountingBudgetVersionRecord,
} from "../../lib/api";
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
import { formatMoney } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/t";
import { isValidAmount4Input } from "./money";
import { newIdempotencyKey, useLegalEntities } from "./useLegalEntities";

const VERSION_TONES: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  draft: "warning",
  active: "success",
  superseded: "neutral",
  rejected: "danger",
};

/** The stored status stays the API's; only the word on screen is translated. */
const VERSION_STATUS_KEYS: Record<string, MessageKey> = {
  draft: "finBudget.statusDraft",
  active: "finBudget.statusActive",
  superseded: "finBudget.statusSuperseded",
  rejected: "finBudget.statusRejected",
};

const CONSUME_KIND_KEYS: Record<"actual" | "commitment" | "adjustment" | "release", MessageKey> = {
  actual: "finBudget.consumeActual",
  commitment: "finBudget.consumeCommitment",
  adjustment: "finBudget.consumeAdjustment",
  release: "finBudget.consumeRelease",
};

type DraftWeight = { periodCode: string; weight: string };

const EMPTY_WEIGHT: DraftWeight = { periodCode: "", weight: "" };

export function FinanceBudgetsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { entities, legalEntityId, setLegalEntityId } = useLegalEntities(token);

  const [budgets, setBudgets] = useState<AccountingBudgetRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [versions, setVersions] = useState<AccountingBudgetVersionRecord[]>([]);
  const [utilization, setUtilization] = useState<AccountingBudgetUtilization | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [fiscalYearCode, setFiscalYearCode] = useState(String(new Date().getFullYear()));
  const [scenario, setScenario] = useState<"original" | "revision" | "forecast">("original");
  const [currency, setCurrency] = useState("IDR");
  const [name, setName] = useState("");

  const [totalAmount, setTotalAmount] = useState("");
  const [weights, setWeights] = useState<DraftWeight[]>([{ ...EMPTY_WEIGHT }]);
  const [note, setNote] = useState("");

  const [consumePeriod, setConsumePeriod] = useState("");
  const [consumeAmount, setConsumeAmount] = useState("");
  const [consumeKind, setConsumeKind] = useState<"actual" | "commitment" | "adjustment" | "release">("actual");
  const [consumeNote, setConsumeNote] = useState("");

  const load = useCallback(async () => {
    if (!legalEntityId) {
      setBudgets([]);
      setSelectedId("");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await api.accountingBudgets(token, { legalEntityId });
      setBudgets(list);
      setSelectedId((current) => (list.some((b) => b.id === current) ? current : list[0]?.id ?? ""));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finBudget.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, legalEntityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) {
      setVersions([]);
      setUtilization(null);
      return;
    }
    try {
      const [versionList, util] = await Promise.all([
        api.accountingBudgetVersions(token, selectedId).catch(() => []),
        api.accountingBudgetUtilization(token, selectedId).catch(() => null),
      ]);
      setVersions(versionList);
      setUtilization(util);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finBudget.detailLoadFailed"));
    }
  }, [token, selectedId, t]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const selectedBudget = budgets.find((b) => b.id === selectedId) ?? null;

  function formError(kind: "missing" | "invalid", fields: Array<string | null>): boolean {
    const list = fields.filter((x): x is string => x !== null);
    if (list.length === 0) return false;
    setNotice(null);
    setError(t(kind === "missing" ? "common.form.missing" : "common.form.invalid", { fields: list.join(", ") }));
    return true;
  }

  // A comma is accepted as the decimal separator ("12,5" -> "12.5").
  const decimal = (v: string) => v.trim().replace(",", ".");

  async function createBudget() {
    if (
      formError("missing", [
        !legalEntityId ? t("fin.common.legalEntity") : null,
        fiscalYearCode.trim() === "" ? t("finBudget.fiscalYear") : null,
        !name.trim() ? t("fin.common.name") : null,
        currency.trim() === "" ? t("fin.common.currency") : null,
      ])
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingCreateBudget(token, {
        legalEntityId,
        fiscalYearCode: fiscalYearCode.trim(),
        scenario,
        currency,
        name: name.trim(),
      });
      setNotice(t("finBudget.created", { name: created.name, year: created.fiscalYearCode }));
      setName("");
      await load();
      setSelectedId(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finBudget.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createVersion() {
    if (!selectedBudget) return;
    if (
      formError("missing", [
        totalAmount.trim() === "" ? t("finBudget.totalAmount") : null,
        !weights.some((w) => w.periodCode.trim() && w.weight.trim())
          ? t("finBudget.periodWeights")
          : null,
      ])
    ) {
      return;
    }
    if (
      formError("invalid", [
        !isValidAmount4Input(decimal(totalAmount)) ? t("finBudget.totalAmount") : null,
        weights.some(
          (w) => (w.periodCode.trim() || w.weight.trim()) && !(w.periodCode.trim() && isValidAmount4Input(decimal(w.weight))),
        )
          ? t("finBudget.periodWeights")
          : null,
      ])
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingCreateBudgetVersion(token, selectedBudget.id, {
        // Verbatim text at 4 decimals, both the total and every weight.
        totalAmount: decimal(totalAmount),
        weights: weights
          .filter((w) => w.periodCode.trim() && isValidAmount4Input(decimal(w.weight)))
          .map((w) => ({ periodCode: w.periodCode.trim(), weight: decimal(w.weight) })),
        note: note.trim() || null,
      });
      setNotice(t("finBudget.versionDrafted", { version: created.versionNumber }));
      setTotalAmount("");
      setNote("");
      setWeights([{ ...EMPTY_WEIGHT }]);
      await loadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finBudget.versionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function act(version: AccountingBudgetVersionRecord, actionCode: "approve" | "reject") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.accountingBudgetAction(token, version.id, {
        actionCode,
        comment: null,
      });
      setNotice(
        t(actionCode === "approve" ? "finBudget.approved" : "finBudget.rejected", {
          version: updated.versionNumber,
        }),
      );
      await loadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finBudget.decisionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function consume() {
    if (!selectedBudget) return;
    if (
      formError("missing", [
        consumePeriod.trim() === "" ? t("finBudget.period") : null,
        consumeAmount.trim() === "" ? t("fin.common.amount") : null,
      ])
    ) {
      return;
    }
    if (formError("invalid", [!isValidAmount4Input(decimal(consumeAmount)) ? t("fin.common.amount") : null])) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.accountingConsumeBudget(token, {
        budgetId: selectedBudget.id,
        periodCode: consumePeriod.trim(),
        amount: decimal(consumeAmount),
        kind: consumeKind,
        idempotencyKey: newIdempotencyKey(),
        note: consumeNote.trim() || null,
      });
      setNotice(
        t("finBudget.consumed", {
          kind: result.kind,
          amount: formatMoney(result.amount),
          period: result.periodCode,
        }),
      );
      setConsumeAmount("");
      setConsumeNote("");
      await loadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finBudget.consumeFailed"));
    } finally {
      setBusy(false);
    }
  }

  const draftVersions = versions.filter((v) => v.status === "draft");
  const activeVersion = versions.find((v) => v.status === "active") ?? null;

  const versionColumns: Column<AccountingBudgetVersionRecord>[] = [
    {
      header: t("finBudget.version"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">v{row.versionNumber}</span>,
    },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={VERSION_TONES[row.status] ?? "neutral"}>
          {t(VERSION_STATUS_KEYS[row.status] ?? "fin.common.notAvailable")}
        </StatusPill>
      ),
    },
    { header: t("finBudget.note"), mobileRole: "detail", cell: (row) => row.note ?? t("fin.common.notAvailable") },
    {
      header: t("fin.common.actions"),
      cell: (row) =>
        row.status === "draft" ? (
          <div className="flex flex-wrap gap-1">
            <Button disabled={busy} onClick={() => void act(row, "approve")}>
              {t("finBudget.approve")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void act(row, "reject")}>
              {t("finBudget.reject")}
            </Button>
          </div>
        ) : (
          <span className="text-ink-faint">{t("fin.common.notAvailable")}</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finBudget.title")} subtitle={t("finBudget.subtitle")} />

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
          <Field label={t("finBudget.fiscalYear")} required>
            <Input value={fiscalYearCode} onChange={(e) => setFiscalYearCode(e.target.value)} placeholder={t("common.form.example", { value: "2026" })} />
          </Field>
          <Field label={t("finBudget.scenario")} required>
            <Select value={scenario} onChange={(e) => setScenario(e.target.value as typeof scenario)}>
              <option value="original">{t("finBudget.scenarioOriginal")}</option>
              <option value="revision">{t("finBudget.scenarioRevision")}</option>
              <option value="forecast">{t("finBudget.scenarioForecast")}</option>
            </Select>
          </Field>
          <Field label={t("fin.common.name")} required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("finBudget.namePlaceholder")}
            />
          </Field>
          <Field label={t("fin.common.currency")} required>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </Field>
        </div>
        <div className="mt-3">
          <Button
            disabled={busy}
            onClick={() => void createBudget()}
          >
            {t("finBudget.createBudget")}
          </Button>
        </div>
      </Card>

      {!legalEntityId ? null : loading ? (
        <Spinner />
      ) : budgets.length === 0 ? (
        <EmptyState title={t("finBudget.noBudgetsTitle")} description={t("finBudget.noBudgetsDesc")} />
      ) : (
        <>
          <Card>
            <Field label={t("finBudget.budget")} required>
              <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                {budgets.map((budget) => (
                  <option key={budget.id} value={budget.id}>
                    {budget.name} · {budget.fiscalYearCode} ({budget.scenario})
                  </option>
                ))}
              </Select>
            </Field>
            <p className="mt-2 text-sm text-ink-dim">
              {selectedBudget
                ? activeVersion
                  ? t("finBudget.activeBaseline", { version: activeVersion.versionNumber })
                  : t("finBudget.noActiveVersion")
                : null}
            </p>
          </Card>

          {selectedBudget ? (
            <>
              <Card>
                <h2 className="mb-3 text-sm font-semibold text-ink">{t("finBudget.draftTitle")}</h2>
                <p className="mb-3 text-sm text-ink-dim">{t("finBudget.draftNote")}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label={t("finBudget.totalAmount")}
                    required
                    hint={totalAmount && !isValidAmount4Input(decimal(totalAmount)) ? t("finBudget.amountHint") : undefined}
                  >
                    <Input
                      inputMode="decimal"
                      value={totalAmount}
                      onChange={(e) => setTotalAmount(e.target.value)}
                      placeholder={t("common.form.example", { value: "1200000000.0000" })}
                      aria-invalid={totalAmount !== "" && !isValidAmount4Input(decimal(totalAmount))}
                    />
                  </Field>
                  <Field label={t("finBudget.note")}>
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={t("finBudget.notePlaceholder")}
                    />
                  </Field>
                </div>

                <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">{t("finBudget.periodWeights")}</h3>
                <div className="space-y-2">
                  {weights.map((weight, index) => (
                    <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                      <div className="sm:col-span-4">
                        <Input
                          aria-label={t("finBudget.periodCodeFor", { n: index + 1 })}
                          placeholder={t("common.form.example", { value: "2026-01" })}
                          value={weight.periodCode}
                          onChange={(e) =>
                            setWeights((current) =>
                              current.map((w, i) => (i === index ? { ...w, periodCode: e.target.value } : w)),
                            )
                          }
                        />
                      </div>
                      <div className="sm:col-span-4">
                        <Input
                          aria-label={t("finBudget.weightFor", { n: index + 1 })}
                          inputMode="decimal"
                          placeholder={t("common.form.example", { value: "1.0000" })}
                          value={weight.weight}
                          onChange={(e) =>
                            setWeights((current) =>
                              current.map((w, i) => (i === index ? { ...w, weight: e.target.value } : w)),
                            )
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setWeights((current) => [...current, { ...EMPTY_WEIGHT }])}>
                    {t("finBudget.addPeriod")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void createVersion()}
                  >
                    {t("finBudget.draftVersion")}
                  </Button>
                </div>
              </Card>

              <div>
                <h2 className="mb-2 text-sm font-semibold text-ink">{t("finBudget.versions")}</h2>
                <DataTable
                  columns={versionColumns}
                  rows={versions}
                  keyOf={(row) => row.id}
                  empty={<EmptyState title={t("finBudget.noVersionsTitle")} description={t("finBudget.noVersionsDesc")} />}
                />
                {draftVersions.length > 0 ? (
                  <p className="mt-2 text-xs text-ink-faint">{t("finBudget.approvalNote")}</p>
                ) : null}
              </div>

              {utilization ? (
                <Card>
                  <h2 className="mb-3 text-sm font-semibold text-ink">{t("finBudget.utilization")}</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-line text-left text-xs text-ink-faint">
                          <th className="py-2 pr-3">{t("finBudget.period")}</th>
                          <th className="py-2 pr-3 text-right">{t("finBudget.baseline")}</th>
                          <th className="py-2 pr-3 text-right">{t("finBudget.actual")}</th>
                          <th className="py-2 pr-3 text-right">{t("finBudget.committed")}</th>
                          <th className="py-2 pr-3 text-right">{t("finBudget.available")}</th>
                          <th className="py-2 text-right">{t("finBudget.variance")}</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {utilization.periods.map((period) => (
                          <tr key={period.periodCode} className="border-b border-line/60">
                            <td className="py-2 pr-3">{period.periodCode}</td>
                            <td className="py-2 pr-3 text-right">{formatMoney(period.baseline)}</td>
                            <td className="py-2 pr-3 text-right">{formatMoney(period.actual)}</td>
                            <td className="py-2 pr-3 text-right">{formatMoney(period.committed)}</td>
                            <td className="py-2 pr-3 text-right">{formatMoney(period.available)}</td>
                            <td className="py-2 text-right">{formatMoney(period.variance)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="font-medium">
                          <td className="py-2 pr-3">{t("finBudget.total")}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(utilization.total.baseline)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(utilization.total.actual)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(utilization.total.committed)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(utilization.total.available)}</td>
                          <td className="py-2 text-right tabular-nums">{formatMoney(utilization.total.variance)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </Card>
              ) : null}

              <Card>
                <h2 className="mb-3 text-sm font-semibold text-ink">{t("finBudget.recordSpending")}</h2>
                <p className="mb-3 text-sm text-ink-dim">{t("finBudget.spendingNote")}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label={t("finBudget.period")} required>
                    <Input
                      value={consumePeriod}
                      onChange={(e) => setConsumePeriod(e.target.value)}
                      placeholder={t("common.form.example", { value: "2026-01" })}
                    />
                  </Field>
                  <Field label={t("finBudget.kind")} required>
                    <Select value={consumeKind} onChange={(e) => setConsumeKind(e.target.value as typeof consumeKind)}>
                      {(["actual", "commitment", "adjustment", "release"] as const).map((kind) => (
                        <option key={kind} value={kind}>
                          {t(CONSUME_KIND_KEYS[kind])}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label={t("fin.common.amount")}
                    required
                    hint={consumeAmount && !isValidAmount4Input(decimal(consumeAmount)) ? t("finBudget.amountHint") : undefined}
                  >
                    <Input
                      inputMode="decimal"
                      value={consumeAmount}
                      onChange={(e) => setConsumeAmount(e.target.value)}
                      placeholder={t("common.form.example", { value: "2500000.0000" })}
                      aria-invalid={consumeAmount !== "" && !isValidAmount4Input(decimal(consumeAmount))}
                    />
                  </Field>
                  <Field label={t("finBudget.note")}>
                    <Input value={consumeNote} onChange={(e) => setConsumeNote(e.target.value)} />
                  </Field>
                </div>
                <div className="mt-3">
                  <Button
                    disabled={busy || !activeVersion}
                    onClick={() => void consume()}
                  >
                    {t("finBudget.record")}
                  </Button>
                </div>
                {!activeVersion ? (
                  <p className="mt-2 text-xs text-ink-faint">{t("finBudget.needsApproval")}</p>
                ) : null}
              </Card>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
