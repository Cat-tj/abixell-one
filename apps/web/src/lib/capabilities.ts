/**
 * Checkpoint 1C.1 — Experience-layer capability & navigation model.
 *
 * Single, client-neutral source of truth for the persona navigation. It
 * maps the raw permission codes returned by `GET /me` to the sections a
 * user may SEE. This is a UX convenience only — every backend route
 * re-enforces its own authorization (RBAC + Customer/Organization/Tenant
 * Data Scope). Hiding a nav item never grants or denies access; it only
 * declutters the shell for the persona in front of it.
 *
 * Deliberately NOT hardcoded per client: sections are gated by generic
 * capability, so the exact same build renders the right menu for a
 * Customer User, a Complaint Handler, a Verifier, Management, or an
 * Administrator purely from that user's granted permissions.
 *
 * Naming rule (ADR-0003): every user-facing `label` here is client-neutral
 * product language — no internal "whitelabel / shared core / platform"
 * terminology ever reaches this layer.
 */

/** Permission codes this layer references. These already exist in the
 * Core RBAC catalog (Phase 0 / Checkpoint 1B seed) — 1C.1 adds none.
 *
 * Note (FD-1C-02): the finer-grained `complaint.dashboard.read` and
 * `complaint.configure` permissions are APPROVED but intentionally NOT
 * wired here yet — they gate real functionality that lands in 1C.5
 * (Management Dashboard) and 1C.6 (Admin Configuration). Until then the
 * Management section is gated on the existing `workflow.instance.manage`
 * capability as a conservative proxy, and Administration on the existing
 * `config.manage`. This keeps 1C.1 a pure frontend foundation with zero
 * backend/permission changes; the swap is a one-line change in each
 * `requiresAnyOf` when those permissions are introduced. */
export const PERMISSIONS = {
  complaintRead: "complaint.read",
  complaintManage: "complaint.manage",
  workflowManage: "workflow.instance.manage",
  complaintDashboardRead: "complaint.dashboard.read",
  complaintConfigure: "complaint.configure",
  configManage: "config.manage",
  configModuleRead: "config.module.read",
  configModuleManage: "config.module.manage",
  configPlatformRead: "config.platform.read",
  configPlatformManage: "config.platform.manage",
  configOrgRead: "config.org.read",
  configOrgManage: "config.org.manage",
  configSystemRead: "config.system.read",
  configSystemManage: "config.system.manage",
  configUserRead: "config.user.read",
  configUserManage: "config.user.manage",
  configWorkflowRead: "config.workflow.read",
  configWorkflowManage: "config.workflow.manage",
  configNotificationRead: "config.notification.read",
  configNotificationManage: "config.notification.manage",
  configDocumentRead: "config.document.read",
  configDocumentManage: "config.document.manage",
  surveyManage: "survey.manage",
  surveyRespond: "survey.respond",
  surveyAnalyticsRead: "survey.analytics.read",
  serviceOperationsRead: "service_operations.read",
  serviceOperationsManage: "service_operations.manage",
  serviceOperationsExecute: "service_operations.execute",
  serviceOperationsConfigure: "service_operations.configure",
  serviceOperationsPackManage: "service_operations.pack.manage",
  serviceOperationsOptimizationRead: "service_operations.optimization.read",
  serviceOperationsOptimizationApply: "service_operations.optimization.apply",
  customerRead: "customer.read",
  customerManage: "customer.manage",
  contractRead: "contract.read",
  contractManage: "contract.manage",
  projectRead: "project.read",
  projectManage: "project.manage",
  siteRead: "site.read",
  siteManage: "site.manage",
  serviceRead: "service.read",
  serviceManage: "service.manage",
  workforceRead: "workforce.read",
  workforceManage: "workforce.manage",
  workforceAttendanceRead: "workforce.attendance.read",
  workforceAttendanceManage: "workforce.attendance.manage",
  workforceLeaveRead: "workforce.leave.read",
  workforceLeaveManage: "workforce.leave.manage",
  workforceLeaveApprove: "workforce.leave.approve",
  workforcePayrollRead: "workforce.payroll.read",
  workforcePayrollManage: "workforce.payroll.manage",
  workforcePayrollApprove: "workforce.payroll.approve",
  workforceRecruitmentRead: "workforce.recruitment.read",
  workforceRecruitmentManage: "workforce.recruitment.manage",
  workforcePerformanceRead: "workforce.performance.read",
  workforcePerformanceManage: "workforce.performance.manage",
  workforcePlanningRead: "workforce.planning.read",
  workforcePlanningManage: "workforce.planning.manage",
  workforcePlanningApply: "workforce.planning.apply",
  supplyChainRead: "supply_chain.read",
  supplyChainManage: "supply_chain.manage",
  supplyChainStockManage: "supply_chain.stock.manage",
  supplyChainConfigure: "supply_chain.configure",
  supplyChainWarehouseRead: "supply_chain.warehouse.read",
  supplyChainWarehouseManage: "supply_chain.warehouse.manage",
  supplyChainInventoryRead: "supply_chain.inventory.read",
  supplyChainInventoryManage: "supply_chain.inventory.manage",
  supplyChainInventoryApprove: "supply_chain.inventory.approve",
  supplyChainValuationRead: "supply_chain.valuation.read",
  supplyChainValuationManage: "supply_chain.valuation.manage",
  supplyChainProcurementRead: "supply_chain.procurement.read",
  supplyChainProcurementManage: "supply_chain.procurement.manage",
  supplyChainProcurementAward: "supply_chain.procurement.award",
  supplyChainContractRead: "supply_chain.contract.read",
  supplyChainContractManage: "supply_chain.contract.manage",
  supplyChainContractApprove: "supply_chain.contract.approve",
  supplyChainAnalyticsRead: "supply_chain.analytics.read",
  assetRead: "asset.read",
  assetManage: "asset.manage",
  assetMove: "asset.move",
  assetMaintenanceRead: "asset.maintenance.read",
  assetMaintenanceManage: "asset.maintenance.manage",
  assetMeterManage: "asset.meter.manage",
  assetDowntimeManage: "asset.downtime.manage",
  assetAnalyticsRead: "asset.analytics.read",
  financeRead: "finance.read",
  financeManage: "finance.manage",
  financeApprove: "finance.approve",
  financeConfigure: "finance.configure",
  financeAccountingRead: "finance.accounting.read",
  financeAccountingManage: "finance.accounting.manage",
  financeAccountingConfigure: "finance.accounting.configure",
  financeAccountingPeriodLock: "finance.accounting.period.lock",
  financeAccountingApprove: "finance.accounting.approve",
  projectDeliveryRead: "project_delivery.read",
  projectDeliveryManage: "project_delivery.manage",
  projectDeliveryAdvancedRead: "project_delivery.advanced.read",
  projectDeliveryAdvancedManage: "project_delivery.advanced.manage",
  projectDeliveryCostRead: "project_delivery.cost.read",
  projectDeliveryCostManage: "project_delivery.cost.manage",
  hseRead: "hse.read",
  hseAdvancedRead: "hse.advanced.read",
  hseAdvancedManage: "hse.advanced.manage",
  hseInvestigationLead: "hse.investigation.lead",
  hsePermitRequest: "hse.permit.request",
  hseCapaVerify: "hse.capa.verify",
  reportingRead: "reporting.read",
  reportingExport: "reporting.export",
  reportingBiManage: "reporting.bi.manage",
  reportingPredictiveRead: "reporting.predictive.read",
  adminConsoleRead: "admin.console.read",
  tenantUpdate: "tenant.update",
  salesRead: "sales.read",
  salesManage: "sales.manage",
  salesApprove: "sales.approve",
  serviceQualityRead: "service_quality.read",
  serviceQualityConfigure: "service_quality.configure",
} as const;

