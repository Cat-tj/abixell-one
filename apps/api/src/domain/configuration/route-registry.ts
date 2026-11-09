/**
 * Route registry — the code-owned canonical list of every client route in the
 * application dictionary (Epic 2 Wave 1, CORE-ROADMAP.md §4.2 and §4.3).
 *
 * Locked decision (ADR-0014, §4.2): "Inti di kode, penimpa di database" —
 * core definitions live in code and are reviewed with the migration; tenant
 * overrides come later. This file IS the core definition. It is seeded into
 * `app_windows` (one row per route, per tenant) by the tenant trigger and the
 * backfill in 1787200000000_epic-2-wave-1-route-auto-registration.cjs.
 *
 * The same data is mirrored for the browser at
 * `apps/web/src/lib/routeRegistry.ts`; the parity test in
 * `apps/api/tests/route-registry-parity.test.ts` keeps the two in step.
 *
 * Two jobs this supports:
 *   1. Auto-registration — every route gets a window row automatically, so a
 *      page does not have to be manually entered to exist in the dictionary.
 *   2. The route guard (Epic 3) — the dictionary is the only place a route's
 *      required permission is declared. A route absent from this file is
 *      `belum_terdaftar` and, per §4.2 principle 6, cannot be role-locked.
 *
 * Status values (§4.3 "Status resmi setiap route"):
 *   - `di_menu`         — a normal working page; appears in nav and in the
 *                         role screen. (Roadmap: `di-menu`.)
 *   - `tersembunyi`     — a form, detail page, or tool page; hidden from nav
 *                         but STILL permission-checked.
 *   - `belum_terdaftar` — route exists with no status yet. Not role-lockable.
 *                         Reported for follow-up, not silently allowed through.
 *
 * `permissions` is "any of": the route resolves when the user holds at least
 * one code. An empty array means the route is authenticated-only (e.g. the
 * personal profile page) — it still requires a session, just no capability.
 *
 * Detail routes inherit their parent's access (§4.3 "Halaman rincian ...
 * mewarisi aksesnya"), so their permission list is repeated from the parent
 * rather than resolved at runtime — an explicit copy keeps the registry
 * readable and diffable.
 *
 * §4.3 open item 3 ("rincian mana saja yang memang perlu pengecualian
 * hanya-baca") was audited 2026-09-26 across the registry's detail routes
 * (parentPath set). The measurement:
 *
 *   - 15 of 17 detail routes repeat their parent's list verbatim.
 *   - `/asset-maintenance/assets/:assetId` is admitted by a different
 *     capability set: meters, downtime, and performance analytics rather
 *     than the maintenance list. Test roles OPERATOR_ROLE and NO_ANALYTICS_ROLE
 *     show the distinction: the former holds `asset.meter.manage` and
 *     `asset.analytics.read`; the latter holds only `asset.maintenance.read`.
 *   - `/hse/report` is the second and only other deviation: the server gates
 *     the create form on `hse.report` (hse.service.ts:110), not `hse.manage`,
 *     so both codes are listed — an admission correction, not a mode change.
 *   - No detail page is read-only. `/finance/transactions/:transactionId`, the
 *     route the roadmap names by hand, writes through `finance.manage` and
 *     `finance.approve`.
 *
 * What the audit does NOT support is the conclusion first drawn from it — that
 * a read-only exception has no reason to exist. Page capability and role
 * permission are different questions. That a page contains mutations says
 * nothing about whether a given role may perform them; a role holding only
 * `*.read` must be able to open the page and not write, and today nothing
 * expresses that. `permissions` here answers "may the role open the Window at
 * all" — it cannot answer "read-only". That is the third layer, the per-role
 * window lock `role_window_access` (§4.4 Gelombang 1), which is why the roadmap
 * added it and why this registry cannot carry the exception alone.
 *
 * `role_window_access` has landed (Epic 4 Wave 1) and is enforced: step 11b
 * maps each mutating API path to a Window in `window-enforcement.ts`, and
 * `window-access-plugin.ts` rejects POST/PUT/PATCH/DELETE with a 403 when every
 * authorization-effective assignment for that Window is read-only. The route
 * gate still decides whether the page renders.
 *
 * One residue was left by the historical seed, and it was visible. `1787200000000`
 * seeded this route's `note` as "Read-only exception (§4.3): own window identity
 * so it can be locked apart from the list." That note is copied into
 * `app_windows.description` by `config_seed_app_windows_for_tenant()`, and
 * `GET /app-metadata/windows` returns the column — so the wrong framing reached
 * the Application Dictionary for every existing and future tenant, not just this
 * file. The migration is historical (project policy freezes 1755500000000 through
 * 1787600000000), so `1787900000000_epic-3-route-note-correction.cjs` repairs it
 * forward: an UPDATE for existing tenants and a corrected trigger function for
 * future ones. The `note` above is the source-of-truth wording; the registry
 * carries it, the migration restores it in the database.
 *
 * Not digested by the boundary validator — `PHASE_11A_MIGRATION_DIGESTS` ends at
 * `1772000000000`. The freeze on the historical range is a project instruction,
 * not a validator rule.
 */

