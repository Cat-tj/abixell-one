/**
 * Wave A6 GAP #9 — Receiving & Quality.
 *
 * The receiving chain in one place: what arrived, what inspection released,
 * what was complained about, and what went back to the vendor.
 *
 * The number that matters at the end is the last column of the line table —
 * payment eligibility is `accepted - returned - reversed`, the same expression
 * the payment batch re-checks inside its own transaction. It is derived here
 * and never stored, so the screen cannot disagree with the server about what is
 * payable.
 *
 * A complaint and a return are deliberately separate actions: a complaint
 * records the business case and moves nothing, a return ships goods back and
 * consumes the line's returnable quantity.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ScmDiscrepancyRecord,
  type ScmDiscrepancyType,
  type ScmInspectionResult,
  type ScmItem,
  type ScmReceivingLine,
  type ScmReceivingRecord,
  type ScmReceivingRecordDetail,
  type ScmStockCondition,
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
  Select,
  Spinner,
  StatusPill,
  Textarea,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort } from "../../shared/format";

function label(value: string) {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** What the vendor can still be paid for on this line. */
function paymentEligible(line: ScmReceivingLine) {
  return line.quantityAccepted - line.quantityReturned - line.quantityReversed;
}

/** What can still be shipped back: rejected and quarantined goods included. */
function stillReturnable(line: ScmReceivingLine) {
  return line.quantityReceived - line.quantityReturned - line.quantityReversed;
}

const STATUS_TONE = {
  received: "info",
  partially_inspected: "warning",
  accepted: "success",
  rejected: "danger",
  reversed: "neutral",
} as const;

const RETURN_CONDITIONS: ScmStockCondition[] = ["rejected", "quarantined", "quality_hold", "unrestricted"];