export type NavGroupKey = "operations" | "enterprise-core" | "governance";

export interface NavGroup {
  key: NavGroupKey;
  label: string;
  description: string;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "operations",
    label: "Operations",
    description: "Day-to-day work, queues, services, and surveys.",
  },
  {
    key: "enterprise-core",
    label: "Enterprise Core",
    description: "Customers, people, resources, finance, safety, and delivery.",
  },
  {
    key: "governance",
    label: "Governance & Platform",
    description: "Reporting, administration, and tenant governance.",
  },
];

export type ModuleCode =
  | "customer_complaint"
  | "survey_assessment"
  | "service_operations"
  | "customer_commercial"
  | "workforce"
  | "warehouse_management"
  | "procurement_management"
  | "asset"
  | "finance"
  | "hse"
  | "project_delivery"
  | "reporting_insight";

/** Real module catalog codes, not page names or permission prefixes. */
export const MODULE_METADATA: Record<ModuleCode, { label: string; group: NavGroupKey }> = {
  customer_complaint: { label: "Customer Complaints", group: "operations" },
  survey_assessment: { label: "Surveys & Assessments", group: "operations" },
  service_operations: { label: "Service Operations", group: "operations" },
  customer_commercial: { label: "Customers & Commercial", group: "enterprise-core" },
  workforce: { label: "Workforce & HR", group: "enterprise-core" },
  warehouse_management: { label: "Warehouse Management", group: "enterprise-core" },
  procurement_management: { label: "Procurement Management", group: "enterprise-core" },
  asset: { label: "Asset Management", group: "enterprise-core" },
  finance: { label: "Finance", group: "enterprise-core" },
  hse: { label: "Health, Safety & Environment", group: "enterprise-core" },
  project_delivery: { label: "Project Delivery", group: "enterprise-core" },
  reporting_insight: { label: "Reporting & Insights", group: "governance" },
};