export type RouteRegistrationStatus = "di_menu" | "tersembunyi" | "belum_terdaftar";

export interface RouteRegistryEntry {
  /** Absolute client path, exactly as declared in App.tsx (`:param` style). */
  path: string;
  /** Human-readable name shown in the dictionary screen. */
  name: string;
  /** Owning module code — must match a row in `modules`. */
  moduleCode: string;
  status: RouteRegistrationStatus;
  /** Resolves when the user holds at least one of these codes. */
  permissions: string[];
  /**
   * Parent route path for a detail/tool page, when it inherits the parent's
   * access. `undefined` for top-level pages. Informational: the permission
   * list above is already the resolved one.
   */
  parentPath?: string;
  /** Short note for the dictionary screen explaining a non-obvious gate. */
  note?: string;
}

/**
 * Every client route, in the order the dictionary should present them.
 * Adding a route without adding it here is exactly the "kesalahan yang
 * terlihat" §4.3 calls for: the guard reports it as `belum_terdaftar`.
 */
export const ROUTE_REGISTRY: RouteRegistryEntry[] = [
  // --- Overview & personal -------------------------------------------------
  {
    path: "/",
    name: "Overview",
    moduleCode: "platform",
    status: "di_menu",
    permissions: [],
    note: "Landing page; cards themselves are filtered by each section's permission.",
  },
  {
    path: "/profile",
    name: "Profile",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
    note: "Self-service profile. Authenticated only — a user always sees their own page.",
  },

  // --- Complaint lifecycle (module: customer_complaint) --------------------
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
    note: "Gated on workflow.instance.manage until a dedicated verifier permission lands.",
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
    note: "SECURITY GAP CLOSED (Epic 3 §4.3): previously reachable with no client-side gate.",
  },

  // --- Surveys (module: survey_assessment) ---------------------------------
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

  // --- Service operations (module: service_operations) ---------------------
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
    permissions: [
      "service_operations.optimization.read",
      "service_operations.optimization.apply",
    ],
  },
  {
    path: "/service-optimization/:runId",
    name: "Optimization Run Detail",
    moduleCode: "service_operations",
    status: "tersembunyi",
    permissions: [
      "service_operations.optimization.read",
      "service_operations.optimization.apply",
    ],
    parentPath: "/service-optimization",
  },

  // --- Customer & commercial (module: customer_commercial) -----------------
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

  // --- Workforce (module: workforce) ---------------------------------------
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

  // --- Warehouse management (module: warehouse_management) -----------------
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

  // --- Warehouse management (module: warehouse_management) -----------------
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
    permissions: [
      "supply_chain.inventory.read",
      "supply_chain.inventory.manage",
      "supply_chain.inventory.approve",
    ],
  },
  {
    path: "/wms/valuation",
    name: "Valuation & Landed Cost",
    moduleCode: "warehouse_management",
    status: "di_menu",
    permissions: ["supply_chain.valuation.read", "supply_chain.valuation.manage"],
  },
  // Legacy redirects. Kept as hidden windows so the dictionary reports them
  // rather than treating the alias as an unregistered route.
  {
    path: "/supply-chain/warehouses",
    name: "Warehouses (legacy path)",
    moduleCode: "warehouse_management",
    status: "tersembunyi",
    permissions: ["supply_chain.warehouse.read", "supply_chain.warehouse.manage"],
    note: "Redirect to /wms/warehouses.",
  },
  {
    path: "/supply-chain/operations",
    name: "Stock Operations (legacy path)",
    moduleCode: "warehouse_management",
    status: "tersembunyi",
    permissions: [
      "supply_chain.inventory.read",
      "supply_chain.inventory.manage",
      "supply_chain.inventory.approve",
    ],
    note: "Redirect to /wms/operations.",
  },
  {
    path: "/supply-chain/valuation",
    name: "Valuation (legacy path)",
    moduleCode: "warehouse_management",
    status: "tersembunyi",
    permissions: ["supply_chain.valuation.read", "supply_chain.valuation.manage"],
    note: "Redirect to /wms/valuation.",
  },

  // --- Procurement (module: procurement_management) ------------------------
  {
    path: "/procurement/rfqs",
    name: "RFQ & Tendering",
    moduleCode: "procurement_management",
    status: "di_menu",
    permissions: [
      "supply_chain.procurement.read",
      "supply_chain.procurement.manage",
      "supply_chain.procurement.award",
    ],
  },
  {
    path: "/procurement/contracts",
    name: "Supplier Contracts & Scorecards",
    moduleCode: "procurement_management",
    status: "di_menu",
    permissions: [
      "supply_chain.contract.read",
      "supply_chain.contract.manage",
      "supply_chain.contract.approve",
    ],
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
    permissions: [
      "supply_chain.procurement.read",
      "supply_chain.procurement.manage",
      "supply_chain.procurement.award",
    ],
    note: "Redirect to /procurement/rfqs.",
  },
  {
    path: "/supply-chain/contracts",
    name: "Contracts (legacy path)",
    moduleCode: "procurement_management",
    status: "tersembunyi",
    permissions: [
      "supply_chain.contract.read",
      "supply_chain.contract.manage",
      "supply_chain.contract.approve",
    ],
    note: "Redirect to /procurement/contracts.",
  },
  {
    path: "/supply-chain/spend-analytics",
    name: "Spend Analytics (legacy path)",
    moduleCode: "procurement_management",
    status: "tersembunyi",
    permissions: ["supply_chain.analytics.read"],
    note: "Redirect to /procurement/spend-analytics.",
  },

  // --- Assets (module: asset) ----------------------------------------------
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
    permissions: [
      "asset.meter.manage",
      "asset.downtime.manage",
      "asset.analytics.read",
    ],
    parentPath: "/asset-maintenance",
    note: "Narrower than the parent: reads meters, downtime, and performance analytics.",
  },

  // --- Finance (module: finance) -------------------------------------------
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
    note: "Detail with its own window identity (§4.3); role read-only mode is lapis 3, not carried here.",
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
    note: "Wave A6.1 overview of periods, ledgers, charts, and accounts. Reads the Accounting Kernel directly.",
  },
  {
    path: "/finance/statements",
    name: "Financial Statements",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read"],
    note: "Wave A6.1 aging, journals, GL postings, and consolidation. Reads the Accounting Kernel directly.",
  },
  {
    path: "/finance/journals",
    name: "Journals",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.manage"],
    note: "Wave A6.2 write surface for the journal lifecycle. The kernel validates and posts; this page only asks it to move the journal to its next state.",
  },
  {
    path: "/finance/open-items",
    name: "Open Items",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
    note: "Wave A6.2 AP/AR open items and allocation. The kernel refuses any pair that is not credit-source to debit-target.",
  },
  {
    path: "/finance/budgets",
    name: "Budgets",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
    note: "Wave A6.2 budget versions and consumption. A version is approved through the approval runtime, not by this page.",
  },
  {
    path: "/finance/bank-recon",
    name: "Bank Reconciliation",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
    note: "Wave A6.2 statement import, match suggestions, manual matches, and close. The service owns the candidate score and the close decision.",
  },
  {
    path: "/finance/fixed-assets",
    name: "Fixed Assets",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
    note: "Wave A6.2 asset books, depreciation runs, run reversal, and disposal. One run posts one journal for every active book in the period.",
  },
  {
    path: "/finance/periods",
    name: "Periods & Closing",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.period.lock", "finance.accounting.configure", "finance.accounting.approve"],
    note: "Wave A8 period lifecycle: lock periods, request their reopen, approve or reject requests, close month or year, and manage ledgers and charts. All seven operations enforce maker-checker and use the kernel for state transitions.",
  },
  {
    path: "/finance/tax",
    name: "Tax",
    moduleCode: "finance",
    status: "di_menu",
    permissions: ["finance.accounting.read", "finance.accounting.configure"],
    note: "Wave A6.2 PKP registration, tax rules and rate versions, and tax calculation. Rates are fractions; the service owns the rounding.",
  },

  // --- HSE (module: hse) ---------------------------------------------------
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
    note: "The create form is gated server-side by `hse.report` (hse.service.ts:110), not `hse.manage`; both are accepted here so an assignee can also open it to correct a record.",
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
    note: "Wave A7 HSE Advanced. Three segments deep, so it does not collide with `/hse/records/:recordId`. Concluding an investigation needs `hse.investigation.lead`, which the recorded-findings form surfaces as a server refusal.",
  },
  {
    path: "/hse/advanced/permits-audit",
    name: "Permits & Audit",
    moduleCode: "hse",
    status: "di_menu",
    permissions: ["hse.advanced.read", "hse.advanced.manage", "hse.permit.request"],
    parentPath: "/hse",
    note: "Wave A7 HSE Advanced. The permit lifecycle is owned by the Workflow Engine (ADR-0027 §4); the page reads the instance status and offers only the actions the engine returns as available.",
  },
  {
    path: "/hse/advanced/monitoring-capa",
    name: "Monitoring & CAPA",
    moduleCode: "hse",
    status: "di_menu",
    permissions: ["hse.advanced.read", "hse.advanced.manage", "hse.capa.verify"],
    parentPath: "/hse",
    note: "Wave A7 HSE Advanced. CAPA is separate from Core follow-up and anchors by reference (ADR-0027 §1); a breach flag is written at reading time.",
  },

  // --- Project delivery (module: project_delivery) -------------------------
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
    note: "Wave A7 Project Delivery Advanced (PRJ-ADV-001…004). Three segments deep, so it does not collide with `/project-delivery/:projectId`, which matches two.",
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
    note: "Wave A7 Project Delivery Advanced (PRJ-ADV-005…008). Cost position and earned value move together, so one page serves both.",
  },

  // --- Reporting (module: reporting_insight) -------------------------------
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
    note: "Generic drill-down list, reachable only from a dashboard card target.",
  },

  // --- Settings (module: platform) ----------------------------------------
  // One Settings surface consolidates the former Admin Console and Panel Admin.
  // The entry permission is the union of the
  // granular config.<category>.* codes and admin.console.read; each tab is
  // gated further by its own permission.
  {
    path: "/settings",
    name: "Settings",
    moduleCode: "platform",
    status: "di_menu",
    permissions: [
      // Backward compat: existing roles with old monolithic code still grant access
      "config.manage",
      // Epic 15 Panel Admin: granular per-category permissions (Wave 1)
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
      // Governance overview
      "admin.console.read",
    ],
    note: "Single Settings surface (consolidated Admin Console + Panel Admin). Granular config.<category>.* gates each tab; admin.console.read gates the governance overview. See CORE-ROADMAP.md §4.15 Decision #7.",
  },
  {
    path: "/settings/roles/:roleCode",
    name: "Role Definition",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: ["admin.console.read"],
    parentPath: "/settings",
    note: "Epic 4 Wave 1 — reached from the Settings Users & Access tab. Hidden because it is a drill-down, not a menu entry; it renders the same Window picker the tab shows, and the write path behind it is gated by `role_window_access` (step 11b).",
  },
  // --- Entry flow (outside the shell) --------------------------------------
  // §4.3: these three are "didaftarkan sebagai alur masuk" — registered, not
  // waived. Hidden status + no permission keeps the guard uniform: every path
  // in the app resolves from this file, so nothing is silently unregistered.
  {
    path: "/login",
    name: "Sign In",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
    note: "Entry flow. Unauthenticated by design.",
  },
  {
    path: "/select-workspace",
    name: "Select Workspace",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
    note: "Entry flow. Runs after sign-in, before the shell.",
  },
  {
    path: "/public/surveys/:token",
    name: "Public Survey Response",
    moduleCode: "survey_assessment",
    status: "tersembunyi",
    permissions: [],
    note: "Entry flow. Reached by token, never by an authenticated session.",
  },

  // --- Catch-all -----------------------------------------------------------
  {
    path: "*",
    name: "Not Found (redirect to Overview)",
    moduleCode: "platform",
    status: "tersembunyi",
    permissions: [],
    note: "Wildcard route; redirects to /. Registered so the guard has nothing to report as unregistered.",
  },
];

