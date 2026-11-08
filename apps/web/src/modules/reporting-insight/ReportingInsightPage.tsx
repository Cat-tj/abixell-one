/** Phase 9 & Wave A2 — Reporting, Governed BI & Operational Predictive Analytics. */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type BiDataset,
  type BiDatasetDetail,
  type BiFilter,
  type BiFilterOperator,
  type BiQueryConfig,
  type BiQueryResult,
  type BiSavedReport,
  type DashboardModule,
  type ForecastMetrics,
  type ForecastModelCode,
  type GenerateForecastResponse,
  type PredictiveForecastSnapshot,
  type ReportDefinition,
  type ReportRow,
  type StandardReportResult,
} from "../../lib/api";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { formatMoney } from "../../shared/format";

type TabKey = "standard" | "bi" | "predictive";

const FORECAST_MODELS: Array<{ code: ForecastModelCode; label: string; description: string }> = [
  {
    code: "complaint_volume_forecast",
    label: "Complaint Volume Forecast",
    description: "Deterministic 30-90 day forward time-series projection of inbound operational complaints.",
  },
  {
    code: "sla_breach_risk_forecast",
    label: "SLA Breach Risk Projection",
    description: "Historical hazard rate and bounded breach probability extrapolation across active work queues.",
  },
  {
    code: "survey_satisfaction_trend",
    label: "Satisfaction Score Trend & NPS Forecast",
    description: "Ordinary Least Squares score slope and projected customer net promoter sentiment trajectory.",
  },
];

