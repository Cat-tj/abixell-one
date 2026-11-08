/** Wave A1 — Customer & Commercial Advanced (CUS-ADV-001 / CUS-ADV-002). */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type Customer,
  type CommercialService,
  type OpportunityRecord,
  type OpportunityPipelineSummary,
  type OpportunityDetailRecord,
  type QuotationRecord,
  type QuotationDetailRecord,
  type PriceBookRecord,
  type PriceBookEntryRecord,
  type SalesOutcome,
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

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

type RefOption = { code: string; label: string };

const OUTCOMES: SalesOutcome[] = ["open", "won", "lost", "cancelled"];

function outcomeTone(outcome: string | null): Tone {
  if (outcome === "won") return "success";
  if (outcome === "lost") return "danger";
  if (outcome === "cancelled") return "warning";
  return "neutral";
}

function quotationStatusTone(status: string): Tone {
  switch (status) {
    case "accepted":
      return "success";
    case "issued":
      return "info";
    case "in_approval":
      return "warning";
    case "declined":
    case "withdrawn":
    case "expired":
      return "danger";
    case "draft":
    default:
      return "neutral";
  }
}

function money(currency: string, value: number | string | null | undefined): string {
  return `${currency} ${Number(value ?? 0).toLocaleString()}`;
}

function blank(v: string): boolean {
  return v.trim() === "";
}

const EMPTY_OPP_FORM = {
  customerId: "",
  title: "",
  stageCode: "",
  sourceCode: "",
  currencyCode: "IDR",
  estimatedValue: "",
  probabilityPercent: "",
  expectedCloseDate: "",
};

const EMPTY_QUOTE_FORM = {
  opportunityId: "",
  title: "",
  serviceId: "",
  unitCode: "",
  quantity: "1",
  unitPrice: "",
  discountAmount: "",
  validUntil: "",
  notes: "",
};

const EMPTY_BOOK_FORM = { code: "", name: "", currencyCode: "IDR", effectiveFrom: "", effectiveTo: "" };