export interface NavSection {
  /** Omitted only for global workspace and platform administration links. */
  moduleCode?: ModuleCode;
  /** Stable key, also used for testing hooks. */
  key: string;
  /** Static information-architecture group. */
  group: NavGroupKey;
  /** Route path relative to the shell root. */
  path: string;
  /** Client-neutral, user-facing label. */
  label: string;
  /** Short description shown on the Overview cards. */
  description: string;
  /** Visible if the user holds AT LEAST ONE of these permissions.
   * `undefined` means "visible to any authenticated user". */
  requiresAnyOf?: string[];
  /** Visible only to INTERNAL users — those with a tenant, legal_entity or
   * organization_unit Data Scope (Checkpoint 1C.3). Keeps operational areas
   * away from external Customer Users. UX only; the backend still enforces
   * access. */
  requiresInternal?: boolean;
  /** Visible only to users who hold a customer Data Scope (external Customer
   * Users) — the customer-facing complaint experience. */
  requiresCustomerScope?: boolean;
}

/** Internal = explicitly holds a tenant, legal_entity or organization_unit
 * Data Scope. Mirrors the API's `isExternalCaller` (menu-filter.ts): Epic 5 G3
 * added `legal_entity`, and the two lists must agree or an internal user is
 * shown the external shell. */
export function isInternalScope(scopeTypes: string[]): boolean {
  return scopeTypes.some(
    (scope) =>
      scope === "tenant" ||
      scope === "legal_entity" ||
      scope === "organization_unit",
  );
}

export function hasCustomerScope(scopeTypes: string[]): boolean {
  return scopeTypes.includes("customer");
}

