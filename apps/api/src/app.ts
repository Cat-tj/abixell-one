import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { healthRoutes } from "./interfaces/http/routes/health.js";
import { registerAuthDecorators } from "./interfaces/http/plugins/auth-plugin.js";
import { registerBootstrapAuthDecorators } from "./interfaces/http/plugins/bootstrap-auth-plugin.js";
import { registerModuleActivityEnforcement } from "./interfaces/http/plugins/module-activity-plugin.js";
import { registerWindowAccessEnforcement } from "./interfaces/http/plugins/window-access-plugin.js";
import { registerErrorMapping } from "./interfaces/http/error-mapping.js";
import { registerAuthRoutes } from "./interfaces/http/routes/auth.js";
import { registerTenantRoutes } from "./interfaces/http/routes/tenants.js";
import { registerLegalEntityRoutes } from "./interfaces/http/routes/legal-entities.js";
import { registerLegalEntityAttachmentReferenceRoutes } from "./interfaces/http/routes/legal-entity-attachment-references.js";
import { registerOrganizationUnitRoutes } from "./interfaces/http/routes/organization-units.js";
import { registerOrganizationUnitHierarchyRoutes } from "./interfaces/http/routes/organization-unit-hierarchy.js";
import { registerDepartmentRoutes } from "./interfaces/http/routes/departments.js";
import { registerBusinessPartnerRoutes } from "./interfaces/http/routes/business-partners.js";
import { registerSodRoutes } from "./interfaces/http/routes/sod.js";
import { registerRuleRegistryRoutes } from "./interfaces/http/routes/rule-registry.js";
import { registerEmployeePlacementRoutes } from "./interfaces/http/routes/employee-placements.js";
import { registerUserRoutes } from "./interfaces/http/routes/users.js";
import { registerAuditRoutes } from "./interfaces/http/routes/audit.js";
import { registerConfigurationRoutes } from "./interfaces/http/routes/config.js";
import { registerAppMetadataRoutes } from "./interfaces/http/routes/app-metadata.js";
import { registerWorkflowRoutes } from "./interfaces/http/routes/workflow.js";
import { registerNotificationRoutes } from "./interfaces/http/routes/notifications.js";
import { registerMyDashboardRoutes } from "./interfaces/http/routes/my-dashboard.js";
import { registerDocumentRoutes } from "./interfaces/http/routes/documents.js";
import { registerSchedulerRoutes } from "./interfaces/http/routes/scheduler.js";
import { registerIntegrationRoutes } from "./interfaces/http/routes/integration.js";
import { registerObservabilityRoutes } from "./interfaces/http/routes/observability.js";
import { registerCustomerRoutes } from "./interfaces/http/routes/customers.js";
import { registerContractRoutes } from "./interfaces/http/routes/contracts.js";
import { registerProjectRoutes } from "./interfaces/http/routes/projects.js";
import { registerSiteRoutes } from "./interfaces/http/routes/sites.js";
import { registerServiceRoutes } from "./interfaces/http/routes/services.js";
import { registerComplaintRoutes } from "./interfaces/http/routes/complaints.js";
import { registerSurveyRoutes } from "./interfaces/http/routes/surveys.js";
import { registerSurveyAdvancedRoutes } from "./interfaces/http/routes/surveys-advanced.js";
import { registerPublicSurveyRoutes } from "./interfaces/http/routes/public-surveys.js";
import { registerPublicWorkOrderAcceptanceRoutes } from "./interfaces/http/routes/public-work-order-acceptance.js";
import { registerAdminConsoleRoutes } from "./interfaces/http/routes/admin-console.js";
import { registerSalesRoutes } from "./interfaces/http/routes/sales.js";
import { registerServiceQualityRoutes } from "./interfaces/http/routes/service-quality.js";
import { registerServiceOperationsRoutes } from "./modules/service-operations/core/api/service-operations.routes.js";
import { registerServiceOperationsAdvancedRoutes } from "./modules/service-operations/advanced/api/service-operations-advanced.routes.js";
import { registerWorkforceRoutes } from "./modules/workforce/core/api/workforce.routes.js";
import { registerWorkforceAdvancedRoutes } from "./modules/workforce/advanced/api/workforce-advanced.routes.js";
import { registerSupplyChainRoutes } from "./modules/supply-chain/core/api/supply-chain.routes.js";
import { registerSupplyChainAdvancedRoutes } from "./modules/supply-chain/advanced/api/supply-chain-advanced.routes.js";
import { registerWmsRoutes } from "./modules/supply-chain/warehouse/api/wms.routes.js";
import { registerProcurementRoutes } from "./modules/supply-chain/procurement/api/procurement.routes.js";
import { registerAssetRoutes } from "./modules/asset/core/api/asset.routes.js";
import { registerAssetAdvancedRoutes } from "./modules/asset/advanced/api/asset-advanced.routes.js";
import { registerFinanceRoutes } from "./modules/finance/core/api/finance.routes.js";
import { registerFinanceMasterRoutes } from "./modules/finance/master/api/finance-master.routes.js";
import { registerUomRoutes } from "./modules/supply-chain/master/uom/api/uom.routes.js";
import { registerCateringRoutes } from "./modules/service-operations/vertical/catering/api/catering.routes.js";
import { registerAccountingKernelRoutes } from "./modules/accounting/kernel/api/accounting-kernel.routes.js";
import { registerOpenItemRoutes } from "./modules/accounting/open-item/api/open-item.routes.js";
import { registerBudgetRoutes } from "./modules/accounting/budget/api/budget.routes.js";
import { registerBankReconRoutes } from "./modules/accounting/bank-recon/api/bank-recon.routes.js";
import { registerAssetBookRoutes } from "./modules/accounting/asset-book/api/asset-book.routes.js";
import { registerTaxRoutes } from "./modules/accounting/tax/api/tax.routes.js";
import { registerConsolidationRoutes } from "./modules/accounting/consolidation/api/consolidation.routes.js";
import { registerHseRoutes } from "./modules/hse/core/api/hse.routes.js";
import { registerProjectDeliveryRoutes } from "./modules/project-delivery/core/api/project-delivery.routes.js";
import { registerProjectDeliveryAdvancedRoutes } from "./modules/project-delivery/advanced/api/project-delivery-advanced.routes.js";
import { registerHseAdvancedRoutes } from "./modules/hse/advanced/api/hse-advanced.routes.js";
import { registerReportingInsightRoutes } from "./modules/reporting-insight/core/api/reporting-insight.routes.js";
import { registerReportingAdvancedRoutes } from "./interfaces/http/routes/reporting-advanced.js";
import { buildContainer } from "./composition-root.js";
import { getAllowedCorsOrigins, getGlobalRateLimitConfig, isCorsOriginAllowed, resolveTrustProxy } from "./infrastructure/security/http-hardening.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // Client-IP security: trust X-Forwarded-For/X-Forwarded-Proto only from
    // explicitly configured, deployment-controlled proxies. Default is fail-closed
    // (trustProxy: false) so direct clients cannot spoof forwarded headers.
    // Deprecated hop-count (TRUST_PROXY_HOPS) is rejected at startup because
    // Fastify 5.12 treats numeric trust as always-untrusted and hop-count-only
    // trust would allow a client to spoof by supplying enough hops.
    // Valid production trust must be an explicit address/CIDR allowlist in
    // TRUST_PROXY (e.g. "10.0.0.1" or "10.0.0.0/28,172.16.0.5"). Invalid values
    // fail startup. See infrastructure/security/http-hardening.ts.
    trustProxy: resolveTrustProxy(),
    logger: {
      // Observability (Checkpoint 0F): `LOG_LEVEL` can override the
      // default per-environment level (e.g. temporarily set `debug` in
      // a staging/pilot deployment to investigate an issue, without a
      // code change or redeploy) — falls back to the pre-0F default
      // (`debug` in development, `info` otherwise) when unset.
      level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "development" ? "debug" : "info"),
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty" }
          : undefined,
    },
    // Observability Foundation (Checkpoint 0E): every log line Fastify's
    // built-in pino logger emits is tagged with a per-request `reqId`,
    // so a single request's full log trail (including any error) can be
    // correlated. Reuse an inbound `x-request-id` if the caller already
    // has one (e.g. propagated from an API Gateway/Integration Boundary
    // caller) instead of always minting a fresh one.
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      return typeof header === "string" && header.length > 0 ? header : randomUUID();
    },
  });

  // Security hardening (Phase H / PH-2): keep the API-oriented Helmet
  // posture from 0F (standard response headers, no misleading CSP on a JSON
  // API), and add explicit origin restriction for pilot readiness.
  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  const allowedCorsOrigins = getAllowedCorsOrigins();
  app.register(cors, {
    origin: (origin, cb) => cb(null, isCorsOriginAllowed(origin, allowedCorsOrigins)),
  });
  app.register(sensible);
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  // Reliability/Security (Phase H / PH-2): global rate limit remains a
  // deployment-tunable floor against accidental abuse/retry storms. The
  // legacy RATE_LIMIT_MAX env var is still accepted, while
  // RATE_LIMIT_GLOBAL_MAX / RATE_LIMIT_WINDOW make the pilot posture explicit.
  app.register(rateLimit, {
    global: true,
    ...getGlobalRateLimitConfig(),
  });

  registerAuthDecorators(app);
  registerBootstrapAuthDecorators(app);
  registerErrorMapping(app);

  const container = buildContainer();

  // Epic 3 Wave 3 (§4.3 step 9): mutating routes on an inactive module are
  // rejected with a 403 reason. Registered before the route block so the
  // onRoute hook sees every declaration — same ordering contract as the
  // rate-limit comment below.
  registerModuleActivityEnforcement(app, container);

  // Epic 4 Wave 1 (§4.4 step 11b): a Window configured read-only for the
  // actor's Roles rejects POST/PUT/PATCH/DELETE with a 403, while the Window
  // itself stays open. Registered AFTER the module-active gate on purpose —
  // both append a preHandler, so this one runs second and an inactive module
  // reports its own, more actionable reason first.
  registerWindowAccessEnforcement(app, container);

  // Checkpoint 0F fix: every route below is wrapped in a nested
  // `app.register(async ...)` instead of being declared directly on
  // `app` (as it was through Checkpoint 0E). Reason: `fastify.get/post/
  // etc.` add a route IMMEDIATELY/synchronously, bypassing Fastify's
  // avvio boot queue, while `fastify.register(plugin)` calls (helmet,
  // cors, rate-limit above) are queued and only actually execute during
  // `.ready()`. Since @fastify/rate-limit's per-route `config.rateLimit`
  // override works by attaching an `onRoute` hook, that hook must exist
  // BEFORE a route is declared — with unwrapped direct route
  // registration, `/auth/login` was being declared before rate-limit's
  // plugin body had actually run, so its stricter per-route limit was
  // silently never applied (caught by the new phase0-stabilization.test.ts
  // rate-limit test, see decision-log.md). Wrapping every route
  // registration in `app.register(async (scoped) => ...)` puts them in
  // the SAME avvio queue as the plugins above, guaranteeing correct
  // order regardless of whether those plugin `register()` calls above
  // are awaited.
  app.register(async (scoped) => {
    scoped.register(healthRoutes);
    registerAuthRoutes(scoped, container);
    registerTenantRoutes(scoped, container);
    registerLegalEntityRoutes(scoped, container);
    registerLegalEntityAttachmentReferenceRoutes(scoped, container);
    registerOrganizationUnitRoutes(scoped, container);
    // Epic 5 Gelombang 2 — effective-dated hierarchy history, change requests and
    // the tombstone/reference-check flow. Registered beside the unit surface it
    // changes; the permission, not the route, is what separates proposer from
    // publisher (§4.5 principle 12).
    registerOrganizationUnitHierarchyRoutes(scoped, container);
    // Epic 5 Gelombang 1 — Department master (hierarchy + lifecycle). A master
    // surface, never an authorization scope.
    registerDepartmentRoutes(scoped, container);
    // Epic 6 Gelombang 1 — Business Partner canonical party model. Not an
    // authorization scope; lifecycle and role-flag management surface.
    registerBusinessPartnerRoutes(scoped, container);
    // WP-APR-03 / WP-APR-02 — SoD governance + central rule registry surfaces.
    registerSodRoutes(scoped, container);
    registerRuleRegistryRoutes(scoped, container);
    // Epic 6 Gelombang 2 — BP-native, effective-dated employee placement.
    registerEmployeePlacementRoutes(scoped, container);
    registerUserRoutes(scoped, container);
    registerAuditRoutes(scoped, container);
    registerConfigurationRoutes(scoped, container);
    registerAppMetadataRoutes(scoped, container);
    registerWorkflowRoutes(scoped, container);
    registerNotificationRoutes(scoped, container);
    registerMyDashboardRoutes(scoped, container);
    registerDocumentRoutes(scoped, container);
    registerSchedulerRoutes(scoped, container);
    registerIntegrationRoutes(scoped, container);
    registerObservabilityRoutes(scoped, container);
    registerCustomerRoutes(scoped, container);
    registerContractRoutes(scoped, container);
    registerProjectRoutes(scoped, container);
    registerSiteRoutes(scoped, container);
    registerServiceRoutes(scoped, container);
    registerComplaintRoutes(scoped, container);
    registerSurveyRoutes(scoped, container);
    registerSurveyAdvancedRoutes(scoped, container);
    registerPublicSurveyRoutes(scoped, container);
    registerPublicWorkOrderAcceptanceRoutes(scoped, container);
    registerServiceOperationsRoutes(scoped, container);
    registerServiceOperationsAdvancedRoutes(scoped, container);
    registerWorkforceRoutes(scoped, container);
    registerWorkforceAdvancedRoutes(scoped, container);
    registerSupplyChainRoutes(scoped, container);
    registerSupplyChainAdvancedRoutes(scoped, {
      supplyChainAdvanced: container.supplyChainAdvanced,
      wms: container.wms,
      procurement: container.procurement,
    });
    registerWmsRoutes(scoped, { wms: container.wms });
    registerProcurementRoutes(scoped, { procurement: container.procurement });
    registerAssetRoutes(scoped, container);
    registerAssetAdvancedRoutes(scoped, container);
    registerFinanceRoutes(scoped, container);
    // Phase 5 — Finance Master (WP-MD-01) + UoM Central (WP-MD-02)
    registerFinanceMasterRoutes(scoped, container);
    registerUomRoutes(scoped, container);
    // Phase 5 — Catering vertical master (WP-MD-03)
    registerCateringRoutes(scoped, container);
    // Phase 1B — Accounting Kernel (sole writer of the General Ledger, ADR-0023)
    registerAccountingKernelRoutes(scoped, container);
    // WP-FIN-A6-02 — AP/AR open-item settlement (ADR-0017)
    registerOpenItemRoutes(scoped, container);
    // WP-FIN-A6-03 — Budget control (ADR-0020)
    registerBudgetRoutes(scoped, container);
    // WP-FIN-A6-04 — Bank reconciliation (ADR-0018)
    registerBankReconRoutes(scoped, container);
    // WP-FIN-A6-05 — Fixed asset book + depreciation (ADR-0019)
    registerAssetBookRoutes(scoped, container);
    // WP-FIN-A6-06a — Indonesia tax baseline (ADR-0019)
    registerTaxRoutes(scoped, container);
    // WP-FIN-A6-06b — Consolidation (ADR-0022)
    registerConsolidationRoutes(scoped, container);
    // Phase 7 — HSE Core
    registerHseRoutes(scoped, container);
    // Phase 8 — Project Delivery Core
    registerProjectDeliveryRoutes(scoped, container);
    // Wave A7 / PRJ-ADV-001…008 — Project Delivery Advanced (ADR-0026)
    registerProjectDeliveryAdvancedRoutes(scoped, container);
    // Wave A7 / HSE-ADV-001…007 — HSE Advanced (ADR-0027)
    registerHseAdvancedRoutes(scoped, container);
    // Phase 9 — Reporting & Operational Insight Core
    registerReportingInsightRoutes(scoped, container);
    // Wave A2 / RPT-ADV-001…002 — governed BI and predictive analytics
    registerReportingAdvancedRoutes(scoped, container);
    // Phase 11F — Business Admin Console with governed User Role assignments
    registerAdminConsoleRoutes(scoped, container);
    // Wave A1 / CUS-ADV-001 — sales pipeline, quotation, and pricing
    registerSalesRoutes(scoped, container);
    // Wave A1 / SQ-ADV-001…004 — governed Service Quality Advanced
    registerServiceQualityRoutes(scoped, container);
  });

  // Scheduler ownership is enforced by SchedulerService itself so a disabled
  // replica cannot start timers later through the enable API. Starting here is
  // therefore safe on every process; a disabled owner records no intervals.
  container.scheduler.start().catch((err) =>
    app.log.error(err, "Scheduler failed to start"),
  );

  return app;
}

