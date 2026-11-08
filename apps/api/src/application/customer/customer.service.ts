import type {
  Customer,
  CustomerContact,
  CustomerContactRepository,
  CustomerRepository,
} from "../../domain/customer/customer.entity.js";
import type { AuditService } from "../audit/audit.service.js";
import type { RbacService } from "../rbac/rbac.service.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import type { UserRoleAssignment } from "../../domain/rbac/rbac.entity.js";
import { ForbiddenError, NotFoundError } from "../../domain/shared-kernel/errors.js";

export interface CreateCustomerInput {
  code: string;
  name: string;
  status?: string;
  ownerOrganizationUnitId?: string | null;
  notes?: string | null;
}

export interface CreateCustomerContactInput {
  customerId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
}

export interface UpdateCustomerInput {
  code?: string;
  name?: string;
  status?: string;
  ownerOrganizationUnitId?: string | null;
  notes?: string | null;
}

export interface UpdateCustomerContactInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
}

/**
 * Customer Foundation (Checkpoint 1A). Also the reference implementation
 * every other Customer-context service (Contract/Project/Site/Service
 * Assignment) and the Document Service's `customer` Entity Authorization
 * Resolver (ADR-0012) delegate to for "can this actor touch data
 * belonging to this Customer" — kept in one place so the answer can never
 * drift between call sites (ADR-0011).
 */
export class CustomerService {
  constructor(
    private readonly repo: CustomerRepository,
    private readonly contactRepo: CustomerContactRepository,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  async create(actor: ActorContext, input: CreateCustomerInput): Promise<Customer> {
    await this.rbac.requirePermission(actor, "customer.manage");
    if (input.ownerOrganizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, input.ownerOrganizationUnitId);
    }

    const customer = await this.repo.create(
      { ...input, tenantId: actor.tenantId },
      actor.userId,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "customer.created",
      entityType: "customer",
      entityId: customer.id,
      metadata: { code: customer.code, name: customer.name },
    });