/**
 * Persona experience areas prepared by 1C.1. The pages behind
 * Complaints / Verification / Management are foundation placeholders in
 * 1C.1 and are filled in by later, separately-gated checkpoints
 * (1C.2–1C.6). Administration mounts the existing Phase 0 admin surface.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    key: "overview",
    group: "operations",
    path: "/",
    label: "Overview",
    description: "Your workspace at a glance.",
  },
  {
    key: "complaints",
    moduleCode: "customer_complaint",
    group: "operations",
    path: "/complaints",
    label: "Complaints",
    description: "Raise and track the complaints you have submitted.",
    requiresAnyOf: [PERMISSIONS.complaintRead, PERMISSIONS.complaintManage],
    requiresCustomerScope: true,
  },
  {
    key: "queue",
    moduleCode: "customer_complaint",
    group: "operations",
    path: "/queue",
    label: "Queue",
    description: "Work the complaints assigned to you and your team.",
    requiresAnyOf: [PERMISSIONS.complaintRead, PERMISSIONS.complaintManage],
    requiresInternal: true,
  },
  {
    key: "verification",
    moduleCode: "customer_complaint",
    group: "operations",
    path: "/verification",
    label: "Verification",
    description: "Independently verify corrective actions awaiting sign-off.",
    // QA/verification is an internal area — gate it away from Customer Users
    // (who hold complaint.manage on their own complaints). `workflow.instance.manage`
    // is the closest existing capability the verifier persona holds
    // (COMPLAINT_MANAGER); it will be replaced by a dedicated permission
    // when 1C.4 / FD-1C-02 land. Backend still enforces all authorization.
    requiresAnyOf: [PERMISSIONS.workflowManage],
    requiresInternal: true,
  },
  {
    key: "management",
    moduleCode: "customer_complaint",
    group: "operations",
    path: "/management",
    label: "Management",
    description: "Complaint performance, SLA, and escalation visibility.",
    // FD-1C-02: gated on the real management permission now (replacing the
    // 1C.1 workflow.instance.manage proxy). Backend enforces it too.
    requiresAnyOf: [PERMISSIONS.complaintDashboardRead],
    requiresInternal: true,
  },
  {
    key: "my-surveys",
    moduleCode: "survey_assessment",
    group: "operations",
    path: "/my-surveys",
    label: "My Surveys",
    description: "Surveys assigned to you — respond and submit.",
    requiresAnyOf: [PERMISSIONS.surveyRespond],
  },
  {
    key: "surveys",
    moduleCode: "survey_assessment",
    group: "operations",
    path: "/surveys",
    label: "Surveys",
    description: "Author surveys, govern distribution, and review cross-survey analytics.",
    requiresAnyOf: [PERMISSIONS.surveyManage, PERMISSIONS.surveyAnalyticsRead],
    requiresInternal: true,
  },
  {
    key: "operations-dashboard",
    moduleCode: "service_operations",
    group: "operations",
    path: "/operations-dashboard",
    label: "Operations Dashboard",
    description: "L2 management KPIs — production achievement, meal fulfillment, food waste, cost per meal.",
    requiresAnyOf: [PERMISSIONS.serviceOperationsRead],
    requiresInternal: true,
  },
  {
    key: "my-work",
    moduleCode: "service_operations",
    group: "operations",
    path: "/my-work",
    label: "My Work",
    description: "The jobs assigned to you — record what you did in the field.",
    requiresAnyOf: [PERMISSIONS.serviceOperationsExecute],
    requiresInternal: true,
  },
  {
    key: "work-orders",
    moduleCode: "service_operations",
    group: "operations",
    path: "/work-orders",
    label: "Work Orders",
    description: "Plan, assign, and follow the work your teams are delivering.",
    requiresAnyOf: [PERMISSIONS.serviceOperationsManage, PERMISSIONS.serviceOperationsRead],
    requiresInternal: true,
  },
  {
    key: "catering",
    moduleCode: "service_operations",
    group: "operations",
    path: "/catering",
    label: "Catering",
    description: "Plan menus, recipes and meal orders, see what to buy, and track meal batches.",
    requiresAnyOf: [PERMISSIONS.serviceOperationsRead],
    requiresInternal: true,
  },
  {
    key: "service-types",
    moduleCode: "service_operations",
    group: "operations",
    path: "/service-types",
    label: "Service Types",
    description: "Define the reusable services your teams deliver.",
    requiresAnyOf: [PERMISSIONS.serviceOperationsConfigure],
    requiresInternal: true,
  },
  {
    key: "service-packs",
    moduleCode: "service_operations",
    group: "operations",
    path: "/service-packs",
    label: "Service Packs",
    description: "Activate Catering, Housekeeping, Camp, and Facility service presets.",
    requiresAnyOf: [PERMISSIONS.serviceOperationsPackManage],
    requiresInternal: true,
  },
  {
    key: "service-optimization",
    moduleCode: "service_operations",
    group: "operations",
    path: "/service-optimization",
    label: "Service Optimization",
    description: "Generate assignment proposals, inspect rationale, then apply or dismiss explicitly.",
    requiresAnyOf: [
      PERMISSIONS.serviceOperationsOptimizationRead,
      PERMISSIONS.serviceOperationsOptimizationApply,
    ],
    requiresInternal: true,
  },
  {
    key: "customer-commercial",
    moduleCode: "customer_commercial",
    group: "enterprise-core",
    path: "/customer-commercial",
    label: "Customers",
    description: "Manage customers, contacts, contracts, projects, sites, and service links.",
    requiresAnyOf: [PERMISSIONS.customerRead],
    requiresInternal: true,
  },
  {
    key: "sales-pipeline",
    moduleCode: "customer_commercial",
    group: "enterprise-core",
    path: "/sales",
    label: "Sales & Pipeline",
    description: "Opportunities, stage pipelines, quotations, and price books.",
    requiresAnyOf: [PERMISSIONS.salesRead, PERMISSIONS.salesManage],
    requiresInternal: true,
  },
  {
    key: "service-quality",
    moduleCode: "customer_complaint",
    group: "operations",
    path: "/service-quality",
    label: "Service Quality",
    description: "SLA performance, RCA categories, CAPA tracking, and recurrence analytics.",
    requiresAnyOf: [PERMISSIONS.serviceQualityRead, PERMISSIONS.serviceQualityConfigure],
    requiresInternal: true,
  },
  {
    key: "employees",
    moduleCode: "workforce",
    group: "enterprise-core",
    path: "/employees",
    label: "Employees",
    description: "Who works here, and where they belong in the organisation.",
    requiresAnyOf: [PERMISSIONS.workforceRead, PERMISSIONS.workforceManage],
    requiresInternal: true,
  },
  {
    key: "workforce-attendance",
    moduleCode: "workforce",
    group: "enterprise-core",
    path: "/workforce/attendance",
    label: "Attendance & Rosters",
    description: "Plan shifts and rosters, then record attendance outcomes.",
    requiresAnyOf: [PERMISSIONS.workforceAttendanceRead, PERMISSIONS.workforceAttendanceManage],
    requiresInternal: true,
  },
  {
    key: "workforce-leave-overtime",
    moduleCode: "workforce",
    group: "enterprise-core",
    path: "/workforce/leave-overtime",
    label: "Leave & Overtime",
    description: "Manage leave balances, requests, overtime, and approvals.",
    requiresAnyOf: [PERMISSIONS.workforceLeaveRead, PERMISSIONS.workforceLeaveManage, PERMISSIONS.workforceLeaveApprove],
    requiresInternal: true,
  },
  {
    key: "workforce-payroll",
    moduleCode: "workforce",
    group: "enterprise-core",
    path: "/workforce/payroll",
    label: "Payroll",
    description: "Govern statutory policy, salary profiles, payroll runs, and payslips.",
    requiresAnyOf: [PERMISSIONS.workforcePayrollRead, PERMISSIONS.workforcePayrollManage, PERMISSIONS.workforcePayrollApprove],
    requiresInternal: true,
  },
  {
    key: "workforce-recruitment",
    moduleCode: "workforce",
    group: "enterprise-core",
    path: "/workforce/recruitment",
    label: "Recruitment",
    description: "Publish openings and move candidates through the hiring pipeline.",
    requiresAnyOf: [PERMISSIONS.workforceRecruitmentRead, PERMISSIONS.workforceRecruitmentManage],
    requiresInternal: true,
  },
  {
    key: "workforce-performance",
    moduleCode: "workforce",
    group: "enterprise-core",
    path: "/workforce/performance",
    label: "Talent & Performance",
    description: "Develop competency, training, performance, and career pathways.",
    requiresAnyOf: [PERMISSIONS.workforcePerformanceRead, PERMISSIONS.workforcePerformanceManage],
    requiresInternal: true,
  },
  {
    key: "workforce-planning",
    moduleCode: "workforce",
    group: "enterprise-core",
    path: "/workforce/planning",
    label: "Workforce Planning",
    description: "Compare headcount and cost scenarios before an advisory decision.",
    requiresAnyOf: [PERMISSIONS.workforcePlanningRead, PERMISSIONS.workforcePlanningManage, PERMISSIONS.workforcePlanningApply],
    requiresInternal: true,
  },
  {
    key: "items",
    moduleCode: "warehouse_management",
    group: "enterprise-core",
    path: "/items",
    label: "Items & Stock",
    description: "What exists, how much of it, and what moved.",
    requiresAnyOf: [PERMISSIONS.supplyChainRead],
    requiresInternal: true,
  },
  {
    key: "scm-warehouses",
    moduleCode: "warehouse_management",
    group: "enterprise-core",
    path: "/wms/warehouses",
    label: "Warehouses & Tracking",
    description: "Multi-warehouse topology, bin locations, batch/lot, and serial tracking.",
    requiresAnyOf: [PERMISSIONS.supplyChainWarehouseRead, PERMISSIONS.supplyChainWarehouseManage],
    requiresInternal: true,
  },
  {
    key: "scm-operations",
    moduleCode: "warehouse_management",
    group: "enterprise-core",
    path: "/wms/operations",
    label: "Stock Operations",
    description: "Reorder alerts, stock reservations, warehouse transfers, and stock opname.",
    requiresAnyOf: [
      PERMISSIONS.supplyChainInventoryRead,
      PERMISSIONS.supplyChainInventoryManage,
      PERMISSIONS.supplyChainInventoryApprove,
    ],
    requiresInternal: true,
  },
  {
    key: "scm-valuation",
    moduleCode: "warehouse_management",
    group: "enterprise-core",
    path: "/wms/valuation",
    label: "Valuation & Landed Cost",
    description: "FIFO/moving average layers, landed cost vouchers, and landed cost allocations.",
    requiresAnyOf: [PERMISSIONS.supplyChainValuationRead, PERMISSIONS.supplyChainValuationManage],
    requiresInternal: true,
  },
  {
    key: "scm-procurement",
    moduleCode: "procurement_management",
    group: "enterprise-core",
    path: "/procurement/rfqs",
    label: "RFQ & Tendering",
    description: "RFQs, tenders, supplier quotations, bid comparisons, and awarding.",
    requiresAnyOf: [
      PERMISSIONS.supplyChainProcurementRead,
      PERMISSIONS.supplyChainProcurementManage,
      PERMISSIONS.supplyChainProcurementAward,
    ],
    requiresInternal: true,
  },
  {
    key: "scm-contracts",
    moduleCode: "procurement_management",
    group: "enterprise-core",
    path: "/procurement/contracts",
    label: "Supplier Contracts & Scorecards",
    description: "Supplier performance evaluations, rating scorecards, and blanket purchasing contracts.",
    requiresAnyOf: [
      PERMISSIONS.supplyChainContractRead,
      PERMISSIONS.supplyChainContractManage,
      PERMISSIONS.supplyChainContractApprove,
    ],
    requiresInternal: true,
  },
  {
    key: "scm-spend",
    moduleCode: "procurement_management",
    group: "enterprise-core",
    path: "/procurement/spend-analytics",
    label: "Spend Analytics",
    description: "Procurement spend analytics, vendor breakdown, PO metrics, and purchasing trends.",
    requiresAnyOf: [PERMISSIONS.supplyChainAnalyticsRead],
    requiresInternal: true,
  },
  {
    key: "suppliers",
    moduleCode: "procurement_management",
    group: "enterprise-core",
    path: "/suppliers",
    label: "Suppliers",
    description: "Who you buy from.",
    requiresAnyOf: [PERMISSIONS.supplyChainRead],
    requiresInternal: true,
  },
  {
    key: "purchasing",
    moduleCode: "procurement_management",
    group: "enterprise-core",
    path: "/purchasing",
    label: "Purchasing",
    description: "Request, order, and receive what your teams need.",
    requiresAnyOf: [PERMISSIONS.supplyChainManage, PERMISSIONS.supplyChainStockManage],
    requiresInternal: true,
  },
  {
    key: "assets",
    moduleCode: "asset",
    group: "enterprise-core",
    path: "/assets",
    label: "Assets",
    description: "What you own, where it is, and who holds it.",
    requiresAnyOf: [PERMISSIONS.assetRead, PERMISSIONS.assetManage, PERMISSIONS.assetMove],
    requiresInternal: true,
  },
  {
    key: "asset-maintenance",
    moduleCode: "asset",
    group: "enterprise-core",
    path: "/asset-maintenance",
    label: "Asset Maintenance",
    description: "Schedules, work orders, parts, meter readings, downtime, and predictive maintenance.",
    requiresAnyOf: [
      PERMISSIONS.assetMaintenanceRead,
      PERMISSIONS.assetMaintenanceManage,
      PERMISSIONS.assetMeterManage,
      PERMISSIONS.assetDowntimeManage,
      PERMISSIONS.assetAnalyticsRead,
    ],
    requiresInternal: true,
  },
  {
    key: "finance-transactions",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/transactions",
    label: "Transactions",
    description: "What came in, what went out, and what it was for.",
    requiresAnyOf: [PERMISSIONS.financeRead, PERMISSIONS.financeManage],
    requiresInternal: true,
  },
  {
    key: "finance-cashflow",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/cashflow",
    label: "Cashflow",
    description: "What moved this period, and where you stand now.",
    requiresAnyOf: [PERMISSIONS.financeRead],
    requiresInternal: true,
  },
  {
    key: "finance-accounts",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/accounts",
    label: "Cash & Bank",
    description: "Where the money actually sits.",
    requiresAnyOf: [PERMISSIONS.financeConfigure, PERMISSIONS.financeRead],
    requiresInternal: true,
  },
  {
    key: "finance-accounting",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/accounting",
    label: "Accounting",
    description: "The periods you keep, the ledgers behind them, and the chart in force.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead, PERMISSIONS.financeAccountingConfigure],
    requiresInternal: true,
  },
  {
    key: "finance-statements",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/statements",
    label: "Financial Statements",
    description: "What is still owed, what has been posted, and how the group reports.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead],
    requiresInternal: true,
  },
  {
    key: "finance-journals",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/journals",
    label: "Journals",
    description: "Draft a journal, check it against the kernel, post it, or reverse it.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead, PERMISSIONS.financeAccountingManage],
    requiresInternal: true,
  },
  {
    key: "finance-open-items",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/open-items",
    label: "Open Items",
    description: "What customers still owe, what you still owe suppliers, and how they settle.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead, PERMISSIONS.financeAccountingConfigure],
    requiresInternal: true,
  },
  {
    key: "finance-budgets",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/budgets",
    label: "Budgets",
    description: "The baseline for the year, and what has been consumed against it.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead, PERMISSIONS.financeAccountingConfigure],
    requiresInternal: true,
  },
  {
    key: "finance-bank-recon",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/bank-recon",
    label: "Bank Reconciliation",
    description: "Pair the statement with the ledger until only real differences remain.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead, PERMISSIONS.financeAccountingConfigure],
    requiresInternal: true,
  },
  {
    key: "finance-fixed-assets",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/fixed-assets",
    label: "Fixed Assets",
    description: "Asset books, their depreciation runs, and what has been disposed of.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead, PERMISSIONS.financeAccountingConfigure],
    requiresInternal: true,
  },
  {
    key: "finance-tax",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/tax",
    label: "Tax",
    description: "PKP status, the rates in force, and what a basis amount is taxed.",
    requiresAnyOf: [PERMISSIONS.financeAccountingRead, PERMISSIONS.financeAccountingConfigure],
    requiresInternal: true,
  },
  {
    key: "finance-periods",
    moduleCode: "finance",
    group: "enterprise-core",
    path: "/finance/periods",
    label: "Periods & Closing",
    description: "Lock a period, request its reopen, close the month or the year, and keep the ledgers current.",
    requiresAnyOf: [
      PERMISSIONS.financeAccountingRead,
      PERMISSIONS.financeAccountingPeriodLock,
      PERMISSIONS.financeAccountingConfigure,
      PERMISSIONS.financeAccountingApprove,
    ],
    requiresInternal: true,
  },
  {
    key: "hse",
    moduleCode: "hse",
    group: "enterprise-core",
    path: "/hse",
    label: "HSE",
    description: "Record and review health, safety, and environmental activity.",
    requiresAnyOf: [PERMISSIONS.hseRead],
    requiresInternal: true,
  },
  {
    key: "hse-advanced-investigations",
    moduleCode: "hse",
    group: "enterprise-core",
    path: "/hse/advanced/investigations",
    label: "Investigations & Risk",
    description: "Versioned investigation frameworks, root cause, and JSA/HIRA risk assessments.",
    requiresAnyOf: [
      PERMISSIONS.hseAdvancedRead,
      PERMISSIONS.hseAdvancedManage,
      PERMISSIONS.hseInvestigationLead,
    ],
    requiresInternal: true,
  },
  {
    key: "hse-advanced-permits-audit",
    moduleCode: "hse",
    group: "enterprise-core",
    path: "/hse/advanced/permits-audit",
    label: "Permits & Audit",
    description: "Work permits on the Workflow Engine, plus audit programmes, occurrences and findings.",
    requiresAnyOf: [
      PERMISSIONS.hseAdvancedRead,
      PERMISSIONS.hseAdvancedManage,
      PERMISSIONS.hsePermitRequest,
    ],
    requiresInternal: true,
  },
  {
    key: "hse-advanced-monitoring-capa",
    moduleCode: "hse",
    group: "enterprise-core",
    path: "/hse/advanced/monitoring-capa",
    label: "Monitoring & CAPA",
    description: "Threshold monitoring with breach flags, corrective and preventive actions, and indicator snapshots.",
    requiresAnyOf: [
      PERMISSIONS.hseAdvancedRead,
      PERMISSIONS.hseAdvancedManage,
      PERMISSIONS.hseCapaVerify,
    ],
    requiresInternal: true,
  },
  {
    key: "project-delivery",
    moduleCode: "project_delivery",
    group: "enterprise-core",
    path: "/project-delivery",
    label: "Project Delivery",
    description: "Track project activities, milestones, and delivery progress.",
    requiresAnyOf: [PERMISSIONS.projectDeliveryRead, PERMISSIONS.projectDeliveryManage],
    requiresInternal: true,
  },
  {
    key: "project-delivery-advanced-planning",
    moduleCode: "project_delivery",
    group: "enterprise-core",
    path: "/project-delivery/advanced/planning",
    label: "Planning & Scheduling",
    description: "The work breakdown, dependencies, the Gantt view, resource loading, and baseline variance.",
    requiresAnyOf: [
      PERMISSIONS.projectDeliveryAdvancedRead,
      PERMISSIONS.projectDeliveryAdvancedManage,
      PERMISSIONS.projectDeliveryRead,
      PERMISSIONS.projectDeliveryManage,
    ],
    requiresInternal: true,
  },
  {
    key: "project-delivery-advanced-cost-ev",
    moduleCode: "project_delivery",
    group: "enterprise-core",
    path: "/project-delivery/advanced/cost-ev",
    label: "Cost & Earned Value",
    description: "Cost entries and position, earned value, and the snapshot history it is measured against.",
    requiresAnyOf: [
      PERMISSIONS.projectDeliveryCostRead,
      PERMISSIONS.projectDeliveryCostManage,
      PERMISSIONS.projectDeliveryAdvancedRead,
      PERMISSIONS.projectDeliveryAdvancedManage,
    ],
    requiresInternal: true,
  },
  {
    key: "reporting-insight",
    moduleCode: "reporting_insight",
    group: "governance",
    path: "/reporting",
    label: "Reporting",
    description: "Scope-safe reports, governed BI, and deterministic predictive insight.",
    requiresAnyOf: [
      PERMISSIONS.reportingRead,
      PERMISSIONS.reportingBiManage,
      PERMISSIONS.reportingPredictiveRead,
    ],
    requiresInternal: true,
  },
  {
    key: "dashboard",
    moduleCode: "reporting_insight",
    group: "governance",
    path: "/dashboard",
    label: "Dashboard",
    description: "Unified cross-module KPI overview with drill-down to records.",
    requiresAnyOf: [PERMISSIONS.reportingRead],
    requiresInternal: true,
  },
  {
    key: "settings",
    group: "governance",
    path: "/settings",
    label: "Settings",
    // One Settings surface consolidates the former Admin Console and Panel
    // Admin. The entry gate is the union of the granular config.<category>.*
    // codes and admin.console.read; each tab is gated further by its own
    // permission. Internal-only — an external Customer User has no business
    // here even if a permission were somehow granted.
    description:
      "Organization, users, access, configuration, shared services, backup, appearance, and documents.",
    requiresAnyOf: [
      PERMISSIONS.configManage,
      PERMISSIONS.configModuleRead,
      PERMISSIONS.configModuleManage,
      PERMISSIONS.configPlatformRead,
      PERMISSIONS.configPlatformManage,
      PERMISSIONS.configOrgRead,
      PERMISSIONS.configOrgManage,
      PERMISSIONS.configSystemRead,
      PERMISSIONS.configSystemManage,
      PERMISSIONS.configUserRead,
      PERMISSIONS.configUserManage,
      PERMISSIONS.configWorkflowRead,
      PERMISSIONS.configWorkflowManage,
      PERMISSIONS.configNotificationRead,
      PERMISSIONS.configNotificationManage,
      PERMISSIONS.configDocumentRead,
      PERMISSIONS.configDocumentManage,
      PERMISSIONS.adminConsoleRead,
    ],
    requiresInternal: true,
  },
];

/** True if the user (permissions + scope types + active modules) satisfies the section's gate. */
export function canSeeSection(
  section: NavSection,
  permissions: string[],
  scopeTypes: string[],
  activeModuleCodes: string[] = [],
): boolean {
  if (section.moduleCode && !activeModuleCodes.includes(section.moduleCode)) {
    return false;
  }
  if (section.requiresAnyOf && !section.requiresAnyOf.some((p) => permissions.includes(p))) {
    return false;
  }
  if (section.requiresInternal && !isInternalScope(scopeTypes)) return false;
  if (section.requiresCustomerScope && !hasCustomerScope(scopeTypes)) return false;
  return true;
}

