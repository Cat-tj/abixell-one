/**
 * Browser-side mirror of the route registry (Epic 2 Wave 1, CORE-ROADMAP.md
 * §4.2 and §4.3). Copied from
 * apps/api/src/domain/configuration/route-registry.ts, which is canonical.
 *
 * The backend registry is canonical; apps/web cannot import apps/api, so the
 * guard reads this mirror instead. Change the backend registry and this file in
 * the same commit — apps/api/tests/route-registry-parity.test.ts fails if the
 * two ever disagree, including on status and permissions.
 *
 * Epic 3 Wave 1 flipped the guard to ENFORCE (CORE-ROADMAP.md §4.3 step 1:
 * "perilaku default tertutup. Route yang belum punya status resmi tidak boleh
 * merender isi halaman"). AppShell branches on GUARD_ENFORCE and withholds the
 * route rather than warning. The guard is still a UX affordance only — it
 * renders a denial screen, it never stops an API call. Every operation stays
 * gated by the server's own permission check; this only decides what the shell
 * puts on screen.
 */

export type RouteRegistrationStatus = "di_menu" | "tersembunyi" | "belum_terdaftar";

/**
 * Flipped to true in Epic 3 Wave 1 (§4.3 step 1) after the Epic 2 report came
 * back clean across every declared route. The shell withholds the page when
 * this is true; the report banner is gone.
 *
 * This is the end state, not a staging value (Epic 3 Wave 2 closed §4.3 open
 * item 2). An unregistered path already resolves to `null` here and is
 * withheld — the same outcome a deadline would produce, without a window in
 * which such a route renders. What keeps `belum_terdaftar` from ever being
 * reached is the build-time parity check, not a countdown.
 */
export const GUARD_ENFORCE = true;

export interface RouteRegistryEntry {
  path: string;
  name: string;
  moduleCode: string;
  status: RouteRegistrationStatus;
  /** "any of" — the route resolves when the user holds at least one. */
  permissions: string[];
  parentPath?: string;
}