export function ReceivingQualityPanel() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();
  const canManage = permissions.includes(PERMISSIONS.supplyChainInventoryManage);

  const [receipts, setReceipts] = useState<ScmReceivingRecord[]>([]);
  const [discrepancies, setDiscrepancies] = useState<ScmDiscrepancyRecord[]>([]);
  const [warehouses, setWarehouses] = useState<ScmWarehouse[]>([]);
  const [items, setItems] = useState<ScmItem[]>([]);
  const [selected, setSelected] = useState<ScmReceivingRecordDetail | null>(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Inspection form
  const [inspLineId, setInspLineId] = useState("");
  const [inspAccepted, setInspAccepted] = useState("0");
  const [inspRejected, setInspRejected] = useState("0");
  const [inspQuarantined, setInspQuarantined] = useState("0");
  const [inspResult, setInspResult] = useState<ScmInspectionResult>("accepted");
  const [inspReason, setInspReason] = useState("");

  // Complaint form
  const [cmpLineId, setCmpLineId] = useState("");
  const [cmpType, setCmpType] = useState<ScmDiscrepancyType>("quality");
  const [cmpQty, setCmpQty] = useState("");
  const [cmpDescription, setCmpDescription] = useState("");

  // Return form
  const [rtvLineId, setRtvLineId] = useState("");
  const [rtvQty, setRtvQty] = useState("");
  const [rtvCondition, setRtvCondition] = useState<ScmStockCondition>("rejected");
  const [rtvReason, setRtvReason] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [receiptList, discrepancyList, warehouseList, itemList] = await Promise.all([
        api.scmReceivingRecords(token),
        api.scmDiscrepancies(token, { status: "open" }),
        api.scmWarehouses(token),
        api.scmItems(token),
      ]);
      setReceipts(receiptList);
      setDiscrepancies(discrepancyList);
      setWarehouses(warehouseList);
      setItems(itemList);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.rq.msg.failedToLoadReceivingData"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const whMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);
  const lineMap = useMemo(
    () => new Map((selected?.lines ?? []).map((l) => [l.id, l])),
    [selected],
  );
  async function openReceipt(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const detail = await api.scmReceivingRecord(token, id);
      setSelected(detail);
      const first = detail.lines[0];
      setInspLineId(first?.id ?? "");
      setCmpLineId(first?.id ?? "");
      setRtvLineId(first?.id ?? "");
      setInspAccepted("0");
      setInspRejected("0");
      setInspQuarantined("0");
      setRtvQty("");
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.rq.msg.failedToLoadTheReceivingRecord"));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSelected() {
    if (!selected) return;
    const detail = await api.scmReceivingRecord(token, selected.receiving.id);
    setSelected(detail);
  }

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

  async function handleInspect(e: React.FormEvent) {
    e.preventDefault();
    if (
      !formOk(
        [inspLineId ? null : t("scm.rq.f.receivingLine")],
        [
          Number.isNaN(num(inspAccepted)) ? t("scm.rq.f.accepted") : null,
          Number.isNaN(num(inspRejected)) ? t("scm.rq.f.rejected") : null,
          Number.isNaN(num(inspQuarantined)) ? t("scm.rq.f.quarantined") : null,
        ],
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmInspection(token, {
        receivingLineId: inspLineId,
        idempotencyKey: crypto.randomUUID(),
        quantityAccepted: num(inspAccepted),
        quantityRejected: num(inspRejected),
        quantityQuarantined: num(inspQuarantined),
        result: inspResult,
        reason: inspReason.trim() || null,
      });
      setNotice(t("scm.rq.msg.inspectionRecordedTheLineSAcceptedQuanti"));
      setInspReason("");
      await Promise.all([refreshSelected(), loadData()]);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.rq.msg.failedToRecordTheInspection"));
    } finally {
      setBusy(false);
    }
  }

  async function handleComplaint(e: React.FormEvent) {
    e.preventDefault();
    if (
      !formOk(
        [cmpLineId ? null : t("scm.rq.f.receivingLine"), cmpDescription.trim() ? null : t("scm.rq.f.description")],
        [cmpQty.trim() && Number.isNaN(num(cmpQty)) ? t("scm.rq.f.quantity") : null],
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmDiscrepancy(token, {
        receivingLineId: cmpLineId,
        discrepancyType: cmpType,
        quantity: cmpQty.trim() ? num(cmpQty) : null,
        description: cmpDescription.trim(),
      });
      setNotice(t("scm.rq.msg.complaintRecordedNoStockMovedTheGoodsAre"));
      setCmpDescription("");
      setCmpQty("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.rq.msg.failedToRecordTheComplaint"));
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveComplaint(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.resolveScmDiscrepancy(token, id, { status: "resolved" });
      setNotice(t("scm.rq.msg.complaintResolved"));
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.rq.msg.failedToResolveTheComplaint"));
    } finally {
      setBusy(false);
    }
  }

  async function handleReturn(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const rtvQtyNum = num(rtvQty);
    if (
      !formOk(
        [
          rtvLineId ? null : t("scm.rq.f.receivingLine"),
          rtvQty.trim() === "" ? t("scm.rq.f.quantity") : null,
          rtvReason.trim() ? null : t("scm.rq.f.reason"),
        ],
        [rtvQty.trim() !== "" && !(rtvQtyNum > 0) ? t("scm.rq.f.quantity") : null],
      )
    )
      return;
    const line = lineMap.get(rtvLineId);
    if (!line) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmReturnToVendor(token, {
        idempotencyKey: crypto.randomUUID(),
        supplierId: selected.receiving.supplierId,
        purchaseOrderId: selected.receiving.purchaseOrderId,
        warehouseId: line.warehouseId,
        reason: rtvReason.trim(),
        lines: [
          {
            receivingLineId: line.id,
            itemId: line.itemId,
            warehouseId: line.warehouseId,
            locationId: line.locationId,
            stockCondition: rtvCondition,
            ownerType: line.ownerType,
            quantity: rtvQtyNum,
            sortOrder: 1,
          },
        ],
      });
      setNotice(t("scm.rq.msg.returnToVendorExecutedTheLineIsNoLongerP"));
      setRtvQty("");
      setRtvReason("");
      await Promise.all([refreshSelected(), loadData()]);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.rq.msg.failedToReturnGoodsToTheVendor"));
    } finally {
      setBusy(false);
    }
  }

  const receiptColumns: Column<ScmReceivingRecord>[] = [
    {
      header: t("scm.rq.h.receipt"),
      cell: (r) => <span className="font-mono font-semibold">{r.receiptNumber}</span>,
      mobileRole: "title",
    },
    { header: t("scm.rq.h.warehouse"), cell: (r) => whMap.get(r.warehouseId)?.name ?? r.warehouseId },
    { header: t("scm.rq.h.received"), cell: (r) => formatDateShort(r.receivedAt) },
    {
      header: t("scm.rq.h.status"),
      cell: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{label(r.status)}</StatusPill>,
      mobileRole: "status",
    },
    {
      header: t("scm.rq.h.open"),
      cell: (r) => (
        <Button variant="secondary" onClick={() => openReceipt(r.id)} disabled={busy}>
          Open
        </Button>
      ),
    },
  ];

  const lineColumns: Column<ScmReceivingLine>[] = [
    {
      header: t("scm.rq.h.item"),
      cell: (l) => itemMap.get(l.itemId)?.name ?? l.itemId,
      mobileRole: "title",
    },
    { header: t("scm.rq.h.received"), cell: (l) => <span className="font-mono">{l.quantityReceived}</span> },
    { header: t("scm.rq.h.accepted"), cell: (l) => <span className="font-mono">{l.quantityAccepted}</span> },
    {
      header: t("scm.rq.h.rejected"),
      cell: (l) => <span className="font-mono">{l.quantityRejected}</span>,
    },
    {
      header: t("scm.rq.h.quarantined"),
      cell: (l) => <span className="font-mono">{l.quantityQuarantined}</span>,
    },
    { header: t("scm.rq.h.returned"), cell: (l) => <span className="font-mono">{l.quantityReturned}</span> },
    { header: t("scm.rq.h.reversed"), cell: (l) => <span className="font-mono">{l.quantityReversed}</span> },
    {
      header: t("scm.rq.h.paymentEligible"),
      cell: (l) => {
        const eligible = paymentEligible(l);
        return (
          <span className={`font-mono font-semibold ${eligible > 0 ? "text-ink" : "text-ink-faint"}`}>
            {eligible}
          </span>
        );
      },
      mobileRole: "status",
    },
  ];

  const complaintColumns: Column<ScmDiscrepancyRecord>[] = [
    {
      header: t("scm.rq.h.item"),
      cell: (d) => {
        const line = lineMap.get(d.receivingLineId);
        return line ? (itemMap.get(line.itemId)?.name ?? line.itemId) : d.receivingLineId;
      },
      mobileRole: "title",
    },
    { header: t("scm.rq.h.type"), cell: (d) => label(d.discrepancyType) },
    { header: t("scm.rq.h.qty"), cell: (d) => <span className="font-mono">{d.quantity ?? "—"}</span> },
    { header: t("scm.rq.h.description"), cell: (d) => d.description },
    {
      header: t("scm.rq.h.status"),
      cell: (d) => (
        <StatusPill tone={d.status === "open" ? "warning" : "success"}>{label(d.status)}</StatusPill>
      ),
      mobileRole: "status",
    },
    {
      header: t("scm.rq.h.resolve"),
      cell: (d) =>
        d.status === "open" ? (
          <Button variant="secondary" onClick={() => handleResolveComplaint(d.id)} disabled={!canManage || busy}>
            Resolve
          </Button>
        ) : null,
    },
  ];

  if (loading) {
    return (
      <div className="flex justify-center p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <h3 className="mb-3 text-base font-semibold text-ink">{t("scm.rq.t.receivingRecords")}</h3>
        <DataTable
          columns={receiptColumns}
          rows={receipts}
          keyOf={(r) => r.id}
          empty={
            <p className="py-4 text-center text-sm text-ink-dim">
              No goods have been received yet. Receipts appear here once a purchase order is
              delivered against.
            </p>
          }
        />
      </Card>

      {selected && (
        <>
          <Card>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold text-ink">
                {`Receipt ${selected.receiving.receiptNumber}`}
              </h3>
              <StatusPill tone={STATUS_TONE[selected.receiving.status]}>
                {label(selected.receiving.status)}
              </StatusPill>
            </div>
            <DataTable
              columns={lineColumns}
              rows={selected.lines}
              keyOf={(l) => l.id}
              mobileBreakpoint="md"
              empty={<p className="py-4 text-center text-sm text-ink-dim">{t("scm.rq.n.thisReceiptHasNoLines")}</p>}
            />
            <p className="mt-3 text-xs text-ink-dim">
              Payment eligible = accepted − returned − reversed. A complaint does not change it; only
              an inspection or a return does.
            </p>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card>
              <h3 className="mb-3 text-base font-semibold text-ink">{t("scm.rq.t.recordInspection")}</h3>
              <form onSubmit={handleInspect} className="space-y-3">
                <Field label={t("scm.rq.f.receivingLine")} required>
                  <Select value={inspLineId} onChange={(e) => setInspLineId(e.target.value)} disabled={!canManage || busy}>
                    {selected.lines.map((l) => (
                      <option key={l.id} value={l.id}>
                        {`${itemMap.get(l.itemId)?.name ?? l.itemId} — ${l.quantityReceived} received`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-3 gap-2">
                  <Field label={t("scm.rq.f.accepted")}>
                    <Input type="number" min="0" step="any" value={inspAccepted} onChange={(e) => setInspAccepted(e.target.value)} disabled={!canManage || busy} />
                  </Field>
                  <Field label={t("scm.rq.f.rejected")}>
                    <Input type="number" min="0" step="any" value={inspRejected} onChange={(e) => setInspRejected(e.target.value)} disabled={!canManage || busy} />
                  </Field>
                  <Field label={t("scm.rq.f.quarantined")}>
                    <Input type="number" min="0" step="any" value={inspQuarantined} onChange={(e) => setInspQuarantined(e.target.value)} disabled={!canManage || busy} />
                  </Field>
                </div>
                <Field label={t("scm.rq.f.result")} required>
                  <Select value={inspResult} onChange={(e) => setInspResult(e.target.value as ScmInspectionResult)} disabled={!canManage || busy}>
                    <option value="accepted">{t("scm.rq.t.accepted")}</option>
                    <option value="rejected">{t("scm.rq.t.rejected")}</option>
                    <option value="mixed">{t("scm.rq.t.mixed")}</option>
                    <option value="quarantined">{t("scm.rq.t.quarantined")}</option>
                  </Select>
                </Field>
                <Field label={t("scm.rq.f.reason")}>
                  <Input value={inspReason} onChange={(e) => setInspReason(e.target.value)} placeholder={t("scm.rq.p.whyTheGoodsWereJudgedThisWay")} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>
              {t("scm.rq.t.saveInspection")}
              </Button>
              </form>
            </Card>

            <Card>
              <h3 className="mb-3 text-base font-semibold text-ink">{t("scm.rq.t.raiseAComplaint")}</h3>
              <form onSubmit={handleComplaint} className="space-y-3">
                <Field label={t("scm.rq.f.receivingLine")} required>
                  <Select value={cmpLineId} onChange={(e) => setCmpLineId(e.target.value)} disabled={!canManage || busy}>
                    {selected.lines.map((l) => (
                      <option key={l.id} value={l.id}>
                        {`${itemMap.get(l.itemId)?.name ?? l.itemId} — ${l.quantityReceived} received`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("scm.rq.f.type")} required>
                  <Select value={cmpType} onChange={(e) => setCmpType(e.target.value as ScmDiscrepancyType)} disabled={!canManage || busy}>
                    <option value="quality">{t("scm.rq.t.quality")}</option>
                    <option value="shortage">{t("scm.rq.t.shortage")}</option>
                    <option value="overage">{t("scm.rq.t.overage")}</option>
                    <option value="damage">{t("scm.rq.t.damage")}</option>
                    <option value="document">{t("scm.rq.t.document")}</option>
                  </Select>
                </Field>
                <Field label={t("scm.rq.f.quantity")}>
                  <Input type="number" min="0" step="any" value={cmpQty} onChange={(e) => setCmpQty(e.target.value)} placeholder={t("scm.rq.p.optional")} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.rq.f.description")} required>
                  <Textarea value={cmpDescription} onChange={(e) => setCmpDescription(e.target.value)} rows={3} placeholder={t("scm.rq.p.whatIsWrongAndWithWhichGoods")} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>
              {t("scm.rq.t.recordComplaint")}
              </Button>
              </form>
            </Card>

            <Card>
              <h3 className="mb-3 text-base font-semibold text-ink">{t("scm.rq.t.returnToVendor")}</h3>
              <form onSubmit={handleReturn} className="space-y-3">
                <Field label={t("scm.rq.f.receivingLine")} required>
                  <Select value={rtvLineId} onChange={(e) => setRtvLineId(e.target.value)} disabled={!canManage || busy}>
                    {selected.lines.map((l) => (
                      <option key={l.id} value={l.id}>
                        {`${itemMap.get(l.itemId)?.name ?? l.itemId} — ${stillReturnable(l)} returnable`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("scm.rq.f.quantity")} required>
                  <Input
                    type="number"
                    min="0.01"
                    step="any"
                    value={rtvQty}
                    onChange={(e) => setRtvQty(e.target.value)}
                    placeholder={rtvLineId && lineMap.get(rtvLineId) ? `Max ${stillReturnable(lineMap.get(rtvLineId)!)}` : ""}
                    disabled={!canManage || busy}
                  />
                </Field>
                <Field label={t("scm.rq.f.stockCondition")} required>
                  <Select value={rtvCondition} onChange={(e) => setRtvCondition(e.target.value as ScmStockCondition)} disabled={!canManage || busy}>
                    {RETURN_CONDITIONS.map((c) => (
                      <option key={c} value={c}>{label(c)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("scm.rq.f.reason")} required>
                  <Input value={rtvReason} onChange={(e) => setRtvReason(e.target.value)} placeholder={t("scm.rq.p.whyTheGoodsGoBack")} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>
              {t("scm.rq.t.shipBack")}
              </Button>
                <p className="text-xs text-ink-dim">
                  A return consumes the line's returnable quantity, so the same goods cannot be paid for
                  and shipped back.
                </p>
              </form>
            </Card>
          </div>

          <Card>
            <h3 className="mb-3 text-base font-semibold text-ink">{t("scm.rq.t.openComplaints")}</h3>
            <DataTable
              columns={complaintColumns}
              rows={discrepancies.filter((d) => lineMap.has(d.receivingLineId))}
              keyOf={(d) => d.id}
              empty={<p className="py-4 text-center text-sm text-ink-dim">{t("scm.rq.n.noOpenComplaintsOnThisReceipt")}</p>}
            />
          </Card>
        </>
      )}

      {!selected && !loading && (
        <Card>
          <p className="text-sm text-ink-dim">
            {receipts.length === 0
              ? "Open a purchase order delivery to start the receiving chain."
              : "Open a receipt above to inspect it, raise a complaint, or return goods to the vendor."}
          </p>
        </Card>
      )}

      {!canManage && (
        <Alert tone="info">
          You can read the receiving chain but not act on it. Recording an inspection, complaint, or
          return needs the inventory manage permission.
        </Alert>
      )}
    </div>
  );
}
