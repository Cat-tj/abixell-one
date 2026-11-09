import { Suspense, lazy } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/layout/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { useAuth } from "./auth/AuthContext";

// Page modules are code-split (IMP-009): each route's chunk loads on first
// navigation, so the initial bundle carries only the shell and the login entry.
// Named exports are re-mapped to the default shape React.lazy expects.
const RoleSiteSelectionPage = lazy(() => import("./pages/RoleSiteSelectionPage").then((m) => ({ default: m.RoleSiteSelectionPage })));
const OverviewPage = lazy(() => import("./pages/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const SettingsPage = lazy(() => import("./pages/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const ComplaintsListPage = lazy(() => import("./pages/complaints/ComplaintsListPage").then((m) => ({ default: m.ComplaintsListPage })));
const ComplaintCreatePage = lazy(() => import("./pages/complaints/ComplaintCreatePage").then((m) => ({ default: m.ComplaintCreatePage })));
const ComplaintDetailPage = lazy(() => import("./pages/complaints/ComplaintDetailPage").then((m) => ({ default: m.ComplaintDetailPage })));
const OperationalQueuePage = lazy(() => import("./pages/operational/OperationalQueuePage").then((m) => ({ default: m.OperationalQueuePage })));
const OperationalDetailPage = lazy(() => import("./pages/operational/OperationalDetailPage").then((m) => ({ default: m.OperationalDetailPage })));
const VerificationQueuePage = lazy(() => import("./pages/verification/VerificationQueuePage").then((m) => ({ default: m.VerificationQueuePage })));
const VerificationDetailPage = lazy(() => import("./pages/verification/VerificationDetailPage").then((m) => ({ default: m.VerificationDetailPage })));
const ManagementDashboardPage = lazy(() => import("./pages/management/ManagementDashboardPage").then((m) => ({ default: m.ManagementDashboardPage })));
const ComplaintConfigPage = lazy(() => import("./pages/admin/ComplaintConfigPage").then((m) => ({ default: m.ComplaintConfigPage })));
const SurveyListPage = lazy(() => import("./pages/survey/SurveyListPage").then((m) => ({ default: m.SurveyListPage })));
const SurveyDetailPage = lazy(() => import("./pages/survey/SurveyDetailPage").then((m) => ({ default: m.SurveyDetailPage })));
const MySurveysPage = lazy(() => import("./pages/survey/MySurveysPage").then((m) => ({ default: m.MySurveysPage })));
const MySurveyDetailPage = lazy(() => import("./pages/survey/MySurveyDetailPage").then((m) => ({ default: m.MySurveyDetailPage })));
const PublicSurveyPage = lazy(() => import("./pages/survey/PublicSurveyPage").then((m) => ({ default: m.PublicSurveyPage })));
const WorkOrderQueuePage = lazy(() => import("./modules/service-operations/WorkOrderQueuePage").then((m) => ({ default: m.WorkOrderQueuePage })));
const WorkOrderDetailPage = lazy(() => import("./modules/service-operations/WorkOrderDetailPage").then((m) => ({ default: m.WorkOrderDetailPage })));
const OpsDashboardPage = lazy(() => import("./modules/service-operations/ManagementDashboardPage").then((m) => ({ default: m.ManagementDashboardPage })));
const MyWorkPage = lazy(() => import("./modules/service-operations/MyWorkPage").then((m) => ({ default: m.MyWorkPage })));
const MyWorkDetailPage = lazy(() => import("./modules/service-operations/MyWorkDetailPage").then((m) => ({ default: m.MyWorkDetailPage })));
const ServiceDefinitionsPage = lazy(() => import("./modules/service-operations/ServiceDefinitionsPage").then((m) => ({ default: m.ServiceDefinitionsPage })));
const CustomerCommercialPage = lazy(() => import("./modules/customer-commercial/CustomerCommercialPage").then((m) => ({ default: m.CustomerCommercialPage })));
const SalesPipelinePage = lazy(() => import("./pages/sales/SalesPipelinePage").then((m) => ({ default: m.SalesPipelinePage })));
const ServiceQualityPage = lazy(() => import("./pages/service-quality/ServiceQualityPage").then((m) => ({ default: m.ServiceQualityPage })));
const EmployeesPage = lazy(() => import("./modules/workforce/EmployeesPage").then((m) => ({ default: m.EmployeesPage })));
const EmployeeDetailPage = lazy(() => import("./modules/workforce/EmployeeDetailPage").then((m) => ({ default: m.EmployeeDetailPage })));
const WorkforceAttendancePage = lazy(() => import("./pages/workforce-advanced/WorkforceAttendancePage").then((m) => ({ default: m.WorkforceAttendancePage })));
const WorkforceLeaveOvertimePage = lazy(() => import("./pages/workforce-advanced/WorkforceLeaveOvertimePage").then((m) => ({ default: m.WorkforceLeaveOvertimePage })));
const WorkforcePayrollPage = lazy(() => import("./pages/workforce-advanced/WorkforcePayrollPage").then((m) => ({ default: m.WorkforcePayrollPage })));
const WorkforceRecruitmentPage = lazy(() => import("./pages/workforce-advanced/WorkforceRecruitmentPage").then((m) => ({ default: m.WorkforceRecruitmentPage })));
const WorkforcePerformancePage = lazy(() => import("./pages/workforce-advanced/WorkforcePerformancePage").then((m) => ({ default: m.WorkforcePerformancePage })));
const WorkforcePlanningPage = lazy(() => import("./pages/workforce-advanced/WorkforcePlanningPage").then((m) => ({ default: m.WorkforcePlanningPage })));
const ItemsPage = lazy(() => import("./modules/supply-chain/ItemsPage").then((m) => ({ default: m.ItemsPage })));
const SuppliersPage = lazy(() => import("./modules/supply-chain/SuppliersPage").then((m) => ({ default: m.SuppliersPage })));
const PurchasingPage = lazy(() => import("./modules/supply-chain/PurchasingPage").then((m) => ({ default: m.PurchasingPage })));
const WarehousesPage = lazy(() => import("./pages/wms").then((m) => ({ default: m.WarehousesPage })));
const StockOperationsPage = lazy(() => import("./pages/wms").then((m) => ({ default: m.StockOperationsPage })));
const ValuationPage = lazy(() => import("./pages/wms").then((m) => ({ default: m.ValuationPage })));
const ProcurementPage = lazy(() => import("./pages/procurement").then((m) => ({ default: m.ProcurementPage })));
const SupplierContractsPage = lazy(() => import("./pages/procurement").then((m) => ({ default: m.SupplierContractsPage })));
const SpendAnalyticsPage = lazy(() => import("./pages/procurement").then((m) => ({ default: m.SpendAnalyticsPage })));
const AssetsPage = lazy(() => import("./modules/asset/AssetsPage").then((m) => ({ default: m.AssetsPage })));
const AssetDetailPage = lazy(() => import("./modules/asset/AssetDetailPage").then((m) => ({ default: m.AssetDetailPage })));
const CustomerInvoicesPage = lazy(() => import("./modules/service-operations/CustomerInvoicesPage").then((m) => ({ default: m.CustomerInvoicesPage })));
const CateringPage = lazy(() => import("./pages/service-operations/CateringPage").then((m) => ({ default: m.CateringPage })));
const ServicePacksPage = lazy(() => import("./pages/service-operations/ServicePacksPage").then((m) => ({ default: m.ServicePacksPage })));
const ServiceOptimizationPage = lazy(() => import("./pages/service-operations/ServiceOptimizationPage").then((m) => ({ default: m.ServiceOptimizationPage })));
const ServiceOptimizationDetailPage = lazy(() => import("./pages/service-operations/ServiceOptimizationDetailPage").then((m) => ({ default: m.ServiceOptimizationDetailPage })));
const AssetMaintenancePage = lazy(() => import("./pages/asset-advanced/AssetMaintenancePage").then((m) => ({ default: m.AssetMaintenancePage })));
const AssetMaintenanceWorkOrderDetailPage = lazy(() => import("./pages/asset-advanced/AssetMaintenanceWorkOrderDetailPage").then((m) => ({ default: m.AssetMaintenanceWorkOrderDetailPage })));
const AssetPerformancePage = lazy(() => import("./pages/asset-advanced/AssetPerformancePage").then((m) => ({ default: m.AssetPerformancePage })));
const FinanceAccountsPage = lazy(() => import("./modules/finance/FinanceAccountsPage").then((m) => ({ default: m.FinanceAccountsPage })));
const FinanceTransactionsPage = lazy(() => import("./modules/finance/FinanceTransactionsPage").then((m) => ({ default: m.FinanceTransactionsPage })));
const FinanceTransactionDetailPage = lazy(() => import("./modules/finance/FinanceTransactionDetailPage").then((m) => ({ default: m.FinanceTransactionDetailPage })));
const CashflowPage = lazy(() => import("./modules/finance/CashflowPage").then((m) => ({ default: m.CashflowPage })));
const AccountingPage = lazy(() => import("./modules/finance/AccountingPage").then((m) => ({ default: m.AccountingPage })));
const FinancialStatementsPage = lazy(() => import("./modules/finance/FinancialStatementsPage").then((m) => ({ default: m.FinancialStatementsPage })));
const FinanceJournalsPage = lazy(() => import("./modules/finance/FinanceJournalsPage").then((m) => ({ default: m.FinanceJournalsPage })));
const FinanceOpenItemsPage = lazy(() => import("./modules/finance/FinanceOpenItemsPage").then((m) => ({ default: m.FinanceOpenItemsPage })));
const FinanceBudgetsPage = lazy(() => import("./modules/finance/FinanceBudgetsPage").then((m) => ({ default: m.FinanceBudgetsPage })));
const FinanceBankReconPage = lazy(() => import("./modules/finance/FinanceBankReconPage").then((m) => ({ default: m.FinanceBankReconPage })));
const FinanceAssetsPage = lazy(() => import("./modules/finance/FinanceAssetsPage").then((m) => ({ default: m.FinanceAssetsPage })));
const FinanceTaxPage = lazy(() => import("./modules/finance/FinanceTaxPage").then((m) => ({ default: m.FinanceTaxPage })));
const FinancePeriodsPage = lazy(() => import("./modules/finance/FinancePeriodsPage").then((m) => ({ default: m.FinancePeriodsPage })));
const HseRegisterPage = lazy(() => import("./modules/hse/HseRegisterPage").then((m) => ({ default: m.HseRegisterPage })));
const HseReportPage = lazy(() => import("./modules/hse/HseReportPage").then((m) => ({ default: m.HseReportPage })));
const HseDetailPage = lazy(() => import("./modules/hse/HseDetailPage").then((m) => ({ default: m.HseDetailPage })));
const HseAdvancedInvestigationsPage = lazy(() => import("./modules/hse/HseAdvancedInvestigationsPage").then((m) => ({ default: m.HseAdvancedInvestigationsPage })));
const HseAdvancedPermitsAuditPage = lazy(() => import("./modules/hse/HseAdvancedPermitsAuditPage").then((m) => ({ default: m.HseAdvancedPermitsAuditPage })));
const HseAdvancedMonitoringCapaPage = lazy(() => import("./modules/hse/HseAdvancedMonitoringCapaPage").then((m) => ({ default: m.HseAdvancedMonitoringCapaPage })));
const ProjectDeliveryPage = lazy(() => import("./modules/project-delivery/ProjectDeliveryPage").then((m) => ({ default: m.ProjectDeliveryPage })));
const ProjectDeliveryDetailPage = lazy(() => import("./modules/project-delivery/ProjectDeliveryDetailPage").then((m) => ({ default: m.ProjectDeliveryDetailPage })));
const ProjectDeliveryAdvancedPlanningPage = lazy(() => import("./modules/project-delivery/ProjectDeliveryAdvancedPlanningPage").then((m) => ({ default: m.ProjectDeliveryAdvancedPlanningPage })));
const ProjectDeliveryAdvancedCostEVPage = lazy(() => import("./modules/project-delivery/ProjectDeliveryAdvancedCostEVPage").then((m) => ({ default: m.ProjectDeliveryAdvancedCostEVPage })));
const ReportingInsightPage = lazy(() => import("./modules/reporting-insight/ReportingInsightPage").then((m) => ({ default: m.ReportingInsightPage })));
const DashboardPage = lazy(() => import("./pages/dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const DrillDownListPage = lazy(() => import("./pages/dashboard/DrillDownListPage").then((m) => ({ default: m.DrillDownListPage })));
const AdminRoleDefinitionPage = lazy(() => import("./pages/admin/console/AdminRoleDefinitionPage").then((m) => ({ default: m.AdminRoleDefinitionPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));

const pageFallback = (
  <div className="flex min-h-screen items-center justify-center text-sm text-ink-dim">
    Loading…
  </div>
);

/**
 * Route protection as a layout route: waits for AuthProvider to finish
 * validating/refreshing a persisted session before deciding to redirect
 * (Checkpoint 0F) — otherwise a returning user with a valid session would
 * flash through /login on every reload. Nested routes render via <Outlet/>.
 * The Suspense boundary covers the lazy-loaded page modules below.
 */
function ProtectedLayout() {
  const { session, initializing } = useAuth();
  if (initializing) return pageFallback;
  if (!session) return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={pageFallback}>
      <Outlet />
    </Suspense>
  );
}

/**
 * Checkpoint 1C.1 — multi-route experience layer. The shell is a layout
 * route; each persona section is a child route, gated for visibility by
 * the navigation capability model (backend still enforces authorization).
 * Section experiences behind Complaints / Verification / Management arrive
 * in later checkpoints; Administration mounts the existing Phase 0 surface.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Wave A2 / SUR-ADV-005 — token-governed public route, intentionally
          outside authentication and the internal workspace shell. Its own
          Suspense boundary covers the lazy-loaded page module. */}
      <Route
        path="/public/surveys/:token"
        element={
          <Suspense fallback={pageFallback}>
            <PublicSurveyPage />
          </Suspense>
        }
      />
      <Route element={<ProtectedLayout />}>
        {/* Post-login work-context picker — authenticated but deliberately
            outside the shell: the shell's navigation is what the choice
            shapes, so it cannot wrap the screen that makes the choice. */}
        <Route path="/select-workspace" element={<RoleSiteSelectionPage />} />
        <Route path="/" element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="complaints" element={<ComplaintsListPage />} />
          <Route path="complaints/new" element={<ComplaintCreatePage />} />
          <Route path="complaints/:complaintId" element={<ComplaintDetailPage />} />
          <Route path="queue" element={<OperationalQueuePage />} />
          <Route path="queue/:complaintId" element={<OperationalDetailPage />} />
          <Route path="verification" element={<VerificationQueuePage />} />
          <Route path="verification/:complaintId" element={<VerificationDetailPage />} />
          <Route path="management" element={<ManagementDashboardPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="complaints/configuration" element={<ComplaintConfigPage />} />
          <Route path="surveys" element={<SurveyListPage />} />
          <Route path="surveys/:code" element={<SurveyDetailPage />} />
          <Route path="my-surveys" element={<MySurveysPage />} />
          <Route path="my-surveys/:assignmentId" element={<MySurveyDetailPage />} />
          {/* Phase 2 — Service Operations & Work Management */}
          <Route path="work-orders" element={<WorkOrderQueuePage />} />
          <Route path="work-orders/:workOrderId" element={<WorkOrderDetailPage />} />
<Route path="operations-dashboard" element={<OpsDashboardPage />} />
          <Route path="my-work" element={<MyWorkPage />} />
          <Route path="my-work/:workOrderId" element={<MyWorkDetailPage />} />
          <Route path="service-types" element={<ServiceDefinitionsPage />} />
          {/* Wave A3 — Vertical Packs and Service Operations optimization */}
          <Route path="customer-invoices" element={<CustomerInvoicesPage />} />
          <Route path="catering" element={<CateringPage />} />
          <Route path="service-packs" element={<ServicePacksPage />} />
          <Route path="service-optimization" element={<ServiceOptimizationPage />} />
          <Route path="service-optimization/:runId" element={<ServiceOptimizationDetailPage />} />
          {/* Phase 10 — Customer & Commercial completion */}
          <Route path="customer-commercial" element={<CustomerCommercialPage />} />
          {/* Wave A1 — Sales & Pipeline */}
          <Route path="sales" element={<SalesPipelinePage />} />
          {/* Wave A1 — Service Quality Advanced */}
          <Route path="service-quality" element={<ServiceQualityPage />} />
          {/* Phase 3 — Workforce / HR */}
          <Route path="employees" element={<EmployeesPage />} />
          <Route path="employees/:employeeId" element={<EmployeeDetailPage />} />
          {/* Wave A4 — Workforce Advanced */}
          <Route path="workforce/attendance" element={<WorkforceAttendancePage />} />
          <Route path="workforce/leave-overtime" element={<WorkforceLeaveOvertimePage />} />
          <Route path="workforce/payroll" element={<WorkforcePayrollPage />} />
          <Route path="workforce/recruitment" element={<WorkforceRecruitmentPage />} />
          <Route path="workforce/performance" element={<WorkforcePerformancePage />} />
          <Route path="workforce/planning" element={<WorkforcePlanningPage />} />
          {/* Phase 4 — Supply Chain */}
          <Route path="items" element={<ItemsPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="purchasing" element={<PurchasingPage />} />
          {/* Wave A5 — Supply Chain Advanced (decomposed bounded contexts) */}
          <Route path="wms/warehouses" element={<WarehousesPage />} />
          <Route path="wms/operations" element={<StockOperationsPage />} />
          <Route path="wms/valuation" element={<ValuationPage />} />
          <Route path="procurement/rfqs" element={<ProcurementPage />} />
          <Route path="procurement/contracts" element={<SupplierContractsPage />} />
          <Route path="procurement/spend-analytics" element={<SpendAnalyticsPage />} />
          {/* Backward-compatibility redirects for legacy deep links */}
          <Route path="supply-chain/warehouses" element={<Navigate to="/wms/warehouses" replace />} />
          <Route path="supply-chain/operations" element={<Navigate to="/wms/operations" replace />} />
          <Route path="supply-chain/valuation" element={<Navigate to="/wms/valuation" replace />} />
          <Route path="supply-chain/procurement" element={<Navigate to="/procurement/rfqs" replace />} />
          <Route path="supply-chain/contracts" element={<Navigate to="/procurement/contracts" replace />} />
          <Route path="supply-chain/spend-analytics" element={<Navigate to="/procurement/spend-analytics" replace />} />
          {/* Phase 5 — Asset */}
          <Route path="assets" element={<AssetsPage />} />
          <Route path="assets/:assetId" element={<AssetDetailPage />} />
          {/* Wave A3 — Asset Advanced */}
          <Route path="asset-maintenance" element={<AssetMaintenancePage />} />
          <Route path="asset-maintenance/work-orders/:workOrderId" element={<AssetMaintenanceWorkOrderDetailPage />} />
          <Route path="asset-maintenance/assets/:assetId" element={<AssetPerformancePage />} />
          {/* Phase 6 — Finance */}
          <Route path="finance/accounts" element={<FinanceAccountsPage />} />
          <Route path="finance/transactions" element={<FinanceTransactionsPage />} />
          <Route path="finance/transactions/:transactionId" element={<FinanceTransactionDetailPage />} />
          <Route path="finance/cashflow" element={<CashflowPage />} />
          {/* Wave A6.1 — Finance Advanced */}
          <Route path="finance/accounting" element={<AccountingPage />} />
          <Route path="finance/statements" element={<FinancialStatementsPage />} />
          {/* Wave A6.2 — Finance Advanced write surface. Six screens, one
              page each, on routes the A6 API surface already serves. */}
          <Route path="finance/journals" element={<FinanceJournalsPage />} />
          <Route path="finance/open-items" element={<FinanceOpenItemsPage />} />
          <Route path="finance/budgets" element={<FinanceBudgetsPage />} />
          <Route path="finance/bank-recon" element={<FinanceBankReconPage />} />
          <Route path="finance/fixed-assets" element={<FinanceAssetsPage />} />
          <Route path="finance/tax" element={<FinanceTaxPage />} />
          {/* Wave A8 — period lifecycle and closing, on routes the kernel
              already serves. */}
          <Route path="finance/periods" element={<FinancePeriodsPage />} />
          {/* Phase 7 — HSE */}
          <Route path="hse" element={<HseRegisterPage />} />
          <Route path="hse/report" element={<HseReportPage />} />
          <Route path="hse/records/:recordId" element={<HseDetailPage />} />
          {/* Wave A7 — HSE Advanced. Three screens on the routes the A7 API
              already serves; the Advanced permissions gate them. */}
          <Route path="hse/advanced/investigations" element={<HseAdvancedInvestigationsPage />} />
          <Route path="hse/advanced/permits-audit" element={<HseAdvancedPermitsAuditPage />} />
          <Route path="hse/advanced/monitoring-capa" element={<HseAdvancedMonitoringCapaPage />} />
          {/* Phase 8 — Project Delivery */}
          <Route path="project-delivery" element={<ProjectDeliveryPage />} />
          <Route path="project-delivery/:projectId" element={<ProjectDeliveryDetailPage />} />
          {/* Wave A7 — Project Delivery Advanced. Declared after the detail
              route so `/project-delivery/:projectId` never shadows them; the
              segment counts differ anyway. */}
          <Route path="project-delivery/advanced/planning" element={<ProjectDeliveryAdvancedPlanningPage />} />
          <Route path="project-delivery/advanced/cost-ev" element={<ProjectDeliveryAdvancedCostEVPage />} />
          {/* Phase 9 — Reporting & Operational Insight */}
          <Route path="reporting" element={<ReportingInsightPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="drilldown" element={<DrillDownListPage />} />
          {/* Phase 11C — Business Admin Console (read-only) */}
          <Route path="settings/roles/:roleCode" element={<AdminRoleDefinitionPage />} />
          {/* Epic 4 Wave 1 — Role definition editor, reached from the Roles
              section. A distinct route so the definition survives a reload
              and can be linked to directly. */}
          <Route path="profile" element={<ProfilePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