const EMPTY_ENTRY_FORM = { serviceId: "", unitCode: "", unitPrice: "", minQuantity: "1" };

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

  const [services, setServices] = useState<CommercialService[]>([]);
  const [stages, setStages] = useState<RefOption[]>([]);
  const [sources, setSources] = useState<RefOption[]>([]);
  const [units, setUnits] = useState<RefOption[]>([]);
  const [oppForm, setOppForm] = useState(EMPTY_OPP_FORM);
  const [quoteForm, setQuoteForm] = useState(EMPTY_QUOTE_FORM);
  const [bookForm, setBookForm] = useState(EMPTY_BOOK_FORM);
  const [entryForm, setEntryForm] = useState(EMPTY_ENTRY_FORM);
  const [stageForm, setStageForm] = useState({ stageCode: "", outcome: "", outcomeReason: "", note: "" });

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
      const [meRes, custRes, oppsRes, pipeRes, quotesRes, pbooksRes, svcRes, refRes] = await Promise.all([
        api.me(token),
        api.customers(token).catch(() => [] as Customer[]),
        api.opportunities(token, {
          outcome: filterOutcome || undefined,
          stageCode: filterStage || undefined,
        }).catch(() => [] as OpportunityRecord[]),
        api.opportunityPipeline(token).catch(() => [] as OpportunityPipelineSummary[]),
        api.quotations(token).catch(() => [] as QuotationRecord[]),
        api.priceBooks(token).catch(() => [] as PriceBookRecord[]),
        api.commercialServices(token).catch(() => [] as CommercialService[]),
        api.salesReferenceOptions(token).catch(() => ({
          stages: [] as RefOption[],
          sources: [] as RefOption[],
          units: [] as RefOption[],
        })),
      ]);

      setPermissions(meRes.permissions ?? []);
      setCustomers(custRes);
      setOpportunities(oppsRes);
      setPipelineSummaries(pipeRes);
      setQuotations(quotesRes);
      setPriceBooks(pbooksRes);
      setServices(svcRes.filter((sv) => sv.isActive));
      setStages(refRes.stages);
      setSources(refRes.sources);
      setUnits(refRes.units);
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
      .then((detail) => {
        setOpportunityDetail(detail);
        setStageForm({ stageCode: detail.opportunity.stageCode, outcome: "", outcomeReason: "", note: "" });
      })
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
    if (!oppCanSubmit) return;
    try {
      await api.createOpportunity(token, {
        customerId: oppForm.customerId,
        title: oppForm.title.trim(),
        stageCode: oppForm.stageCode,
        sourceCode: oppForm.sourceCode || null,
        currencyCode: oppForm.currencyCode.trim(),
        estimatedValue: oppForm.estimatedValue ? Number(oppForm.estimatedValue) : null,
        probabilityPercent: oppForm.probabilityPercent ? Math.round(Number(oppForm.probabilityPercent)) : null,
        expectedCloseDate: oppForm.expectedCloseDate || null,
      });
      setMessage({ type: "success", text: "Opportunity created successfully." });
      setOppForm(EMPTY_OPP_FORM);
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
    if (!selectedOppId || blank(stageForm.stageCode)) return;
    try {
      await api.changeOpportunityStage(token, selectedOppId, {
        stageCode: stageForm.stageCode,
        outcome: stageForm.outcome ? (stageForm.outcome as SalesOutcome) : undefined,
        outcomeReason: stageForm.outcomeReason.trim() || undefined,
        note: stageForm.note.trim() || undefined,
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
    if (!quoteCanSubmit) return;
    try {
      await api.createQuotation(token, {
        opportunityId: quoteForm.opportunityId,
        title: quoteForm.title.trim(),
        notes: quoteForm.notes.trim() || null,
        validUntil: quoteForm.validUntil || null,
        lines: [
          {
            serviceId: quoteForm.serviceId,
            unitCode: quoteForm.unitCode,
            quantity: Number(quoteForm.quantity),
            unitPrice: quoteForm.unitPrice ? Number(quoteForm.unitPrice) : null,
            discountAmount: quoteForm.discountAmount ? Number(quoteForm.discountAmount) : null,
          },
        ],
      });
      setMessage({ type: "success", text: "Quotation drafted successfully." });
      setQuoteForm(EMPTY_QUOTE_FORM);
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
    if (!bookCanSubmit) return;
    try {
      const created = await api.createPriceBook(token, {
        code: bookForm.code.trim(),
        name: bookForm.name.trim(),
        currencyCode: bookForm.currencyCode.trim(),
        effectiveFrom: bookForm.effectiveFrom,
        effectiveTo: bookForm.effectiveTo || null,
      });
      setMessage({ type: "success", text: "Price Book created." });
      setBookForm(EMPTY_BOOK_FORM);
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
    if (!selectedPriceBookId || !entryCanSubmit) return;
    try {
      await api.addPriceBookEntry(token, selectedPriceBookId, {
        serviceId: entryForm.serviceId,
        unitCode: entryForm.unitCode,
        unitPrice: Number(entryForm.unitPrice),
        minQuantity: entryForm.minQuantity ? Number(entryForm.minQuantity) : undefined,
      });
      setMessage({ type: "success", text: "Price book entry added." });
      setEntryForm(EMPTY_ENTRY_FORM);
      const entries = await api.priceBookEntries(token, selectedPriceBookId);
      setPriceBookEntries(entries);
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof ApiError ? err.message : t("sc.sales.msg.failedToAddPriceBookEntry"),
      });
    }
  }

  const customerName = (id: string | null | undefined) =>
    customers.find((c) => c.id === id)?.name ?? "—";
  const serviceName = (id: string | null | undefined) =>
    services.find((sv) => sv.id === id)?.name ?? "—";

  const oppCanSubmit =
    !blank(oppForm.customerId) &&
    !blank(oppForm.title) &&
    !blank(oppForm.stageCode) &&
    oppForm.currencyCode.trim().length >= 3;
  const quoteCanSubmit =
    !blank(quoteForm.opportunityId) &&
    !blank(quoteForm.title) &&
    !blank(quoteForm.serviceId) &&
    !blank(quoteForm.unitCode) &&
    Number(quoteForm.quantity) > 0;
  const bookCanSubmit =
    !blank(bookForm.code) &&
    !blank(bookForm.name) &&
    bookForm.currencyCode.trim().length >= 3 &&
    !blank(bookForm.effectiveFrom);
  const entryCanSubmit =
    !blank(entryForm.serviceId) &&
    !blank(entryForm.unitCode) &&
    !blank(entryForm.unitPrice) &&
    Number(entryForm.unitPrice) >= 0;

  // Aggregated pipeline rows are keyed by stage + outcome.
  const pipelineCards = useMemo(
    () =>
      pipelineSummaries.map((p) => ({ ...p, key: `${p.stageCode}:${p.outcome}` })),
    [pipelineSummaries],
  );

  const outcomeLabel = (o: string) =>
    o === "open" ? t("sc.sales.t.inProgress")
    : o === "won" ? t("sc.sales.t.won")
    : o === "lost" ? t("sc.sales.t.lost")
    : t("sc.sales.t.cancelled");

  const stageLabel = useCallback(
    (code: string) => stages.find((st) => st.code === code)?.label ?? code,
    [stages],
  );

  const oppColumns: Column<OpportunityRecord>[] = useMemo(
    () => [
      {
        header: t("sc.sales.h.codeTitle"),
        cell: (r: OpportunityRecord) => (
          <div>
            <div className="font-medium text-slate-900">{r.title}</div>
            <div className="text-xs text-slate-500">{r.opportunityNumber}</div>
          </div>
        ),
      },
      {
        header: t("sc.sales.h.stage"),
        cell: (r: OpportunityRecord) => (
          <div className="flex items-center gap-1.5">
            <StatusPill tone="neutral">{stageLabel(r.stageCode)}</StatusPill>
            {r.outcome !== "open" && <StatusPill tone={outcomeTone(r.outcome)}>{r.outcome}</StatusPill>}
          </div>
        ),
      },
      {
        header: t("sc.sales.h.estValue"),
        cell: (r: OpportunityRecord) =>
          r.estimatedValue !== null ? money(r.currencyCode, r.estimatedValue) : "—",
      },
      {
        header: t("sc.sales.h.confidence"),
        cell: (r: OpportunityRecord) => (r.probabilityPercent !== null ? `${r.probabilityPercent}%` : "—"),
      },
      {
        header: t("sc.sales.h.targetClose"),
        cell: (r: OpportunityRecord) => r.expectedCloseDate || "—",
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
    [t, stageLabel],
  );

  const quoteColumns: Column<QuotationRecord>[] = useMemo(
    () => [
      {
        header: t("sc.sales.h.quotationCode"),
        cell: (r: QuotationRecord) => (
          <div>
            <div className="font-medium text-slate-900">{r.quotationNumber}</div>
            <div className="text-xs text-slate-500">{r.title} · v{r.revision}</div>
          </div>
        ),
      },
      {
        header: t("sc.sales.h.status"),
        cell: (r: QuotationRecord) => (
          <StatusPill tone={quotationStatusTone(r.status)}>{r.status.replace("_", " ")}</StatusPill>
        ),
      },
      {
        header: t("sc.sales.h.totalAmount"),
        cell: (r: QuotationRecord) => money(r.currencyCode, r.totalAmount),
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
            {canApproveSales && r.status === "in_approval" && (
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
                {pipelineCards.map((pipe) => (
                  <Card key={pipe.key} className="p-3">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
                      {stageLabel(pipe.stageCode)}
                      {pipe.outcome !== "open" && (
                        <StatusPill tone={outcomeTone(pipe.outcome)}>{pipe.outcome}</StatusPill>
                      )}
                    </div>
                    <div className="text-xl font-bold text-slate-900 mt-1">
                      {pipe.opportunityCount} <span className="text-xs font-normal text-slate-500">{t("sc.sales.t.deals")}</span>
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      {Number(pipe.estimatedValueTotal || 0).toLocaleString()}
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
                        {stages.map((st) => (
                          <option key={st.code} value={st.code}>{st.label}</option>
                        ))}
                      </Select>
                      <Select
                        className="text-xs py-1"
                        value={filterOutcome}
                        onChange={(e) => setFilterOutcome(e.target.value)}
                      >
                        <option value="">{t("sc.sales.t.allOutcomes")}</option>
                        {OUTCOMES.map((o) => (
                          <option key={o} value={o}>{outcomeLabel(o)}</option>
                        ))}
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
                            {opportunityDetail.opportunity.opportunityNumber}
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
                            {customerName(opportunityDetail.opportunity.customerId)}
                          </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-slate-100">
                          <span className="text-slate-500">{t("sc.sales.t.stage")}</span>
                          <StatusPill tone="neutral">
                            {stageLabel(opportunityDetail.opportunity.stageCode)}
                          </StatusPill>
                        </div>
                        <div className="flex justify-between py-1 border-b border-slate-100">
                          <span className="text-slate-500">{t("sc.sales.t.outcome")}</span>
                          <StatusPill tone={outcomeTone(opportunityDetail.opportunity.outcome)}>
                            {opportunityDetail.opportunity.outcome}
                          </StatusPill>
                        </div>
                        <div className="flex justify-between py-1 border-b border-slate-100">
                          <span className="text-slate-500">{t("sc.sales.t.estValue")}</span>
                          <span className="font-medium text-slate-800">
                            {opportunityDetail.opportunity.estimatedValue !== null
                              ? money(
                                  opportunityDetail.opportunity.currencyCode,
                                  opportunityDetail.opportunity.estimatedValue,
                                )
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
                          <Field label={t("sc.sales.f.targetStage")} required>
                            <Select
                              value={stageForm.stageCode}
                              onChange={(e) => setStageForm({ ...stageForm, stageCode: e.target.value })}
                            >
                              <option value="">{t("sc.sales.t.selectStage")}</option>
                              {stages.map((st) => (
                                <option key={st.code} value={st.code}>{st.label}</option>
                              ))}
                            </Select>
                          </Field>
                          <Field label={t("sc.sales.f.outcomeIfClosing")}>
                            <Select
                              value={stageForm.outcome}
                              onChange={(e) => setStageForm({ ...stageForm, outcome: e.target.value })}
                            >
                              <option value="">{t("sc.sales.t.inProgress")}</option>
                              {OUTCOMES.filter((o) => o !== "open").map((o) => (
                                <option key={o} value={o}>{outcomeLabel(o)}</option>
                              ))}
                            </Select>
                          </Field>
                          <Field label={t("sc.sales.f.outcomeReason")}>
                            <Input
                              value={stageForm.outcomeReason}
                              onChange={(e) => setStageForm({ ...stageForm, outcomeReason: e.target.value })}
                            />
                          </Field>
                          <Field label={t("sc.sales.f.noteOutcomeReason")}>
                            <Input
                              value={stageForm.note}
                              placeholder={t("sc.sales.p.stageTransitionRationale")}
                              onChange={(e) => setStageForm({ ...stageForm, note: e.target.value })}
                            />
                          </Field>
                          <Button type="submit" variant="primary" className="w-full" disabled={blank(stageForm.stageCode)}>
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
                          {opportunityDetail.history.map((hist) => (
                            <div key={hist.id} className="text-xs p-2 bg-slate-50 rounded border border-slate-100">
                              <div className="flex justify-between font-medium text-slate-700">
                                <span>
                                  {hist.fromStageCode ? stageLabel(hist.fromStageCode) : "start"} → {stageLabel(hist.toStageCode)}
                                  {hist.toOutcome !== "open" ? ` (${hist.toOutcome})` : ""}
                                </span>
                                <span>{new Date(hist.changedAt).toLocaleDateString()}</span>
                              </div>
                              {hist.note && <div className="text-slate-500 mt-1">{hist.note}</div>}
                            </div>
                          ))}
                        </div>
                      </div>

                      {opportunityDetail.quotations.length > 0 && (
                        <div className="pt-3 border-t border-slate-200 space-y-2">
                          <div className="text-xs font-bold text-slate-600">{t("sc.sales.t.relatedQuotations")}</div>
                          {opportunityDetail.quotations.map((q) => (
                            <div key={q.id} className="flex justify-between text-xs p-2 bg-slate-50 rounded border border-slate-100">
                              <span>{q.quotationNumber} · v{q.revision}</span>
                              <span>{money(q.currencyCode, q.totalAmount)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  ) : canManageSales ? (
                    <Card className="space-y-4">
                      <h4 className="font-semibold text-slate-900">{t("sc.sales.t.newOpportunity")}</h4>
                      <form onSubmit={handleCreateOpportunity} className="space-y-3">
                        <Field label={t("sc.sales.f.title")} required>
                          <Input
                            value={oppForm.title}
                            placeholder={t("sc.sales.p.annualFiberRenewal")}
                            onChange={(e) => setOppForm({ ...oppForm, title: e.target.value })}
                          />
                        </Field>
                        <Field label={t("sc.sales.f.customer")} required>
                          <Select
                            value={oppForm.customerId}
                            onChange={(e) => setOppForm({ ...oppForm, customerId: e.target.value })}
                          >
                            <option value="">{t("sc.sales.t.selectCustomer")}</option>
                            {customers.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} ({c.code})
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t("sc.sales.f.stage")} required>
                          <Select
                            value={oppForm.stageCode}
                            onChange={(e) => setOppForm({ ...oppForm, stageCode: e.target.value })}
                          >
                            <option value="">{t("sc.sales.t.selectStage")}</option>
                            {stages.map((st) => (
                              <option key={st.code} value={st.code}>{st.label}</option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t("sc.sales.f.source")}>
                          <Select
                            value={oppForm.sourceCode}
                            onChange={(e) => setOppForm({ ...oppForm, sourceCode: e.target.value })}
                          >
                            <option value="">{t("sc.sales.t.noSource")}</option>
                            {sources.map((so) => (
                              <option key={so.code} value={so.code}>{so.label}</option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t("sc.sales.f.currency")} required>
                          <Input
                            value={oppForm.currencyCode}
                            maxLength={8}
                            onChange={(e) => setOppForm({ ...oppForm, currencyCode: e.target.value.toUpperCase() })}
                          />
                        </Field>
                        <Field label={t("sc.sales.f.estimatedValue")}>
                          <Input
                            type="number"
                            min="0"
                            placeholder="150000000"
                            value={oppForm.estimatedValue}
                            onChange={(e) => setOppForm({ ...oppForm, estimatedValue: e.target.value })}
                          />
                        </Field>
                        <Field label={t("sc.sales.f.confidence")}>
                          <Input
                            type="number"
                            placeholder="75"
                            min="0"
                            max="100"
                            step="1"
                            value={oppForm.probabilityPercent}
                            onChange={(e) => setOppForm({ ...oppForm, probabilityPercent: e.target.value })}
                          />
                        </Field>
                        <Field label={t("sc.sales.f.targetCloseDate")}>
                          <Input
                            type="date"
                            value={oppForm.expectedCloseDate}
                            onChange={(e) => setOppForm({ ...oppForm, expectedCloseDate: e.target.value })}
                          />
                        </Field>
                        <Button type="submit" variant="primary" className="w-full" disabled={!oppCanSubmit}>
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
                          {quotationDetail.quotation.quotationNumber}
                        </h4>
                        <p className="text-xs text-slate-500">
                          {quotationDetail.quotation.title} · Revision #{quotationDetail.quotation.revision}
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
                          {customerName(quotationDetail.quotation.customerId)}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sc.sales.t.status")}</span>
                        <StatusPill tone={quotationStatusTone(quotationDetail.quotation.status)}>
                          {quotationDetail.quotation.status.replace("_", " ")}
                        </StatusPill>
                      </div>
                      {quotationDetail.status?.stepName && (
                        <div className="flex justify-between py-1 border-b border-slate-100">
                          <span className="text-slate-500">{t("sc.sales.t.approvalStep")}</span>
                          <span className="font-medium text-slate-800">{quotationDetail.status.stepName}</span>
                        </div>
                      )}
                      <div className="flex justify-between py-1 border-b border-slate-100">
                        <span className="text-slate-500">{t("sc.sales.t.total")}</span>
                        <span className="font-bold text-slate-900">
                          {money(quotationDetail.quotation.currencyCode, quotationDetail.quotation.totalAmount)}
                        </span>
                      </div>
                    </div>

                    {/* Line Items */}
                    <div className="pt-2 border-t border-slate-200">
                      <div className="text-xs font-bold text-slate-600 mb-2">
                        Line Items
                      </div>
                      <div className="space-y-2">
                        {quotationDetail.lines.map((line) => (
                          <div
                            key={line.id}
                            className="p-2.5 bg-slate-50 rounded border border-slate-200 text-xs flex justify-between items-center"
                          >
                            <div>
                              <div className="font-medium text-slate-800">
                                {line.serviceNameSnapshot}
                              </div>
                              <div className="text-slate-500">
                                {line.quantity} {line.unitCode} x {Number(line.unitPrice).toLocaleString()} (disc: {Number(line.discountAmount).toLocaleString()})
                              </div>
                            </div>
                            <div className="font-semibold text-slate-900">
                              {Number(line.lineTotal).toLocaleString()}
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
                      <Field label={t("sc.sales.f.opportunity")} required>
                        <Select
                          value={quoteForm.opportunityId}
                          onChange={(e) => setQuoteForm({ ...quoteForm, opportunityId: e.target.value })}
                        >
                          <option value="">{t("sc.sales.t.selectOpportunity")}</option>
                          {opportunities.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.opportunityNumber} - {o.title}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("sc.sales.f.title")} required>
                        <Input
                          value={quoteForm.title}
                          onChange={(e) => setQuoteForm({ ...quoteForm, title: e.target.value })}
                        />
                      </Field>
                      <Field label={t("sc.sales.f.service")} required>
                        <Select
                          value={quoteForm.serviceId}
                          onChange={(e) => setQuoteForm({ ...quoteForm, serviceId: e.target.value })}
                        >
                          <option value="">{t("sc.sales.t.selectService")}</option>
                          {services.map((sv) => (
                            <option key={sv.id} value={sv.id}>
                              {sv.name} ({sv.code})
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label={t("sc.sales.f.unit")} required>
                          <Select
                            value={quoteForm.unitCode}
                            onChange={(e) => setQuoteForm({ ...quoteForm, unitCode: e.target.value })}
                          >
                            <option value="">{t("sc.sales.t.selectUnit")}</option>
                            {units.map((u) => (
                              <option key={u.code} value={u.code}>{u.label}</option>
                            ))}
                          </Select>
                        </Field>
                        <Field label={t("sc.sales.f.quantity")} required>
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            value={quoteForm.quantity}
                            onChange={(e) => setQuoteForm({ ...quoteForm, quantity: e.target.value })}
                          />
                        </Field>
                      </div>
                      <Field label={t("sc.sales.f.unitPriceOptional")}>
                        <Input
                          type="number"
                          min="0"
                          placeholder="25000000"
                          value={quoteForm.unitPrice}
                          onChange={(e) => setQuoteForm({ ...quoteForm, unitPrice: e.target.value })}
                        />
                      </Field>
                      <Field label={t("sc.sales.f.discountAmount")}>
                        <Input
                          type="number"
                          min="0"
                          value={quoteForm.discountAmount}
                          onChange={(e) => setQuoteForm({ ...quoteForm, discountAmount: e.target.value })}
                        />
                      </Field>
                      <Field label={t("sc.sales.f.validUntil")}>
                        <Input
                          type="date"
                          value={quoteForm.validUntil}
                          onChange={(e) => setQuoteForm({ ...quoteForm, validUntil: e.target.value })}
                        />
                      </Field>
                      <Field label={t("sc.sales.f.notes")}>
                        <Input
                          value={quoteForm.notes}
                          onChange={(e) => setQuoteForm({ ...quoteForm, notes: e.target.value })}
                        />
                      </Field>
                      <Button type="submit" variant="primary" className="w-full" disabled={!quoteCanSubmit}>
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
                        {pb.customerId === null && (
                          <StatusPill tone="info">{t("sc.sales.t.tenantWide")}</StatusPill>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        Code: {pb.code} | Currency: {pb.currencyCode} | {pb.effectiveFrom}{pb.effectiveTo ? ` → ${pb.effectiveTo}` : ""}
                      </div>
                    </div>
                  ))}
                </div>

                {canManageSales && (
                  <Card className="space-y-3 mt-4">
                    <div className="font-semibold text-slate-900 text-sm">{t("sc.sales.t.addPriceBook")}</div>
                    <form onSubmit={handleCreatePriceBook} className="space-y-2">
                      <Input value={bookForm.code} placeholder={t("sc.sales.p.codeEGPbEnt2026")} onChange={(e) => setBookForm({ ...bookForm, code: e.target.value })} />
                      <Input value={bookForm.name} placeholder={t("sc.sales.p.nameEGEnterpriseTier")} onChange={(e) => setBookForm({ ...bookForm, name: e.target.value })} />
                      <Input value={bookForm.currencyCode} maxLength={8} placeholder={t("sc.sales.p.currencyEGIdr")} onChange={(e) => setBookForm({ ...bookForm, currencyCode: e.target.value.toUpperCase() })} />
                      <Field label={t("sc.sales.f.effectiveFrom")} required>
                        <Input type="date" value={bookForm.effectiveFrom} onChange={(e) => setBookForm({ ...bookForm, effectiveFrom: e.target.value })} />
                      </Field>
                      <Field label={t("sc.sales.f.effectiveTo")}>
                        <Input type="date" value={bookForm.effectiveTo} onChange={(e) => setBookForm({ ...bookForm, effectiveTo: e.target.value })} />
                      </Field>
                      <Button type="submit" variant="secondary" className="w-full text-xs" disabled={!bookCanSubmit}>
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
                            <th className="p-3">{t("sc.sales.h.service")}</th>
                            <th className="p-3">{t("sc.sales.h.unit")}</th>
                            <th className="p-3">{t("sc.sales.h.unitPrice")}</th>
                            <th className="p-3">{t("sc.sales.h.minQty")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {priceBookEntries.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="p-4 text-center text-slate-400 text-xs">
                                No entries configured for this price book.
                              </td>
                            </tr>
                          ) : (
                            priceBookEntries.map((entry) => (
                              <tr key={entry.id}>
                                <td className="p-3 font-medium text-slate-900">{serviceName(entry.serviceId)}</td>
                                <td className="p-3 text-slate-500">{entry.unitCode}</td>
                                <td className="p-3">
                                  {Number(entry.unitPrice).toLocaleString()}
                                </td>
                                <td className="p-3">{entry.minQuantity}</td>
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
                        <form onSubmit={handleAddPriceBookEntry} className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <Select value={entryForm.serviceId} onChange={(e) => setEntryForm({ ...entryForm, serviceId: e.target.value })}>
                            <option value="">{t("sc.sales.t.selectService")}</option>
                            {services.map((sv) => (
                              <option key={sv.id} value={sv.id}>{sv.name} ({sv.code})</option>
                            ))}
                          </Select>
                          <Select value={entryForm.unitCode} onChange={(e) => setEntryForm({ ...entryForm, unitCode: e.target.value })}>
                            <option value="">{t("sc.sales.t.selectUnit")}</option>
                            {units.map((u) => (
                              <option key={u.code} value={u.code}>{u.label}</option>
                            ))}
                          </Select>
                          <Input type="number" min="0" value={entryForm.unitPrice} placeholder={t("sc.sales.p.unitPrice")} onChange={(e) => setEntryForm({ ...entryForm, unitPrice: e.target.value })} />
                          <Input type="number" min="0" step="any" value={entryForm.minQuantity} placeholder={t("sc.sales.p.minQty")} onChange={(e) => setEntryForm({ ...entryForm, minQuantity: e.target.value })} />
                          <div className="col-span-2 md:col-span-4">
                            <Button type="submit" variant="primary" className="w-full text-xs" disabled={!entryCanSubmit}>
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
