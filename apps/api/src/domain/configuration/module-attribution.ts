/**
 * Module attribution — the code-owned rule set that assigns each permission,
 * each API path segment, and each route to exactly one module in `modules`
 * (Epic 2 Wave 1, CORE-ROADMAP.md §4.2).
 *
 * Why this file exists. Wave 1 registers three dictionary objects
 * automatically — `app_processes` (one row per permission), `app_api_resources`
 * (one row per HTTP route), and the already-shipped `app_windows` (one row per
 * client route). Every one of those objects carries `module_code`, and
 * `modules` holds exactly fourteen real codes. Nothing in the schema ties a
 * permission or an API path to its module, so without a stated rule the
 * automation would have to guess — and a guess here is what §4.3 calls
 * "kesalahan yang tidak terlihat": a page silently locked to the wrong module,
 * or silently never lockable at all.
 *
 * Locked decision (ADR-0014, §4.2): "inti di kode, penimpa di database". This
 * file is the core definition. It is seeded into the database by the tenant
 * trigger and backfill in the Wave 1 dictionary-seed migration, and the parity
 * test compares the seeded rows against this file so the two cannot drift.
 *
 * Three derivations, each with a stated source of truth:
 *
 *   1. `attributePermission` — from the module that owns the service checking
 *      the permission. Verified against every `requirePermission` call site:
 *      the prefix families below are exactly the service file locations, and
 *      the `PERMISSION_MODULE_EXCEPTIONS` list holds every permission whose
 *      owner is not implied by its prefix.
 *
 *   2. `attributeApiPath` — from the first path segment of the route. The
 *      API surface is grouped by resource noun, and the noun names the module.
 *      The one place the noun lies is the legacy `/supply-chain/advanced`
 *      alias, which mounts three modules' registrars under a single segment;
 *      `API_PATH_MODULE_OVERRIDES` states those subtrees explicitly, and it is
 *      consulted before the segment table.
 *
 *   3. Route attribution is NOT here — it is already stated per route in
 *      `route-registry.ts`, which is the canonical source for `app_windows`.
 *
 * No expression text, no heuristic scoring: a plain table, longest prefix
 * first, with an explicit exception list. A permission or segment that matches
 * nothing resolves to `undefined` and the caller must report it — never
 * silently default it.
 */

/** The fourteen codes present in `modules`. Kept as a literal union so a
 * typo in a rule below is a compile error rather than a row that fails to
 * resolve at seed time. */
export type ModuleCode =
  | "asset"
  | "customer_commercial"
  | "customer_complaint"
  | "finance"
  | "hse"
  | "platform"
  | "procurement_management"
  | "project_delivery"
  | "reporting_insight"
  | "service_operations"
  | "supply_chain"
  | "survey_assessment"
  | "warehouse_management"
  | "workforce";

export const MODULE_CODES: readonly ModuleCode[] = [
  "asset",
  "customer_commercial",
  "customer_complaint",
  "finance",
  "hse",
  "platform",
  "procurement_management",
  "project_delivery",
  "reporting_insight",
  "service_operations",
  "supply_chain",
  "survey_assessment",
  "warehouse_management",
  "workforce",
];

/**
 * Permissions whose owning module is not implied by their prefix.
 *
 * Read this as "the module that owns the service which checks this code",
 * never as "the module whose name sounds closest". Each entry is justified
 * against its call site.
 */
export const PERMISSION_MODULE_EXCEPTIONS: Readonly<Record<string, ModuleCode>> = {
  // Customer & Commercial services. These prefixes are domain nouns shared
  // across modules, so the prefix rule cannot decide them:
  //   contract.service.ts, customer.service.ts, project.service.ts,
  //   sales.service.ts, service-catalog.service.ts, site.service.ts
  // — all under `application/customer/` and `application/sales/`.
  "contract.read": "customer_commercial",
  "contract.manage": "customer_commercial",
  "customer.read": "customer_commercial",
  "customer.manage": "customer_commercial",
  "project.read": "customer_commercial",
  "project.manage": "customer_commercial",
  "sales.read": "customer_commercial",
  "sales.manage": "customer_commercial",
  "sales.approve": "customer_commercial",
  "sales.configure": "customer_commercial",
  "service.read": "customer_commercial",
  "service.manage": "customer_commercial",
  "site.read": "customer_commercial",
  "site.manage": "customer_commercial",

  // Service Quality is the service_quality.* family but lives in the
  // customer_complaint module: `route-registry.ts` puts `/service-quality`
  // under `customer_complaint`, and `service-quality.service.ts` owns both
  // the complaint lifecycle and its quality analytics.
  // (Handled by the `service_quality.` prefix rule below — listed here only
  // as documentation of the deliberate exception to name-matching.)

  // Documents are a platform-level shared service (`document.service.ts`),
  // not a module's private surface.
  "document.read": "platform",
  "document.manage": "platform",
};

