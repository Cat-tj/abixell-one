import type {
  Locale,
  UpdateUserProfileInput,
  UserRepository,
} from "../../domain/identity/user.entity.js";
import type { RbacRepository } from "../../domain/rbac/rbac.entity.js";
import type { CustomerRepository } from "../../domain/customer/customer.entity.js";
import type { AuditService } from "../audit/audit.service.js";
import type { RbacService } from "../rbac/rbac.service.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import { ConflictError, NotFoundError } from "../../domain/shared-kernel/errors.js";
import { hashPassword } from "../../infrastructure/security/password.js";

/**
 * Checkpoint 1A / ADR-0011 — the Customer User provisioning path.
 *
 * Narrow on purpose (§4.4 D: no two doors with different policies). Every
 * assignment whose only valid form is the `customer` scope is created here;
 * every INTERNAL User is created through `POST /admin/users`, whose governed
 * policy checks the console ticket, the actor's own permission-bearing
 * visibility, the delegation ceiling, and the module ceiling. This path keeps
 * only the ADR-0011 checks the customer model requires, because the governed
 * surface refuses `customer` scope by design until the Service Operation
 * interview closes (§4.4 E).
 */
export interface CreateExternalCustomerUserInput {
  email: string;
  fullName: string;
  password: string;
  roleCode: string;
  scopeCustomerId: string;
}

export class UserService {
  constructor(
    private readonly repo: UserRepository,
    private readonly rbacRepo: RbacRepository,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    /** Checkpoint 1A — used only to resolve a Customer's owner
     * Organization Unit when creating a Customer User (scopeType
     * 'customer'); optional so existing tests/callers that never create a
     * Customer User do not need to wire it. */
    private readonly customerRepo?: CustomerRepository,
  ) {}

  async createExternalCustomerUser(
    actor: ActorContext,
    input: CreateExternalCustomerUserInput,
  ) {
    await this.rbac.requirePermission(actor, "user.create");

    const existing = await this.repo.findByEmailInTenant(actor.tenantId, input.email);
    if (existing) {
      throw new ConflictError(`Email '${input.email}' already exists in this Tenant`);
    }

    const role = await this.rbacRepo.findRoleByCode(actor.tenantId, input.roleCode);
    if (!role) throw new NotFoundError("Role", input.roleCode);

    // Checkpoint 1A: the actor creating a Customer User must themself
    // be authorized against that Customer (the same "cannot grant wider
    // than you hold" principle the governed surface applies) — a
    // Supervisor scoped only to Customer A cannot create a Customer
    // User for Customer B.
    const customer = await this.customerRepo?.findById(input.scopeCustomerId);
    if (!customer || customer.tenantId !== actor.tenantId) {
      throw new NotFoundError("Customer", input.scopeCustomerId);
    }
    await this.rbac.requireCustomerContextScopeForActor(actor, {
      customerId: input.scopeCustomerId,
      ownerOrganizationUnitId: customer.ownerOrganizationUnitId,
    });

    const passwordHash = await hashPassword(input.password);
    const user = await this.repo.create(
      { tenantId: actor.tenantId, email: input.email, fullName: input.fullName, passwordHash },
      actor.userId,
    );

    const assignment = await this.rbacRepo.assignRole(
      actor.tenantId,
      {
        userId: user.id,
        roleId: role.id,
        scopeType: "customer",
        scopeOrganizationUnitId: null,
        scopeCustomerId: input.scopeCustomerId,
      },
      actor.userId,
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "user.created",
      entityType: "user",
      entityId: user.id,
      metadata: { email: user.email, roleCode: role.code, scopeType: "customer" },
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "user.role_assigned",
      entityType: "user",
      entityId: user.id,
      metadata: { roleCode: role.code, scopeType: "customer" },
    });

    return { user, assignment };
  }

  async listForTenant(actor: ActorContext) {
    await this.rbac.requirePermission(actor, "user.read");
    return this.repo.listByTenant(actor.tenantId);
  }

  async getMe(actor: ActorContext) {
    const user = await this.repo.findById(actor.userId);
    if (!user || user.tenantId !== actor.tenantId) {
      throw new NotFoundError("User", actor.userId);
    }
    return user;
  }

  /** Self-service profile edit. Current-password verification happens
   * inside the repository's transaction, under the user-row lock, so a
   * concurrent password change cannot be verified against and then
   * overwritten (see PgUserRepository.updateOwnProfile). */
  async updateOwnProfile(
    actor: ActorContext,
    input: { fullName?: string; passwordHash?: string; preferredLocale?: Locale },
    currentPassword?: string,
  ) {
    return this.repo.updateOwnProfile(input, actor, currentPassword);
  }

  async updateProfile(
    actor: ActorContext,
    id: string,
    input: { fullName?: string; email?: string; password?: string },
  ) {
    const update: UpdateUserProfileInput = {};
    if (input.fullName !== undefined) {
      await this.rbac.requirePermission(actor, "user.update");
      update.fullName = input.fullName;
    }
    if (input.email !== undefined) {
      await this.rbac.requirePermission(actor, "user.email.update");
      update.email = input.email;
    }
    if (input.password !== undefined) {
      await this.rbac.requirePermission(actor, "user.password.reset");
      update.passwordHash = await hashPassword(input.password);
    }
    return this.repo.updateProfile(id, update, actor);
  }

  async setActive(actor: ActorContext, id: string, isActive: boolean) {
    await this.rbac.requirePermission(
      actor,
      isActive ? "user.activate" : "user.deactivate",
    );
    return this.repo.setActive(id, isActive, actor);
  }

  /**
   * Terminate (owner request): hard stop distinct from deactivate. Login
   * denied, sessions revoked, records retained — see repo.terminate.
   */
  async terminate(actor: ActorContext, id: string, reason: string | null) {
    await this.rbac.requirePermission(actor, "user.deactivate");
    const user = await this.repo.terminate(id, actor, reason);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "user.terminated",
      entityType: "user",
      entityId: id,
      metadata: { reason: reason ?? null },
    });
    return user;
  }
  async softDelete(actor: ActorContext, id: string) {
    await this.rbac.requirePermission(actor, "user.delete");
    return this.repo.softDelete(id, actor);
  }
}
