import { pool } from "./infrastructure/persistence/db.js";
import { PgTenantRepository } from "./infrastructure/persistence/repositories/tenant.repository.pg.js";
import { PgLegalEntityRepository } from "./infrastructure/persistence/repositories/legal-entity.repository.pg.js";
import { PgOrganizationUnitRepository } from "./infrastructure/persistence/repositories/organization-unit.repository.pg.js";
import { PgOrganizationUnitHierarchyRepository } from "./infrastructure/persistence/repositories/organization-unit-hierarchy.repository.pg.js";
import { PgParameterReader } from "./infrastructure/configuration/parameter-reader.pg.js";
import { buildModuleConfigRegistry } from "./application/configuration/build-module-config-registry.js";
import { PgDepartmentRepository } from "./infrastructure/persistence/repositories/department.repository.pg.js";
import { PgBusinessPartnerRepository } from "./infrastructure/persistence/repositories/business-partner.repository.pg.js";
import { PgEmployeePlacementRepository } from "./infrastructure/persistence/repositories/employee-placement.repository.pg.js";
import { PgUserRepository } from "./infrastructure/persistence/repositories/user.repository.pg.js";
import { PgRbacRepository } from "./infrastructure/persistence/repositories/rbac.repository.pg.js";
import { PgAuditLogRepository } from "./infrastructure/persistence/repositories/audit-log.repository.pg.js";
import { PgConfigurationRepository } from "./infrastructure/persistence/repositories/configuration.repository.pg.js";
import { PgAppMetadataRepository } from "./infrastructure/persistence/repositories/app-metadata.repository.pg.js";
import { PgWorkflowRepository } from "./infrastructure/persistence/repositories/workflow.repository.pg.js";
import { PgApprovalAuthorityRepository } from "./infrastructure/persistence/repositories/approval-authority.repository.pg.js";
import { PgSodRepository } from "./infrastructure/persistence/repositories/sod.repository.pg.js";
import { PgRuleRegistryRepository } from "./infrastructure/persistence/repositories/rule-registry.repository.pg.js";
import { PgDomainEventRepository } from "./infrastructure/persistence/repositories/domain-event.repository.pg.js";
import { PgNotificationRepository } from "./infrastructure/persistence/repositories/notification.repository.pg.js";
import { PgDocumentRepository } from "./infrastructure/persistence/repositories/document.repository.pg.js";
import { PgSchedulerRepository } from "./infrastructure/persistence/repositories/scheduler.repository.pg.js";
import { PgIntegrationRepository } from "./infrastructure/persistence/repositories/integration.repository.pg.js";
import {
  PgCustomerContactRepository,
  PgCustomerRepository,
} from "./infrastructure/persistence/repositories/customer.repository.pg.js";
import { PgContractRepository } from "./infrastructure/persistence/repositories/contract.repository.pg.js";
import { PgProjectRepository } from "./infrastructure/persistence/repositories/project.repository.pg.js";
import { PgSiteRepository } from "./infrastructure/persistence/repositories/site.repository.pg.js";
import {
  PgCustomerServiceLinkRepository,
  PgServiceRepository,
} from "./infrastructure/persistence/repositories/service.repository.pg.js";
import { PgComplaintRepository } from "./infrastructure/persistence/repositories/complaint.repository.pg.js";
import { PgSalesRepository } from "./infrastructure/persistence/repositories/sales.repository.pg.js";
import { PgServiceQualityRepository } from "./infrastructure/persistence/repositories/service-quality.repository.pg.js";
import { LocalFileStorage } from "./infrastructure/storage/local-file-storage.js";