    return customer;
  }

  async update(actor: ActorContext, id: string, input: UpdateCustomerInput): Promise<Customer> {
    await this.rbac.requirePermission(actor, "customer.manage");
    const current = await this.getAuthorized(actor, id);
    if (input.ownerOrganizationUnitId) {
      await this.rbac.requireOrganizationUnitScopeForActor(actor, input.ownerOrganizationUnitId);
    }

    const customer = await this.repo.update(current.id, input, actor.userId);
    if (!customer) throw new NotFoundError("Customer", id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "customer.updated",
      entityType: "customer",
      entityId: customer.id,
      metadata: { code: customer.code, name: customer.name, status: customer.status },
    });

    return customer;
  }

  async listForTenant(actor: ActorContext): Promise<Customer[]> {
    await this.rbac.requirePermission(actor, "customer.read");
    const all = await this.repo.listByTenant(actor.tenantId);

    // Checkpoint 1B hardening: `GET /customers` now applies Customer Data
    // Scope per row, not just the Tenant-wide `customer.read` permission
    // (the 1A gap explicitly flagged as a follow-up, pulled forward
    // because Complaint creation uses Customer as its business context —
    // a Customer User or scoped internal role must not be able to browse
    // Customers outside their own scope while picking one to file a
    // Complaint against). Assignments are fetched once and reused per row
    // (`isCustomerContextScopeCoveredByAssignments`) rather than once per
    // Customer — cheap at Phase 0/1A/1B data volumes (see the existing,
    // documented "no pagination yet" item in the Technical Debt Register;
    // this filtering shares that same known scaling ceiling, not a new
    // one).
    const assignments = await this.rbac.getAssignments(actor.userId);
    if (assignments.some((a) => a.scopeType === "tenant")) return all;

    const matches = await this.rbac.buildCustomerContextScopeMatcher(actor.tenantId, assignments);
    return all.filter((customer) =>
      matches({
        customerId: customer.id,
        ownerOrganizationUnitId: customer.ownerOrganizationUnitId,
      }),
    );
  }

  /**
   * Checkpoint 1C.5 — trusted-caller resolution of the Customer ids within
   * the actor's Data Scope, WITHOUT requiring `customer.read`. A business
   * module that has already authorized the actor for its own operation (e.g.
   * ComplaintDashboardService, gated on `complaint.dashboard.read`) uses this
   * to constrain aggregation to the allowed customers — so scope is enforced
   * in the query, not the UI. Same trusted-caller posture as
   * WorkflowService.getInstanceForEntityOwner. Returns only the fields a
   * scope filter needs.
   */
  async listScopedCustomerIds(actor: ActorContext): Promise<string[]> {
    const all = await this.repo.listByTenant(actor.tenantId);
    const assignments = await this.rbac.getAssignments(actor.userId);
    return this.filterCustomerIdsByAssignments(all, assignments);
  }

  /** Site-scoping of tasks (field officers): the Customer ids covered by the
   * actor's ACTIVE assignment only (Epic 1 §4.1 C — the same form
   * `getAuthorized` / `canAccessForDocument` enforce on a single record).
   * `listScopedCustomerIds` unions EVERY assignment the user holds, so a user
   * who is petugas@Site-A in one assignment and holds a broader role in
   * another would see both sites' work while the Site-A role is active. Task
   * LIST reads use this variant so list and detail agree. */
  async listScopedCustomerIdsForActor(actor: ActorContext): Promise<string[]> {
    const all = await this.repo.listByTenant(actor.tenantId);
    return this.filterCustomerIdsByAssignments(all, this.rbac.getActiveAssignment(actor));
  }

  /** Trusted-caller variant that couples the business permission and Customer
   * Data Scope to the same effective assignment. This closes the privilege-
   * composition gap where a narrow role supplied permission while an unrelated
   * role supplied broader scope. */
  async listScopedCustomerIdsForPermission(
    actor: ActorContext,
    permissionCode: string,
  ): Promise<string[]> {
    const [all, assignments] = await Promise.all([
      this.repo.listByTenant(actor.tenantId),
      this.rbac.getAssignmentsWithPermission(actor.userId, permissionCode),
    ]);
    return this.filterCustomerIdsByAssignments(all, assignments);
  }

  private async filterCustomerIdsByAssignments(
    customers: Customer[],
    assignments: UserRoleAssignment[],
  ): Promise<string[]> {
    if (assignments.some((assignment) => assignment.scopeType === "tenant")) {
      return customers.map((customer) => customer.id);
    }
    // One read of the tenant's units, then an in-memory match per Customer
    // (was up to two queries per Customer).
    const tenantId = customers[0]?.tenantId;
    if (!tenantId) return [];
    const matches = await this.rbac.buildCustomerContextScopeMatcher(tenantId, assignments);
    return customers
      .filter((customer) =>
        matches({
          customerId: customer.id,
          ownerOrganizationUnitId: customer.ownerOrganizationUnitId,
        }),
      )
      .map((customer) => customer.id);
  }

  /** Loads a Customer and enforces both Tenant isolation and Data Scope.
   * The single choke point every Customer-context module (Contract,
   * Project, Site, Service Assignment, Document resolver) calls through. */
  async getAuthorized(actor: ActorContext, customerId: string): Promise<Customer> {
    const customer = await this.repo.findById(customerId);
    if (!customer || customer.tenantId !== actor.tenantId) {
      throw new NotFoundError("Customer", customerId);
    }
    await this.rbac.requireCustomerContextScopeForActor(actor, {
      customerId: customer.id,
      ownerOrganizationUnitId: customer.ownerOrganizationUnitId,
    });
    return customer;
  }

  /** Trusted-caller visibility gate with permission and Customer Data Scope
   * coupled to the same effective assignment. */
  async getAuthorizedForPermission(
    actor: ActorContext,
    customerId: string,
    permissionCode: string,
  ): Promise<Customer> {
    const customer = await this.repo.findById(customerId);
    if (!customer || customer.tenantId !== actor.tenantId) {
      throw new NotFoundError("Customer", customerId);
    }
    const assignments = await this.rbac.getAssignmentsWithPermission(
      actor.userId,
      permissionCode,
    );
    const covered = await this.rbac.isCustomerContextScopeCoveredByAssignments(assignments, {
      customerId: customer.id,
      ownerOrganizationUnitId: customer.ownerOrganizationUnitId,
    });
    if (!covered) {
      throw new ForbiddenError(
        `Permission '${permissionCode}' and Customer Data Scope must come from the same assignment`,
      );
    }
    return customer;
  }

  /**
   * Checkpoint 1A binding decision (Document Scope): "Attachment mengikuti
   * authorization dan Data Scope dari parent entity ... tidak memiliki
   * independent business authorization yang terpisah". Used by the
   * Document Service's `customer` Entity Authorization Resolver
   * (ADR-0012) — deliberately does NOT require `customer.read`/`.manage`,
   * only Tenant isolation + Data Scope, matching that binding decision
   * literally: an attachment's authorization is the parent's Data Scope,
   * not a second, independent permission check.
   */
  async canAccessForDocument(actor: ActorContext, customerId: string): Promise<boolean> {
    const customer = await this.repo.findById(customerId);
    if (!customer || customer.tenantId !== actor.tenantId) return false;
    return this.rbac.isActiveCustomerContextScopeCovered(actor, {
      customerId: customer.id,
      ownerOrganizationUnitId: customer.ownerOrganizationUnitId,
    });
  }

  async createContact(actor: ActorContext, input: CreateCustomerContactInput) {
    await this.rbac.requirePermission(actor, "customer.manage");
    const customer = await this.getAuthorized(actor, input.customerId);

    const contact = await this.contactRepo.create(
      { ...input, tenantId: actor.tenantId },
      actor.userId,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "customer.contact_created",
      entityType: "customer_contact",
      entityId: contact.id,
      metadata: { customerId: customer.id, name: contact.name },
    });

    return contact;
  }

  async updateContact(
    actor: ActorContext,
    id: string,
    input: UpdateCustomerContactInput,
  ): Promise<CustomerContact> {
    await this.rbac.requirePermission(actor, "customer.manage");
    const current = await this.contactRepo.findById(id);
    if (!current || current.tenantId !== actor.tenantId) {
      throw new NotFoundError("CustomerContact", id);
    }
    await this.getAuthorized(actor, current.customerId);

    const contact = await this.contactRepo.update(current.id, input, actor.userId);
    if (!contact) throw new NotFoundError("CustomerContact", id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "customer.contact_updated",
      entityType: "customer_contact",
      entityId: contact.id,
      metadata: { customerId: contact.customerId, name: contact.name },
    });

    return contact;
  }

  async listContacts(actor: ActorContext, customerId: string) {
    await this.rbac.requirePermission(actor, "customer.read");
    await this.getAuthorized(actor, customerId);
    return this.contactRepo.listByCustomer(customerId);
  }

  async getCustomer(actor: ActorContext, customerId: string): Promise<Customer> {
    await this.rbac.requirePermission(actor, "customer.read");
    return this.getAuthorized(actor, customerId);
  }

  /**
   * Wave A8 / ADR-0028 — TRUSTED-CALLER partner read of every Customer in the
   * tenant. Same posture as `WorkflowService.getEntityStatus`: the caller (the
   * partner route layer) has ALREADY authorized the machine credential against
   * `customer.read` from the credential's own permission set, and `tenantId`
   * MUST come from the authenticated credential row, never from a request
   * parameter. No human RBAC/Data Scope is evaluated here: a partner credential
   * has no user, session, or assignment, and is tenant-wide by construction.
   * Do not call from any session-authenticated route.
   */
  async listForPartner(tenantId: string): Promise<Customer[]> {
    return this.repo.listByTenant(tenantId);
  }

  /** Trusted-caller single read for the partner surface (see `listForPartner`).
   * A Customer of another tenant is indistinguishable from a missing one. */
  async getForPartner(tenantId: string, customerId: string): Promise<Customer> {
    const customer = await this.repo.findById(customerId);
    if (!customer || customer.tenantId !== tenantId) {
      throw new NotFoundError("Customer", customerId);
    }
    return customer;
  }
}
