/**
 * Wave A6.6 — Indonesia tax baseline (FIN-ADV-006).
 *
 * Three things in sequence:
 *
 *   1. the legal entity is registered as PKP or non-PKP, from a date;
 *   2. a tax rule is created per tax type (PPN, PPh 22, 23, 26), and a rate
 *      version is attached to it with the account the tax posts to;
 *   3. a calculation asks the service what tax applies to a basis amount on a
 *      date, and it answers using the version effective that day.
 *
 * Rates are fractions, not percentages: 0.11 is 11%. They are 6-decimal
 * strings and stay strings. The page never multiplies anything — the service
 * owns the arithmetic and the rounding mode.
 *
 * PPh Badan and PPh 21 are out of scope here (ADR-0019): they are annual or
 * payroll obligations, not per-transaction taxes.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingAccountRecord,
  type AccountingTaxCalculationRecord,
  type AccountingTaxRegistrationRecord,
  type AccountingTaxRuleRecord,
  type AccountingTaxRuleVersionRecord,
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

const VERSION_TONES: Record<AccountingTaxRuleVersionRecord["status"], "neutral" | "success" | "warning"> = {
  draft: "warning",
  approved: "success",
  superseded: "neutral",
};

/** The stored type stays the API's; only the word on screen is translated. */
const TAX_TYPE_KEYS: Record<AccountingTaxRuleRecord["taxType"], MessageKey> = {
  ppn: "finTax.typePpn",
  pph22: "finTax.typePph22",
  pph23: "finTax.typePph23",
  pph26: "finTax.typePph26",
};

const VERSION_STATUS_KEYS: Record<AccountingTaxRuleVersionRecord["status"], MessageKey> = {
  draft: "finBudget.statusDraft",
  approved: "finTax.statusApproved",
  superseded: "finBudget.statusSuperseded",
};

const BASIS_KEYS: Record<"gross" | "net" | "dpp", MessageKey> = {
  gross: "finTax.basisGross",
  net: "finTax.basisNet",
  dpp: "finTax.basisDpp",
};

const ROUNDING_KEYS: Record<"half_up" | "half_even" | "truncate", MessageKey> = {
  half_up: "finTax.roundHalfUp",
  half_even: "finTax.roundHalfEven",
  truncate: "finTax.roundTruncate",
};

/** A rate is a fraction with at most six decimals. 0.11 is eleven percent. */
function isValidRateInput(value: string): boolean {
  return /^\d{1,3}(\.\d{1,6})?$/.test(value.trim());
}

