/**
 * Phase 6 — Cash and bank accounts (FIN-CORE-004, FIN-CORE-011).
 *
 * These are operational money containers, not a chart of accounts. The
 * balance shown is the backend's, always: this page never computes or edits
 * one. There is no reconciliation, statement import, or GL mapping here.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type FinanceAccount } from "../../lib/api";
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
import { accountTypeLabel, formatMoney } from "./money";
import { useT } from "../../i18n/LocaleProvider";

type OrganizationUnitOption = { id: string; name: string };
type LegalEntityOption = { id: string; name: string };

export function FinanceAccountsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [units, setUnits] = useState<OrganizationUnitOption[]>([]);
  const [legalEntities, setLegalEntities] = useState<LegalEntityOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [accountType, setAccountType] = useState<"cash" | "bank" | "petty_cash">("cash");
  const [currency, setCurrency] = useState("IDR");
  const [unitId, setUnitId] = useState("");
  const [legalEntityId, setLegalEntityId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAccounts(await api.financeAccounts(token));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finAccounts.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const [unitList, entityList] = await Promise.all([
        api.organizationUnits(token).catch(() => [] as OrganizationUnitOption[]),
        api.legalEntities(token).catch(() => [] as LegalEntityOption[]),
      ]);
      setUnits(unitList);
      setLegalEntities(entityList);
    })();
  }, [token]);

  async function run(action: () => Promise<unknown>, successMessage: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("fin.common.actionFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<FinanceAccount>[] = [
    { header: t("fin.common.code"), cell: (row) => <span className="font-medium">{row.code}</span> },
    { header: t("fin.common.name"), cell: (row) => row.name },
    { header: t("fin.common.type"), cell: (row) => accountTypeLabel(t, row.accountType) },
    { header: t("fin.common.currency"), cell: (row) => row.currency },
    {
      header: t("fin.common.balance"),
      className: "text-right tabular-nums",
      cell: (row) => <span className="font-medium">{formatMoney(row.balance)}</span>,
    },
    {
      header: t("fin.common.state"),
      cell: (row) => (
        <StatusPill tone={row.isActive ? "success" : "neutral"}>
          {row.isActive ? t("fin.state.active") : t("fin.state.inactive")}
        </StatusPill>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finAccounts.title")} subtitle={t("finAccounts.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("finAccounts.addTitle")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("fin.common.code")} required>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("finAccounts.codePlaceholder")}
            />
          </Field>
          <Field label={t("fin.common.name")} required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("finAccounts.namePlaceholder")}
            />
          </Field>
          <Field label={t("fin.common.type")} required>
            <Select
              value={accountType}
              onChange={(e) => setAccountType(e.target.value as "cash" | "bank" | "petty_cash")}
            >
              <option value="cash">{t("finAccounts.typeCash")}</option>
              <option value="bank">{t("finAccounts.typeBank")}</option>
              <option value="petty_cash">{t("finAccounts.typePettyCash")}</option>
            </Select>
          </Field>
          <Field label={t("fin.common.currency")} required hint={t("finAccounts.currencyHint")}>
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="IDR"
            />
          </Field>
          <Field label={t("fin.common.legalEntity")}>
            <Select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
              <option value="">{t("fin.common.none")}</option>
              {legalEntities.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("finAccounts.responsibleUnit")}>
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">{t("finAccounts.tenantWide")}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              disabled={busy}
              onClick={async () => {
                const missing = [
                  !code.trim() ? t("fin.common.code") : null,
                  !name.trim() ? t("fin.common.name") : null,
                ].filter((x): x is string => x !== null);
                if (missing.length > 0) {
                  setNotice(null);
                  setError(t("common.form.missing", { fields: missing.join(", ") }));
                  return;
                }
                if (currency.trim().length !== 3) {
                  setNotice(null);
                  setError(t("common.form.invalid", { fields: t("fin.common.currency") }));
                  return;
                }
                const ok = await run(
                  () =>
                    api.createFinanceAccount(token, {
                      code: code.trim(),
                      name: name.trim(),
                      accountType,
                      currency: currency.trim(),
                      legalEntityId: legalEntityId || null,
                      organizationUnitId: unitId || null,
                    }),
                  t("finAccounts.created", { code }),
                );
                if (ok) {
                  setCode("");
                  setName("");
                }
              }}
            >
              {t("fin.common.create")}
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-ink-faint">{t("finAccounts.note")}</p>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={accounts}
          keyOf={(row) => row.id}
          empty={
            <EmptyState title={t("finAccounts.emptyTitle")} description={t("finAccounts.emptyDesc")} />
          }
        />
      )}
    </div>
  );
}