import { AuditService } from "./application/audit/audit.service.js";
import { RbacService } from "./application/rbac/rbac.service.js";
import { SodService } from "./application/rbac/sod.service.js";
import { RuleRegistryService } from "./application/rules/rule-registry.service.js";
import { ApprovalAuthorityService } from "./domain/rbac/approval-authority.service.js";
import { TenantService } from "./application/tenant/tenant.service.js";
import { LegalEntityService } from "./application/legal-entity/legal-entity.service.js";
import { PgLegalEntityAttachmentReferenceRepository } from "./infrastructure/persistence/repositories/legal-entity-attachment-reference.repository.pg.js";
import { LegalEntityAttachmentReferenceService } from "./application/legal-entity-attachment-reference/legal-entity-attachment-reference.service.js";
import { OrganizationUnitService } from "./application/organization-unit/organization-unit.service.js";
import { OrganizationUnitHierarchyService } from "./application/organization-unit/organization-unit-hierarchy.service.js";
import { DepartmentService } from "./application/department/department.service.js";
import { BusinessPartnerService } from "./application/business-partner/business-partner.service.js";
import { EmployeePlacementService } from "./application/employee/employee-placement.service.js";
import { UserService } from "./application/identity/user.service.js";
import { AuthService } from "./application/identity/auth.service.js";
import { ConfigurationService } from "./application/configuration/configuration.service.js";
import { AppMetadataService } from "./application/configuration/app-metadata.service.js";
import { WorkflowService } from "./application/workflow/workflow.service.js";
import { EventBus } from "./application/event/event-bus.js";
import { NotificationService } from "./application/notification/notification.service.js";
import { DocumentService } from "./application/document/document.service.js";
import { SchedulerService } from "./application/scheduler/scheduler.service.js";
import { registerJobHandlers } from "./application/scheduler/job-handlers.js";
import { IntegrationService } from "./application/integration/integration.service.js";
import { CustomerService } from "./application/customer/customer.service.js";
import { ContractService } from "./application/customer/contract.service.js";
import { ProjectService } from "./application/customer/project.service.js";
import { SiteService } from "./application/customer/site.service.js";
import { ServiceCatalogService } from "./application/customer/service-catalog.service.js";
import { ComplaintService } from "./application/complaint/complaint.service.js";
import { ComplaintDashboardService } from "./application/complaint/complaint-dashboard.service.js";
import { PgComplaintDashboardRepository } from "./infrastructure/persistence/repositories/complaint-dashboard.repository.pg.js";
import { ComplaintConfigurationService } from "./application/complaint/complaint-configuration.service.js";
import { SalesService } from "./application/sales/sales.service.js";
import { ServiceQualityService } from "./application/service-quality/service-quality.service.js";
import { PgSurveyRepository } from "./infrastructure/persistence/repositories/survey.repository.pg.js";
import { PgSurveyAdvancedRepository } from "./infrastructure/persistence/repositories/survey-advanced.repository.pg.js";
import { SurveyService } from "./application/survey/survey.service.js";
import { SurveyResponseService } from "./application/survey/survey-response.service.js";
import { SurveyAnalyticsService } from "./application/survey/survey-analytics.service.js";
import { SurveyPublicResponseService } from "./application/survey/survey-public.service.js";
import { PgSurveyIntegrationRepository } from "./infrastructure/persistence/repositories/survey-integration.repository.pg.js";
import { SurveyIntegrationService } from "./application/survey-integration/survey-integration.service.js";
import { PgServiceOperationsRepository } from "./modules/service-operations/core/infrastructure/service-operations.repository.pg.js";
import { ServiceOperationsService } from "./modules/service-operations/core/application/service-operations.service.js";
import { KPIService } from "./modules/service-operations/core/application/kpi.service.js";
import { PgWorkforceRepository } from "./modules/workforce/core/infrastructure/workforce.repository.pg.js";
import { WorkforceService } from "./modules/workforce/core/application/workforce.service.js";
import { PgWorkforceAdvancedRepository } from "./modules/workforce/advanced/infrastructure/workforce-advanced.repository.pg.js";
import { WorkforceAdvancedService } from "./modules/workforce/advanced/application/workforce-advanced.service.js";
import { PgSupplyChainRepository } from "./modules/supply-chain/core/infrastructure/supply-chain.repository.pg.js";
import { SupplyChainService } from "./modules/supply-chain/core/application/supply-chain.service.js";
import { PgSupplyChainAdvancedRepository } from "./modules/supply-chain/advanced/infrastructure/supply-chain-advanced.repository.pg.js";
import { SupplyChainAdvancedService } from "./modules/supply-chain/advanced/application/supply-chain-advanced.service.js";
import {
  WarehouseTopologyService,
  ItemTrackingService,
  StockLedgerService,
  ReorderReservationService,
  TransferOpnameService,
  ValuationService,
  ReceivingInspectionService,
  ReturnsReversalsService,
  ConsignmentService,
  DisposalService,
  WarehouseTaskService,
  AccountingEventService,
} from "./modules/supply-chain/warehouse/index.js";
import {
  RfqBiddingService,
  SupplierGovernanceService,
  SupplierContractService,
  ServiceAcceptanceService,
  VendorInvoiceService,
  SpendAnalyticsService,
  PaymentService,
} from "./modules/supply-chain/procurement/index.js";
import { PgAssetRepository } from "./modules/asset/core/infrastructure/asset.repository.pg.js";
import { PgUomRepository } from "./modules/supply-chain/master/uom/infrastructure/uom.repository.pg.js";
import { UomService } from "./modules/supply-chain/master/uom/application/uom.service.js";
import { AssetService } from "./modules/asset/core/application/asset.service.js";
import { PgServiceOperationsAdvancedRepository } from "./modules/service-operations/advanced/infrastructure/service-operations-advanced.repository.pg.js";
import { ServiceOperationsAdvancedService } from "./modules/service-operations/advanced/application/service-operations-advanced.service.js";
import { PgCateringRepository } from "./modules/service-operations/vertical/catering/infrastructure/catering.repository.pg.js";
import { CateringService } from "./modules/service-operations/vertical/catering/application/catering.service.js";
import { PgAssetAdvancedRepository } from "./modules/asset/advanced/infrastructure/asset-advanced.repository.pg.js";
import { AssetAdvancedService } from "./modules/asset/advanced/application/asset-advanced.service.js";
import { PgFinanceRepository } from "./modules/finance/core/infrastructure/finance.repository.pg.js";
import { FinanceService } from "./modules/finance/core/application/finance.service.js";
import { PgFinanceMasterRepository } from "./modules/finance/master/infrastructure/finance-master.repository.pg.js";
import { FinanceMasterService } from "./modules/finance/master/application/finance-master.service.js";
import { PgAccountingKernelRepository } from "./modules/accounting/kernel/infrastructure/accounting-kernel.repository.pg.js";
import { AccountingKernelService } from "./modules/accounting/kernel/application/accounting-kernel.service.js";
import { PgOpenItemRepository } from "./modules/accounting/open-item/infrastructure/open-item.repository.pg.js";
import { OpenItemService } from "./modules/accounting/open-item/application/open-item.service.js";
import { PgBudgetRepository } from "./modules/accounting/budget/infrastructure/budget.repository.pg.js";
import { BudgetService } from "./modules/accounting/budget/application/budget.service.js";
import { PgBankReconRepository } from "./modules/accounting/bank-recon/infrastructure/bank-recon.repository.pg.js";
import { BankReconService } from "./modules/accounting/bank-recon/application/bank-recon.service.js";
import { PgAssetBookRepository } from "./modules/accounting/asset-book/infrastructure/asset-book.repository.pg.js";
import { AssetBookService } from "./modules/accounting/asset-book/application/asset-book.service.js";
import { PgTaxRepository } from "./modules/accounting/tax/infrastructure/tax.repository.pg.js";
import { TaxService } from "./modules/accounting/tax/application/tax.service.js";
import { PgConsolidationRepository } from "./modules/accounting/consolidation/infrastructure/consolidation.repository.pg.js";
import { ConsolidationService } from "./modules/accounting/consolidation/application/consolidation.service.js";
import { AccountingEventConsumerService } from "./modules/accounting/consumer/accounting-event-consumer.service.js";
import { PgAccountingEventWritePort } from "./modules/supply-chain/ports/accounting-event.port.pg.js";
import { PgHseRepository } from "./modules/hse/core/infrastructure/hse.repository.pg.js";
import { HseService } from "./modules/hse/core/application/hse.service.js";
import { PgProjectDeliveryRepository } from "./modules/project-delivery/core/infrastructure/project-delivery.repository.pg.js";
import { ProjectDeliveryService } from "./modules/project-delivery/core/application/project-delivery.service.js";
// Wave A7 — Project Delivery Advanced (ADR-0026). Planning math and project
// cost truth are Advanced-only; the ledger stays the Accounting Kernel's.
import { PgProjectDeliveryAdvancedRepository } from "./modules/project-delivery/advanced/infrastructure/project-delivery-advanced.repository.pg.js";
import { ProjectPlanService } from "./modules/project-delivery/advanced/application/project-plan.service.js";
import { ProjectCostService } from "./modules/project-delivery/advanced/application/project-cost.service.js";
// Wave A7 — HSE Advanced (ADR-0027). CAPA is a separate aggregate from the Core
// follow-up, permit lifecycle is the Workflow Engine's, and indicators are
// frozen snapshots.
import { PgHseAdvancedRepository } from "./modules/hse/advanced/infrastructure/hse-advanced.repository.pg.js";
import { HseAdvancedService } from "./modules/hse/advanced/application/hse-advanced.service.js";
import { HseAssuranceService } from "./modules/hse/advanced/application/hse-assurance.service.js";
import { HseCapaService } from "./modules/hse/advanced/application/hse-capa.service.js";
import { PgReportingInsightRepository } from "./modules/reporting-insight/core/infrastructure/reporting-insight.repository.pg.js";
import { ReportingInsightService } from "./modules/reporting-insight/core/application/reporting-insight.service.js";
import { PgBiRepository } from "./modules/reporting-insight/advanced/infrastructure/bi.repository.pg.js";
import { BiService } from "./modules/reporting-insight/advanced/application/bi.service.js";
import { PgPredictiveRepository } from "./modules/reporting-insight/advanced/infrastructure/predictive.repository.pg.js";
import { PredictiveService } from "./modules/reporting-insight/advanced/application/predictive.service.js";
import { AdminConsoleService } from "./application/admin-console/admin-console.service.js";
import type { EntityAuthorizationResolverRegistry } from "./application/document/entity-authorization-resolver.js";