/**
 * Prefix rules, longest first at lookup time. The list is written in
 * reading order; `attributePermission` sorts by descending prefix length so
 * `supply_chain.warehouse_task.` wins over `supply_chain.warehouse.` and both
 * win over `supply_chain.`.
 *
 * The `supply_chain.*` family is deliberately split across three modules. The
 * boundary follows 1784000000000_wave-a5-1-stage-3-module-catalog.cjs
 * verbatim: shared master data (items, suppliers, purchase requests/orders)
 * stays `supply_chain`; physical inventory custody and valuation is
 * `warehouse_management`; strategic sourcing, contracts, service acceptance
 * and spend analytics is `procurement_management`.
 */
export const PERMISSION_MODULE_PREFIXES: ReadonlyArray<readonly [string, ModuleCode]> = [
  // Platform — identity, tenancy, configuration and cross-module plumbing.
  // Epic 6 Gelombang 1 — Business Partner canonical party model (platform-level infrastructure).
  ["business_partner.", "platform"],
  ["bp_role.", "platform"],
  ["bp_contact.", "platform"],
  ["bp_address.", "platform"],
  ["tax_registration.", "platform"],
  ["employee_profile.", "platform"],

  // LOA price visibility (`wms.price.view`) gates cost/price fields on WMS reads.
  ["wms.", "warehouse_management"],

  // Supply Chain — warehouse custody and valuation.
  ["supply_chain.warehouse_task.", "warehouse_management"],
  ["supply_chain.warehouse.", "warehouse_management"],
  ["supply_chain.valuation.", "warehouse_management"],
  ["supply_chain.inventory.", "warehouse_management"],
  ["supply_chain.disposal.", "warehouse_management"],
  ["supply_chain.consignment.", "warehouse_management"],
  ["supply_chain.receiving.", "warehouse_management"],

  // Supply Chain — sourcing, contracts, acceptance, analytics.
  ["supply_chain.service_acceptance.", "procurement_management"],
  ["supply_chain.vendor_invoice.", "procurement_management"],
  ["supply_chain.payment.", "procurement_management"],
  ["supply_chain.procurement.", "procurement_management"],
  ["supply_chain.contract.", "procurement_management"],
  ["supply_chain.analytics.", "procurement_management"],

  // Supply Chain — Accounting-readiness hooks and returns-to-vendor stay with
  // the SCM core: returns are a custody reversal owned by the supply-chain
  // service, and account assignment is the SCM-side validation of Finance's
  // posting readiness (ADR-0023 keeps Finance the owner of the posting side).
  ["supply_chain.account_assignment.", "supply_chain"],
  ["supply_chain.accounting_event.", "supply_chain"],
  ["supply_chain.return.", "supply_chain"],
  ["supply_chain.", "supply_chain"],

  // Service surfaces.
  ["service_operations.", "service_operations"],
  ["service_quality.", "customer_complaint"],

  // Remaining module prefixes.
  ["project_delivery.", "project_delivery"],
  ["reporting.", "reporting_insight"],
  ["workforce.", "workforce"],
  ["complaint.", "customer_complaint"],
  ["survey.", "survey_assessment"],
  ["finance.", "finance"],
  ["asset.", "asset"],
  ["hse.", "hse"],

  // Platform — identity, tenancy, configuration and cross-module plumbing.
  ["admin.", "platform"],
  // Role definition authority (Epic 4 §4.4 Gelombang 1): sits ahead of the
  // user.* family because `user.role.manage` (assignment of existing roles)
  // and `role.manage` (mutating a role definition) are deliberately separate.
  ["role.", "platform"],
  ["audit_log.", "platform"],
  ["config.", "platform"],
  // Epic 5 Gelombang 1 — the Department master is tenant-owned platform data
  // (organisation structure), never a module of its own.
  ["department.", "platform"],
  ["integration.", "platform"],
  ["legal_entity.", "platform"],
  ["notification.", "platform"],
  ["observability.", "platform"],
  ["organization_unit.", "platform"],
  ["scheduler.", "platform"],
  ["tenant.", "platform"],
  ["user.", "platform"],
  ["workflow.", "platform"],
];

/** Prefix rules held longest-first, so a longer, more specific prefix always
 * beats a shorter one that is also a prefix of the code. */
const PREFIXES_LONGEST_FIRST = [...PERMISSION_MODULE_PREFIXES].sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * Resolve the owning module for a permission code.
 *
 * Exact exceptions win over prefixes. Returns `undefined` when nothing
 * matches: the caller must report an unattributed permission, because a
 * permission with no module cannot be locked to a role under §4.4.
 */