export function FinanceTaxPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { entities, legalEntityId, setLegalEntityId } = useLegalEntities(token);

  const [registrations, setRegistrations] = useState<AccountingTaxRegistrationRecord[]>([]);
  const [rules, setRules] = useState<AccountingTaxRuleRecord[]>([]);
  const [accounts, setAccounts] = useState<AccountingAccountRecord[]>([]);
  const [calculations, setCalculations] = useState<AccountingTaxCalculationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Registration
  const [taxpayerStatus, setTaxpayerStatus] = useState<"pkp" | "non_pkp">("pkp");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [registrationFrom, setRegistrationFrom] = useState("");

  // Rule
  const [ruleCode, setRuleCode] = useState("");
  const [taxType, setTaxType] = useState<AccountingTaxRuleRecord["taxType"]>("ppn");
  const [ruleDescription, setRuleDescription] = useState("");

  // Rule version
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [versions, setVersions] = useState<AccountingTaxRuleVersionRecord[]>([]);
  const [rate, setRate] = useState("");
  const [basis, setBasis] = useState<"gross" | "net" | "dpp">("gross");
  const [roundingMode, setRoundingMode] = useState<"half_up" | "half_even" | "truncate">("half_up");
  const [requiresPkp, setRequiresPkp] = useState(false);
  const [taxAccountId, setTaxAccountId] = useState("");
  const [versionFrom, setVersionFrom] = useState("");

  // Calculation
  const [calcRuleCode, setCalcRuleCode] = useState("");
  const [calcBasis, setCalcBasis] = useState("");
  const [calcDate, setCalcDate] = useState("");
  const [calcCurrency, setCalcCurrency] = useState("IDR");

  const load = useCallback(async () => {
    if (!legalEntityId) {
      setRegistrations([]);
      setRules([]);
      setCalculations([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [registrationList, ruleList, accountList, calculationList] = await Promise.all([
        api.accountingTaxRegistrations(token, legalEntityId).catch(() => []),
        api.accountingTaxRules(token, { legalEntityId }).catch(() => []),
        api.accountingAccounts(token, { legalEntityId, activeOnly: true }),
        api.accountingTaxCalculations(token, { legalEntityId }).catch(() => []),
      ]);
      setRegistrations(registrationList);
      setRules(ruleList);
      setAccounts(accountList);
      setCalculations(calculationList);
      setSelectedRuleId((current) => (ruleList.some((r) => r.id === current) ? current : ruleList[0]?.id ?? ""));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTax.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, legalEntityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadVersions = useCallback(async () => {
    if (!selectedRuleId) {
      setVersions([]);
      return;
    }
    try {
      setVersions(await api.accountingTaxRuleVersions(token, selectedRuleId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTax.versionsFailed"));
    }
  }, [token, selectedRuleId, t]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const activeRegistration = registrations.find((r) => r.status === "active") ?? null;
  const selectedRule = rules.find((r) => r.id === selectedRuleId) ?? null;

  function formProblem(kind: "missing" | "invalid", fields: Array<string | null>): boolean {
    const list = fields.filter((x): x is string => x !== null);
    if (list.length === 0) return false;
    setNotice(null);
    setError(t(kind === "missing" ? "common.form.missing" : "common.form.invalid", { fields: list.join(", ") }));
    return true;
  }

  // A comma is accepted as the decimal separator ("0,11" -> "0.11").
  const decimal = (v: string) => v.trim().replace(",", ".");

  async function registerTaxpayer() {
    if (formProblem("missing", [!registrationFrom ? t("finTax.effectiveFrom") : null])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingRegisterTaxpayer(token, {
        legalEntityId,
        taxpayerStatus,
        effectiveFrom: registrationFrom,
        registrationNumber: registrationNumber.trim() || null,
      });
      setNotice(t(created.taxpayerStatus === "pkp" ? "finTax.registeredPkp" : "finTax.registeredNonPkp"));
      setRegistrationNumber("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTax.registerFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createRule() {
    if (formProblem("missing", [!ruleCode.trim() ? t("finTax.ruleCode") : null])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingCreateTaxRule(token, {
        legalEntityId,
        ruleCode: ruleCode.trim().toUpperCase(),
        taxType,
        description: ruleDescription.trim() || null,
      });
      setNotice(t("finTax.ruleCreated", { code: created.ruleCode }));
      setRuleCode("");
      setRuleDescription("");
      await load();
      setSelectedRuleId(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTax.ruleFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createVersion() {
    if (!selectedRule) return;
    if (
      formProblem("missing", [
        rate.trim() === "" ? t("finTax.rate") : null,
        !taxAccountId ? t("finTax.taxAccount") : null,
        !versionFrom ? t("finTax.effectiveFrom") : null,
      ])
    ) {
      return;
    }
    if (formProblem("invalid", [!isValidRateInput(decimal(rate)) ? `${t("finTax.rate")} (${t("finTax.rateHintInvalid")})` : null])) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingCreateTaxRuleVersion(token, selectedRule.id, {
        // Verbatim text: a rate is a fraction with at most six decimals.
        rate: decimal(rate),
        basis,
        roundingMode,
        requiresPkp,
        accountId: taxAccountId,
        effectiveFrom: versionFrom,
        effectiveTo: null,
      });
      setNotice(t("finTax.versionDrafted", { version: created.versionNumber, rate: created.rate }));
      setRate("");
      await loadVersions();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTax.versionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function act(version: AccountingTaxRuleVersionRecord, actionCode: "approve" | "reject") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.accountingTaxRuleVersionAction(token, version.id, { actionCode, comment: null });
      setNotice(
        t(actionCode === "approve" ? "finTax.approved" : "finTax.rejected", { version: updated.versionNumber }),
      );
      await loadVersions();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finBudget.decisionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function calculate() {
    if (
      formProblem("missing", [
        !calcRuleCode ? t("finTax.ruleCode") : null,
        calcBasis.trim() === "" ? t("finTax.basisAmount") : null,
        !calcDate ? t("finTax.calculationDate") : null,
        !calcCurrency.trim() ? t("fin.common.currency") : null,
      ])
    ) {
      return;
    }
    if (formProblem("invalid", [!isValidAmountInput(decimal(calcBasis)) ? t("finTax.basisAmount") : null])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.accountingCalculateTax(token, {
        legalEntityId,
        ruleCode: calcRuleCode.trim().toUpperCase(),
        // Verbatim text at 2 decimals.
        basisAmount: decimal(calcBasis),
        calculationDate: calcDate,
        currency: calcCurrency,
        idempotencyKey: newIdempotencyKey(),
      });
      setNotice(
        t("finTax.calculated", {
          tax: `${formatMoney(result.taxAmount)} ${result.currency}`,
          basis: formatMoney(result.basisAmount),
          rate: result.rate,
          status: result.taxpayerStatus,
        }),
      );
      setCalcBasis("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finTax.calculateFailed"));
    } finally {
      setBusy(false);
    }
  }

  const versionColumns: Column<AccountingTaxRuleVersionRecord>[] = [
    {
      header: t("finBudget.version"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">v{row.versionNumber}</span>,
    },
    { header: t("finTax.rate"), className: "tabular-nums", cell: (row) => row.rate },
    { header: t("finTax.basis"), cell: (row) => t(BASIS_KEYS[row.basis]) },
    { header: t("finTax.rounding"), cell: (row) => t(ROUNDING_KEYS[row.roundingMode]) },
    { header: t("fin.common.from"), className: "tabular-nums", cell: (row) => formatDateShort(row.effectiveFrom) },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) => <StatusPill tone={VERSION_TONES[row.status]}>{t(VERSION_STATUS_KEYS[row.status])}</StatusPill>,
    },
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

  const calculationColumns: Column<AccountingTaxCalculationRecord>[] = [
    {
      header: t("fin.common.date"),
      mobileRole: "title",
      className: "tabular-nums",
      cell: (row) => formatDateShort(row.calculationDate),
    },
    {
      header: t("finTax.basis"),
      className: "text-right tabular-nums",
      cell: (row) => formatMoney(row.basisAmount),
    },
    { header: t("finTax.rate"), className: "tabular-nums", cell: (row) => row.rate },
    {
      header: t("finTax.tax"),
      className: "text-right tabular-nums whitespace-nowrap",
      mobileRole: "detail",
      cell: (row) => `${formatMoney(row.taxAmount)} ${row.currency}`,
    },
    { header: t("finTax.as"), mobileRole: "status", cell: (row) => <Badge>{row.taxpayerStatus}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finTax.title")} subtitle={t("finTax.subtitle")} />

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
        <EmptyState title={t("fin.common.chooseLegalEntity")} description={t("finTax.chooseEntityDesc")} />
      ) : loading ? (
        <Spinner />
      ) : (
        <>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finTax.taxpayerStatus")}</h2>
            <p className="mb-3 text-sm text-ink-dim">
              {activeRegistration
                ? t(
                    activeRegistration.registrationNumber ? "finTax.currentlyWithNpwp" : "finTax.currently",
                    {
                      status: activeRegistration.taxpayerStatus.toUpperCase(),
                      npwp: activeRegistration.registrationNumber ?? "",
                      date: formatDateShort(activeRegistration.effectiveFrom),
                    },
                  )
                : t("finTax.notRegistered")}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("fin.common.status")} required>
                <Select value={taxpayerStatus} onChange={(e) => setTaxpayerStatus(e.target.value as "pkp" | "non_pkp")}>
                  <option value="pkp">{t("finTax.statusPkp")}</option>
                  <option value="non_pkp">{t("finTax.statusNonPkp")}</option>
                </Select>
              </Field>
              <Field label={t("finTax.registrationNumber")} hint={t("finTax.registrationNumberHint")}>
                <Input value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} />
              </Field>
              <Field label={t("finTax.effectiveFrom")} required>
                <Input type="date" value={registrationFrom} onChange={(e) => setRegistrationFrom(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Button disabled={busy} onClick={() => void registerTaxpayer()}>
                {t("finTax.recordStatus")}
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finTax.taxRule")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("finTax.ruleCode")} required>
                <Input value={ruleCode} onChange={(e) => setRuleCode(e.target.value)} placeholder={t("common.form.example", { value: "PPN-OUT-11" })} />
              </Field>
              <Field label={t("finTax.taxType")} required>
                <Select value={taxType} onChange={(e) => setTaxType(e.target.value as AccountingTaxRuleRecord["taxType"])}>
                  {(Object.keys(TAX_TYPE_KEYS) as AccountingTaxRuleRecord["taxType"][]).map((type) => (
                    <option key={type} value={type}>
                      {t(TAX_TYPE_KEYS[type])}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("fin.common.description")}>
                <Input value={ruleDescription} onChange={(e) => setRuleDescription(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Button disabled={busy} onClick={() => void createRule()}>
                {t("finTax.createRule")}
              </Button>
            </div>
          </Card>

          {rules.length === 0 ? null : (
            <>
              <Card>
                <h2 className="mb-3 text-sm font-semibold text-ink">{t("finTax.rateVersion")}</h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label={t("finTax.rule")} required>
                    <Select value={selectedRuleId} onChange={(e) => setSelectedRuleId(e.target.value)}>
                      {rules.map((rule) => (
                        <option key={rule.id} value={rule.id}>
                          {rule.ruleCode} · {t(TAX_TYPE_KEYS[rule.taxType])}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label={t("finTax.rate")}
                    required
                    hint={rate && !isValidRateInput(decimal(rate)) ? t("finTax.rateHintInvalid") : t("finTax.rateHint")}
                  >
                    <Input
                      inputMode="decimal"
                      value={rate}
                      onChange={(e) => setRate(e.target.value)}
                      placeholder={t("common.form.example", { value: "0.110000" })}
                      aria-invalid={rate !== "" && !isValidRateInput(decimal(rate))}
                    />
                  </Field>
                  <Field label={t("finTax.basis")} required hint={t("finTax.basisHint")}>
                    <Select value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
                      {(["gross", "net", "dpp"] as const).map((value) => (
                        <option key={value} value={value}>
                          {t(BASIS_KEYS[value])}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("finTax.rounding")} required>
                    <Select value={roundingMode} onChange={(e) => setRoundingMode(e.target.value as typeof roundingMode)}>
                      {(["half_up", "half_even", "truncate"] as const).map((value) => (
                        <option key={value} value={value}>
                          {t(ROUNDING_KEYS[value])}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("finTax.taxAccount")} required>
                    <Select value={taxAccountId} onChange={(e) => setTaxAccountId(e.target.value)}>
                      <option value="">{t("fin.common.select")}</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.accountCode} · {account.accountName}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("finTax.effectiveFrom")} required>
                    <Input type="date" value={versionFrom} onChange={(e) => setVersionFrom(e.target.value)} />
                  </Field>
                  <Field label={t("finTax.pkpOnly")} hint={t("finTax.pkpOnlyHint")}>
                    <Select value={requiresPkp ? "yes" : "no"} onChange={(e) => setRequiresPkp(e.target.value === "yes")}>
                      <option value="no">{t("finTax.appliesToEveryone")}</option>
                      <option value="yes">{t("finTax.requiresPkp")}</option>
                    </Select>
                  </Field>
                </div>
                <div className="mt-3">
                  <Button
                    disabled={busy || !selectedRule}
                    onClick={() => void createVersion()}
                  >
                    {t("finBudget.draftVersion")}
                  </Button>
                </div>
              </Card>

              <div>
                <h2 className="mb-2 text-sm font-semibold text-ink">
                  {selectedRule
                    ? t("finTax.versionsFor", { code: selectedRule.ruleCode })
                    : t("finBudget.versions")}
                </h2>
                <DataTable
                  columns={versionColumns}
                  rows={versions}
                  keyOf={(row) => row.id}
                  empty={<EmptyState title={t("finBudget.noVersionsTitle")} description={t("finBudget.noVersionsDesc")} />}
                />
              </div>
            </>
          )}

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finTax.calculateTitle")}</h2>
            <p className="mb-3 text-sm text-ink-dim">{t("finTax.calculateNote")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("finTax.ruleCode")} required>
                <Select value={calcRuleCode} onChange={(e) => setCalcRuleCode(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {rules.map((rule) => (
                    <option key={rule.id} value={rule.ruleCode}>
                      {rule.ruleCode} · {t(TAX_TYPE_KEYS[rule.taxType])}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t("finTax.basisAmount")}
                required
                hint={calcBasis && !isValidAmountInput(decimal(calcBasis)) ? t("finTax.basisAmountHint") : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={calcBasis}
                  onChange={(e) => setCalcBasis(e.target.value)}
                  placeholder={t("common.form.example", { value: "1000000.00" })}
                  aria-invalid={calcBasis !== "" && !isValidAmountInput(decimal(calcBasis))}
                />
              </Field>
              <Field label={t("finTax.calculationDate")} required>
                <Input type="date" value={calcDate} onChange={(e) => setCalcDate(e.target.value)} />
              </Field>
              <Field label={t("fin.common.currency")} required>
                <Input value={calcCurrency} onChange={(e) => setCalcCurrency(e.target.value.toUpperCase())} maxLength={3} />
              </Field>
            </div>
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={() => void calculate()}
              >
                {t("finTax.calculate")}
              </Button>
            </div>
          </Card>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finTax.calculations")}</h2>
            <DataTable
              columns={calculationColumns}
              rows={calculations}
              keyOf={(row) => row.id}
              empty={
                <EmptyState title={t("finTax.noCalculationsTitle")} description={t("finTax.noCalculationsDesc")} />
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
