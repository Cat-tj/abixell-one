/**
 * Wave A5 — Valuation & Landed Cost: FIFO Layers, Landed Cost Vouchers & Capitalization (SCM-ADV-005).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ScmItem,
  type ScmLandedCost,
  type ScmLandedCostDetail,
  type ScmLandedCostAllocationMethod,
  type PurchaseOrderRecord,
  type ScmValuationLayer,
  type ScmWarehouse,
} from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
import { PERMISSIONS } from "../../lib/capabilities";
import { useShell } from "../../shell/layout/AppShell";
import {
  Alert,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, formatMoney } from "../../shared/format";

function label(v: string) {
  return v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function ValuationPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();

  const canManage = permissions.includes(PERMISSIONS.supplyChainValuationManage);

  const [tab, setTab] = useState<"layers" | "landed_costs">("layers");
  const [items, setItems] = useState<ScmItem[]>([]);
  const [warehouses, setWarehouses] = useState<ScmWarehouse[]>([]);
  const [pos, setPos] = useState<PurchaseOrderRecord[]>([]);
  const [layers, setLayers] = useState<ScmValuationLayer[]>([]);
  const [landedCosts, setLandedCosts] = useState<ScmLandedCost[]>([]);

  const [selectedLandedCost, setSelectedLandedCost] = useState<ScmLandedCostDetail | null>(null);

  const [filterItemId, setFilterItemId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form states - Landed Cost
  const [lcPoId, setLcPoId] = useState("");
  const [lcMethod, setLcMethod] = useState<ScmLandedCostAllocationMethod>("by_value");
  const [lcFreight, setLcFreight] = useState("500000");
  const [lcCostType, setLcCostType] = useState("Freight & Logistics");
  const [lcNotes, setLcNotes] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [itList, whList, poList, layList, lcList] = await Promise.all([
        api.scmItems(token),
        api.scmWarehouses(token),
        api.purchaseOrders(token),
        api.scmValuationLayers(token, filterItemId ? { itemId: filterItemId } : undefined),
        api.scmLandedCosts(token),
      ]);
      setItems(itList);
      setWarehouses(whList);
      setPos(poList);
      setLayers(layList);
      setLandedCosts(lcList);

      if (poList.length > 0 && !lcPoId) setLcPoId(poList[0].id);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.val.msg.failedToLoadValuationData"));
    } finally {
      setLoading(false);
    }
  }, [token, filterItemId, lcPoId, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const whMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);
  const poMap = useMemo(() => new Map(pos.map((p) => [p.id, p])), [pos]);

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

  async function handleCreateLandedCost(e: React.FormEvent) {
    e.preventDefault();
    if (
      !formOk(
        [
          lcPoId ? null : t("scm.val.f.targetPurchaseOrder"),
          lcCostType.trim() ? null : t("scm.val.f.costType"),
          lcFreight.trim() ? null : t("scm.val.f.amountIdr"),
        ],
        [lcFreight.trim() && !(num(lcFreight) > 0) ? t("scm.val.f.amountIdr") : null],
      )
    )
      return;
    if (!formOk([items.length > 0 ? null : t("scm.val.h.item")])) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const targetItem = items[0];
      const allocAmount = num(lcFreight) || 0;
      await api.createScmLandedCost(token, {
        purchaseOrderId: lcPoId,
        costType: lcCostType,
        amount: allocAmount,
        allocationMethod: lcMethod,
        notes: lcNotes.trim() || null,
        allocations: [
          {
            itemId: targetItem.id,
            allocatedAmount: allocAmount,
            costPerUnitAdded: 1000,
          },
        ],
      });
      setNotice(t("scm.val.msg.landedCostVoucherCreated"));
      setLcNotes("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.val.msg.failedToCreateLandedCostVoucher"));
    } finally {
      setBusy(false);
    }
  }

  async function handleApplyLandedCost(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.applyScmLandedCost(token, id);
      setNotice(t("scm.val.msg.landedCostAllocatedAndAppliedToInventory"));
      await loadData();
      if (selectedLandedCost && selectedLandedCost.landedCost.id === id) {
        const updated = await api.scmLandedCost(token, id);
        setSelectedLandedCost(updated);
      }
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.val.msg.failedToApplyLandedCost"));
    } finally {
      setBusy(false);
    }
  }

  async function openLandedCostDetail(id: string) {
    setBusy(true);
    setError(null);
    try {
      const dt = await api.scmLandedCost(token, id);
      setSelectedLandedCost(dt);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.val.msg.failedToLoadLandedCostDetail"));
    } finally {
      setBusy(false);
    }
  }

  const layerColumns: Column<ScmValuationLayer>[] = [
    { header: t("scm.val.h.item"), cell: (r) => itemMap.get(r.itemId)?.name || r.itemId, mobileRole: "title" },
    { header: t("scm.val.h.warehouse"), cell: (r) => r.warehouseId ? (whMap.get(r.warehouseId)?.name || r.warehouseId) : "Global" },
    { header: t("scm.val.h.originalQty"), cell: (r) => <span className="font-mono">{r.originalQuantity}</span> },
    { header: t("scm.val.h.remainingQty"), cell: (r) => <span className="font-mono font-bold text-blue-600">{r.remainingQuantity}</span> },
    { header: t("scm.val.h.unitCostIdr"), cell: (r) => <span className="font-mono">{formatMoney(r.effectiveUnitCost)}</span> },
    { header: t("scm.val.h.totalRemainingValue"), cell: (r) => <span className="font-mono font-semibold text-emerald-600">{formatMoney(r.totalValue)}</span>, mobileRole: "status" },
    { header: t("scm.val.h.receivedDate"), cell: (r) => formatDateShort(r.receivedDate) },
  ];

  const landedCostColumns: Column<ScmLandedCost>[] = [
    { header: t("scm.val.h.voucher"), cell: (r) => <span className="font-mono font-semibold">{r.voucherNumber}</span>, mobileRole: "title" },
    { header: t("scm.val.h.purchaseOrder"), cell: (r) => poMap.get(r.purchaseOrderId)?.orderNumber || r.purchaseOrderId },
    { header: t("scm.val.h.costType"), cell: (r) => r.costType },
    { header: t("scm.val.h.method"), cell: (r) => label(r.allocationMethod) },
    { header: t("scm.val.h.amount"), cell: (r) => <span className="font-mono font-bold text-slate-800">{formatMoney(r.amount)}</span> },
    { header: t("scm.val.h.status"), cell: (r) => <StatusPill tone={r.status === "applied" ? "success" : "warning"}>{label(r.status)}</StatusPill>, mobileRole: "status" },
    {
      header: t("scm.val.h.actions"),
      cell: (r) => (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => openLandedCostDetail(r.id)}>{t("scm.val.t.detail")}</Button>
          {r.status === "draft" && (
            <Button variant="primary" onClick={() => handleApplyLandedCost(r.id)} disabled={!canManage || busy}>{t("scm.val.t.apply")}</Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("scm.val.title.valuationLandedCost")}
        subtitle={t("scm.val.sub.immutableFifoValuationLayersTotalCapital")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {!canManage && <Alert tone="info">{t("scm.val.n.readOnly")}</Alert>}

      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <Button variant={tab === "layers" ? "primary" : "secondary"} onClick={() => { setTab("layers"); setSelectedLandedCost(null); }}>{t("scm.val.t.fifoValuationLayers")}</Button>
        <Button variant={tab === "landed_costs" ? "primary" : "secondary"} onClick={() => setTab("landed_costs")}>{t("scm.val.t.landedCostAllocations")}</Button>
      </div>

      {loading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : tab === "layers" ? (
        <div className="space-y-4">
          <div className="flex gap-4 items-center">
            <Field label={t("scm.val.f.filterByItem")}>
              <Select value={filterItemId} onChange={(e) => setFilterItemId(e.target.value)}>
                <option value="">{t("scm.val.t.allInventoryItems")}</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}
              </Select>
            </Field>
          </div>
          <Card>
            <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.val.t.activeFifoInventoryLayers")}</h3>
            <DataTable columns={layerColumns} rows={layers} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.val.n.noActiveInventoryValuationLayersFound")}</p>} />
          </Card>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card>
                <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.val.t.landedCostVouchers")}</h3>
                <DataTable columns={landedCostColumns} rows={landedCosts} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.val.n.noLandedCostVouchersCreated")}</p>} />
              </Card>
            </div>
            <div>
              <Card>
                <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.val.t.createLandedCostVoucher")}</h3>
                <form onSubmit={handleCreateLandedCost} className="space-y-4">
                  <Field label={t("scm.val.f.targetPurchaseOrder")} required>
                    <Select value={lcPoId} onChange={(e) => setLcPoId(e.target.value)} disabled={!canManage || busy}>
                      {pos.map((p) => <option key={p.id} value={p.id}>{p.orderNumber}</option>)}
                    </Select>
                  </Field>
                  <Field label={t("scm.val.f.costType")} required>
                    <Input value={lcCostType} onChange={(e) => setLcCostType(e.target.value)} disabled={!canManage || busy} />
                  </Field>
                  <Field label={t("scm.val.f.allocationBasis")} required>
                    <Select value={lcMethod} onChange={(e) => setLcMethod(e.target.value as ScmLandedCostAllocationMethod)} disabled={!canManage || busy}>
                      <option value="by_value">{t("scm.val.t.byLineItemValueDefault")}</option>
                      <option value="by_quantity">{t("scm.val.t.byLineQuantity")}</option>
                      <option value="by_weight">{t("scm.val.t.byLineWeight")}</option>
                      <option value="equal">{t("scm.val.t.equalAllocation")}</option>
                    </Select>
                  </Field>
                  <Field label={t("scm.val.f.amountIdr")} required>
                    <Input type="number" value={lcFreight} onChange={(e) => setLcFreight(e.target.value)} disabled={!canManage || busy} />
                  </Field>
                  <Field label={t("scm.val.f.voucherNotes")}>
                    <Input value={lcNotes} onChange={(e) => setLcNotes(e.target.value)} placeholder={t("scm.val.p.customsBillBLReference")} disabled={!canManage || busy} />
                  </Field>
                  <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.val.t.generateVoucher")}</Button>
                </form>
              </Card>
            </div>
          </div>

          {selectedLandedCost && (
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{`Landed Cost Breakdown: ${selectedLandedCost.landedCost.voucherNumber}`}</h3>
              <div className="space-y-4">
                <div className="flex gap-4 text-sm">
                  <div><strong>{t("scm.val.f.status")}</strong> <StatusPill tone={selectedLandedCost.landedCost.status === "applied" ? "success" : "warning"}>{label(selectedLandedCost.landedCost.status)}</StatusPill></div>
                  <div><strong>{t("scm.val.f.totalCost")}</strong> <span className="font-mono font-bold">{formatMoney(selectedLandedCost.landedCost.amount)}</span></div>
                  <div><strong>{t("scm.val.f.method")}</strong> {label(selectedLandedCost.landedCost.allocationMethod)}</div>
                </div>
                <DataTable
                  columns={[
                    { header: t("scm.val.h.item"), cell: (r) => itemMap.get(r.itemId)?.name || r.itemId, mobileRole: "title" },
                    { header: t("scm.val.h.allocatedAmount"), cell: (r) => <span className="font-mono font-bold text-amber-600">+{formatMoney(r.allocatedAmount)}</span> },
                    { header: t("scm.val.h.costPerUnitAdded"), cell: (r) => <span className="font-mono font-bold text-emerald-600">+{formatMoney(r.costPerUnitAdded)}</span>, mobileRole: "status" },
                  ]}
                  rows={selectedLandedCost.allocations}
                  keyOf={(r) => r.id}
                />
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
