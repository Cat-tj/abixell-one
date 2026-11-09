/**
 * Wave A5 — Supplier Evaluation & Contract Purchasing (SCM-ADV-007).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type SupplierRecord,
  type ScmSupplierContract,
  type ScmSupplierEvaluation,
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

export function SupplierContractsPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();

  const canManage = permissions.includes(PERMISSIONS.supplyChainContractManage);
  const canApprove = permissions.includes(PERMISSIONS.supplyChainContractApprove);

  const [tab, setTab] = useState<"evaluations" | "contracts">("evaluations");
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [evaluations, setEvaluations] = useState<ScmSupplierEvaluation[]>([]);
  const [contracts, setContracts] = useState<ScmSupplierContract[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form states - Evaluation
  const [evalSuppId, setEvalSuppId] = useState("");
  const [evalPeriod, setEvalPeriod] = useState("2026-Q3");
  const [evalQuality, setEvalQuality] = useState("90");
  const [evalDelivery, setEvalDelivery] = useState("85");
  const [evalPricing, setEvalPricing] = useState("80");
  const [evalService, setEvalService] = useState("95");
  const [evalNotes, setEvalNotes] = useState("");

  // Form states - Contract
  const [ctrSuppId, setCtrSuppId] = useState("");
  const [ctrTitle, setCtrTitle] = useState("");
  const [ctrStart, setCtrStart] = useState(() => localDateInputValue());
  const [ctrEnd, setCtrEnd] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return localDateInputValue(d);
  });
  const [ctrCommitment, setCtrCommitment] = useState("500000000");
  const [ctrTerms, setCtrTerms] = useState("Annual master service & goods agreement");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [suppList, evalList, ctrList] = await Promise.all([
        api.suppliers(token),
        api.scmSupplierEvaluations(token),
        api.scmSupplierContracts(token),
      ]);
      setSuppliers(suppList);
      setEvaluations(evalList);
      setContracts(ctrList);

      if (suppList.length > 0 && !evalSuppId) setEvalSuppId(suppList[0].id);
      if (suppList.length > 0 && !ctrSuppId) setCtrSuppId(suppList[0].id);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.supplier.msg.failedToLoadSupplierContractsEvaluations"));
    } finally {
      setLoading(false);
    }
  }, [token, evalSuppId, ctrSuppId, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const suppMap = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);

  async function handleCreateEvaluation(e: React.FormEvent) {
    e.preventDefault();
    if (!evalSuppId || !evalPeriod.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmSupplierEvaluation(token, {
        supplierId: evalSuppId,
        evaluationPeriod: evalPeriod.trim(),
        periodStartDate: "2026-07-01",
        periodEndDate: "2026-09-30",
        qualityScore: Number(evalQuality),
        deliveryScore: Number(evalDelivery),
        pricingScore: Number(evalPricing),
        serviceScore: Number(evalService),
        notes: evalNotes.trim() || null,
      });
      setNotice(t("scm.supplier.msg.supplierScorecardEvaluated"));
      setEvalNotes("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.supplier.msg.failedToRecordSupplierEvaluation"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateContract(e: React.FormEvent) {
    e.preventDefault();
    if (!ctrSuppId || !ctrTitle.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmSupplierContract(token, {
        supplierId: ctrSuppId,
        title: ctrTitle.trim(),
        contractType: "blanket_po",
        startDate: ctrStart,
        endDate: ctrEnd,
        committedAmount: Number(ctrCommitment) || 0,
        termsAndConditions: ctrTerms.trim() || null,
        items: [],
      });
      setNotice(t("scm.supplier.msg.purchasingContractRegistered"));
      setCtrTitle("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.supplier.msg.failedToRegisterSupplierContract"));
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveContract(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.actOnScmSupplierContract(token, id, "approve", "Approved by authorized procurement officer");
      setNotice(t("scm.supplier.msg.supplierContractApproved"));
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.supplier.msg.failedToApproveSupplierContract"));
    } finally {
      setBusy(false);
    }
  }

  const evalColumns: Column<ScmSupplierEvaluation>[] = [
    { header: t("scm.supplier.h.supplier"), cell: (e) => suppMap.get(e.supplierId)?.name || e.supplierId, mobileRole: "title" },
    { header: t("scm.supplier.h.period"), cell: (e) => <span className="font-mono font-semibold">{e.evaluationPeriod}</span> },
    { header: t("scm.supplier.h.quality35"), cell: (e) => `${e.qualityScore}` },
    { header: t("scm.supplier.h.delivery30"), cell: (e) => `${e.deliveryScore}` },
    { header: t("scm.supplier.h.pricing20"), cell: (e) => `${e.pricingScore}` },
    { header: t("scm.supplier.h.service15"), cell: (e) => `${e.serviceScore}` },
    { header: t("scm.supplier.h.overallScore"), cell: (e) => <span className="font-mono font-bold">{e.overallScore.toFixed(1)}</span> },
    {
      header: t("scm.supplier.h.ratingGrade"),
      cell: (e) => <Badge className="bg-blue-50 text-blue-700">{t("scm.supplier.t.gradeN", { n: e.ratingGrade })}</Badge>,
      mobileRole: "status",
    },
  ];

  const contractColumns: Column<ScmSupplierContract>[] = [
    { header: t("scm.supplier.h.contract"), cell: (c) => <span className="font-mono font-semibold">{c.contractNumber}</span>, mobileRole: "title" },
    { header: t("scm.supplier.h.supplier"), cell: (c) => suppMap.get(c.supplierId)?.name || c.supplierId },
    { header: t("scm.supplier.h.contractTitle"), cell: (c) => c.title },
    { header: t("scm.supplier.h.validityPeriod"), cell: (c) => `${formatDateShort(c.startDate)} – ${formatDateShort(c.endDate)}` },
    { header: t("scm.supplier.h.committedAmount"), cell: (c) => <span className="font-mono font-bold text-slate-800">{formatMoney(c.committedAmount)}</span> },
    { header: t("scm.supplier.h.consumedSpend"), cell: (c) => <span className="font-mono text-emerald-600">{formatMoney(c.spentAmount)}</span> },
    { header: t("scm.supplier.h.status"), cell: (c) => <StatusPill tone={c.status === "active" ? "success" : c.status === "draft" ? "warning" : "neutral"}>{label(c.status)}</StatusPill>, mobileRole: "status" },
    {
      header: t("scm.supplier.h.actions"),
      cell: (c) =>
        c.status === "draft" ? (
          <Button variant="primary" onClick={() => handleApproveContract(c.id)} disabled={!canApprove || busy}>{t("scm.supplier.t.approve")}</Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("scm.supplier.title.supplierContractsEvaluations")}
        subtitle={t("scm.supplier.sub.supplierPerformanceScorecardEvaluationsK")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <Button variant={tab === "evaluations" ? "primary" : "secondary"} onClick={() => setTab("evaluations")}>{t("scm.supplier.t.supplierScorecards")}</Button>
        <Button variant={tab === "contracts" ? "primary" : "secondary"} onClick={() => setTab("contracts")}>{t("scm.supplier.t.purchasingContracts")}</Button>
      </div>

      {loading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : tab === "evaluations" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.supplier.t.supplierEvaluationScorecards")}</h3>
              <DataTable columns={evalColumns} rows={evaluations} keyOf={(e) => e.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.supplier.n.noSupplierEvaluationsRecorded")}</p>} />
            </Card>
          </div>
          <div>
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.supplier.t.conductSupplierEvaluation")}</h3>
              <form onSubmit={handleCreateEvaluation} className="space-y-4">
                <Field label={t("scm.supplier.f.supplier")} required>
                  <Select value={evalSuppId} onChange={(e) => setEvalSuppId(e.target.value)} disabled={!canManage || busy}>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.supplier.f.evaluationPeriod")} required>
                  <Input value={evalPeriod} onChange={(e) => setEvalPeriod(e.target.value)} placeholder={t("scm.supplier.p.eG2026Q3")} disabled={!canManage || busy} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t("scm.supplier.f.qualityScore0100")} required><Input type="number" min="0" max="100" value={evalQuality} onChange={(e) => setEvalQuality(e.target.value)} disabled={!canManage || busy} /></Field>
                  <Field label={t("scm.supplier.f.deliveryScore0100")} required><Input type="number" min="0" max="100" value={evalDelivery} onChange={(e) => setEvalDelivery(e.target.value)} disabled={!canManage || busy} /></Field>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t("scm.supplier.f.pricingScore0100")} required><Input type="number" min="0" max="100" value={evalPricing} onChange={(e) => setEvalPricing(e.target.value)} disabled={!canManage || busy} /></Field>
                  <Field label={t("scm.supplier.f.serviceScore0100")} required><Input type="number" min="0" max="100" value={evalService} onChange={(e) => setEvalService(e.target.value)} disabled={!canManage || busy} /></Field>
                </div>
                <Field label={t("scm.supplier.f.evaluationRemarks")}>
                  <Input value={evalNotes} onChange={(e) => setEvalNotes(e.target.value)} placeholder={t("scm.supplier.p.onTimeDeliveryPerformanceNotes")} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.supplier.t.submitScorecard")}</Button>
              </form>
            </Card>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.supplier.t.masterPurchasingContracts")}</h3>
              <DataTable columns={contractColumns} rows={contracts} keyOf={(c) => c.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.supplier.n.noPurchasingContractsRegistered")}</p>} />
            </Card>
          </div>
          <div>
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.supplier.t.registerPurchasingContract")}</h3>
              <form onSubmit={handleCreateContract} className="space-y-4">
                <Field label={t("scm.supplier.f.supplier")} required>
                  <Select value={ctrSuppId} onChange={(e) => setCtrSuppId(e.target.value)} disabled={!canManage || busy}>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.supplier.f.contractTitle")} required>
                  <Input value={ctrTitle} onChange={(e) => setCtrTitle(e.target.value)} placeholder={t("scm.supplier.p.annualRawMaterialSupply")} disabled={!canManage || busy} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t("scm.supplier.f.startDate")} required><Input type="date" value={ctrStart} onChange={(e) => setCtrStart(e.target.value)} disabled={!canManage || busy} /></Field>
                  <Field label={t("scm.supplier.f.endDate")} required><Input type="date" value={ctrEnd} onChange={(e) => setCtrEnd(e.target.value)} disabled={!canManage || busy} /></Field>
                </div>
                <Field label={t("scm.supplier.f.committedBudgetIdr")}>
                  <Input type="number" value={ctrCommitment} onChange={(e) => setCtrCommitment(e.target.value)} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.supplier.f.contractTerms")}>
                  <Input value={ctrTerms} onChange={(e) => setCtrTerms(e.target.value)} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.supplier.t.registerContract")}</Button>
              </form>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