export function attributePermission(code: string): ModuleCode | undefined {
  const exact = PERMISSION_MODULE_EXCEPTIONS[code];
  if (exact !== undefined) return exact;
  for (const [prefix, moduleCode] of PREFIXES_LONGEST_FIRST) {
    if (code.startsWith(prefix)) return moduleCode;
  }
  return undefined;
}

/**
 * First-path-segment → module for API resources.
 *
 * Every route registered on the API server has exactly one first segment, and
 * this table covers all of them. Segments are the resource noun the routes are
 * grouped under, which is why `items` and `purchase-orders` sit under
 * `supply_chain` while `wms` sits under `warehouse_management` — the same
 * split the permission table makes.
 */
export const API_SEGMENT_MODULES: Readonly<Record<string, ModuleCode>> = {
  // Platform.
  // Wave A8 / PLT-ADV-001 — the versioned partner surface under /api/partner/*
  // is platform-level API economy capability.
  api: "platform",
  admin: "platform",
  "app-metadata": "platform",
  "audit-log": "platform",
  auth: "platform",
  "business-partners": "platform",
  config: "platform",
  departments: "platform",
  documents: "platform",
  health: "platform",
  integration: "platform",
  "legal-entities": "platform",
  me: "platform",
  my: "platform",
  notifications: "platform",
  observability: "platform",
  "organization-units": "platform",
  "organization-unit-change-requests": "platform",
  placements: "platform",
  // WP-APR-02/03 — SoD governance and central rule registry are platform-level
  // configuration surfaces (config.read/manage), same posture as `config`.
  "rule-registry": "platform",
  scheduler: "platform",
  sod: "platform",
  tenants: "platform",
  users: "platform",
  workflow: "platform",

  // Asset.
  assets: "asset",
  "asset-movements": "asset",

  // Customer Complaint (includes Service Quality).
  complaints: "customer_complaint",
  "service-quality": "customer_complaint",

  // Customer & Commercial.
  contracts: "customer_commercial",
  "customer-contacts": "customer_commercial",
  "customer-service-links": "customer_commercial",
  customers: "customer_commercial",
  projects: "customer_commercial",
  sales: "customer_commercial",
  services: "customer_commercial",
  sites: "customer_commercial",

  // Finance.
  finance: "finance",
  accounting: "finance",

  // HSE.
  hse: "hse",

  // Project Delivery.
  "project-delivery": "project_delivery",

  // Reporting & Insight.
  reporting: "reporting_insight",

  // Service Operations.
  "service-definitions": "service_operations",
  "service-operations": "service_operations",
  "work-orders": "service_operations",
  "work-requests": "service_operations",
  // SO-CORE-017 KPI dashboard — a service-operations management surface.
  dashboard: "service_operations",
  // WP-MD-03 Catering vertical master — a service-operations vertical, not a
  // new module.
  catering: "service_operations",

  // Supply Chain — shared master data and purchasing.
  items: "supply_chain",
  "purchase-orders": "supply_chain",
  "purchase-requests": "supply_chain",
  stock: "supply_chain",
  suppliers: "supply_chain",
  "supply-chain": "supply_chain",
  // WP-MD-02 UoM Central.
  "unit-conversions": "supply_chain",
  "units-of-measure": "supply_chain",

  // Procurement Management.
  procurement: "procurement_management",

  // Warehouse Management.
  wms: "warehouse_management",

  // Survey & Assessment (includes the public response entry point).
  public: "survey_assessment",
  "survey-assignments": "survey_assessment",
  "survey-distribution-tokens": "survey_assessment",
  "survey-questions": "survey_assessment",
  "survey-versions": "survey_assessment",
  surveys: "survey_assessment",

  // Workforce.
  employees: "workforce",
  positions: "workforce",
  workforce: "workforce",
};

/**
 * The one place the first-segment rule is wrong: the legacy
 * `/supply-chain/advanced/*` namespace.
 *
 * That namespace is a backward-compatibility shim
 * (`supply-chain/advanced/api/supply-chain-advanced.routes.ts`) which mounts
 * three different registrars under a single first segment:
 *
 *   registerWmsRoutes(app, deps, "/supply-chain/advanced")
 *   registerProcurementRoutes(app, deps, "/supply-chain/advanced")
 *   + three legacy-only account-assignment-config routes
 *
 * So the first segment says `supply_chain` for all of them, while the routes
 * are in fact warehouse, procurement, and supply-chain writes. Left uncorrected
 * this is a silent bypass of §4.3's module ceiling: a tenant that turns off
 * `warehouse_management` but keeps `supply_chain` could still post inventory
 * movements at `/supply-chain/advanced/movements`, and the same handler refused
 * at `/wms/movements` would be accepted at the alias URL. The reverse is just
 * as wrong — disabling `supply_chain` alone would 403 the alias while the
 * canonical `/wms/*` route keeps working.
 *
 * Stated as a table, longest prefix first, exactly like the permission rules
 * above. `module-namespace-parity.test.ts` derives the pairs mechanically from
 * the live route tree and fails if this table and the registrars ever disagree —
 * so adding a route to either namespace without a home here is a test failure,
 * not a silent hole.
 */
