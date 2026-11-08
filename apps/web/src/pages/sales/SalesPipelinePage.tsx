/** Wave A1 — Customer & Commercial Advanced (CUS-ADV-001 / CUS-ADV-002). */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Customer,
  type OpportunityRecord,
  type OpportunityPipelineSummary,
  type OpportunityDetailRecord,
  type QuotationRecord,
  type QuotationDetailRecord,
  type PriceBookRecord,
  type PriceBookEntryRecord,
} from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
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

function stageTone(stageCode: string): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (stageCode) {
    case "closed":
      return "neutral";
    case "negotiation":
      return "warning";
    case "proposal":
      return "info";
    case "qualification":
    case "lead":
    default:
      return "neutral";
  }
}

function outcomeTone(outcome: string | null): "neutral" | "info" | "success" | "warning" | "danger" {
  if (outcome === "won") return "success";
  if (outcome === "lost" || outcome === "abandoned") return "danger";
  return "neutral";
}

function quotationStatusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "accepted":
      return "success";
    case "issued":
      return "info";
    case "submitted":
      return "warning";
    case "declined":
    case "withdrawn":
      return "danger";
    case "draft":
    default:
      return "neutral";
  }
}

export function SalesPipelinePage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();

  const [activeTab, setActiveTab] = useState<"pipeline" | "quotations" | "price-books">("pipeline");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityRecord[]>([]);
  const [pipelineSummaries, setPipelineSummaries] = useState<OpportunityPipelineSummary[]>([]);
  const [selectedOppId, setSelectedOppId] = useState<string | null>(null);
  const [opportunityDetail, setOpportunityDetail] = useState<OpportunityDetailRecord | null>(null);

  const [quotations, setQuotations] = useState<QuotationRecord[]>([]);
  const [selectedQuotationId, setSelectedQuotationId] = useState<string | null>(null);
  const [quotationDetail, setQuotationDetail] = useState<QuotationDetailRecord | null>(null);

  const [priceBooks, setPriceBooks] = useState<PriceBookRecord[]>([]);
  const [selectedPriceBookId, setSelectedPriceBookId] = useState<string | null>(null);
  const [priceBookEntries, setPriceBookEntries] = useState<PriceBookEntryRecord[]>([]);

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "error" | "success" | "info"; text: string } | null>(null);

  const [filterOutcome, setFilterOutcome] = useState<string>("");
  const [filterStage, setFilterStage] = useState<string>("");

  const canManageSales = permissions.includes("sales.manage");
  const canApproveSales = permissions.includes("sales.approve");

  const loadData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [meRes, custRes, oppsRes, pipeRes, quotesRes, pbooksRes] = await Promise.all([
        api.me(token),
        api.customers(token).catch(() => [] as Customer[]),
        api.opportunities(token, {
          outcome: filterOutcome || undefined,
          stageCode: filterStage || undefined,
        }).catch(() => [] as OpportunityRecord[]),
        api.opportunityPipeline(token).catch(() => [] as OpportunityPipelineSummary[]),
        api.quotations(token).catch(() => [] as QuotationRecord[]),
        api.priceBooks(token).catch(() => [] as PriceBookRecord[]),
      ]);

      setPermissions(meRes.permissions ?? []);
      setCustomers(custRes);
      setOpportunities(oppsRes);
      setPipelineSummaries(pipeRes);
      setQuotations(quotesRes);
      setPriceBooks(pbooksRes);
      if (pbooksRes.length > 0 && !selectedPriceBookId) {
        setSelectedPriceBookId(pbooksRes[0].id);
      }
    } catch (err) {
      const text = err instanceof ApiError ? err.message : t("sc.sales.msg.failedToLoadSalesData");
      setMessage({ type: "error", text });
    } finally {
      setLoading(false);
    }
  }, [token, filterOutcome, filterStage, selectedPriceBookId, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load opportunity detail
  useEffect(() => {
    if (!selectedOppId) {
      setOpportunityDetail(null);
      return;
    }
    api.opportunity(token, selectedOppId)
      .then((detail) => setOpportunityDetail(detail))
      .catch((err) => {
        setMessage({
          type: "error",
          text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToLoadOpportunityDetail"),
        });
      });
  }, [token, selectedOppId, t]);

  // Load quotation detail
  useEffect(() => {
    if (!selectedQuotationId) {
      setQuotationDetail(null);
      return;
    }
    api.quotation(token, selectedQuotationId)
      .then((detail) => setQuotationDetail(detail))
      .catch((err) => {
        setMessage({
          type: "error",
          text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToLoadQuotationDetail"),
        });
      });
  }, [token, selectedQuotationId, t]);

  // Load price book entries
  useEffect(() => {
    if (!selectedPriceBookId) {
      setPriceBookEntries([]);
      return;
    }
    api.priceBookEntries(token, selectedPriceBookId)
      .then((entries) => setPriceBookEntries(entries))
      .catch((err) => {
        setMessage({
          type: "error",
          text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToLoadPriceBookEntries"),
        });
      });
  }, [token, selectedPriceBookId, t]);

  // Handle Create Opportunity
  async function handleCreateOpportunity(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.createOpportunity(token, {
        code: String(form.get("code")).trim(),
        title: String(form.get("title")).trim(),
        customerId: String(form.get("customerId")),
        leadSource: String(form.get("leadSource") || "inbound"),
        stageCode: String(form.get("stageCode") || "lead"),
        estimatedValue: form.get("estimatedValue") ? Number(form.get("estimatedValue")) : null,
        currency: String(form.get("currency") || "IDR"),
        confidencePercent: form.get("confidencePercent") ? Number(form.get("confidencePercent")) : null,
        targetCloseDate: form.get("targetCloseDate") ? String(form.get("targetCloseDate")) : null,
      });
      setMessage({ type: "success", text: "Opportunity created successfully." });
      (e.target as HTMLFormElement).reset();
      loadData();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToCreateOpportunity"),
      });
    }
  }

  // Handle Opportunity Stage Transition
  async function handleStageChange(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedOppId) return;
    const form = new FormData(e.currentTarget);
    try {
      const stageCode = String(form.get("stageCode"));
      const outcome = form.get("outcome") ? String(form.get("outcome")) : undefined;
      const outcomeReason = form.get("outcomeReason") ? String(form.get("outcomeReason")) : undefined;
      const note = form.get("note") ? String(form.get("note")) : undefined;

      await api.changeOpportunityStage(token, selectedOppId, {
        stageCode,
        outcome: outcome || undefined,
        outcomeReason,
        note,
      });
      setMessage({ type: "success", text: "Opportunity stage updated." });
      const updated = await api.opportunity(token, selectedOppId);
      setOpportunityDetail(updated);
      loadData();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToUpdateOpportunityStage"),
      });
    }
  }

  // Handle Create Quotation
  async function handleCreateQuotation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      const lineItems = [
        {
          description: String(form.get("itemDescription") || "Primary Service"),
          unitPrice: Number(form.get("unitPrice") || 0),
          quantity: Number(form.get("quantity") || 1),
          discountPercent: Number(form.get("discountPercent") || 0),
        },
      ];

      await api.createQuotation(token, {
        code: String(form.get("code")).trim(),
        opportunityId: form.get("opportunityId") ? String(form.get("opportunityId")) : null,
        customerId: String(form.get("customerId")),
        priceBookId: form.get("priceBookId") ? String(form.get("priceBookId")) : null,
        currency: String(form.get("currency") || "IDR"),
        validUntil: form.get("validUntil") ? String(form.get("validUntil")) : null,
        items: lineItems,
      });
      setMessage({ type: "success", text: "Quotation drafted successfully." });
      (e.target as HTMLFormElement).reset();
      loadData();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToCreateQuotation"),
      });
    }
  }

  // Handle Submit Quotation
  const handleSubmitQuotation = useCallback(async (id: string) => {
    try {
      await api.submitQuotationForApproval(token, id);
      setMessage({ type: "success", text: "Quotation submitted for review." });
      loadData();
      if (selectedQuotationId === id) {
        const updated = await api.quotation(token, id);
        setQuotationDetail(updated);
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToSubmitQuotation"),
      });
    }
  }, [loadData, selectedQuotationId, token, t]);

  // Handle Approve Quotation
  const handleApproveQuotation = useCallback(async (id: string, decision: "issued" | "withdrawn") => {
    try {
      await api.recordQuotationApproval(token, id, decision);
      setMessage({ type: "success", text: `Quotation ${decision}.` });
      loadData();
      if (selectedQuotationId === id) {
        const updated = await api.quotation(token, id);
        setQuotationDetail(updated);
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToUpdateQuotationApproval"),
      });
    }
  }, [loadData, selectedQuotationId, token, t]);

  // Handle Customer Decision
  const handleCustomerDecision = useCallback(async (id: string, decision: "accepted" | "declined") => {
    try {
      await api.recordQuotationCustomerDecision(token, id, { decision });
      setMessage({ type: "success", text: `Customer decision recorded: ${decision}.` });
      loadData();
      if (selectedQuotationId === id) {
        const updated = await api.quotation(token, id);
        setQuotationDetail(updated);
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToRecordCustomerDecision"),
      });
    }
  }, [loadData, selectedQuotationId, token, t]);

  // Handle Create Price Book
  async function handleCreatePriceBook(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      const created = await api.createPriceBook(token, {
        code: String(form.get("code")).trim(),
        name: String(form.get("name")).trim(),
        currency: String(form.get("currency") || "IDR"),
        isStandard: form.get("isStandard") === "true",
      });
      setMessage({ type: "success", text: "Price Book created." });
      (e.target as HTMLFormElement).reset();
      setSelectedPriceBookId(created.id);
      loadData();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToCreatePriceBook"),
      });
    }
  }

  // Handle Add Entry to Price Book
  async function handleAddPriceBookEntry(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedPriceBookId) return;
    const form = new FormData(e.currentTarget);
    try {
      await api.addPriceBookEntry(token, selectedPriceBookId, {
        itemSku: String(form.get("itemSku")).trim(),
        unitPrice: Number(form.get("unitPrice")),
        minQuantity: Number(form.get("minQuantity") || 1),
        maxQuantity: form.get("maxQuantity") ? Number(form.get("maxQuantity")) : null,
        unitOfMeasure: String(form.get("unitOfMeasure") || "unit"),
      });
      setMessage({ type: "success", text: "Price book entry added." });
      (e.target as HTMLFormElement).reset();
      const entries = await api.priceBookEntries(token, selectedPriceBookId);
      setPriceBookEntries(entries);
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToAddPriceBookEntry"),
      });
    }
  }

  const oppColumns: Column<OpportunityRecord>[] = useMemo(
    () => [
      {
        header: t("sc.sales.h.codeTitle"),
        cell: (r: OpportunityRecord) => (
          <div>
            <div className="font-medium text-slate-900">{r.title}</div>
            <div className="text-xs text-slate-500">{r.code}</div>
          </div>
        ),
      },
      {
        header: t("sc.sales.h.stage"),
        cell: (r: OpportunityRecord) => (
          <div className="flex items-center gap-1.5">
            <StatusPill tone={stageTone(r.stageCode)}>{r.stageCode}</StatusPill>
            {r.outcome && <StatusPill tone={outcomeTone(r.outcome)}>{r.outcome}</StatusPill>}
          </div>
        ),
      },
      {
        header: t("sc.sales.h.estValue"),
        cell: (r: OpportunityRecord) =>
          r.estimatedValue !== null
            ? `${r.currency} ${Number(r.estimatedValue).toLocaleString()}`
            : "—",
      },
      {
        header: t("sc.sales.h.confidence"),
        cell: (r: OpportunityRecord) => (r.confidencePercent !== null ? `${r.confidencePercent}%` : "—"),
      },
      {
        header: t("sc.sales.h.targetClose"),
        cell: (r: OpportunityRecord) => r.targetCloseDate || "—",
      },
      {
        header: "",
        cell: (r: OpportunityRecord) => (
          <Button
            variant="secondary"
            className="text-xs py-1"
            onClick={() => setSelectedOppId(r.id)}
          >
            View Details
          </Button>
        ),
      },
    ],
    [t],
  );

  const quoteColumns: Column<QuotationRecord>[] = useMemo(
    () => [
      {
        header: t("sc.sales.h.quotationCode"),
        cell: (r: QuotationRecord) => (
          <div>
            <div className="font-medium text-slate-900">{r.code}</div>
            <div className="text-xs text-slate-500">v{r.revisionNumber}</div>
          </div>
        ),
      },
      {
        header: t("sc.sales.h.status"),
        cell: (r: QuotationRecord) => (
          <StatusPill tone={quotationStatusTone(r.status)}>{r.status}</StatusPill>
        ),
      },
      {
        header: t("sc.sales.h.totalAmount"),
        cell: (r: QuotationRecord) => `${r.currency} ${Number(r.totalAmount).toLocaleString()}`,
      },
      {
        header: t("sc.sales.h.validUntil"),
        cell: (r: QuotationRecord) => r.validUntil || "—",
      },
      {
        header: t("sc.sales.h.actions"),
        cell: (r: QuotationRecord) => (
          <div className="flex gap-1">
            <Button
              variant="secondary"
              className="text-xs py-1"
              onClick={() => setSelectedQuotationId(r.id)}
            >
              View
            </Button>
            {canManageSales && r.status === "draft" && (
              <Button
                variant="secondary"
                className="text-xs py-1"
                onClick={() => handleSubmitQuotation(r.id)}
              >
                Submit
              </Button>
            )}
            {canApproveSales && r.status === "submitted" && (
              <Button
                variant="primary"
                className="text-xs py-1"
                onClick={() => handleApproveQuotation(r.id, "issued")}
              >
                Approve (Issue)
              </Button>
            )}
            {r.status === "issued" && (
              <Button
                variant="secondary"
                className="text-xs py-1 text-emerald-700"
                onClick={() => handleCustomerDecision(r.id, "accepted")}
              >
                Accept
              </Button>
            )}
          </div>
        ),
      },
    ],
    [
      canManageSales,
      canApproveSales,
      handleApproveQuotation,
      handleCustomerDecision,
      handleSubmitQuotation,
      t,
    ],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("sc.sales.title.salesPipeline")}
        subtitle={t("sc.sales.sub.manageCommercialOpportunitiesStagePipeli")}
      />

      {message && (
        <Alert tone={message.type === "error" ? "error" : message.type === "success" ? "success" : "info"}>
          {message.text}
        </Alert>
      )}

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex space-x-6">
          <button
            onClick={() => setActiveTab("pipeline")}
            className={`pb-3 text-sm font-medium border-b-2 ${
              activeTab === "pipeline"
                ? "border-slate-900 text-slate-900 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Opportunities & Pipeline
          </button>
          <button
            onClick={() => setActiveTab("quotations")}
            className={`pb-3 text-sm font-medium border-b-2 ${
              activeTab === "quotations"
                ? "border-slate-900 text-slate-900 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Quotations & Pricing
          </button>
          <button
            onClick={() => setActiveTab("price-books")}
            className={`pb-3 text-sm font-medium border-b-2 ${
              activeTab === "price-books"
                ? "border-slate-900 text-slate-900 font-semibold"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            Price Books & Volume Matrix
          </button>
        </nav>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <>
          {/* TAB 1: OPPORTUNITIES & PIPELINE */}
          {activeTab === "pipeline" && (
            <div className="space-y-6">
              {/* Pipeline summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {pipelineSummaries.map((pipe) => (
                  <Card key={pipe.stageCode} className="p-3">
                    <div className="text-xs font-bold text-slate-500r">
                      {pipe.stageCode}
                    </div>
                    <div className="text-xl font-bold text-slate-900 mt-1">
                      {pipe.count} <span className="text-xs font-normal text-slate-500">{t("sc.sales.t.deals")}</span>
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      IDR {Number(pipe.totalEstimatedValue || 0).toLocaleString()}
                    </div>
                  </Card>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Opportunities Table */}
                <div className="lg:col-span-2 space-y-4">
                  <div className="flex justify-between items-center gap-4">
                    <h3 className="text-base font-semibold text-slate-900">{t("sc.sales.t.opportunities")}</h3>
                    <div className="flex gap-2">
                      <Select
                        className="text-xs py-1"
                        value={filterStage}
                        onChange={(e) => setFilterStage(e.target.value)}
                      >
                        <option value="">{t("sc.sales.t.allStages")}</option>
                        <option value="lead">{t("sc.sales.t.lead")}</option>
                        <option value="qualification">{t("sc.sales.t.qualification")}</option>
                        <option value="proposal">{t("sc.sales.t.proposal")}</option>
                        <option value="negotiation">{t("sc.sales.t.negotiation")}</option>
                        <option value="closed">{t("sc.sales.t.closed")}</option>
                      </Select>
                      <Select
                        className="text-xs py-1"
                        value={filterOutcome}
                        onChange={(e) => setFilterOutcome(e.target.value)}
                      >
                        <option value="">{t("sc.sales.t.allOutcomes")}</option>
                        <option value="won">{t("sc.sales.t.won")}</option>
                        <option value="lost">{t("sc.sales.t.lost")}</option>
                        <option value="abandoned">{t("sc.sales.t.abandoned")}</option>
                      </Select>
                    </div>
                  </div>

                  <DataTable
                    columns={oppColumns}
                    rows={opportunities}
                    keyOf={(r) => r.id}
                    empty={<div className="p-6 text-center text-sm text-slate-500">{t("sc.sales.t.noOpportunitiesFound")}</div>}
                  />
                </div>

                {/* Right side: Detail or Create Form */}
                <div className="space-y-6">
                  {selectedOppId && opportunityDetail ? (
                    <Card className="space-y-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="font-semibold text-slate-900 text-lg">
                            {opportunityDetail.opportunity.title}
                          </h4>
                          <p className="text-xs text-slate-500">
                            {opportunityDetail.opportunity.code}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          className="text-xs"
                          onClick={() => setSelectedOppId(null)}
                        >
                          Close
                        </Button>
                      </div>

                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between py-1 border-b border-slate-100">
                          <span className="text-slate-500">{t("sc.sales.t.customer")}</span>
                          <span className="font-medium text-slate-800">
                            {opportunityDetail.customer?.name ?? "—"}
                          </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-slate-100">
                          <span className="text-slate-500">{t("sc.sales.t.stage")}</span>
                          <StatusPill tone={stageTone(opportunityDetail.opportunity.stageCode)}>
                            {opportunityDetail.opportunity.stageCode}
                          </StatusPill>
                        </div>
                        {opportunityDetail.opportunity.outcome && (
                          <div className="flex justify-between py-1 border-b border-slate-100">
                            <span className="text-slate-500">{t("sc.sales.t.outcome")}</span>
                            <StatusPill tone={outcomeTone(opportunityDetail.opportunity.outcome)}>
                              {opportunityDetail.opportunity.outcome}
                            </StatusPill>
                          </div>
                        )}
                        <div className="flex justify-between py-1 border-b border-slate-100">
                          <span className="text-slate-500">{t("sc.sales.t.estValue")}</span>
                          <span className="font-medium text-slate-800">
                            {opportunityDetail.opportunity.estimatedValue
                              ? `${opportunityDetail.opportunity.currency} ${Number(
                                  opportunityDetail.opportunity.estimatedValue,
                                ).toLocaleString()}`
                              : "—"}
                          </span>
                        </div>
                      </div>

                      {/* Stage Transition Form */}
                      {canManageSales && (
                        <form onSubmit={handleStageChange} className="space-y-3 pt-2 border-t border-slate-200">
                          <div className="text-xs font-bold text-slate-600">
                            Advance Stage
                          </div>
                          <Field label={t("sc.sales.f.targetStage")}>
                            <Select name="stageCode" defaultValue={opportunityDetail.opportunity.stageCode}>
                              <option value="lead">{t("sc.sales.t.lead")}</option>
                              <option value="qualification">{t("sc.sales.t.qualification")}</option>
                              <option value="proposal">{t("sc.sales.t.proposal")}</option>
                              <option value="negotiation">{t("sc.sales.t.negotiation")}</option>
                              <option value="closed">{t("sc.sales.t.closed")}</option>
                            </Select>
                          </Field>
                          <Field label={t("sc.sales.f.outcomeIfClosing")}>
                            <Select name="outcome">
                              <option value="">{t("sc.sales.t.inProgress")}</option>
                              <option value="won">{t("sc.sales.t.won")}</option>
                              <option value="lost">{t("sc.sales.t.lost")}</option>
                              <option value="abandoned">{t("sc.sales.t.abandoned")}</option>
                            </Select>
                          </Field>
                          <Field label={t("sc.sales.f.noteOutcomeReason")}>
                            <Input name="note" placeholder={t("sc.sales.p.stageTransitionRationale")} />
                          </Field>
                          <Button type="submit" variant="primary" className="w-full">
              {t("sc.sales.t.updateStage")}
              </Button>
                        </form>
                      )}

                      {/* Stage History */}
                      <div className="pt-3 border-t border-slate-200 space-y-2">
                        <div className="text-xs font-bold text-slate-600">
                          Stage Timeline
                        </div>
                        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                          {opportunityDetail.stageHistory.map((hist) => (
                            <div key={hist.id} className="text-xs p-2 bg-slate-50 rounded border border-slate-100">
                              <div className="flex justify-between font-medium text-slate-700">
                                <span>{hist.fromStageCode || "start"} → {hist.toStageCode}</span>
                                <span>{new Date(hist.changedAt).toLocaleDateString()}</span>
                              </div>
                              {hist.note && <div className="text-slate-500 mt-1">{hist.note}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </Card>
                  ) : canManageSales ? (
                    <Card className="space-y-4">
                      <h4 className="font-semibold text-slate-900">{t("sc.sales.t.newOpportunity")}</h4>
                      <form onSubmit={handleCreateOpportunity} className="space-y-3">
                        <Field label={t("sc.sales.f.code")} required>
                          <Input name="code" placeholder="OPP-2026-001" required />
                        </Field>
                        <Field label={t("sc.sales.f.title")} required>
                          <Input name="title" placeholder={t("sc.sales.p.annualFiberRenewal")} required />
                        </Field>
                        <Field label={t("sc.sales.f.customer")} required>
                          <Select name="customerId" required>
                            <option value="">{t("sc.sales.t.selectCustomer")}</option>
                            {customers.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} ({c.code})
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t("sc.sales.f.estimatedValue")}>
                          <Input type="number" name="estimatedValue" placeholder="150000000" />
                        </Field>
                        <Field label={t("sc.sales.f.confidence")}>
                          <Input type="number" name="confidencePercent" placeholder="75" min="0" max="100" />
                        </Field>
                        <Field label={t("sc.sales.f.targetCloseDate")}>
                          <Input type="date" name="targetCloseDate" />
                        </Field>
                        <Button type="submit" variant="primary" className="w-full">
              {t("sc.sales.t.createOpportunity")}
              </Button>
                      </form>
                    </Card>
                  ) : null}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: QUOTATIONS & PRICING */}
          {activeTab === "quotations" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-4">
                <h3 className="text-base font-semibold text-slate-900">{t("sc.sales.t.quotations")}</h3>
                <DataTable
                  columns={quoteColumns}
                  rows={quotations}
                  keyOf={(r) => r.id}
                  empty={<div className="p-6 text-center text-sm text-slate-500">{t("sc.sales.t.noQuotationsGeneratedYet")}</div>}
                />
              </div>

              <div className="space-y-6">
                {selectedQuotationId && quotationDetail ? (
                  <Card className="space-y-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-semibold text-slate-900 text-lg">
                          {quotationDetail.quotation.code}
                        </h4>
                        <p className="text-xs text-slate-500">
                          Revision #{quotationDetail.quotation.revisionNumber}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="text-xs"
                        onClick={() => setSelectedQuotationId(null)}
                      >
                        Close
                      </Button>
                    </div>

                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sc.sales.t.customer")}</span>
                        <span className="font-medium text-slate-800">
                          {quotationDetail.customer?.name ?? "—"}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sc.sales.t.status")}</span>
                        <StatusPill tone={quotationStatusTone(quotationDetail.quotation.status)}>
                          {quotationDetail.quotation.status}
                        </StatusPill>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sc.sales.t.total")}</span>
                        <span className="font-bold text-slate-900">
                          {quotationDetail.quotation.currency}{" "}
                          {Number(quotationDetail.quotation.totalAmount).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* Line Items */}
                    <div className="pt-2 border-t border-slate-200">
                      <div className="text-xs font-bold text-slate-600 mb-2">
                        Line Items
                      </div>
                      <div className="space-y-2">
                        {quotationDetail.items.map((item) => (
                          <div
                            key={item.id}
                            className="p-2.5 bg-slate-50 rounded border border-slate-200 text-xs flex justify-between items-center"
                          >
                            <div>
                              <div className="font-medium text-slate-800">
                                {item.description}
                              </div>
                              <div className="text-slate-500">
                                {item.quantity} x {Number(item.unitPrice).toLocaleString()} (disc: {item.discountPercent}%)
                              </div>
                            </div>
                            <div className="font-semibold text-slate-900">
                              {Number(item.lineTotal).toLocaleString()}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>
                ) : canManageSales ? (
                  <Card className="space-y-4">
                    <h4 className="font-semibold text-slate-900">{t("sc.sales.t.draftQuotation")}</h4>
                    <form onSubmit={handleCreateQuotation} className="space-y-3">
                      <Field label={t("sc.sales.f.quotationCode")} required>
                        <Input name="code" placeholder="QUO-2026-001" required />
                      </Field>
                      <Field label={t("sc.sales.f.customer")} required>
                        <Select name="customerId" required>
                          <option value="">{t("sc.sales.t.selectCustomer")}</option>
                          {customers.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("sc.sales.f.opportunityOptional")}>
                        <Select name="opportunityId">
                          <option value="">{t("sc.sales.t.none")}</option>
                          {opportunities.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.code} - {o.title}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("sc.sales.f.priceBookOptional")}>
                        <Select name="priceBookId">
                          <option value="">{t("sc.sales.t.standardCatalog")}</option>
                          {priceBooks.map((pb) => (
                            <option key={pb.id} value={pb.id}>
                              {pb.name} ({pb.currency})
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("sc.sales.f.itemDescription")} required>
                        <Input name="itemDescription" placeholder={t("sc.sales.p.dedicated1gbpsBandwidth")} required />
                      </Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label={t("sc.sales.f.unitPrice")} required>
                          <Input type="number" name="unitPrice" placeholder="25000000" required />
                        </Field>
                        <Field label={t("sc.sales.f.quantity")} required>
                          <Input type="number" name="quantity" defaultValue="1" min="1" required />
                        </Field>
                      </div>
                      <Field label={t("sc.sales.f.discount")}>
                        <Input type="number" name="discountPercent" defaultValue="0" min="0" max="100" />
                      </Field>
                      <Field label={t("sc.sales.f.validUntil")}>
                        <Input type="date" name="validUntil" />
                      </Field>
                      <Button type="submit" variant="primary" className="w-full">
              {t("sc.sales.t.createQuotation")}
              </Button>
                    </form>
                  </Card>
                ) : null}
              </div>
            </div>
          )}

          {/* TAB 3: PRICE BOOKS & VOLUME MATRIX */}
          {activeTab === "price-books" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column: Price Books List */}
              <div className="space-y-4">
                <h3 className="text-base font-semibold text-slate-900">{t("sc.sales.t.priceBooks")}</h3>
                <div className="space-y-2">
                  {priceBooks.map((pb) => (
                    <div
                      key={pb.id}
                      onClick={() => setSelectedPriceBookId(pb.id)}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedPriceBookId === pb.id
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="font-semibold text-slate-900">{pb.name}</div>
                        {pb.isStandard && (
                          <StatusPill tone="info">{t("sc.sales.t.standard")}</StatusPill>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        Code: {pb.code} | Currency: {pb.currency}
                      </div>
                    </div>
                  ))}
                </div>

                {canManageSales && (
                  <Card className="space-y-3 mt-4">
                    <div className="font-semibold text-slate-900 text-sm">{t("sc.sales.t.addPriceBook")}</div>
                    <form onSubmit={handleCreatePriceBook} className="space-y-2">
                      <Input name="code" placeholder={t("sc.sales.p.codeEGPbEnt2026")} required />
                      <Input name="name" placeholder={t("sc.sales.p.nameEGEnterpriseTier")} required />
                      <Input name="currency" placeholder={t("sc.sales.p.currencyEGIdr")} defaultValue="IDR" required />
                      <Button type="submit" variant="secondary" className="w-full text-xs">
              {t("sc.sales.t.createPriceBook")}
              </Button>
                    </form>
                  </Card>
                )}
              </div>

              {/* Right Columns: Entries for selected price book */}
              <div className="lg:col-span-2 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-base font-semibold text-slate-900">{t("sc.sales.t.volumePriceMatrix")}</h3>
                </div>

                {selectedPriceBookId ? (
                  <div className="space-y-4">
                    <Card className="p-0 overflow-hidden">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                          <tr>
                            <th className="p-3">SKU</th>
                            <th className="p-3">{t("sc.sales.h.unitPrice")}</th>
                            <th className="p-3">{t("sc.sales.h.minQty")}</th>
                            <th className="p-3">{t("sc.sales.h.maxQty")}</th>
                            <th className="p-3">UOM</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {priceBookEntries.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="p-4 text-center text-slate-400 text-xs">
                                No entries configured for this price book.
                              </td>
                            </tr>
                          ) : (
                            priceBookEntries.map((entry) => (
                              <tr key={entry.id}>
                                <td className="p-3 font-medium text-slate-900">{entry.itemSku}</td>
                                <td className="p-3">
                                  {Number(entry.unitPrice).toLocaleString()}
                                </td>
                                <td className="p-3">{entry.minQuantity}</td>
                                <td className="p-3">{entry.maxQuantity ?? "∞"}</td>
                                <td className="p-3 text-slate-500">{entry.unitOfMeasure}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </Card>

                    {canManageSales && (
                      <Card className="space-y-3">
                        <div className="font-semibold text-slate-900 text-sm">
                          Add Volume Entry to Selected Book
                        </div>
                        <form onSubmit={handleAddPriceBookEntry} className="grid grid-cols-2 md:grid-cols-5 gap-2">
                          <Input name="itemSku" placeholder={t("sc.sales.p.skuEGBw100m")} required />
                          <Input type="number" name="unitPrice" placeholder={t("sc.sales.p.unitPrice")} required />
                          <Input type="number" name="minQuantity" placeholder={t("sc.sales.p.minQty")} defaultValue="1" required />
                          <Input type="number" name="maxQuantity" placeholder={t("sc.sales.p.maxQtyOpt")} />
                          <Input name="unitOfMeasure" placeholder={t("sc.sales.p.uomEGMbps")} defaultValue="unit" required />
                          <div className="col-span-2 md:col-span-5">
                            <Button type="submit" variant="primary" className="w-full text-xs">
              {t("sc.sales.t.addVolumePricingTier")}
              </Button>
                          </div>
                        </form>
                      </Card>
                    )}
                  </div>
                ) : (
                  <EmptyState title={t("sc.sales.title.selectAPriceBook")} description={t("sc.sales.d.chooseAPriceBookOnTheLeftToInspectItsVol")} />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