export function ReportingInsightPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [activeTab, setActiveTab] = useState<TabKey>("standard");

  // --- Standard Reports state (Phase 9) ---
  const [reports, setReports] = useState<ReportDefinition[]>([]);
  const [dashboard, setDashboard] = useState<DashboardModule[]>([]);
  const [selectedCode, setSelectedCode] = useState("");
  const [result, setResult] = useState<StandardReportResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Governed BI state (RPT-ADV-001) ---
  const [biDatasets, setBiDatasets] = useState<BiDataset[]>([]);
  const [selectedDatasetCode, setSelectedDatasetCode] = useState<string>("");
  const [datasetDetail, setDatasetDetail] = useState<BiDatasetDetail | null>(null);
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([]);
  const [selectedMeasures, setSelectedMeasures] = useState<string[]>([]);
  const [filters, setFilters] = useState<BiFilter[]>([]);
  const [biLoading, setBiLoading] = useState(false);
  const [biExecuting, setBiExecuting] = useState(false);
  const [biExporting, setBiExporting] = useState(false);
  const [biResult, setBiResult] = useState<BiQueryResult | null>(null);
  const [savedReports, setSavedReports] = useState<BiSavedReport[]>([]);
  const [newReportTitle, setNewReportTitle] = useState("");
  const [newReportCode, setNewReportCode] = useState("");
  const [savingReport, setSavingReport] = useState(false);
  const [biError, setBiError] = useState<string | null>(null);

  // --- Predictive Analytics state (RPT-ADV-002) ---
  const [selectedModel, setSelectedModel] = useState<ForecastModelCode>("complaint_volume_forecast");
  const [lookbackDays, setLookbackDays] = useState<number>(60);
  const [forecastDays, setForecastDays] = useState<number>(30);
  const [forecastResponse, setForecastResponse] = useState<GenerateForecastResponse | null>(null);
  const [forecastHistory, setForecastHistory] = useState<PredictiveForecastSnapshot[]>([]);
  const [predictiveLoading, setPredictiveLoading] = useState(false);
  const [forecastGenerating, setForecastGenerating] = useState(false);
  const [predictiveError, setPredictiveError] = useState<string | null>(null);

  const selectedReport = reports.find((report) => report.code === selectedCode) ?? null;

  const loadFoundation = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reportList, dashboardResult] = await Promise.all([
        api.reportingReports(token),
        api.reportingDashboard(token),
      ]);
      setReports(reportList);
      setDashboard(dashboardResult.modules);
      setSelectedCode((current) => current || reportList[0]?.code || "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ri.main.msg.couldNotLoadReportingInsight"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  const loadReport = useCallback(async () => {
    if (!selectedCode) {
      setResult(null);
      return;
    }
    setReportLoading(true);
    setError(null);
    try {
      setResult(await api.reportingReport(token, selectedCode));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ri.main.msg.couldNotLoadTheSelectedReport"));
    } finally {
      setReportLoading(false);
    }
  }, [token, selectedCode, t]);

  useEffect(() => {
    void loadFoundation();
  }, [loadFoundation]);

  useEffect(() => {
    if (!loading && activeTab === "standard") void loadReport();
  }, [loading, loadReport, activeTab]);

  // Load BI datasets on tab switch
  const loadBiDatasets = useCallback(async () => {
    setBiLoading(true);
    setBiError(null);
    try {
      const list = await api.biDatasets(token);
      setBiDatasets(list);
      if (list.length > 0 && !selectedDatasetCode) {
        setSelectedDatasetCode(list[0].code);
      }
    } catch (err) {
      setBiError(err instanceof ApiError ? err.message : t("ri.main.msg.couldNotLoadBiDatasets"));
    } finally {
      setBiLoading(false);
    }
  }, [token, selectedDatasetCode, t]);

  // Load selected dataset detail and saved reports
  const loadDatasetDetail = useCallback(async (code: string) => {
    if (!code) return;
    setBiLoading(true);
    setBiError(null);
    try {
      const [detail, saved] = await Promise.all([
        api.biDataset(token, code),
        api.biSavedReports(token, code),
      ]);
      setDatasetDetail(detail);
      setSavedReports(saved);
      // Pick default dimensions and measures
      const defaultDims = detail.fields.filter((f) => f.isDimension).slice(0, 2).map((f) => f.code);
      const defaultMeasures = detail.fields.filter((f) => f.isMeasure).slice(0, 2).map((f) => f.code);
      setSelectedDimensions(defaultDims);
      setSelectedMeasures(defaultMeasures);
      setFilters([]);
      setBiResult(null);
    } catch (err) {
      setBiError(err instanceof ApiError ? err.message : t("ri.main.msg.couldNotLoadDatasetDetails"));
    } finally {
      setBiLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    if (activeTab === "bi") {
      void loadBiDatasets();
    }
  }, [activeTab, loadBiDatasets]);

  useEffect(() => {
    if (activeTab === "bi" && selectedDatasetCode) {
      void loadDatasetDetail(selectedDatasetCode);
    }
  }, [activeTab, selectedDatasetCode, loadDatasetDetail]);

  // Load Predictive data
  const loadPredictiveData = useCallback(async (modelCode: ForecastModelCode) => {
    setPredictiveLoading(true);
    setPredictiveError(null);
    try {
      const [latest, history] = await Promise.all([
        api.latestPredictiveSnapshot(token, modelCode),
        api.predictiveSnapshots(token, modelCode),
      ]);
      if (latest) {
        setForecastResponse({
          snapshot: latest,
          forecast: {
            modelCode: latest.modelCode,
            status: latest.status,
            forecastPeriodStart: latest.forecastPeriodStart,
            forecastPeriodEnd: latest.forecastPeriodEnd,
            historicalDataPoints: latest.dataPoints.filter((p) => p.period < latest.forecastPeriodStart),
            projectedDataPoints: latest.dataPoints.filter((p) => p.period >= latest.forecastPeriodStart),
            metrics: "historicalAverage" in latest.metrics ? (latest.metrics as unknown as ForecastMetrics) : null,
            confidenceIntervals: latest.confidenceIntervals,
            insufficientDataReason: latest.status === "insufficient_data" ? "Historical window contains fewer than 30 active days." : null,
          },
        });
      } else {
        setForecastResponse(null);
      }
      setForecastHistory(history);
    } catch (err) {
      setPredictiveError(err instanceof ApiError ? err.message : t("ri.main.msg.couldNotLoadPredictiveSnapshots"));
    } finally {
      setPredictiveLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    if (activeTab === "predictive") {
      void loadPredictiveData(selectedModel);
    }
  }, [activeTab, selectedModel, loadPredictiveData]);

  // Standard report export
  const exportReport = async () => {
    if (!selectedCode) return;
    setExporting(true);
    setError(null);
    try {
      const exported = await api.exportReportingReport(token, selectedCode);
      const blob = new Blob([exported.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ri.main.msg.couldNotExportTheSelectedReport"));
    } finally {
      setExporting(false);
    }
  };

  // BI Query execution
  const executeBiQuery = async () => {
    if (!selectedDatasetCode || (selectedDimensions.length === 0 && selectedMeasures.length === 0)) {
      setBiError("Please select at least one dimension or measure.");
      return;
    }
    setBiExecuting(true);
    setBiError(null);
    const config: BiQueryConfig = {
      datasetCode: selectedDatasetCode,
      dimensions: selectedDimensions,
      measures: selectedMeasures,
      filters,
    };
    try {
      const queryRes = await api.biQuery(token, config);
      setBiResult(queryRes);
    } catch (err) {
      setBiError(err instanceof ApiError ? err.message : t("ri.main.msg.governedBiExecutionFailed"));
    } finally {
      setBiExecuting(false);
    }
  };

  // BI Query CSV export
  const exportBiQuery = async () => {
    if (!selectedDatasetCode) return;
    setBiExporting(true);
    setBiError(null);
    const config: BiQueryConfig = {
      datasetCode: selectedDatasetCode,
      dimensions: selectedDimensions,
      measures: selectedMeasures,
      filters,
    };
    try {
      const exported = await api.exportBiQuery(token, config);
      const blob = new Blob([exported.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setBiError(err instanceof ApiError ? err.message : t("ri.main.msg.governedBiExportFailed"));
    } finally {
      setBiExporting(false);
    }
  };

  // Save BI report
  const handleSaveReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReportTitle.trim() || !newReportCode.trim() || !selectedDatasetCode) return;
    setSavingReport(true);
    setBiError(null);
    try {
      const saved = await api.createBiSavedReport(token, {
        code: newReportCode.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
        title: newReportTitle.trim(),
        config: {
          datasetCode: selectedDatasetCode,
          dimensions: selectedDimensions,
          measures: selectedMeasures,
          filters,
        },
      });
      setSavedReports((prev) => [saved, ...prev]);
      setNewReportTitle("");
      setNewReportCode("");
    } catch (err) {
      setBiError(err instanceof ApiError ? err.message : t("ri.main.msg.couldNotSaveCustomBiReport"));
    } finally {
      setSavingReport(false);
    }
  };

  // Load saved BI report config
  const handleApplySavedReport = (saved: BiSavedReport) => {
    if (saved.config.datasetCode !== selectedDatasetCode) {
      setSelectedDatasetCode(saved.config.datasetCode);
    }
    setSelectedDimensions(saved.config.dimensions || []);
    setSelectedMeasures(saved.config.measures || []);
    setFilters(saved.config.filters || []);
  };

  // Generate predictive forecast
  const handleGenerateForecast = async () => {
    setForecastGenerating(true);
    setPredictiveError(null);
    try {
      const response = await api.generatePredictiveForecast(token, {
        modelCode: selectedModel,
        lookbackDays,
        forecastDays,
      });
      setForecastResponse(response);
      setForecastHistory((prev) => [response.snapshot, ...prev.filter((s) => s.id !== response.snapshot.id)]);
    } catch (err) {
      setPredictiveError(err instanceof ApiError ? err.message : t("ri.main.msg.forecastComputationFailed"));
    } finally {
      setForecastGenerating(false);
    }
  };

  const columns = useMemo<Column<ReportRow>[]>(() => {
    if (!result) return [];
    return result.columns.map((column) => ({
      header: column.label,
      className:
        column.type === "number" || column.type === "money" || column.type === "percent"
          ? "text-right tabular-nums"
          : undefined,
      cell: (row) => formatValue(row[column.key], column.type),
    }));
  }, [result]);

  const biColumns = useMemo<Column<Record<string, string | number | boolean | null>>[]>(() => {
    if (!biResult) return [];
    return biResult.columns.map((col) => ({
      header: col.label,
      className: col.type === "number" || col.type === "money" ? "text-right tabular-nums" : undefined,
      cell: (row) => formatValue(row[col.key] as string | number | null | undefined, col.type),
    }));
  }, [biResult]);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("ri.main.title.reportingOperationalInsight")}
        subtitle={t("ri.main.sub.scopeSafeOperationalReportsGovernedSelfS")}
        actions={
          <Button
            onClick={() => {
              if (activeTab === "standard") void loadFoundation();
              else if (activeTab === "bi") void loadBiDatasets();
              else void loadPredictiveData(selectedModel);
            }}
            variant="secondary"
          >
            Refresh
          </Button>
        }
      />

      {/* Tab Navigation */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex space-x-6">
          <button
            type="button"
            onClick={() => setActiveTab("standard")}
            className={`whitespace-nowrap pb-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === "standard"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
            }`}
          >
            Standard Reports & Dashboard
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("bi")}
            className={`whitespace-nowrap pb-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === "bi"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
            }`}
          >
            Governed BI Studio (RPT-ADV-001)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("predictive")}
            className={`whitespace-nowrap pb-3 text-sm font-medium transition-colors border-b-2 ${
              activeTab === "predictive"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
            }`}
          >
            Predictive Forecasting (RPT-ADV-002)
          </button>
        </nav>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: Standard Reports & Dashboard                                        */}
      {/* ========================================================================= */}
      {activeTab === "standard" && (
        <div className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}

          <Card>
            <p className="text-sm text-slate-600">
              Reports are read-only and generated from backend Data Scope filtered projections. Dashboard totals and CSV
              exports use the same scoped report result; inactive modules are omitted.
            </p>
          </Card>

          {loading ? (
            <Spinner />
          ) : reports.length === 0 ? (
            <EmptyState
              title={t("ri.main.title.noReportsAvailable")}
              description={t("ri.main.d.noActivatedModuleCurrentlyExposesAStanda")}
            />
          ) : (
            <>
              <section>
                <h2 className="mb-2 text-sm font-semibold text-slate-800">{t("ri.main.t.executiveDashboard")}</h2>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {dashboard.map((module) => (
                    <Card key={module.moduleCode}>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3 className="font-medium text-slate-900">{module.moduleName}</h3>
                        <StatusPill tone="info">{t("ri.main.t.active")}</StatusPill>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {module.cards.map((card) => (
                          <div
                            key={`${module.moduleCode}-${card.label}`}
                            className="rounded border border-slate-100 bg-slate-50 p-3"
                          >
                            <p className="text-xs font-bold text-slate-500">
                              {card.label}
                            </p>
                            <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                              {card.value}
                            </p>
                          </div>
                        ))}
                      </div>
                    </Card>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <Card>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                    <label className="block text-sm">
                      <span className="font-medium text-slate-700">{t("ri.main.t.standardReport")}</span>
                      <Select
                        value={selectedCode}
                        onChange={(event) => setSelectedCode(event.target.value)}
                      >
                        {reports.map((report) => (
                          <option key={report.code} value={report.code}>
                            {report.title}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <Button
                      onClick={exportReport}
                      disabled={!selectedCode || exporting}
                      variant="secondary"
                    >
                      {exporting ? "Exporting…" : "Export CSV"}
                    </Button>
                  </div>
                  {selectedReport ? (
                    <p className="mt-2 text-sm text-slate-500">{selectedReport.description}</p>
                  ) : null}
                </Card>

                {reportLoading ? (
                  <Spinner />
                ) : result ? (
                  <>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {Object.entries(result.summary).map(([key, value]) => (
                        <Card key={key}>
                          <p className="text-xs font-bold text-slate-500">
                            {humanize(key)}
                          </p>
                          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                            {value}
                          </p>
                        </Card>
                      ))}
                    </div>
                    <DataTable
                      columns={columns}
                      rows={result.rows}
                      keyOf={(row) => `${result.code}-${row.label}-${JSON.stringify(row)}`}
                      empty={
                        <EmptyState
                          title={t("ri.main.title.noScopedRows")}
                          description={t("ri.main.d.noRecordsAreAvailableWithinYourDataScope")}
                        />
                      }
                    />
                  </>
                ) : null}
              </section>
            </>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: Governed BI Studio (RPT-ADV-001)                                    */}
      {/* ========================================================================= */}
      {activeTab === "bi" && (
        <div className="space-y-4">
          {biError ? <Alert tone="error">{biError}</Alert> : null}

          <Card>
            <div className="space-y-1">
              <h3 className="font-semibold text-slate-900">{t("ri.main.t.governedBiWarehouseProjections")}</h3>
              <p className="text-sm text-slate-600">
                Self-service multi-dimensional queries against registered catalog datasets. All queries are strictly compiled
                from whitelisted metadata, execute in read-only transactions with strict row limits (1,000 max), and apply your
                active Customer Data Scope automatically. Arbitrary SQL, query editors, and code execution are strictly disabled.
              </p>
            </div>
          </Card>

          {biLoading && !datasetDetail ? (
            <Spinner />
          ) : biDatasets.length === 0 ? (
            <EmptyState
              title={t("ri.main.title.noBiDatasetsAvailable")}
              description={t("ri.main.d.noRegisteredBiDatasetsAreActiveOrMatchYo")}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
              {/* Left Sidebar: Dataset & Saved Reports */}
              <div className="space-y-4">
                <Card>
                  <label className="block text-sm">
                    <span className="font-medium text-slate-700">{t("ri.main.t.biDataset")}</span>
                    <Select
                      value={selectedDatasetCode}
                      onChange={(e) => setSelectedDatasetCode(e.target.value)}
                    >
                      {biDatasets.map((ds) => (
                        <option key={ds.code} value={ds.code}>
                          {ds.name} ({ds.moduleCode})
                        </option>
                      ))}
                    </Select>
                  </label>
                  {datasetDetail?.dataset.description && (
                    <p className="mt-2 text-xs text-slate-500">
                      {datasetDetail.dataset.description}
                    </p>
                  )}
                </Card>

                {/* Saved Reports for this dataset */}
                <Card>
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-slate-800">{t("ri.main.t.savedReports")}</h4>
                    <StatusPill tone="neutral">{savedReports.length}</StatusPill>
                  </div>
                  {savedReports.length === 0 ? (
                    <p className="text-xs text-slate-500">{t("ri.main.n.noSavedReportsForThisDatasetYet")}</p>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {savedReports.map((saved) => (
                        <div
                          key={saved.id}
                          className="rounded border border-slate-200 p-2 text-xs flex items-center justify-between hover:bg-slate-50"
                        >
                          <div>
                            <p className="font-medium text-slate-900">{saved.title}</p>
                            <p className="text-slate-400 font-mono text-[10px]">{saved.code}</p>
                          </div>
                          <div className="flex space-x-1">
                            <button
                              type="button"
                              onClick={() => handleApplySavedReport(saved)}
                              className="text-blue-600 hover:text-blue-800 font-medium px-1.5 py-0.5 rounded bg-blue-50"
                            >
                              Load
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                if (!confirm(`Delete saved report "${saved.title}"?`)) return;
                                try {
                                  await api.deleteBiSavedReport(token, saved.id);
                                  setSavedReports((prev) => prev.filter((r) => r.id !== saved.id));
                                } catch (err) {
                                  setBiError(err instanceof ApiError ? err.message : t("ri.main.msg.failedToDeleteSavedReport"));
                                }
                              }}
                              className="text-red-500 hover:text-red-700 font-medium px-1.5 py-0.5 rounded hover:bg-red-50"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {/* Save Current Query Form */}
                <Card>
                  <h4 className="mb-2 text-sm font-semibold text-slate-800">{t("ri.main.t.saveCustomReport")}</h4>
                  <form onSubmit={handleSaveReport} className="space-y-2 text-xs">
                    <div>
                      <span className="font-medium text-slate-600">{t("ri.main.t.reportCode")}</span>
                      <Input
                        placeholder={t("ri.main.p.myOperationalKpi")}
                        value={newReportCode}
                        onChange={(e) => setNewReportCode(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <span className="font-medium text-slate-600">{t("ri.main.t.reportTitle")}</span>
                      <Input
                        placeholder={t("ri.main.p.weeklyVolumeByUnit")}
                        value={newReportTitle}
                        onChange={(e) => setNewReportTitle(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" disabled={savingReport} variant="secondary" className="w-full">
                      {savingReport ? "Saving…" : "Save Report Configuration"}
                    </Button>
                  </form>
                </Card>
              </div>

              {/* Main Query & Projection Builder */}
              <div className="space-y-4">
                {datasetDetail && (
                  <Card>
                    <div className="space-y-4">
                      {/* Dimensions Selection */}
                      <div>
                        <span className="text-xs font-semiboldr text-slate-500">
                          Group By Dimensions
                        </span>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {datasetDetail.fields
                            .filter((f) => f.isDimension)
                            .map((field) => {
                              const isSelected = selectedDimensions.includes(field.code);
                              return (
                                <button
                                  key={field.code}
                                  type="button"
                                  onClick={() => {
                                    setSelectedDimensions((prev) =>
                                      isSelected
                                        ? prev.filter((c) => c !== field.code)
                                        : [...prev, field.code]
                                    );
                                  }}
                                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
                                    isSelected
                                      ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                                      : "bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200"
                                  }`}
                                >
                                  {field.name}
                                </button>
                              );
                            })}
                        </div>
                      </div>

                      {/* Measures Selection */}
                      <div>
                        <span className="text-xs font-semiboldr text-slate-500">
                          Aggregated Measures
                        </span>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {datasetDetail.fields
                            .filter((f) => f.isMeasure)
                            .map((field) => {
                              const isSelected = selectedMeasures.includes(field.code);
                              return (
                                <button
                                  key={field.code}
                                  type="button"
                                  onClick={() => {
                                    setSelectedMeasures((prev) =>
                                      isSelected
                                        ? prev.filter((c) => c !== field.code)
                                        : [...prev, field.code]
                                    );
                                  }}
                                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
                                    isSelected
                                      ? "bg-emerald-600 text-white border-emerald-600 shadow-xs"
                                      : "bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200"
                                  }`}
                                >
                                  {field.name} ({field.aggregation?.toUpperCase() ?? "AGG"})
                                </button>
                              );
                            })}
                        </div>
                      </div>

                      {/* Filter Builder */}
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semiboldr text-slate-500">
                            Data Filters
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const firstFilterable = datasetDetail.fields.find((f) => f.isFilterable);
                              if (firstFilterable) {
                                setFilters((prev) => [
                                  ...prev,
                                  { field: firstFilterable.code, operator: "eq", value: "" },
                                ]);
                              }
                            }}
                            className="text-xs text-blue-600 hover:underline font-medium"
                          >
                            + Add Filter
                          </button>
                        </div>

                        {filters.length === 0 ? (
                          <p className="mt-1 text-xs text-slate-400">{t("ri.main.n.noActiveFiltersEntireScopedDatasetWillBe")}</p>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {filters.map((filter, idx) => (
                              <div key={idx} className="flex items-center gap-2 text-xs">
                                <Select
                                  value={filter.field}
                                  onChange={(e) => {
                                    const next = [...filters];
                                    next[idx].field = e.target.value;
                                    setFilters(next);
                                  }}
                                  className="w-48"
                                >
                                  {datasetDetail.fields
                                    .filter((f) => f.isFilterable)
                                    .map((f) => (
                                      <option key={f.code} value={f.code}>
                                        {f.name}
                                      </option>
                                    ))}
                                </Select>
                                <Select
                                  value={filter.operator}
                                  onChange={(e) => {
                                    const next = [...filters];
                                    next[idx].operator = e.target.value as BiFilterOperator;
                                    setFilters(next);
                                  }}
                                  className="w-28"
                                >
                                  <option value="eq">{t("ri.main.t.equals")}</option>
                                  <option value="neq">{t("ri.main.t.notEquals")}</option>
                                  <option value="gt">{t("ri.main.t.greaterThanGt")}</option>
                                  <option value="gte">{t("ri.main.t.greaterOrEqualGt")}</option>
                                  <option value="lt">{t("ri.main.t.lessThanLt")}</option>
                                  <option value="lte">{t("ri.main.t.lessOrEqualLt")}</option>
                                </Select>
                                <Input
                                  placeholder={t("ri.main.p.value")}
                                  value={String(filter.value)}
                                  onChange={(e) => {
                                    const next = [...filters];
                                    next[idx].value = e.target.value;
                                    setFilters(next);
                                  }}
                                  className="flex-1"
                                />
                                <button
                                  type="button"
                                  onClick={() => setFilters((prev) => prev.filter((_, i) => i !== idx))}
                                  className="text-red-500 hover:text-red-700 font-bold px-2 py-1"
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
                        <Button
                          onClick={exportBiQuery}
                          disabled={biExporting || (selectedDimensions.length === 0 && selectedMeasures.length === 0)}
                          variant="secondary"
                        >
                          {biExporting ? "Exporting CSV…" : "Export BI CSV"}
                        </Button>
                        <Button
                          onClick={executeBiQuery}
                          disabled={biExecuting || (selectedDimensions.length === 0 && selectedMeasures.length === 0)}
                          variant="primary"
                        >
                          {biExecuting ? "Executing Query…" : "Run Governed Query"}
                        </Button>
                      </div>
                    </div>
                  </Card>
                )}

                {/* Query Results Table */}
                {biExecuting ? (
                  <Spinner label={t("ri.main.f.executingMultiDimensionalQueryProjection")} />
                ) : biResult ? (
                  <Card>
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-semibold text-slate-900">{t("ri.main.t.queryResults")}</h4>
                        <StatusPill tone="info">{biResult.rowCount} rows</StatusPill>
                        {biResult.truncated && (
                          <StatusPill tone="warning">{t("ri.main.t.limitedTo1000Rows")}</StatusPill>
                        )}
                      </div>
                      <span className="text-xs text-slate-400 font-mono">
                        Generated {new Date(biResult.generatedAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <DataTable
                      columns={biColumns}
                      rows={biResult.rows}
                      keyOf={(row) => JSON.stringify(row)}
                      empty={
                        <EmptyState
                          title={t("ri.main.title.noDataReturned")}
                          description={t("ri.main.d.theQueryExecutedSuccessfullyButProducedN")}
                        />
                      }
                    />
                  </Card>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: Predictive Forecasting (RPT-ADV-002)                                */}
      {/* ========================================================================= */}
      {activeTab === "predictive" && (
        <div className="space-y-4">
          {predictiveError ? <Alert tone="error">{predictiveError}</Alert> : null}

          <Card>
            <div className="space-y-1">
              <h3 className="font-semibold text-slate-900">{t("ri.main.t.deterministicOperationalForecasting")}</h3>
              <p className="text-sm text-slate-600">
                Statistically bounded predictive projections calculated via Ordinary Least Squares (OLS) linear regression
                and moving average trend decomposition across your organization's operational history. All forecasting models
                are tenant-isolated, strictly deterministic, and generate bounded snapshot projections without autonomous domain mutation.
              </p>
            </div>
          </Card>

          {/* Model Selector & Parameters */}
          <Card>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto]">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">{t("ri.main.t.forecastingModel")}</span>
                  <Select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value as ForecastModelCode)}
                  >
                    {FORECAST_MODELS.map((m) => (
                      <option key={m.code} value={m.code}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </label>

                <label className="block text-sm">
                  <span className="font-medium text-slate-700">{t("ri.main.t.historicalLookbackDays")}</span>
                  <Input
                    type="number"
                    min={30}
                    max={365}
                    value={lookbackDays}
                    onChange={(e) => setLookbackDays(Number(e.target.value))}
                  />
                </label>

                <label className="block text-sm">
                  <span className="font-medium text-slate-700">{t("ri.main.t.forecastHorizonDays")}</span>
                  <Input
                    type="number"
                    min={7}
                    max={90}
                    value={forecastDays}
                    onChange={(e) => setForecastDays(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="flex items-end">
                <Button
                  onClick={handleGenerateForecast}
                  disabled={forecastGenerating}
                  variant="primary"
                  className="w-full sm:w-auto"
                >
                  {forecastGenerating ? "Computing Model…" : "Generate Forecast"}
                </Button>
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-500">
              {FORECAST_MODELS.find((m) => m.code === selectedModel)?.description}
            </p>
          </Card>

          {predictiveLoading ? (
            <Spinner label={t("ri.main.f.loadingHistoricalForecastSnapshots")} />
          ) : forecastResponse ? (
            <div className="space-y-4">
              {forecastResponse.forecast.status === "insufficient_data" ? (
                <Card>
                  <div className="flex items-start gap-3">
                    <div aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-600">!</div>
                    <div>
                      <h4 className="font-semibold text-slate-900">{t("ri.main.t.insufficientOperationalHistory")}</h4>
                      <p className="mt-1 text-sm text-slate-600">
                        {forecastResponse.forecast.insufficientDataReason ??
                          "The selected lookback window requires at least 30 days of operational records to establish a reliable regression slope and confidence bounds."}
                      </p>
                      <p className="mt-2 text-xs text-slate-400">
                        Forecast period: {forecastResponse.forecast.forecastPeriodStart} to {forecastResponse.forecast.forecastPeriodEnd}
                      </p>
                    </div>
                  </div>
                </Card>
              ) : (
                <>
                  {/* Summary Metric Cards */}
                  {forecastResponse.forecast.metrics && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Card>
                        <p className="text-xs font-bold text-slate-500">
                          Historical Daily Average
                        </p>
                        <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
                          {forecastResponse.forecast.metrics.historicalAverage.toFixed(2)}
                        </p>
                      </Card>
                      <Card>
                        <p className="text-xs font-bold text-slate-500">
                          Trend Slope / Day
                        </p>
                        <p
                          className={`mt-1 text-2xl font-bold tabular-nums ${
                            forecastResponse.forecast.metrics.trendSlopePerDay > 0
                              ? "text-rose-600"
                              : forecastResponse.forecast.metrics.trendSlopePerDay < 0
                              ? "text-emerald-600"
                              : "text-slate-900"
                          }`}
                        >
                          {forecastResponse.forecast.metrics.trendSlopePerDay > 0 ? "+" : ""}
                          {forecastResponse.forecast.metrics.trendSlopePerDay.toFixed(4)}
                        </p>
                      </Card>
                      <Card>
                        <p className="text-xs font-bold text-slate-500">
                          Projected Next Period Total
                        </p>
                        <p className="mt-1 text-2xl font-bold tabular-nums text-blue-600">
                          {forecastResponse.forecast.metrics.projectedNextPeriodValue.toFixed(1)}
                        </p>
                      </Card>
                    </div>
                  )}

                  {/* Projected Points & Confidence Interval Table */}
                  <Card>
                    <div className="mb-3 flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-slate-900">
                        Forward Projections & 95% Confidence Intervals
                      </h4>
                      <StatusPill tone="info">
                        {forecastResponse.forecast.forecastPeriodStart} → {forecastResponse.forecast.forecastPeriodEnd}
                      </StatusPill>
                    </div>

                    <div className="max-h-96 overflow-y-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                          <tr>
                            <th className="p-2">{t("ri.main.h.periodDate")}</th>
                            <th className="p-2 text-right">{t("ri.main.h.projectedValue")}</th>
                            <th className="p-2 text-right">{t("ri.main.h.lowerBound95Ci")}</th>
                            <th className="p-2 text-right">{t("ri.main.h.upperBound95Ci")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {forecastResponse.forecast.projectedDataPoints.map((dp) => {
                            const ci = forecastResponse.forecast.confidenceIntervals.find(
                              (c) => c.period === dp.period
                            );
                            return (
                              <tr key={dp.period} className="hover:bg-slate-50">
                                <td className="p-2 font-mono text-slate-700">{dp.period}</td>
                                <td className="p-2 text-right font-semibold tabular-nums text-blue-600">
                                  {dp.value.toFixed(2)}
                                </td>
                                <td className="p-2 text-right tabular-nums text-slate-500">
                                  {ci ? ci.lower.toFixed(2) : "—"}
                                </td>
                                <td className="p-2 text-right tabular-nums text-slate-500">
                                  {ci ? ci.upper.toFixed(2) : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </>
              )}

              {/* Historical Snapshots Audit Log */}
              <Card>
                <div className="mb-3 flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-800">{t("ri.main.t.forecastSnapshotAuditHistory")}</h4>
                  <StatusPill tone="neutral">{forecastHistory.length} snapshots</StatusPill>
                </div>
                {forecastHistory.length === 0 ? (
                  <p className="text-xs text-slate-500">{t("ri.main.n.noPreviousSnapshotRecordsForThisModel")}</p>
                ) : (
                  <div className="space-y-2">
                    {forecastHistory.slice(0, 5).map((snap) => (
                      <div
                        key={snap.id}
                        className="rounded border border-slate-100 bg-slate-50 p-2 text-xs flex items-center justify-between"
                      >
                        <div>
                          <p className="font-semibold text-slate-800">
                            Period: {snap.forecastPeriodStart} → {snap.forecastPeriodEnd}
                          </p>
                          <p className="text-slate-400 font-mono text-[10px]">
                            Snapshot ID: {snap.id} • Status: {snap.status}
                          </p>
                        </div>
                        <span className="text-slate-500 text-[11px]">
                          {new Date(snap.generatedAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          ) : (
            <EmptyState
              title={t("ri.main.title.noForecastGenerated")}
              description={t("ri.main.d.selectYourDesiredModelParametersAndClick")}
            />
          )}
        </div>
      )}
    </div>
  );
}

function formatValue(value: string | number | boolean | null | undefined, type?: string) {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "boolean" || typeof value === "boolean") return value ? "Yes" : "No";
  if (type === "money") return formatMoney(String(value));
  if (type === "percent" && typeof value === "number") return `${value.toFixed(1)}%`;
  if (type === "percent") return `${value}%`;
  if (type === "number" && typeof value === "number") return value.toLocaleString();
  return String(value);
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase());
}