/** Every client route, mirrored from the backend registry. */
export const ROUTE_REGISTRY: RouteRegistryEntry[] = [
  {
    path: "/",
    name: "Overview",
    moduleCode: "platform",
    status: "di_menu",
    permissions: [],
  },
  {
    path: "/profile",
    name: "Profile",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
  },
  {
    path: "/complaints",
    name: "Complaints",
    moduleCode: "customer_complaint",
    status: "di_menu",
    permissions: ["complaint.read", "complaint.manage"],
  },
  {
    path: "/complaints/new",
    name: "Raise a Complaint",
    moduleCode: "customer_complaint",
    status: "tersembunyi",
    permissions: ["complaint.read", "complaint.manage"],
    parentPath: "/complaints",
  },
  {
    path: "/complaints/:complaintId",
    name: "Complaint Detail",
    moduleCode: "customer_complaint",
    status: "tersembunyi",
    permissions: ["complaint.read", "complaint.manage"],
    parentPath: "/complaints",
  },
  {
    path: "/queue",
    name: "Queue",
    moduleCode: "customer_complaint",
    status: "di_menu",
    permissions: ["complaint.read", "complaint.manage"],
  },
  {
    path: "/queue/:complaintId",
    name: "Queue Item",
    moduleCode: "customer_complaint",
    status: "tersembunyi",
    permissions: ["complaint.read", "complaint.manage"],
    parentPath: "/queue",
  },
  {
    path: "/verification",
    name: "Verification",
    moduleCode: "customer_complaint",
    status: "di_menu",
    permissions: ["workflow.instance.manage"],
  },
  {
    path: "/verification/:complaintId",
    name: "Verification Detail",
    moduleCode: "customer_complaint",
    status: "tersembunyi",
    permissions: ["workflow.instance.manage"],
    parentPath: "/verification",
  },
  {
    path: "/management",
    name: "Management Dashboard",
    moduleCode: "customer_complaint",
    status: "di_menu",
    permissions: ["complaint.dashboard.read"],
  },
  {
    path: "/service-quality",
    name: "Service Quality",
    moduleCode: "customer_complaint",
    status: "di_menu",
    permissions: ["service_quality.read", "service_quality.configure"],
  },
  {
    path: "/complaints/configuration",
    name: "Complaint Configuration",
    moduleCode: "customer_complaint",
    status: "tersembunyi",
    permissions: ["complaint.configure"],
  },
  {
    path: "/surveys",
    name: "Surveys",
    moduleCode: "survey_assessment",
    status: "di_menu",
    permissions: ["survey.manage", "survey.analytics.read"],
  },
  {
    path: "/surveys/:code",
    name: "Survey Detail",
    moduleCode: "survey_assessment",
    status: "tersembunyi",
    permissions: ["survey.manage", "survey.analytics.read"],
    parentPath: "/surveys",
  },
  {
    path: "/my-surveys",
    name: "My Surveys",
    moduleCode: "survey_assessment",
    status: "di_menu",
    permissions: ["survey.respond"],
  },
  {
    path: "/my-surveys/:assignmentId",
    name: "Survey Response",
    moduleCode: "survey_assessment",
    status: "tersembunyi",
    permissions: ["survey.respond"],
    parentPath: "/my-surveys",
  },
  {
    path: "/work-orders",
    name: "Work Orders",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.manage", "service_operations.read"],
  },
  {
    path: "/catering",
    name: "Catering",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.read"],
  },
  {
    path: "/customer-invoices",
    name: "Customer Invoices",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.read"],
  },
  {
    path: "/work-orders/:workOrderId",
    name: "Work Order Detail",
    moduleCode: "service_operations",
    status: "tersembunyi",
    permissions: ["service_operations.manage", "service_operations.read"],
    parentPath: "/work-orders",
  },
  {
    path: "/operations-dashboard",
    name: "Operations Dashboard",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.read"],
  },
  {
    path: "/my-work",
    name: "My Work",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.execute"],
  },
  {
    path: "/my-work/:workOrderId",
    name: "My Work Detail",
    moduleCode: "service_operations",
    status: "tersembunyi",
    permissions: ["service_operations.execute"],
    parentPath: "/my-work",
  },
  {
    path: "/service-types",
    name: "Service Types",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.configure"],
  },
  {
    path: "/service-packs",
    name: "Service Packs",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.pack.manage"],
  },
  {
    path: "/service-optimization",
    name: "Service Optimization",
    moduleCode: "service_operations",
    status: "di_menu",
    permissions: ["service_operations.optimization.read", "service_operations.optimization.apply"],
  },
  {
    path: "/service-optimization/:runId",
    name: "Optimization Run Detail",
    moduleCode: "service_operations",
    status: "tersembunyi",
    permissions: ["service_operations.optimization.read", "service_operations.optimization.apply"],
    parentPath: "/service-optimization",
  },
  {
    path: "/customer-commercial",
    name: "Customers",
    moduleCode: "customer_commercial",
    status: "di_menu",
    permissions: ["customer.read"],
  },
  {
    path: "/sales",
    name: "Sales & Pipeline",
    moduleCode: "customer_commercial",
    status: "di_menu",
    permissions: ["sales.read", "sales.manage"],
  },
  {
    path: "/employees",
    name: "Employees",
    moduleCode: "workforce",
    status: "di_menu",
    permissions: ["workforce.read", "workforce.manage"],
  },
  {
    path: "/employees/:employeeId",
    name: "Employee Detail",
    moduleCode: "workforce",
    status: "tersembunyi",
    permissions: ["workforce.read", "workforce.manage"],
    parentPath: "/employees",
  },
  {
    path: "/workforce/attendance",
    name: "Attendance & Rosters",
    moduleCode: "workforce",
    status: "di_menu",
    permissions: ["workforce.attendance.read", "workforce.attendance.manage"],
  },
  {
    path: "/workforce/leave-overtime",
    name: "Leave & Overtime",
    moduleCode: "workforce",
    status: "di_menu",
    permissions: ["workforce.leave.read", "workforce.leave.manage", "workforce.leave.approve"],
  },
  {
    path: "/workforce/payroll",
    name: "Payroll",
    moduleCode: "workforce",
    status: "di_menu",
    permissions: ["workforce.payroll.read", "workforce.payroll.manage", "workforce.payroll.approve"],
  },
  {
    path: "/workforce/recruitment",
    name: "Recruitment",
    moduleCode: "workforce",
    status: "di_menu",
    permissions: ["workforce.recruitment.read", "workforce.recruitment.manage"],
  },
  {
    path: "/workforce/performance",
    name: "Talent & Performance",
    moduleCode: "workforce",
    status: "di_menu",
    permissions: ["workforce.performance.read", "workforce.performance.manage"],
  },
  {
    path: "/workforce/planning",
    name: "Workforce Planning",
    moduleCode: "workforce",
    status: "di_menu",
    permissions: ["workforce.planning.read", "workforce.planning.manage", "workforce.planning.apply"],
  },
  {
    path: "/items",
    name: "Items & Stock",
    moduleCode: "warehouse_management",
    status: "di_menu",
    permissions: ["supply_chain.read"],
  },
  {
    path: "/suppliers",
    name: "Suppliers",
    moduleCode: "procurement_management",
    status: "di_menu",
    permissions: ["supply_chain.read"],
  },
  {
    path: "/purchasing",
    name: "Purchasing",
    moduleCode: "procurement_management",
    status: "di_menu",
    permissions: ["supply_chain.manage", "supply_chain.stock.manage"],
  },
  {
    path: "/wms/warehouses",
    name: "Warehouses & Tracking",
    moduleCode: "warehouse_management",
    status: "di_menu",
    permissions: ["supply_chain.warehouse.read", "supply_chain.warehouse.manage"],
  },
  {
    path: "/wms/operations",
    name: "Stock Operations",
    moduleCode: "warehouse_management",
    status: "di_menu",
    permissions: ["supply_chain.inventory.read", "supply_chain.inventory.manage", "supply_chain.inventory.approve"],
  },
  {
    path: "/wms/valuation",
    name: "Valuation & Landed Cost",
    moduleCode: "warehouse_management",
    status: "di_menu",
    permissions: ["supply_chain.valuation.read", "supply_chain.valuation.manage"],
  },
  {
    path: "/supply-chain/warehouses",
    name: "Warehouses (legacy path)",
    moduleCode: "warehouse_management",
    status: "tersembunyi",
    permissions: ["supply_chain.warehouse.read", "supply_chain.warehouse.manage"],
  },
  {
    path: "/supply-chain/operations",
    name: "Stock Operations (legacy path)",
    moduleCode: "warehouse_management",
    status: "tersembunyi",
    permissions: ["supply_chain.inventory.read", "supply_chain.inventory.manage", "supply_chain.inventory.approve"],
  },
  {
    path: "/supply-chain/valuation",
    name: "Valuation (legacy path)",
    moduleCode: "warehouse_management",
    status: "tersembunyi",
    permissions: ["supply_chain.valuation.read", "supply_chain.valuation.manage"],
  },
  {
    path: "/procurement/rfqs",
    name: "RFQ & Tendering",
    moduleCode: "procurement_management",
    status: "di_menu",
    permissions: ["supply_chain.procurement.read", "supply_chain.procurement.manage", "supply_chain.procurement.award"],
  },
  {
    path: "/procurement/contracts",
    name: "Supplier Contracts & Scorecards",
    moduleCode: "procurement_management",
    status: "di_menu",
    permissions: ["supply_chain.contract.read", "supply_chain.contract.manage", "supply_chain.contract.approve"],
  },
  {
    path: "/procurement/spend-analytics",
    name: "Spend Analytics",
    moduleCode: "procurement_management",
    status: "di_menu",
    permissions: ["supply_chain.analytics.read"],
  },
  {
    path: "/supply-chain/procurement",
    name: "RFQ (legacy path)",
    moduleCode: "procurement_management",
    status: "tersembunyi",
    permissions: ["supply_chain.procurement.read", "supply_chain.procurement.manage", "supply_chain.procurement.award"],
  },
  {
    path: "/supply-chain/contracts",
    name: "Contracts (legacy path)",
    moduleCode: "procurement_management",
    status: "tersembunyi",
    permissions: ["supply_chain.contract.read", "supply_chain.contract.manage", "supply_chain.contract.approve"],
  },
  {
    path: "/supply-chain/spend-analytics",
    name: "Spend Analytics (legacy path)",
    moduleCode: "procurement_management",
    status: "tersembunyi",
    permissions: ["supply_chain.analytics.read"],
  },
  {
    path: "/assets",
    name: "Assets",
    moduleCode: "asset",
    status: "di_menu",
    permissions: ["asset.read", "asset.manage", "asset.move"],
  },
  {
    path: "/assets/:assetId",
    name: "Asset Detail",
    moduleCode: "asset",
    status: "tersembunyi",
    permissions: ["asset.read", "asset.manage", "asset.move"],
    parentPath: "/assets",
  },
  {
    path: "/asset-maintenance",
    name: "Asset Maintenance",
    moduleCode: "asset",
    status: "di_menu",
    permissions: ["asset.maintenance.read", "asset.maintenance.manage"],
  },
  {
    path: "/asset-maintenance/work-orders/:workOrderId",
    name: "Maintenance Work Order Detail",
    moduleCode: "asset",
    status: "tersembunyi",
    permissions: ["asset.maintenance.read", "asset.maintenance.manage"],
    parentPath: "/asset-maintenance",
  },
  {
    path: "/asset-maintenance/assets/:assetId",
    name: "Asset Performance",
    moduleCode: "asset",
    status: "tersembunyi",
    permissions: ["asset.meter.manage", "asset.downtime.manage", "asset.analytics.read"],
    parentPath: "/asset-maintenance",
  },
  {
    path: "/finance/accounts",
    name: "Cash & Bank",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.configure", "finance.read"],
  },
  {
    path: "/finance/transactions",
    name: "Transactions",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.read", "finance.manage"],
  },
  {
    path: "/finance/transactions/:transactionId",
    name: "Transaction Detail",
    moduleCode: "finance",
    status: "tersembunyi",
    permissions: ["finance.read", "finance.manage"],
    parentPath: "/finance/transactions",
  },
  {
    path: "/finance/cashflow",
    name: "Cashflow",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.read"],
  },
  {
    path: "/finance/accounting",
    name: "Accounting",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
  },
  {
    path: "/finance/statements",
    name: "Financial Statements",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read"],
  },
  {
    path: "/finance/journals",
    name: "Journals",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.manage"],
  },
  {
    path: "/finance/open-items",
    name: "Open Items",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
  },
  {
    path: "/finance/budgets",
    name: "Budgets",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
  },
  {
    path: "/finance/bank-recon",
    name: "Bank Reconciliation",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
  },
  {
    path: "/finance/fixed-assets",
    name: "Fixed Assets",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
  },
  {
    path: "/finance/periods",
    name: "Periods & Closing",
    moduleCode: "finance",
    status: "di_menu",
    permissions: [
      "finance.accounting.read",
      "finance.accounting.period.lock",
      "finance.accounting.configure",
      "finance.accounting.approve",
    ],
  },
  {
    path: "/finance/tax",
    name: "Tax",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
  },
  {
    path: "/hse",
    name: "HSE",
    moduleCode: "hse",
    status: "di_menu",
    permissions: ["hse.read"],
  },
  {
    path: "/hse/report",
    name: "Report an Incident",
    moduleCode: "hse",
    status: "tersembunyi",
    permissions: ["hse.report", "hse.manage"],
    parentPath: "/hse",
  },
  {
    path: "/hse/records/:recordId",
    name: "HSE Record Detail",
    moduleCode: "hse",
    status: "tersembunyi",
    permissions: ["hse.read"],
    parentPath: "/hse",
  },
  {
    path: "/hse/advanced/investigations",
    name: "Investigations & Risk",
    moduleCode: "hse",
    status: "di_menu",
    permissions: ["hse.advanced.read", "hse.advanced.manage", "hse.investigation.lead"],
    parentPath: "/hse",
  },
  {
    path: "/hse/advanced/permits-audit",
    name: "Permits & Audit",
    moduleCode: "hse",
    status: "di_menu",
    permissions: ["hse.advanced.read", "hse.advanced.manage", "hse.permit.request"],
    parentPath: "/hse",
  },
  {
    path: "/hse/advanced/monitoring-capa",
    name: "Monitoring & CAPA",
    moduleCode: "hse",
    status: "di_menu",
    permissions: ["hse.advanced.read", "hse.advanced.manage", "hse.capa.verify"],
    parentPath: "/hse",
  },
  {
    path: "/project-delivery",
    name: "Project Delivery",
    moduleCode: "project_delivery",
    status: "di_menu",
    permissions: ["project_delivery.read", "project_delivery.manage"],
  },
  {
    path: "/project-delivery/:projectId",
    name: "Project Detail",
    moduleCode: "project_delivery",
    status: "tersembunyi",
    permissions: ["project_delivery.read", "project_delivery.manage"],
    parentPath: "/project-delivery",
  },
  {
    path: "/project-delivery/advanced/planning",
    name: "Planning & Scheduling",
    moduleCode: "project_delivery",
    status: "di_menu",
    permissions: [
      "project_delivery.advanced.read",
      "project_delivery.advanced.manage",
      "project_delivery.read",
      "project_delivery.manage",
    ],
    parentPath: "/project-delivery",
  },
  {
    path: "/project-delivery/advanced/cost-ev",
    name: "Cost & Earned Value",
    moduleCode: "project_delivery",
    status: "di_menu",
    permissions: [
      "project_delivery.cost.read",
      "project_delivery.cost.manage",
      "project_delivery.advanced.read",
      "project_delivery.advanced.manage",
    ],
    parentPath: "/project-delivery",
  },
  {
    path: "/reporting",
    name: "Reporting",
    moduleCode: "reporting_insight",
    status: "di_menu",
    permissions: ["reporting.read", "reporting.bi.manage", "reporting.predictive.read"],
  },
  {
    path: "/dashboard",
    name: "Dashboard",
    moduleCode: "reporting_insight",
    status: "di_menu",
    permissions: ["reporting.read"],
  },
  {
    path: "/drilldown",
    name: "Drill-down",
    moduleCode: "reporting_insight",
    status: "tersembunyi",
    permissions: ["reporting.read"],
    parentPath: "/dashboard",
  },
  {
    path: "/settings",
    name: "Settings",
    moduleCode: "platform",
    status: "di_menu",
    permissions: [
      "config.manage",
      "config.module.read",
      "config.module.manage",
      "config.platform.read",
      "config.platform.manage",
      "config.org.read",
      "config.org.manage",
      "config.system.read",
      "config.system.manage",
      "config.user.read",
      "config.user.manage",
      "config.workflow.read",
      "config.workflow.manage",
      "config.notification.read",
      "config.notification.manage",
      "config.document.read",
      "config.document.manage",
      "admin.console.read",
    ],
  },
  // Epic 4 Wave 1 — Role definition lives inside the Settings Users & Access
  // tab. The tab list stays on `admin.console.read`; the definition screen
  // itself is gated per-view (config.read to load, role.manage to save), so
  // the route guard only needs to let console holders through.
  {
    path: "/settings/roles/:roleCode",
    name: "Role Definition",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: ["admin.console.read"],
    parentPath: "/settings",
  },
  {
    path: "/login",
    name: "Sign In",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
  },
  {
    path: "/select-workspace",
    name: "Select Workspace",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
  },
  {
    path: "/public/surveys/:token",
    name: "Public Survey Response",
    moduleCode: "survey_assessment",
    status: "tersembunyi",
    permissions: [],
  },
  {
    path: "*",
    name: "Not Found (redirect to Overview)",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
  },
];