export const API_PATH_MODULE_OVERRIDES: ReadonlyArray<readonly [string, ModuleCode]> = [
  // Delegated to registerWmsRoutes ⇒ warehouse_management.
  ["/supply-chain/advanced/warehouses", "warehouse_management"],
  ["/supply-chain/advanced/warehouse-locations", "warehouse_management"],
  ["/supply-chain/advanced/warehouse-tasks", "warehouse_management"],
  ["/supply-chain/advanced/batches", "warehouse_management"],
  ["/supply-chain/advanced/serials", "warehouse_management"],
  ["/supply-chain/advanced/balances", "warehouse_management"],
  ["/supply-chain/advanced/movements", "warehouse_management"],
  ["/supply-chain/advanced/reorder-policies", "warehouse_management"],
  ["/supply-chain/advanced/reorder-alerts", "warehouse_management"],
  ["/supply-chain/advanced/reservations", "warehouse_management"],
  ["/supply-chain/advanced/transfers", "warehouse_management"],
  ["/supply-chain/advanced/opnames", "warehouse_management"],
  ["/supply-chain/advanced/valuation-layers", "warehouse_management"],
  ["/supply-chain/advanced/landed-costs", "warehouse_management"],
  ["/supply-chain/advanced/receiving-records", "warehouse_management"],
  ["/supply-chain/advanced/inspections", "warehouse_management"],
  ["/supply-chain/advanced/discrepancies", "warehouse_management"],
  ["/supply-chain/advanced/returns-to-vendor", "warehouse_management"],
  ["/supply-chain/advanced/receipt-reversals", "warehouse_management"],
  ["/supply-chain/advanced/replacements", "warehouse_management"],
  ["/supply-chain/advanced/accounting-ready-events", "warehouse_management"],
  ["/supply-chain/advanced/consignment", "warehouse_management"],
  ["/supply-chain/advanced/inventory", "warehouse_management"],
  ["/supply-chain/advanced/disposals", "warehouse_management"],

  // Delegated to registerProcurementRoutes ⇒ procurement_management.
  ["/supply-chain/advanced/rfqs", "procurement_management"],
  ["/supply-chain/advanced/bids", "procurement_management"],
  ["/supply-chain/advanced/evaluations", "procurement_management"],
  ["/supply-chain/advanced/contracts", "procurement_management"],
  ["/supply-chain/advanced/spend-analytics", "procurement_management"],
  ["/supply-chain/advanced/service-acceptances", "procurement_management"],
  ["/supply-chain/advanced/invoices", "procurement_management"],
  ["/supply-chain/advanced/payments", "procurement_management"],

  // Legacy-only: cross-cutting account-assignment configuration, which stays
  // on the SCM core (the same split `PERMISSION_MODULE_PREFIXES` makes for
  // `supply_chain.account_assignment.`).
  ["/supply-chain/advanced/account-assignment-configs", "supply_chain"],

  // WP-OPS-01 Phase 6 — the public acceptance link lives under `/public`, but
  // it is a Work Order write, not a survey response. Without this override the
  // first-segment table's `public: "survey_assessment"` row would claim it.
  ["/public/work-orders", "service_operations"],

  // Wave A8 / PLT-ADV-001 — the versioned partner surface is platform-level
  // API economy capability, not the `integration` outbox worker.
  ["/api/partner", "platform"],
];

/** Longest first, so a more specific subtree beats a shorter one that is also
 * a prefix of the path. */
const OVERRIDES_LONGEST_FIRST = [...API_PATH_MODULE_OVERRIDES].sort(
  (a, b) => b[0].length - a[0].length,
);

/**
 * Resolve the owning module for an API route path.
 *
 * The path arrives as Fastify declares it (`/wms/warehouses/:id`), so the
 * caller passes the raw route URL. A path with no first segment (the root)
 * resolves to `undefined` and must be reported rather than defaulted.
 *
 * Explicit subtree overrides win over the first-segment table, and an override
 * matches only on a segment boundary — `/supply-chain/advanced/inventory`
 * matches, `/supply-chain/advanced/inventory-x` does not.
 */
export function attributeApiPath(path: string): ModuleCode | undefined {
  for (const [prefix, moduleCode] of OVERRIDES_LONGEST_FIRST) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return moduleCode;
  }
  const segment = path.replace(/^\//, "").split("/")[0];
  if (segment === "" || segment.startsWith(":")) return undefined;
  return API_SEGMENT_MODULES[segment];
}