/** The sections a user may see, in nav order. */
export function visibleSections(
  permissions: string[],
  scopeTypes: string[],
  activeModuleCodes: string[] = [],
): NavSection[] {
  return NAV_SECTIONS.filter((section) =>
    canSeeSection(section, permissions, scopeTypes, activeModuleCodes),
  );
}

export interface VisibleNavGroup extends NavGroup {
  sections: NavSection[];
}

export type VisibleNavNode =
  | { type: "section"; section: NavSection }
  | { type: "module"; moduleCode: ModuleCode; label: string; sections: NavSection[] };

export interface VisibleNavTreeGroup extends NavGroup {
  nodes: VisibleNavNode[];
}

/** Visible sections grouped by the approved Platform Experience information architecture. */
export function visibleSectionGroups(
  permissions: string[],
  scopeTypes: string[],
  activeModuleCodes: string[] = [],
): VisibleNavGroup[] {
  const sections = visibleSections(permissions, scopeTypes, activeModuleCodes);
  return NAV_GROUPS.map((group) => ({
    ...group,
    sections: sections.filter((section) => section.group === group.key),
  })).filter((group) => group.sections.length > 0);
}

/** Visible navigation rendered as standalone global links and module-owned trees. */
export function visibleNavTree(
  permissions: string[],
  scopeTypes: string[],
  activeModuleCodes: string[] = [],
): VisibleNavTreeGroup[] {
  const sections = visibleSections(permissions, scopeTypes, activeModuleCodes);
  return NAV_GROUPS.map((group) => {
    const nodes: VisibleNavNode[] = [];
    const modules = new Map<ModuleCode, Extract<VisibleNavNode, { type: "module" }>>();

    for (const section of sections) {
      if (section.group !== group.key) continue;
      if (!section.moduleCode) {
        nodes.push({ type: "section", section });
        continue;
      }
      const existing = modules.get(section.moduleCode);
      if (existing) {
        existing.sections.push(section);
        continue;
      }
      const moduleNode: Extract<VisibleNavNode, { type: "module" }> = {
        type: "module",
        moduleCode: section.moduleCode,
        label: MODULE_METADATA[section.moduleCode].label,
        sections: [section],
      };
      modules.set(section.moduleCode, moduleNode);
      nodes.push(moduleNode);
    }

    return { ...group, nodes };
  }).filter((group) => group.nodes.length > 0);
}