/** Trailing slashes are equivalent: `/complaints/` is `/complaints`. */
function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "");
  return path;
}

/**
 * The route entry matching a pathname, or `null` when no route in App.tsx
 * corresponds to it. `:param` matches exactly one segment. The wildcard `*`
 * is deliberately not a fallback: if it matched, no path could ever resolve to
 * `belum_terdaftar` — and surface those is what makes a missing registration
 * visible instead of silently allowed through.
 *
 * Matching is case-insensitive to stay aligned with React Router, which matches
 * case-insensitively by default. A guard stricter than the router would deny a
 * path the router happily renders; the two must agree on what "this route" is.
 */
export function resolveRouteEntry(pathname: string): RouteRegistryEntry | null {
  const normalized = normalizePath(pathname).toLocaleLowerCase();
  const exact = ROUTE_REGISTRY.find(
    (r) => normalizePath(r.path).toLocaleLowerCase() === normalized,
  );
  if (exact) return exact;

  const requestParts = normalized.split("/");
  return (
    ROUTE_REGISTRY.find((route) => {
      if (route.path === "*") return false;
      const routeParts = normalizePath(route.path).toLocaleLowerCase().split("/");
      if (routeParts.length !== requestParts.length) return false;
      return routeParts.every(
        (part, index) => part.startsWith(":") || part === requestParts[index],
      );
    }) ?? null
  );
}

