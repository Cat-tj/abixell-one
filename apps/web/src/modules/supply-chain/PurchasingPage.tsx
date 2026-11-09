/**
 * Phase 4 — Purchasing surface (SCM-CORE-007…010, SCM-CORE-013).
 *
 * One coherent screen for the purchasing loop: raise a request, move it
 * through its configured approval lifecycle, turn an approved request into
 * an order, issue it, and receive against its lines.
 *
 * Lifecycle buttons are rendered from the backend's `availableActions` —
 * never from a hardcoded status rule.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type PurchaseOrderDetail,
  type PurchaseOrderRecord,
  type PurchaseRequestDetail,
  type PurchaseRequestRecord,
  type ScmItem,
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
  Textarea,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, statusTone } from "../../shared/format";

export function PurchasingPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [requests, setRequests] = useState<PurchaseRequestRecord[]>([]);
  const [orders, setOrders] = useState<PurchaseOrderRecord[]>([]);
  const [items, setItems] = useState<ScmItem[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [requestDetail, setRequestDetail] = useState<PurchaseRequestDetail | null>(null);
  const [orderDetail, setOrderDetail] = useState<PurchaseOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [justification, setJustification] = useState("");
  const [prItem, setPrItem] = useState("");
  const [prQuantity, setPrQuantity] = useState("");
  const [supplierCode, setSupplierCode] = useState("");
  const [receiptQuantity, setReceiptQuantity] = useState("");
  const [receiptLineId, setReceiptLineId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [requestList, orderList, itemList, supplierList] = await Promise.all([
        api.purchaseRequests(token),
        api.purchaseOrders(token).catch(() => [] as PurchaseOrderRecord[]),
        api.scmItems(token).catch(() => [] as ScmItem[]),
        api.suppliers(token).catch(() => [] as SupplierRecord[]),
      ]);
      setRequests(requestList);
      setOrders(orderList);
      setItems(itemList.filter((i) => i.isActive));
      setSuppliers(supplierList.filter((s) => s.isActive));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("msc.purch.msg.couldNotLoadPurchasingData"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openRequest = useCallback(
    async (id: string) => {
      setError(null);
      try {
        setRequestDetail(await api.purchaseRequest(token, id));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("msc.purch.msg.couldNotLoadTheRequest"));
      }
    },
    [token, t],
  );

  const openOrder = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const detail = await api.purchaseOrder(token, id);
        setOrderDetail(detail);
        setReceiptLineId(detail.lines[0]?.id ?? "");
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("msc.purch.msg.couldNotLoadTheOrder"));
      }
    },
    [token, t],
  );

  /** Shows what is missing/invalid and returns false when the form cannot be sent. */
  function formOk(missing: Array<string | null>, invalid: Array<string | null> = []): boolean {
    const m = missing.filter((x): x is string => x !== null);
    const i = invalid.filter((x): x is string => x !== null);
    if (m.length === 0 && i.length === 0) return true;
    setNotice(null);
    setError(
      m.length > 0
        ? t("common.form.missing", { fields: m.join(", ") })
        : t("common.form.invalid", { fields: i.join(", ") }),
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
    return false;
  }

  const num = (v: string) => Number(v.replace(/\s/g, "").replace(",", "."));

  async function run(action: () => Promise<unknown>, successMessage: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
      if (requestDetail) await openRequest(requestDetail.request.id);
      if (orderDetail) await openOrder(orderDetail.order.id);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("msc.purch.msg.actionFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const itemName = (itemId: string) => items.find((i) => i.id === itemId)?.name ?? itemId.slice(0, 8);

  const requestColumns: Column<PurchaseRequestRecord>[] = [
    { header: t("msc.purch.h.number"), cell: (row) => <span className="font-medium">{row.requestNumber}</span> },
    { header: t("msc.purch.h.justification"), cell: (row) => row.justification },
    { header: t("msc.purch.h.required"), cell: (row) => formatDateShort(row.requiredDate) },
    {
      header: t("msc.purch.h.order"),
      cell: (row) => (row.convertedPurchaseOrderId ? <Badge>{t("msc.purch.t.ordered")}</Badge> : "—"),
    },
  ];

  const orderColumns: Column<PurchaseOrderRecord>[] = [
    { header: t("msc.purch.h.number"), cell: (row) => <span className="font-medium">{row.orderNumber}</span> },
    {
      header: t("msc.purch.h.state"),
      cell: (row) => (
        <StatusPill tone={row.cancelledAt ? "neutral" : row.issuedAt ? "success" : "warning"}>
          {row.cancelledAt ? "Cancelled" : row.issuedAt ? "Issued" : "Draft"}
        </StatusPill>
      ),
    },
    { header: t("msc.purch.h.expected"), cell: (row) => formatDateShort(row.expectedDate) },
    { header: t("msc.purch.h.currency"), cell: (row) => row.currency ?? "—" },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("msc.purch.title.purchasing")} subtitle={t("msc.purch.sub.requestOrderAndReceiveWhatYourTeamsNeed")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("msc.purch.t.raiseAPurchaseRequest")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("msc.purch.f.item")} required>
            <Select value={prItem} onChange={(e) => setPrItem(e.target.value)}>
              <option value="">{t("msc.purch.t.select")}</option>
              {items.map((i) => (
                <option key={i.id} value={i.code}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("msc.purch.f.quantity")} required>
            <Input
              type="number"
              min="0"
              step="any"
              value={prQuantity}
              onChange={(e) => setPrQuantity(e.target.value)}
            />
          </Field>
          <Field label={t("msc.purch.f.justification")} required>
            <Textarea rows={1} value={justification} onChange={(e) => setJustification(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              disabled={busy}
              onClick={async () => {
                if (
                  !formOk(
                    [
                      prItem ? null : t("msc.purch.f.item"),
                      prQuantity.trim() ? null : t("msc.purch.f.quantity"),
                      justification.trim() ? null : t("msc.purch.f.justification"),
                    ],
                    [prQuantity.trim() && !(num(prQuantity) > 0) ? t("msc.purch.f.quantity") : null],
                  )
                )
                  return;
                const ok = await run(
                  () =>
                    api.createPurchaseRequest(token, {
                      justification: justification.trim(),
                      lines: [{ itemCode: prItem, quantity: num(prQuantity) }],
                    }),
                  "Purchase request created.",
                );
                if (ok) {
                  setJustification("");
                  setPrQuantity("");
                }
              }}
            >
              {t("common.create")}
            </Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-800">{t("msc.purch.t.purchaseRequests")}</h2>
            <DataTable
              columns={requestColumns}
              rows={requests}
              keyOf={(row) => row.id}
              onRowClick={(row) => void openRequest(row.id)}
              empty={<EmptyState title={t("msc.purch.title.noPurchaseRequests")} description={t("msc.purch.d.raiseOneAboveToGetStarted")} />}
            />
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-800">{t("msc.purch.t.purchaseOrders")}</h2>
            <DataTable
              columns={orderColumns}
              rows={orders}
              keyOf={(row) => row.id}
              onRowClick={(row) => void openOrder(row.id)}
              empty={<EmptyState title={t("msc.purch.title.noPurchaseOrders")} description={t("msc.purch.d.approveARequestThenPlaceAnOrder")} />}
            />
          </div>
        </>
      )}

      {requestDetail ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">
            Request <Badge>{requestDetail.request.requestNumber}</Badge>{" "}
            {requestDetail.status ? (
              <StatusPill tone={statusTone(requestDetail.status.instanceStatus)}>
                {requestDetail.status.stepName ?? requestDetail.status.instanceStatus}
              </StatusPill>
            ) : null}
          </h2>
          <ul className="mb-3 space-y-1 text-sm text-slate-800">
            {requestDetail.lines.map((line) => (
              <li key={line.id}>
                {itemName(line.itemId)} — {line.quantity}
              </li>
            ))}
          </ul>

          {requestDetail.availableActions.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {requestDetail.availableActions.map((action) => (
                <Button
                  key={action.actionCode}
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api.actOnPurchaseRequest(token, requestDetail.request.id, action.actionCode),
                      `${action.name} recorded.`,
                    )
                  }
                >
                  {action.name}
                </Button>
              ))}
            </div>
          ) : null}

          {requestDetail.status?.instanceStatus === "approved" && !requestDetail.request.convertedPurchaseOrderId ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("msc.purch.f.supplier")} required>
                <Select value={supplierCode} onChange={(e) => setSupplierCode(e.target.value)}>
                  <option value="">{t("msc.purch.t.select")}</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (!formOk([supplierCode ? null : t("msc.purch.f.supplier")])) return;
                    void run(
                      () =>
                        api.createPurchaseOrder(token, {
                          supplierCode,
                          purchaseRequestId: requestDetail.request.id,
                        }),
                      "Purchase order created.",
                    );
                  }}
                >
                  Create purchase order
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {orderDetail ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">
            Order <Badge>{orderDetail.order.orderNumber}</Badge>{" "}
            <StatusPill tone={orderDetail.state === "issued" ? "success" : "warning"}>{orderDetail.state}</StatusPill>
          </h2>
          <p className="mb-3 text-sm text-slate-600">Supplier: {orderDetail.supplier?.name ?? "—"}</p>
          <ul className="mb-3 space-y-1 text-sm text-slate-800">
            {orderDetail.lines.map((line) => (
              <li key={line.id}>
                {itemName(line.itemId)} — ordered {line.quantityOrdered}, received {line.quantityReceived}
              </li>
            ))}
          </ul>

          {orderDetail.state === "draft" ? (
            <Button
              disabled={busy}
              onClick={() => run(() => api.issuePurchaseOrder(token, orderDetail.order.id), "Order issued.")}
            >
              Issue order
            </Button>
          ) : null}

          {orderDetail.state === "issued" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("msc.purch.f.line")} required>
                <Select value={receiptLineId} onChange={(e) => setReceiptLineId(e.target.value)}>
                  {orderDetail.lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {itemName(line.itemId)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("msc.purch.f.quantityReceived")} required>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={receiptQuantity}
                  onChange={(e) => setReceiptQuantity(e.target.value)}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !formOk(
                        [
                          receiptLineId ? null : t("msc.purch.f.line"),
                          receiptQuantity.trim() ? null : t("msc.purch.f.quantityReceived"),
                        ],
                        [receiptQuantity.trim() && !(num(receiptQuantity) > 0) ? t("msc.purch.f.quantityReceived") : null],
                      )
                    )
                      return;
                    const ok = await run(
                      () =>
                        api.receiveAgainstOrder(token, orderDetail.order.id, {
                          lineId: receiptLineId,
                          quantity: num(receiptQuantity),
                        }),
                      "Goods received against the order.",
                    );
                    if (ok) setReceiptQuantity("");
                  }}
                >
                  Record receipt
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