/** Search only already-visible nodes; a module-label match retains all its children. */
export function filterNavTree(groups: VisibleNavTreeGroup[], query: string): VisibleNavTreeGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return groups;
  const matches = (section: NavSection) =>
    `${section.label} ${section.description}`.toLocaleLowerCase().includes(normalizedQuery);

  return groups.map((group) => ({
    ...group,
    nodes: group.nodes.flatMap((node): VisibleNavNode[] => {
      if (node.type === "section") return matches(node.section) ? [node] : [];
      const sections = node.label.toLocaleLowerCase().includes(normalizedQuery)
        ? node.sections
        : node.sections.filter(matches);
      return sections.length > 0 ? [{ ...node, sections }] : [];
    }),
  })).filter((group) => group.nodes.length > 0);
}

/** Same case-insensitive segment boundary as NavLink; /assets-old is not /assets. */
export function activeNavModuleCodes(groups: VisibleNavTreeGroup[], pathname: string): ModuleCode[] {
  const current = pathname.toLocaleLowerCase();
  return groups.flatMap((group) => group.nodes.flatMap((node) => {
    if (node.type !== "module") return [];
    return node.sections.some(({ path }) => {
      const destination = path.toLocaleLowerCase();
      return current === destination || (destination !== "/" && current.startsWith(`${destination}/`));
    }) ? [node.moduleCode] : [];
  }));
}