/**
 * Entry-flow routes run before the shell exists and carry no permission: the
 * sign-in screen, the workspace picker, the token-addressed public survey, and
 * the catch-all redirect. They resolve, so the guard allows them anyway — this
 * exists so the shell can name WHY it renders one with no navigation behind
 * it, instead of leaving it looking like a route that slipped through.
 */
const ENTRY_FLOW_PATHS = new Set(["/login", "/select-workspace", "/public/surveys/:token", "*"]);

export function isEntryFlowRoute(entry: RouteRegistryEntry | null): boolean {
  return entry !== null && ENTRY_FLOW_PATHS.has(entry.path);
}

export interface RouteGuardReport {
  pathname: string;
  /** `false` when the path is unknown to the registry (`belum_terdaftar`). */
  registered: boolean;
  entry: RouteRegistryEntry | null;
  /** Permission codes the route requires and the user does not hold. */
  missingPermissions: string[];
  /** `true` when the route resolves and the user may reach it. */
  ok: boolean;
}

/**
 * Resolve a pathname against the registry and the user's granted permissions.
 * Pure and total: it reports, it does not decide. GUARD_ENFORCE decides.
 */
export function evaluateRouteAccess(
  pathname: string,
  grantedPermissions: readonly string[],
): RouteGuardReport {
  const entry = resolveRouteEntry(pathname);
  if (!entry) {
    return {
      pathname,
      registered: false,
      entry: null,
      missingPermissions: [],
      ok: false,
    };
  }
  const granted = new Set(grantedPermissions);
  const absent = entry.permissions.filter((code) => !granted.has(code));
  // "any of": the route resolves with at least one of its codes, so it is only
  // withheld when the user holds none of them.
  const missingPermissions =
    entry.permissions.length > 0 && absent.length === entry.permissions.length ? absent : [];
  return {
    pathname,
    registered: true,
    entry,
    missingPermissions,
    ok: missingPermissions.length === 0,
  };
}
