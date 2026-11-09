/**
 * Wave A6.2 — AP/AR open items and settlement (FIN-ADV-002).
 *
 * An open item is a debt or a claim that has not been settled yet. Two things
 * this page will not do:
 *
 *   - it does not decide which item settles which. An allocation is between a
 *     credit-direction instrument (the source) and a debit-direction one (the
 *     target), and the kernel refuses any pair that does not fit that shape.
 *   - it does not compute the remaining amount. The item list already carries
 *     `originalAmount`; what is still open comes from the kernel.
 *
 * Amounts are 4 decimals here because source documents are numeric(18,4).
 * Two decimals would silently round an invoice.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AccountingOpenItemRecord,
  type Customer,
  type SupplierRecord,
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
import { isValidAmount4Input } from "./money";
import { newIdempotencyKey, useLegalEntities } from "./useLegalEntities";

export function FinanceOpenItemsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { entities, legalEntityId, setLegalEntityId } = useLegalEntities(token);

  const [items, setItems] = useState<AccountingOpenItemRecord[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [side, setSide] = useState<"AR" | "AP">("AR");
  const [direction, setDirection] = useState<"debit" | "credit">("debit");
  const [sourceKind, setSourceKind] = useState<
    "invoice" | "payment" | "credit_note" | "debit_note" | "down_payment" | "withholding" | "unapplied"
  >("invoice");
  const [sourceRefTable, setSourceRefTable] = useState("customer_invoices");
  const [sourceRefId, setSourceRefId] = useState("");
  const [partyId, setPartyId] = useState("");
  const [documentNo, setDocumentNo] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [currency, setCurrency] = useState("IDR");
  const [originalAmount, setOriginalAmount] = useState("");

  const [sourceItemId, setSourceItemId] = useState("");
  const [targetItemId, setTargetItemId] = useState("");
  const [allocationAmount, setAllocationAmount] = useState("");
  const [allocationDate, setAllocationDate] = useState("");

  useEffect(() => {
    void (async () => {
      const [customerList, supplierList] = await Promise.all([
        api.customers(token).catch(() => [] as Customer[]),
        api.suppliers(token).catch(() => [] as SupplierRecord[]),
      ]);
      setCustomers(customerList);
      setSuppliers(supplierList);
    })();
  }, [token]);

  const load = useCallback(async () => {
    if (!legalEntityId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setItems(await api.accountingOpenItems(token, { legalEntityId }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finOpen.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, legalEntityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const parties = side === "AR" ? customers : suppliers;
  const partyLabel = (row: AccountingOpenItemRecord) => {
    const list = row.partyType === "customer" ? customers : suppliers;
    return list.find((p) => p.id === row.partyId)?.name ?? row.partyId;
  };
  // The kernel's allocation contract: the source is the credit instrument, the
  // target is the debit one. Filtering here means the operator cannot pick a
  // pair the service would reject.
  const creditItems = items.filter((item) => item.direction === "credit");
  const debitItems = items.filter((item) => item.direction === "debit");
  // A comma is accepted as the decimal separator ("12,5" -> "12.5").
  const decimal = (v: string) => v.trim().replace(",", ".");
  const allocationNorm = decimal(allocationAmount);
  const amountValid = isValidAmount4Input(allocationNorm) && /[1-9]/.test(allocationNorm);

  function formProblem(kind: "missing" | "invalid", fields: Array<string | null>): boolean {
    const list = fields.filter((x): x is string => x !== null);
    if (list.length === 0) return false;
    setNotice(null);
    setError(t(kind === "missing" ? "common.form.missing" : "common.form.invalid", { fields: list.join(", ") }));
    return true;
  }

  async function createItem() {
    if (
      formProblem("missing", [
        !partyId ? (side === "AR" ? t("fin.common.customer") : t("finOpen.supplier")) : null,
        !documentNo.trim() ? t("finOpen.documentNo") : null,
        !documentDate ? t("finOpen.documentDate") : null,
        originalAmount.trim() === "" ? t("fin.common.amount") : null,
        !currency.trim() ? t("fin.common.currency") : null,
        !sourceRefTable.trim() ? t("finOpen.sourceTable") : null,
        !sourceRefId.trim() ? t("finOpen.sourceId") : null,
      ])
    ) {
      return;
    }
    if (formProblem("invalid", [!isValidAmount4Input(decimal(originalAmount)) ? t("fin.common.amount") : null])) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.accountingCreateOpenItem(token, {
        legalEntityId,
        side,
        direction,
        sourceKind,
        sourceRefTable: sourceRefTable.trim(),
        sourceRefId: sourceRefId.trim(),
        partyType: side === "AR" ? "customer" : "supplier",
        partyId,
        documentNo: documentNo.trim(),
        documentDate,
        dueDate: dueDate || null,
        currency,
        // Verbatim text at 4 decimals — never parsed to a number.
        originalAmount: decimal(originalAmount),
      });
      setNotice(
        t("finOpen.recorded", {
          number: created.documentNo,
          amount: `${formatMoney(created.originalAmount)} ${created.currency}`,
        }),
      );
      setDocumentNo("");
      setSourceRefId("");
      setOriginalAmount("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finOpen.recordFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function allocate() {
    if (
      formProblem("missing", [
        !sourceItemId ? t("finOpen.settlesCredit") : null,
        !targetItemId ? t("finOpen.settledDebit") : null,
        allocationAmount.trim() === "" ? t("fin.common.amount") : null,
        !allocationDate ? t("finOpen.allocationDate") : null,
      ])
    ) {
      return;
    }
    if (formProblem("invalid", [!amountValid ? t("fin.common.amount") : null])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.accountingAllocate(token, {
        legalEntityId,
        sourceOpenItemId: sourceItemId,
        targetOpenItemId: targetItemId,
        amount: allocationNorm,
        allocationDate,
        idempotencyKey: newIdempotencyKey(),
      });
      setNotice(t("finOpen.allocated"));
      setAllocationAmount("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("finOpen.allocateFailed"));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<AccountingOpenItemRecord>[] = [
    {
      header: t("finOpen.document"),
      mobileRole: "title",
      cell: (row) => <span className="font-medium text-ink">{row.documentNo}</span>,
    },
    { header: t("finOpen.side"), cell: (row) => <Badge>{row.side}</Badge> },
    { header: t("fin.common.direction"), cell: (row) => row.direction },
    { header: t("finOpen.party"), cell: (row) => partyLabel(row) },
    { header: t("finOpen.documentDate"), className: "tabular-nums", cell: (row) => formatDateShort(row.documentDate) },
    { header: t("finOpen.due"), className: "tabular-nums", cell: (row) => formatDateShort(row.dueDate) },
    {
      header: t("finOpen.original"),
      className: "text-right tabular-nums whitespace-nowrap",
      mobileRole: "detail",
      cell: (row) => `${formatMoney(row.originalAmount)} ${row.currency}`,
    },
    { header: t("finOpen.source"), mobileRole: "status", cell: (row) => <StatusPill>{row.sourceKind}</StatusPill> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("finOpen.title")} subtitle={t("finOpen.subtitle")} />

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
        <EmptyState title={t("fin.common.chooseLegalEntity")} description={t("finOpen.chooseEntityDesc")} />
      ) : (
        <>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finOpen.recordTitle")}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("finOpen.side")} required>
                <Select
                  value={side}
                  onChange={(e) => {
                    const next = e.target.value as "AR" | "AP";
                    setSide(next);
                    setPartyId("");
                    setSourceRefTable(next === "AR" ? "customer_invoices" : "scm_vendor_invoices");
                  }}
                >
                  <option value="AR">{t("finOpen.sideAr")}</option>
                  <option value="AP">{t("finOpen.sideAp")}</option>
                </Select>
              </Field>
              <Field label={t("fin.common.direction")} required hint={t("finOpen.directionHint")}>
                <Select value={direction} onChange={(e) => setDirection(e.target.value as "debit" | "credit")}>
                  <option value="debit">{t("finOpen.debit")}</option>
                  <option value="credit">{t("finOpen.credit")}</option>
                </Select>
              </Field>
              <Field label={t("finOpen.kind")} required>
                <Select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as typeof sourceKind)}>
                  <option value="invoice">{t("finOpen.kindInvoice")}</option>
                  <option value="payment">{t("finOpen.kindPayment")}</option>
                  <option value="credit_note">{t("finOpen.kindCreditNote")}</option>
                  <option value="debit_note">{t("finOpen.kindDebitNote")}</option>
                  <option value="down_payment">{t("finOpen.kindDownPayment")}</option>
                  <option value="withholding">{t("finOpen.kindWithholding")}</option>
                  <option value="unapplied">{t("finOpen.kindUnapplied")}</option>
                </Select>
              </Field>
              <Field label={side === "AR" ? t("fin.common.customer") : t("finOpen.supplier")} required>
                <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {parties.map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("finOpen.documentNo")} required>
                <Input value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} placeholder={t("common.form.example", { value: "INV-2026-0001" })} />
              </Field>
              <Field label={t("finOpen.documentDate")} required>
                <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
              </Field>
              <Field label={t("finOpen.dueDate")}>
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
              <Field
                label={t("fin.common.amount")}
                required
                hint={originalAmount && !isValidAmount4Input(decimal(originalAmount)) ? t("finOpen.amountHint") : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={originalAmount}
                  onChange={(e) => setOriginalAmount(e.target.value)}
                  placeholder={t("common.form.example", { value: "1250.7500" })}
                  aria-invalid={originalAmount !== "" && !isValidAmount4Input(decimal(originalAmount))}
                />
              </Field>
              <Field label={t("fin.common.currency")} required>
                <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
              </Field>
              <Field label={t("finOpen.sourceTable")} required hint={t("finOpen.sourceTableHint")}>
                <Input value={sourceRefTable} onChange={(e) => setSourceRefTable(e.target.value)} />
              </Field>
              <Field label={t("finOpen.sourceId")} required hint={t("finOpen.sourceIdHint")}>
                <Input value={sourceRefId} onChange={(e) => setSourceRefId(e.target.value)} placeholder={t("common.form.example", { value: "UUID" })} />
              </Field>
            </div>
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={() => void createItem()}
              >
                {t("finOpen.record")}
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("finOpen.settleTitle")}</h2>
            <p className="mb-3 text-sm text-ink-dim">{t("finOpen.settleNote")}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("finOpen.settlesCredit")} required>
                <Select value={sourceItemId} onChange={(e) => setSourceItemId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {creditItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.documentNo} · {formatMoney(item.originalAmount)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("finOpen.settledDebit")} required>
                <Select value={targetItemId} onChange={(e) => setTargetItemId(e.target.value)}>
                  <option value="">{t("fin.common.select")}</option>
                  {debitItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.documentNo} · {formatMoney(item.originalAmount)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t("fin.common.amount")}
                required
                hint={allocationAmount && !amountValid ? t("finOpen.allocateAmountHint") : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={allocationAmount}
                  onChange={(e) => setAllocationAmount(e.target.value)}
                  placeholder={t("common.form.example", { value: "500.0000" })}
                  aria-invalid={allocationAmount !== "" && !amountValid}
                />
              </Field>
              <Field label={t("finOpen.allocationDate")} required>
                <Input type="date" value={allocationDate} onChange={(e) => setAllocationDate(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Button disabled={busy} onClick={() => void allocate()}>
                {t("finOpen.allocate")}
              </Button>
            </div>
            {creditItems.length === 0 || debitItems.length === 0 ? (
              <p className="mt-2 text-xs text-ink-faint">{t("finOpen.bothSidesNeeded")}</p>
            ) : null}
          </Card>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">{t("finOpen.title")}</h2>
            {loading ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                rows={items}
                keyOf={(row) => row.id}
                empty={<EmptyState title={t("finOpen.emptyTitle")} description={t("finOpen.emptyDesc")} />}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