/**
 * The route entry matching a resolved pathname, or `null` when no route in
 * App.tsx corresponds to it. Matching is segment-wise so a detail URL such as
 * `/complaints/9f2c…` resolves to `/complaints/:complaintId`; a `:param`
 * segment matches any single segment.
 *
 * The wildcard `*` is deliberately NOT a runtime fallback. It exists in the
 * registry so the declared route set matches App.tsx and so it gets a window
 * row, but if it also matched here then no path could ever resolve to
 * `belum_terdaftar` — and reporting those paths is the entire point of the
 * report-only guard.
 */
export function resolveRouteEntry(path: string): RouteRegistryEntry | null {
  const normalized = normalizePath(path);
  const exact = ROUTE_REGISTRY.find((r) => r.path === normalized);
  if (exact) return exact;

  const requestParts = normalized.split("/");
  const match = ROUTE_REGISTRY.find((route) => {
    if (route.path === "*") return false;
    const routeParts = route.path.split("/");
    if (routeParts.length !== requestParts.length) return false;
    return routeParts.every(
      (part, index) => part.startsWith(":") || part === requestParts[index],
    );
  });
  return match ?? null;
}

/** Trailing slashes are equivalent: `/complaints/` is `/complaints`. */
function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "");
  return path;
}

/**
 * The registration status for a path. A path absent from the registry is
 * `belum_terdaftar` — reported, never silently allowed, never role-lockable
 * (§4.2 principle 6).
 */
export function resolveRouteStatus(path: string): RouteRegistrationStatus {
  return resolveRouteEntry(path)?.status ?? "belum_terdaftar";
}

/** The permissions a path requires, or `null` when the path is unregistered. */
export function resolveRoutePermissions(path: string): string[] | null {
  return resolveRouteEntry(path)?.permissions ?? null;
}