/**
 * Simple manual composition root (no DI framework — deliberate, per
 * anti-overengineering guidance for Phase 0). Every HTTP route resolves
 * its dependencies from here so the interfaces/http layer never talks to
 * `pool` or a `*.pg.ts` repository directly.
 *
 * Checkpoint 0E wiring order matters a little: `EventBus` is built before
 * `WorkflowService` (which publishes into it) and before
 * `NotificationService`/`IntegrationService` (which subscribe to it) —
 * everything downstream of the Event Foundation depends on it, nothing
 * upstream of it depends on any Shared Service.
 */
export function buildContainer() {
  const tenantRepo = new PgTenantRepository(pool);
  const legalEntityRepo = new PgLegalEntityRepository(pool);
  const organizationUnitRepo = new PgOrganizationUnitRepository(pool);
  // Epic 5 Gelombang 1 — Department master. Deliberately NOT a scope source:
  // the repository is only ever reached with the actor's tenant id, and no
  // scope column or RbacService scope method is involved (see the module
  // comment on domain/department/department.entity.ts).
  const departmentRepo = new PgDepartmentRepository(pool);
  // Epic 6 Gelombang 1 — Business Partner canonical party model. Not an
  // authorization scope (see the module comment on
  // domain/business-partner/business-partner.entity.ts), same posture as
  // `departmentRepo` above.
  const businessPartnerRepo = new PgBusinessPartnerRepository(pool);
  // Epic 6 Gelombang 2 — effective-dated employee placement over BP-native
  // employee identity. This repository owns placement history and never writes
  // legacy Workforce `employees` / `employee_assignments` tables (Option B).
  const employeePlacementRepo = new PgEmployeePlacementRepository(pool);
  const userRepo = new PgUserRepository(pool);
  const rbacRepo = new PgRbacRepository(pool);
  const auditRepo = new PgAuditLogRepository(pool);
  const configurationRepo = new PgConfigurationRepository(pool);
  const appMetadataRepo = new PgAppMetadataRepository(pool);
  const workflowRepo = new PgWorkflowRepository(pool);
  const domainEventRepo = new PgDomainEventRepository(pool);
  const notificationRepo = new PgNotificationRepository(pool);
  const documentRepo = new PgDocumentRepository(pool);
  const schedulerRepo = new PgSchedulerRepository(pool);
  const integrationRepo = new PgIntegrationRepository(pool);
  const customerRepo = new PgCustomerRepository(pool);
  const customerContactRepo = new PgCustomerContactRepository(pool);
  const contractRepo = new PgContractRepository(pool);
  const projectRepo = new PgProjectRepository(pool);
  const siteRepo = new PgSiteRepository(pool);
  const serviceRepo = new PgServiceRepository(pool);
  const customerServiceLinkRepo = new PgCustomerServiceLinkRepository(pool);
  const complaintRepo = new PgComplaintRepository(pool);

  const audit = new AuditService(auditRepo);
  const rbac = new RbacService(rbacRepo, organizationUnitRepo, legalEntityRepo);
  // Epic 1 (§4.1 D) — approval authority & separation of duties. Reads role
  // limits, the supervisor chain, org-unit supervisor, the currency table and
  // the accumulated-approval window; wired here so the document workflows of
  // Epics 7+ resolve an approver through one place.
  const approvalAuthority = new ApprovalAuthorityService(new PgApprovalAuthorityRepository(pool));
  const configuration = new ConfigurationService(
    configurationRepo,
    audit,
    rbac,
    buildModuleConfigRegistry(),
  );
  // §4.15 Putaran 7 — trusted-caller numeric reads for every module manifest
  // consumer below. One instance, built right after `configuration` exists,
  // so a module never needs its own `config.read` permission just to pick up
  // its own tunable.
  const parameterReader = new PgParameterReader(configuration);
  // Epic 5 Gelombang 2 — effective-dated hierarchy history, change requests and
  // the tombstone/reference-check flow. A separate repository because it owns a
  // different question (what the structure WAS and who may change it) from the
  // one `organizationUnitRepo` answers (what the unit is now). Built after
  // `parameterReader` because the backdate bound it enforces is now a
  // parameter (`platform.organization_unit.backdate_limit_days`).
  const organizationUnitHierarchyRepo = new PgOrganizationUnitHierarchyRepository(pool, parameterReader);
  // Epic 2 Wave 1 — Application Dictionary. configurationRepo is reused as the
  // Schema Registry source so Ajv validation of rule payloads reads the real
  // metadata_registry row (area='app_field_rules', key='rules_definition').
  const appMetadata = new AppMetadataService(appMetadataRepo, audit, rbac, configurationRepo);

  const eventBus = new EventBus(domainEventRepo, (eventType, error) => {
    console.error(`[EventBus] subscriber for '${eventType}' failed:`, error);
  });

  const workflow = new WorkflowService(workflowRepo, audit, rbac, eventBus, approvalAuthority);
  const notification = new NotificationService(notificationRepo, rbacRepo, audit, rbac);
  const integration = new IntegrationService(integrationRepo, tenantRepo, eventBus, audit, rbac);

  // Customer Foundation (Checkpoint 1A) — built before DocumentService so
  // its `customer` Entity Authorization Resolver (ADR-0012) can close
  // over `customerService.canAccessForDocument` below.
  const customer = new CustomerService(customerRepo, customerContactRepo, audit, rbac);
  const contract = new ContractService(contractRepo, customer, audit, rbac);
  const project = new ProjectService(projectRepo, customer, audit, rbac);
  const site = new SiteService(siteRepo, customer, audit, rbac);
  const serviceCatalog = new ServiceCatalogService(
    serviceRepo,
    customerServiceLinkRepo,
    customer,
    audit,
    rbac,
  );

  // Generic Customer Complaint Engine (Checkpoint 1B) — built on top of
  // Customer Foundation (1A) + the generic Workflow Engine (0D/0E) +
  // Configuration/Numbering (0C). Built before DocumentService so its
  // own `complaint` Entity Authorization Resolver (ADR-0012 pattern) can
  // close over `complaint.canAccessForDocument` below, same as `customer`.
  const complaint = new ComplaintService(
    complaintRepo,
    customer,
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Checkpoint 1C.5 — Management Dashboard read-model (aggregate-only,
  // permission-gated + Data-Scope-aware; no new persistence, FD-1C-01).
  const complaintDashboard = new ComplaintDashboardService(
    new PgComplaintDashboardRepository(pool),
    customer,
    rbac,
    parameterReader,
  );

  // Checkpoint 1C.6 — Complaint Administration surface (gated on
  // complaint.configure; reuses Configuration/Notification/Workflow via
  // trusted-caller reads + audited writes, no new config storage).
  const complaintConfiguration = new ComplaintConfigurationService(
    rbac,
    configuration,
    notification,
    workflow,
  );

  // Wave A1 / CUS-ADV-001 — Sales pipeline, quotation, and configurable
  // pricing on top of Customer Foundation (1A) + the generic Workflow
  // Engine (0D/0E) + Configuration/Numbering (0C). Built before
  // DocumentService so its `sales_quotation` Entity Authorization Resolver
  // can close over `sales.canAccessForDocument`, exactly as `customer` and
  // `complaint` do (ADR-0012).
  const sales = new SalesService(
    new PgSalesRepository(pool),
    serviceRepo,
    customer,
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Wave A1 / SQ-ADV-001…004 — Service Quality Advanced remains an
  // application-level extension of Complaint Core. It reads the Complaint
  // aggregate, owns only its advanced projections, and delegates lifecycle to
  // Workflow rather than introducing a competing complaint state machine.
  const serviceQuality = new ServiceQualityService(
    new PgServiceQualityRepository(pool),
    complaint,
    contractRepo,
    customer,
    configuration,
    rbac,
    audit,
    eventBus,
    workflow,
    (eventType, error) => {
      console.error(`[ServiceQuality] event '${eventType}' failed:`, error);
    },
  );

  // Phase 2 — Service Operations & Work Management Core. First module built
  // under the frozen target repository architecture
  // (`modules/service-operations/core/...`, blueprint §11A). Constructed
  // before DocumentService so its `work_order` Entity Authorization Resolver
  // can close over `serviceOperations.canAccessForDocument`, exactly as
  // `customer` and `complaint` do (ADR-0012). `accountingEventPort` is built
  // early (moved up from its former Phase 3 spot) so Phase 2's acceptance
  // gate (WP-OPS-01 Phase 6) can also depend on it.
  const accountingEventPort = new PgAccountingEventWritePort(pool);

  const serviceOperationsRepo = new PgServiceOperationsRepository(pool);
  const serviceOperations = new ServiceOperationsService(
    serviceOperationsRepo,
    customer,
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
    accountingEventPort,
  );
  const kpi = new KPIService(serviceOperationsRepo, rbac);

  // Phase 3 — Workforce / HR Core. Built before DocumentService so its
  // `employee` Entity Authorization Resolver can close over
  // `workforce.canAccessForDocument` (ADR-0012). Employee documents are
  // gated by a dedicated capability, not by plain workforce.read.
  const workforce = new WorkforceService(
    new PgWorkforceRepository(pool),
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Wave A4 / HR-ADV-001…009 — Workforce Advanced owns operational HR
  // extensions (attendance, leave, payroll, recruitment, performance, and
  // manpower planning) while Core remains the identity/placement source.
  const workforceAdvanced = new WorkforceAdvancedService(
    new PgWorkforceAdvancedRepository(pool),
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
    accountingEventPort,
  );

  // Phase 4 — Supply Chain Core. Built before DocumentService so its
  // purchase-document resolvers can close over it (ADR-0012).
  const supplyChain = new SupplyChainService(
    new PgSupplyChainRepository(pool),
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Phase 6 — Finance Core.
  const finance = new FinanceService(
    new PgFinanceRepository(pool),
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Wave A5 / SCM-ADV-001…008 — Supply Chain Advanced extends inventory,
  // valuation, procurement/tendering, vendor contracts, and spend analytics.
  // WP-PRO-03 payment-batch GL posting goes through the accounting-ready-event
  // outbox (consumed by the Accounting Kernel), not through Finance Core, so
  // this service has no dependency on `finance`.
  const supplyChainAdvanced = new SupplyChainAdvancedService(
    new PgSupplyChainAdvancedRepository(pool),
    rbac,
    audit,
    workflow,
    eventBus,
    configuration,
  );

  // Decomposed WMS & Procurement bounded context application services
  const wms = {
    topology: new WarehouseTopologyService(supplyChainAdvanced),
    tracking: new ItemTrackingService(supplyChainAdvanced),
    ledger: new StockLedgerService(supplyChainAdvanced),
    reorder: new ReorderReservationService(supplyChainAdvanced),
    transferOpname: new TransferOpnameService(supplyChainAdvanced),
    valuation: new ValuationService(supplyChainAdvanced),
    receiving: new ReceivingInspectionService(supplyChainAdvanced),
    returns: new ReturnsReversalsService(supplyChainAdvanced),
    consignment: new ConsignmentService(supplyChainAdvanced),
    disposal: new DisposalService(supplyChainAdvanced),
    task: new WarehouseTaskService(supplyChainAdvanced),
    accountingEvent: new AccountingEventService(supplyChainAdvanced),
  };

  const procurement = {
    rfq: new RfqBiddingService(supplyChainAdvanced),
    supplierGovernance: new SupplierGovernanceService(supplyChainAdvanced),
    supplierContract: new SupplierContractService(supplyChainAdvanced),
    serviceAcceptance: new ServiceAcceptanceService(supplyChainAdvanced),
    vendorInvoice: new VendorInvoiceService(supplyChainAdvanced),
    spendAnalytics: new SpendAnalyticsService(supplyChainAdvanced),
    payment: new PaymentService(supplyChainAdvanced),
  };

  // Phase 5 — Asset Core. Built before DocumentService so its `asset` Entity
  // Authorization Resolver can close over `asset.canAccessForDocument`
  // (ADR-0012). Asset documents are gated by a dedicated capability AND the
  // asset's own Data Scope, not by plain asset.read.
  const asset = new AssetService(
    new PgAssetRepository(pool),
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Wave A3 / PACK-001…004 & SO-ADV-002…005 — Vertical Service Packs and
  // route/roster/capacity/workload optimization over Service Operations Core.
  const serviceOperationsAdvancedRepo = new PgServiceOperationsAdvancedRepository(pool);
  const serviceOperationsAdvanced = new ServiceOperationsAdvancedService(
    serviceOperationsAdvancedRepo,
    serviceOperations,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Wave A3 / AST-ADV-001…007 — preventive/corrective maintenance,
  // spare parts, meter readings, downtime, reliability and predictive
  // analytics. Lifecycle is delegated to Workflow Engine via instance id.
  const assetAdvanced = new AssetAdvancedService(
    new PgAssetAdvancedRepository(pool),
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Phase 6 — Finance Core is built earlier (above, before Supply Chain
  // Advanced) so its `finance_transaction` Entity Authorization Resolver can
  // still close over `finance.canAccessForDocument` (ADR-0012) ahead of
  // DocumentService, and so WP-PRO-03 payment approval can record cash
  // movement. Financial evidence is gated by a dedicated capability AND the
  // transaction's Data Scope.

  // Phase 5 — Finance Master (WP-MD-01) and UoM Central (WP-MD-02). Master
  // data surfaces; no workflow or posting involvement.
  const financeMaster = new FinanceMasterService(
    new PgFinanceMasterRepository(pool),
    audit,
    rbac,
  );
  const uomRepo = new PgUomRepository(pool);
  const uom = new UomService(uomRepo, audit, rbac);

  // Phase 5 (WP-MD-03) — Catering vertical master. Structure + simple K5
  // costing only; ingredient UoM reuses UoM Central (K6). The service resolves
  // unit codes through the UoM repository port directly — not the UomService
  // application surface — so a catering configurator does not also need
  // supply_chain.read to write a recipe (catering is a service_operations
  // vertical). The conversion engine itself is still UoM Central; costing
  // resolves conversions in SQL against unit_conversions.
  // WP-OPS-01 — catering writes are gated on the catering Service Pack being
  // active for the tenant. The advanced repo structurally satisfies the
  // vertical's `PackActivationPort` (duck typing), so the vertical keeps its
  // boundary: it never imports advanced-module internals.
  const catering = new CateringService(
    new PgCateringRepository(pool),
    uomRepo,
    audit,
    rbac,
    customer,
    serviceOperationsAdvancedRepo,
  );

  // Phase 1B — Accounting Kernel. Sole writer of the General Ledger
  // (ADR-0023 ACCEPTED). Period reopen is a maker-checker flow enforced in
  // code (AccountingKernelService.approvePeriodReopen: requester ≠ approver)
  // and in the DB (guard_period_reopen trigger); no Workflow Definition
  // dependency. workflow_instance_id on accounting_periods stays nullable for
  // a future Epic 9 integration that can add it without a re-migration.
  const accountingKernelRepo = new PgAccountingKernelRepository(pool);
  // WP-APR-02 — central rule registry repository; the kernel consults it
  // before the posting-rules table (DEC-008/BR-013 single source of truth).
  const ruleRegistryRepo = new PgRuleRegistryRepository(pool);
  const accountingKernel = new AccountingKernelService(
    accountingKernelRepo,
    configuration,
    audit,
    rbac,
    eventBus,
    ruleRegistryRepo,
  );
  const accountingEventConsumer = new AccountingEventConsumerService(
    accountingKernel,
    accountingEventPort,
    accountingKernelRepo,
    parameterReader,
  );

  // WP-FIN-A6-02 — AP/AR open-item settlement (ADR-0017). Remaining balances
  // are projections of the append-only allocation history; the repo holds the
  // transaction+lock path that keeps over-allocation fail-closed.
  const openItem = new OpenItemService(new PgOpenItemRepository(pool), rbac, audit);

  // WP-FIN-A6-03 — Budget control (ADR-0020). Versioned baselines go through
  // the Workflow Engine for maker-checker approval; consumption is idempotent
  // and fail-closed on hard_stop policies.
  const budget = new BudgetService(new PgBudgetRepository(pool), rbac, audit, workflow);

  // WP-FIN-A6-04 — Bank reconciliation (ADR-0018). Statement facts are imported
  // and matched; the ledger is read for the book side, never written here. No
  // bank adapter is wired: the reserved ports stay unimplemented in Wave A6 and
  // `BankPaymentInitiator` is disabled by the Founder decision.
  const bankRecon = new BankReconService(new PgBankReconRepository(pool), rbac, audit);

  // WP-FIN-A6-05 — Fixed asset book + depreciation (ADR-0019). The asset book
  // never reads `assets` directly: every asset is authorized through
  // `asset.getAsset` / `asset.canAccessForDocument` so Data Scope is decided in
  // one place. Depreciation posts through the kernel's internal seam, keeping
  // the Accounting Kernel the sole writer of the GL (ADR-0023).
  const assetBook = new AssetBookService(
    new PgAssetBookRepository(pool),
    rbac,
    audit,
    accountingKernel,
    { assertAssetAccess: (actor, assetId) => asset.assertAssetAccess(actor, assetId) },
  );

  // WP-FIN-A6-06a — Indonesia tax baseline (ADR-0019). Registrations and rule
  // versions are effective-dated policy; rule versions go through the Workflow
  // Engine for maker-checker approval. This service records calculations as
  // evidence and never posts — the Accounting Kernel stays the sole GL writer.
  const tax = new TaxService(new PgTaxRepository(pool), rbac, audit, workflow);

  // WP-FIN-A6-06b — Consolidation (ADR-0022). Groups, FSV versions and
  // eliminations all go through the Workflow Engine. The module reads posted
  // ledger facts and translates them; eliminations post through the kernel, so
  // ADR-0023 holds — this module never writes the GL itself.
  const consolidation = new ConsolidationService(
    new PgConsolidationRepository(pool),
    rbac,
    audit,
    workflow,
    accountingKernel,
  );

  // Phase 7 — HSE Core. Built before DocumentService so its `hse_record`
  // Entity Authorization Resolver can close over `hse.canAccessForDocument`
  // (ADR-0012). HSE evidence is gated by hse.documents.read AND Data Scope.
  const hse = new HseService(
    new PgHseRepository(pool),
    workflow,
    configuration,
    audit,
    rbac,
    eventBus,
  );

  // Phase 8 — Project Delivery Core. Built before DocumentService so activity
  // and milestone documents use the shared entity authorization resolver and
  // inherit project/customer Data Scope instead of a new attachment subsystem.
  const projectDelivery = new ProjectDeliveryService(
    new PgProjectDeliveryRepository(pool),
    audit,
    rbac,
    eventBus,
  );

  // Wave A7 — Project Delivery Advanced (PRJ-ADV-001…008). `accountingEventPort`
  // is the same `PgAccountingEventWritePort` Supply Chain and Workforce emit
  // through, so Project Delivery never gains a path to the ledger itself
  // (ADR-0026 §2).
  const projectDeliveryAdvancedRepo = new PgProjectDeliveryAdvancedRepository(pool);
  const projectPlan = new ProjectPlanService(projectDeliveryAdvancedRepo, audit, rbac);
  const projectCost = new ProjectCostService(projectDeliveryAdvancedRepo, accountingEventPort, audit, rbac);

  // Wave A7 — HSE Advanced (HSE-ADV-001…007). Its own repository reads the Core
  // HSE tables through reference ports only, so nothing here can write a Core
  // record or a Core follow-up (ADR-0027 §1). `workflow` is passed in for
  // permits alone: permit lifecycle is the Engine's, not this module's (§4).
  const hseAdvancedRepo = new PgHseAdvancedRepository(pool);
  const hseAdvanced = new HseAdvancedService(hseAdvancedRepo, workflow, configuration, audit, rbac);
  const hseAssurance = new HseAssuranceService(hseAdvancedRepo, configuration, audit, rbac);
  const hseCapa = new HseCapaService(hseAdvancedRepo, configuration, audit, rbac);

  // Phase 9 — Reporting & Operational Insight Core. Read-only projections over
  // activated modules; explicit reporting permissions and Data Scope enforced
  // in the service/repository, without importing business-module internals.
  const reportingInsight = new ReportingInsightService(
    new PgReportingInsightRepository(pool),
    rbac,
  );

  // Wave A2 / RPT-ADV-001 — Governed Self-Service BI and Reporting Warehouse.
  // Static registry query compilation, zero dynamic arbitrary SQL or code
  // execution, mandatory Data Scope projection and statement timeout.
  const biRepo = new PgBiRepository(pool);
  const reportingBi = new BiService(biRepo, audit, rbac);

  // Wave A2 / RPT-ADV-002 — Deterministic Predictive Analytics Foundation.
  // Moving-average + linear-trend regression across operational history,
  // tenant-isolated, bounded computation, zero autonomous domain mutation.
  const predictiveRepo = new PgPredictiveRepository(pool);
  const reportingPredictive = new PredictiveService(predictiveRepo, audit, rbac);

  // Phase 11F — Business Admin Console plus governed User Role assignments.
  // Existing consolidation reads stay permission-gated; the narrow write
  // surface is owned transactionally by the RBAC repository using this same
  // shared Pool. No Builder or generic configuration mutation is introduced.
  const adminConsole = new AdminConsoleService(
    rbac,
    rbacRepo,
    userRepo,
    configuration,
    workflow,
    audit,
  );

  const documentEntityResolvers: EntityAuthorizationResolverRegistry = new Map([
    [
      "customer",
      { canAccess: (actor, entityId) => customer.canAccessForDocument(actor, entityId) },
    ],
    [
      "complaint",
      { canAccess: (actor, entityId) => complaint.canAccessForDocument(actor, entityId) },
    ],
    [
      "work_order",
      { canAccess: (actor, entityId) => serviceOperations.canAccessForDocument(actor, entityId) },
    ],
    [
      "employee",
      { canAccess: (actor, entityId) => workforce.canAccessForDocument(actor, entityId) },
    ],
    [
      "purchase_request",
      { canAccess: (actor, entityId) => supplyChain.canAccessRequestForDocument(actor, entityId) },
    ],
    [
      "purchase_order",
      { canAccess: (actor, entityId) => supplyChain.canAccessOrderForDocument(actor, entityId) },
    ],
    [
      "asset",
      { canAccess: (actor, entityId) => asset.canAccessForDocument(actor, entityId) },
    ],
    [
      "finance_transaction",
      { canAccess: (actor, entityId) => finance.canAccessForDocument(actor, entityId) },
    ],
    [
      "hse_record",
      { canAccess: (actor, entityId) => hse.canAccessForDocument(actor, entityId) },
    ],
    [
      "project_delivery_activity",
      {
        canAccess: (actor, entityId) =>
          projectDelivery.canAccessForDocument(actor, "project_delivery_activity", entityId),
      },
    ],
    [
      "project_delivery_milestone",
      {
        canAccess: (actor, entityId) =>
          projectDelivery.canAccessForDocument(actor, "project_delivery_milestone", entityId),
      },
    ],
    [
      "sales_quotation",
      { canAccess: (actor, entityId) => sales.canAccessForDocument(actor, entityId) },
    ],
    [
      "capa_action",
      { canAccess: (actor, entityId) => serviceQuality.canAccessCapaForDocument(actor, entityId) },
    ],
    [
      "workforce_leave_request",
      { canAccess: (actor, entityId) => workforceAdvanced.canAccessLeaveRequestForDocument(actor, entityId) },
    ],
    [
      "workforce_job_application",
      { canAccess: (actor, entityId) => workforceAdvanced.canAccessJobApplicationForDocument(actor, entityId) },
    ],
    [
      "workforce_training_enrollment",
      { canAccess: (actor, entityId) => workforceAdvanced.canAccessTrainingEnrollmentForDocument(actor, entityId) },
    ],
    [
      "scm_stock_transfer",
      { canAccess: (actor, entityId) => supplyChainAdvanced.canAccessStockTransferForDocument(actor, entityId) },
    ],
    [
      "scm_stock_opname",
      { canAccess: (actor, entityId) => supplyChainAdvanced.canAccessStockOpnameForDocument(actor, entityId) },
    ],
    [
      "scm_rfq",
      { canAccess: (actor, entityId) => supplyChainAdvanced.canAccessRfqForDocument(actor, entityId) },
    ],
    [
      "scm_supplier_contract",
      { canAccess: (actor, entityId) => supplyChainAdvanced.canAccessSupplierContractForDocument(actor, entityId) },
    ],
    [
      "scm_landed_cost",
      { canAccess: (actor, entityId) => supplyChainAdvanced.canAccessLandedCostForDocument(actor, entityId) },
    ],
    [
      "scm_receiving_record",
      { canAccess: (actor, entityId) => supplyChainAdvanced.canAccessReceivingRecordForDocument(actor, entityId) },
    ],
    [
      "scm_return_to_vendor",
      { canAccess: (actor, entityId) => supplyChainAdvanced.canAccessReturnToVendorForDocument(actor, entityId) },
    ],
  ]);
  const document = new DocumentService(
    documentRepo,
    new LocalFileStorage(),
    audit,
    rbac,
    eventBus,
    documentEntityResolvers,
    parameterReader,
  );

  // Generic Survey & Assessment Engine (Checkpoint 1D.1). Reuses the shared
  // EntityAuthorizationResolver registry so an Assignment's optional context
  // entity (e.g. a Complaint) is authorized without Survey Core knowing that
  // module (ADR-0012). No Complaint/1E integration wired here.
  const surveyRepo = new PgSurveyRepository(pool);
  const surveyAdvancedRepo = new PgSurveyAdvancedRepository(pool);
  const survey = new SurveyService(
    surveyRepo,
    audit,
    rbac,
    eventBus,
    documentEntityResolvers,
    surveyAdvancedRepo,
  );
  const surveyResponse = new SurveyResponseService(
    surveyRepo,
    audit,
    rbac,
    eventBus,
    surveyAdvancedRepo,
  );
  const surveyAnalytics = new SurveyAnalyticsService(
    surveyRepo,
    surveyAdvancedRepo,
    audit,
    rbac,
    eventBus,
  );
  const surveyPublic = new SurveyPublicResponseService(
    surveyRepo,
    surveyAdvancedRepo,
    audit,
    eventBus,
  );

  // Survey Integration orchestrator (Checkpoint 1E.1) — turns a Complaint
  // customer-confirmation into a Survey Assignment WITHOUT coupling the two
  // Cores. It depends on Complaint (read) + Survey (application port) only;
  // neither Core depends on it or on each other (FD-1E §2/§39). Wired as a
  // subscriber below.
  const surveyIntegrationRepo = new PgSurveyIntegrationRepository(pool);
  const surveyIntegration = new SurveyIntegrationService(
    surveyIntegrationRepo,
    survey,
    complaintRepo,
    userRepo,
    rbac,
    audit,
    rbacRepo,
    eventBus,
    (policyCode, error) => console.error(`[SurveyIntegration] policy '${policyCode}' failed:`, error),
    serviceOperationsRepo,
  );

  // Any Domain Event, regardless of publisher, reaches both — this is
  // the "modul lain di masa depan tanpa perlu mengubah modul yang
  // mempublikasikan event" guarantee from doc 07, proven with the two
  // concrete subscribers this checkpoint ships.
  eventBus.subscribe("*", (event) => notification.handleDomainEvent(event));
  eventBus.subscribe("*", (event) => integration.handleDomainEvent(event));

  // Checkpoint 1B: re-publish the generic Workflow Engine's
  // `workflow.escalated` event under the Complaint Event Catalog name
  // (`complaint.escalated`, doc section 33) WHEN it belongs to a
  // Complaint — zero changes to the generic engine, zero Complaint-
  // specific code inside it; this is purely a translation subscriber,
  // the same "modul lain tanpa mengubah publisher" pattern as every
  // other subscriber here.
  eventBus.subscribe("workflow.escalated", async (event) => {
    if (event.entityType !== "complaint") return;
    await eventBus.publish({
      tenantId: event.tenantId,
      eventType: "complaint.escalated",
      entityType: "complaint",
      entityId: event.entityId,
      payload: event.payload,
      createdBy: event.createdBy,
    });
  });

  // Checkpoint 1E.1: Complaint customer-confirmation triggers Survey
  // Assignment via the Integration orchestrator. The subscriber only
  // consumes the event; all business logic (policy/respondent/version
  // resolution, idempotency) lives in SurveyIntegrationService, which never
  // throws (a failed integration must not roll back the confirmation).
  eventBus.subscribe("complaint.customer_confirmed", (event) =>
    surveyIntegration.handleTriggerEvent(event),
  );

  // WP-OPS-01 Phase 6: a Customer acceptance of a Work Order triggers the
  // post-acceptance CSAT survey through the SAME orchestrator. Policies are
  // matched on ('work_order', 'work_order.accepted'); a token-path acceptance
  // (no actor) yields a durable `skipped` execution, never an error.
  eventBus.subscribe("work_order.accepted", (event) =>
    surveyIntegration.handleTriggerEvent(event),
  );

  // Checkpoint 1E.2: a submitted Survey is evaluated against the policy
  // snapshot taken when it was assigned; a matching outcome raises
  // management attention (notification + execution + audit). NO automatic
  // Complaint reopen and no Workflow mutation — Survey Core stays unaware
  // of Complaint semantics and Complaint Core is never called from here.
  eventBus.subscribe("survey.submitted", (event) => surveyIntegration.handleSurveySubmitted(event));

  // Wave A1 / SQ-ADV-001 — complaint-level SLA projections follow durable
  // Complaint lifecycle events. The handler is idempotent and never advances
  // Complaint/Workflow state itself.
  for (const eventType of [
    "complaint.submitted",
    "complaint.acknowledged",
    "complaint.customer_confirmed",
  ]) {
    eventBus.subscribe(eventType, (event) => serviceQuality.handleComplaintEvent(event));
  }

  // Wave A1 / SQ-ADV-004 — Founder-gated feedback automation proposals.
  // The handler evaluates triggers and persists idempotent proposals ONLY.
  for (const eventType of [
    "survey.submitted",
    "complaint.reopened",
    "service_quality.sla_resolution_breached",
  ]) {
    eventBus.subscribe(eventType, (event) => serviceQuality.handleFeedbackEvent(event));
  }

  const scheduler = new SchedulerService(
    schedulerRepo,
    rbac,
    (jobCode, error) => {
      console.error(`[Scheduler] job '${jobCode}' failed:`, error);
    },
    { timersDisabled: process.env.SCHEDULER_DISABLED === "true" },
  );
  registerJobHandlers(scheduler, {
    tenantRepo,
    workflow,
    integration,
    serviceQuality,
    accountingEventConsumer,
    survey,
  });

  return {
    pool,
    audit,
    rbac,
    approvalAuthority,
    eventBus,
    scheduler,
    tenant: new TenantService(tenantRepo, audit, rbac, rbacRepo),
    legalEntity: new LegalEntityService(legalEntityRepo, rbac),
    legalEntityAttachmentReference: new LegalEntityAttachmentReferenceService(
      new PgLegalEntityAttachmentReferenceRepository(pool),
      legalEntityRepo,
      rbac,
    ),
    organizationUnit: new OrganizationUnitService(organizationUnitRepo, rbac, rbacRepo),
    organizationUnitHierarchy: new OrganizationUnitHierarchyService(
      organizationUnitHierarchyRepo,
      organizationUnitRepo,
      rbac,
      parameterReader,
    ),
    departments: new DepartmentService(departmentRepo, rbac),
    businessPartner: new BusinessPartnerService(businessPartnerRepo, rbac),
    // WP-APR-03 / WP-APR-02 — SoD governance surface and central rule registry.
    sod: new SodService(new PgSodRepository(pool), rbac),
    ruleRegistry: new RuleRegistryService(ruleRegistryRepo, rbac),
    employeePlacement: new EmployeePlacementService(employeePlacementRepo, rbac),
    user: new UserService(userRepo, rbacRepo, audit, rbac, customerRepo),
    auth: new AuthService(pool, tenantRepo, userRepo, audit, parameterReader),
    configuration,
    appMetadata,
    workflow,
    notification,
    document,
    integration,
    customer,
    contract,
    project,
    site,
    serviceCatalog,
    complaint,
    complaintDashboard,
    complaintConfiguration,
    sales,
    serviceQuality,
    survey,
    surveyResponse,
    surveyAnalytics,
    surveyPublic,
    surveyIntegration,
    serviceOperations,
    serviceOperationsAdvanced,
    kpi,
    workforce,
    workforceAdvanced,
    supplyChain,
    supplyChainAdvanced,
    wms,
    procurement,
    asset,
    assetAdvanced,
    finance,
    financeMaster,
    uom,
    catering,
    accountingKernel,
    accountingEventConsumer,
    openItem,
    budget,
    bankRecon,
    assetBook,
    tax,
    consolidation,
    hse,
    hseAdvanced,
    hseAssurance,
    hseCapa,
    projectDelivery,
    projectPlan,
    projectCost,
    reportingInsight,
    reportingBi,
    reportingPredictive,
    adminConsole,
  };
}

export type Container = ReturnType<typeof buildContainer>;
