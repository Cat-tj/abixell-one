/**
 * Wave A5 — RFQ, Tender & Bid Comparison (SCM-ADV-006).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ScmItem,
  type ScmRfq,
  type ScmRfqDetail,
  type SupplierRecord,
  type ScmSupplierBid,
} from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
import { PERMISSIONS } from "../../lib/capabilities";
import { useShell } from "../../shell/layout/AppShell";
import {
  Alert,
  Badge,
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
import { localDateInputValue } from "../../shared/localDateTime";

function label(v: string) {
  return v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function ProcurementPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();

  const canManage = permissions.includes(PERMISSIONS.supplyChainProcurementManage);
  const canAward = permissions.includes(PERMISSIONS.supplyChainProcurementAward);

  const [rfqs, setRfqs] = useState<ScmRfq[]>([]);
  const [items, setItems] = useState<ScmItem[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);

  const [selectedRfqDetail, setSelectedRfqDetail] = useState<ScmRfqDetail | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form states - Create RFQ
  const [rfqTitle, setRfqTitle] = useState("");
  const [rfqDeadline, setRfqDeadline] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return localDateInputValue(d);
  });
  const [rfqItemId, setRfqItemId] = useState("");
  const [rfqQty, setRfqQty] = useState("100");
  const [rfqSpec, setRfqSpec] = useState("");

  // Form states - Submit Bid
  const [bidSupplierId, setBidSupplierId] = useState("");
  const [bidPrice, setBidPrice] = useState("50000");
  const [bidLeadDays, setBidLeadDays] = useState("7");
  const [bidNotes, setBidNotes] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rfqList, itemList, suppList] = await Promise.all([
        api.scmRfqs(token),
        api.scmItems(token),
        api.suppliers(token),
      ]);
      setRfqs(rfqList);
      setItems(itemList);
      setSuppliers(suppList);

      if (itemList.length > 0 && !rfqItemId) setRfqItemId(itemList[0].id);
      if (suppList.length > 0 && !bidSupplierId) setBidSupplierId(suppList[0].id);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.proc.msg.failedToLoadProcurementData"));
    } finally {
      setLoading(false);
    }
  }, [token, rfqItemId, bidSupplierId, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const suppMap = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);

  async function handleCreateRfq(e: React.FormEvent) {
    e.preventDefault();
    if (!rfqTitle.trim() || !rfqItemId || Number(rfqQty) <= 0 || !rfqDeadline) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmRfq(token, {
        title: rfqTitle.trim(),
        procurementType: "rfq",
        // API wants a full date-time; the deadline is the end of the chosen local day.
        submissionDeadline: new Date(`${rfqDeadline}T23:59:59`).toISOString(),
        notes: rfqSpec.trim() || null,
        items: [
          {
            itemId: rfqItemId,
            targetQuantity: Number(rfqQty),
            specifications: rfqSpec.trim() || null,
          },
        ],
      });
      setNotice(t("scm.proc.msg.rfqPublishedSuccessfully"));
      setRfqTitle("");
      setRfqSpec("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.proc.msg.failedToCreateRfq"));
    } finally {
      setBusy(false);
    }
  }

  async function openRfqDetail(id: string) {
    setBusy(true);
    setError(null);
    try {
      const dt = await api.scmRfq(token, id);
      setSelectedRfqDetail(dt);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.proc.msg.failedToLoadRfqDetail"));
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitBid(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRfqDetail || !bidSupplierId || selectedRfqDetail.items.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const item0 = selectedRfqDetail.items[0];
      const qty = item0.targetQuantity;
      const unit = Number(bidPrice);
      await api.submitScmSupplierBid(token, {
        rfqId: selectedRfqDetail.rfq.id,
        supplierId: bidSupplierId,
        leadTimeDays: Number(bidLeadDays),
        validUntil: selectedRfqDetail.rfq.submissionDeadline,
        notes: bidNotes.trim() || null,
        lines: [
          {
            rfqItemId: item0.id,
            offeredQuantity: qty,
            offeredUnitPrice: unit,
            offeredTotalPrice: qty * unit,
            remarks: "Standard quote",
          },
        ],
      });
      setNotice(t("scm.proc.msg.supplierBidRecorded"));
      setBidNotes("");
      const updated = await api.scmRfq(token, selectedRfqDetail.rfq.id);
      setSelectedRfqDetail(updated);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.proc.msg.failedToSubmitSupplierBid"));
    } finally {
      setBusy(false);
    }
  }

  async function handleAwardBid(bidId: string) {
    if (!selectedRfqDetail) return;
    setBusy(true);
    setError(null);
    try {
      await api.awardScmSupplierBid(token, { bidId });
      setNotice(t("scm.proc.msg.bidAwardedSuccessfully"));
      await loadData();
      const updated = await api.scmRfq(token, selectedRfqDetail.rfq.id);
      setSelectedRfqDetail(updated);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.proc.msg.failedToAwardBid"));
    } finally {
      setBusy(false);
    }
  }

  const rfqColumns: Column<ScmRfq>[] = [
    { header: "RFQ #", cell: (r) => <span className="font-mono font-semibold">{r.rfqNumber}</span>, mobileRole: "title" },
    { header: t("scm.proc.h.title"), cell: (r) => r.title },
    { header: t("scm.proc.h.deadline"), cell: (r) => formatDateShort(r.submissionDeadline) },
    { header: t("scm.proc.h.status"), cell: (r) => <StatusPill tone={r.status === "awarded" ? "success" : r.status === "in_evaluation" ? "info" : "warning"}>{label(r.status)}</StatusPill>, mobileRole: "status" },
    {
      header: t("scm.proc.h.action"),
      cell: (r) => <Button variant="secondary" onClick={() => openRfqDetail(r.id)}>{t("scm.proc.t.inspectCompare")}</Button>,
    },
  ];

  const bidColumns: Column<ScmSupplierBid>[] = [
    { header: t("scm.proc.h.supplier"), cell: (b) => suppMap.get(b.supplierId)?.name || b.supplierId, mobileRole: "title" },
    { header: t("scm.proc.h.quotedTotal"), cell: (b) => <span className="font-mono font-bold text-slate-800">{formatMoney(b.totalAmount)}</span> },
    { header: t("scm.proc.h.leadTime"), cell: (b) => `${b.leadTimeDays ?? "—"} days` },
    { header: t("scm.proc.h.finalScore"), cell: (b) => b.finalScore != null ? <Badge>{b.finalScore} / 100</Badge> : "—" },
    { header: t("scm.proc.h.status"), cell: (b) => <StatusPill tone={b.status === "awarded" ? "success" : b.status === "rejected" ? "danger" : "neutral"}>{label(b.status)}</StatusPill>, mobileRole: "status" },
    {
      header: t("scm.proc.h.awardDecision"),
      cell: (b) =>
        selectedRfqDetail?.rfq.status !== "awarded" && b.status !== "awarded" ? (
          <Button variant="primary" onClick={() => handleAwardBid(b.id)} disabled={!canAward || busy}>{t("scm.proc.t.awardToPo")}</Button>
        ) : b.status === "awarded" ? (
          <span className="text-xs font-semibold text-emerald-600">✓ Awarded</span>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("scm.proc.title.rfqTenderManagement")}
        subtitle={t("scm.proc.sub.multiLineRfqPublicationSupplierQuotation")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {loading && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.proc.t.activeRfqsTenders")}</h3>
            <DataTable columns={rfqColumns} rows={rfqs} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.proc.n.noRfqsCreated")}</p>} />
          </Card>
        </div>
        <div>
          <Card>
            <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.proc.t.publishNewRfq")}</h3>
            <form onSubmit={handleCreateRfq} className="space-y-4">
              <Field label={t("scm.proc.f.rfqTitle")} required>
                <Input value={rfqTitle} onChange={(e) => setRfqTitle(e.target.value)} placeholder={t("scm.proc.p.procurementOfServerRacks")} disabled={!canManage || busy} />
              </Field>
              <Field label={t("scm.proc.f.submissionDeadline")} required>
                <Input type="date" value={rfqDeadline} onChange={(e) => setRfqDeadline(e.target.value)} disabled={!canManage || busy} />
              </Field>
              <Field label={t("scm.proc.f.targetItem")} required>
                <Select value={rfqItemId} onChange={(e) => setRfqItemId(e.target.value)} disabled={!canManage || busy}>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}
                </Select>
              </Field>
              <Field label={t("scm.proc.f.quantityRequired")} required>
                <Input type="number" min="1" value={rfqQty} onChange={(e) => setRfqQty(e.target.value)} disabled={!canManage || busy} />
              </Field>
              <Field label={t("scm.proc.f.technicalSpecification")}>
                <Input value={rfqSpec} onChange={(e) => setRfqSpec(e.target.value)} placeholder={t("scm.proc.p.minimum42uDualPdu")} disabled={!canManage || busy} />
              </Field>
              <Button type="submit" variant="primary" disabled={!canManage || busy || !rfqTitle.trim() || !rfqItemId || Number(rfqQty) <= 0 || !rfqDeadline}>{t("scm.proc.t.publishRfq")}</Button>
            </form>
          </Card>
        </div>
      </div>

      {selectedRfqDetail && (
        <Card>
          <h3 className="text-base font-semibold text-slate-900 mb-3">{`RFQ Comparative Bids: ${selectedRfqDetail.rfq.rfqNumber} — ${selectedRfqDetail.rfq.title}`}</h3>
          <div className="space-y-6">
            <div className="flex flex-wrap gap-6 text-sm">
              <div><strong>{t("scm.proc.f.status")}</strong> <StatusPill tone={selectedRfqDetail.rfq.status === "awarded" ? "success" : "info"}>{label(selectedRfqDetail.rfq.status)}</StatusPill></div>
              <div><strong>{t("scm.proc.f.deadline")}</strong> {formatDateShort(selectedRfqDetail.rfq.submissionDeadline)}</div>
            </div>

            <div>
              <h4 className="text-sm font-bold text-slate-800 mb-2">{t("scm.proc.t.requiredItems")}</h4>
              <DataTable
                columns={[
                  { header: t("scm.proc.h.item"), cell: (l) => itemMap.get(l.itemId)?.name || l.itemId, mobileRole: "title" },
                  { header: t("scm.proc.h.targetQty"), cell: (l) => l.targetQuantity },
                  { header: t("scm.proc.h.specification"), cell: (l) => l.specifications || "—", mobileRole: "status" },
                ]}
                rows={selectedRfqDetail.items}
                keyOf={(l) => l.id}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <h4 className="text-sm font-bold text-slate-800 mb-2">{t("scm.proc.t.supplierBidsReceived")}</h4>
                <DataTable columns={bidColumns} rows={selectedRfqDetail.bids} keyOf={(b) => b.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.proc.n.noSupplierBidsSubmittedForThisRfqYet")}</p>} />
              </div>
              <div>
                <Card>
                  <h4 className="text-sm font-bold text-slate-800 mb-3">{t("scm.proc.t.recordSupplierBid")}</h4>
                  <form onSubmit={handleSubmitBid} className="space-y-4">
                    <Field label={t("scm.proc.f.supplier")} required>
                      <Select value={bidSupplierId} onChange={(e) => setBidSupplierId(e.target.value)} disabled={!canManage || busy}>
                        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    </Field>
                    <Field label={t("scm.proc.f.unitPriceQuotedIdr")} required>
                      <Input type="number" value={bidPrice} onChange={(e) => setBidPrice(e.target.value)} disabled={!canManage || busy} />
                    </Field>
                    <Field label={t("scm.proc.f.leadTimeDays")} required>
                      <Input type="number" value={bidLeadDays} onChange={(e) => setBidLeadDays(e.target.value)} disabled={!canManage || busy} />
                    </Field>
                    <Field label={t("scm.proc.f.bidNotes")}>
                      <Input value={bidNotes} onChange={(e) => setBidNotes(e.target.value)} placeholder={t("scm.proc.p.includesFobShipping")} disabled={!canManage || busy} />
                    </Field>
                    <Button type="submit" variant="primary" disabled={!canManage || busy || selectedRfqDetail.rfq.status === "awarded"}>{t("scm.proc.t.submitBid")}</Button>
                  </form>
                </Card>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
