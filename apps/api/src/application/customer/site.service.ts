import type { Site, SiteRepository, UpdateSiteInput } from "../../domain/customer/site.entity.js";
import type { AuditService } from "../audit/audit.service.js";
import type { RbacService } from "../rbac/rbac.service.js";
import type { CustomerService } from "./customer.service.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import { NotFoundError } from "../../domain/shared-kernel/errors.js";

export interface CreateSiteInput {
  customerId: string;
  projectId?: string | null;
  code: string;
  name: string;
  address?: string | null;
  status?: string;
}

export class SiteService {
  constructor(
    private readonly repo: SiteRepository,
    private readonly customers: CustomerService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  async create(actor: ActorContext, input: CreateSiteInput): Promise<Site> {
    await this.rbac.requirePermission(actor, "site.manage");
    await this.customers.getAuthorized(actor, input.customerId);

    const site = await this.repo.create({ ...input, tenantId: actor.tenantId }, actor.userId);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "site.created",
      entityType: "site",
      entityId: site.id,
      metadata: { customerId: input.customerId, code: site.code },
    });

    return site;
  }

  async update(actor: ActorContext, id: string, input: UpdateSiteInput): Promise<Site> {
    await this.rbac.requirePermission(actor, "site.manage");
    const current = await this.repo.findById(id);
    if (!current || current.tenantId !== actor.tenantId) {
      throw new NotFoundError("Site", id);
    }
    await this.customers.getAuthorized(actor, current.customerId);

    const site = await this.repo.update(current.id, input, actor.userId);
    if (!site) throw new NotFoundError("Site", id);

    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "site.updated",
      entityType: "site",
      entityId: site.id,
      metadata: { customerId: site.customerId, code: site.code, status: site.status },
    });

    return site;
  }

  /** All tenant sites — complaint queue display (owner request). */
  async listForTenant(actor: ActorContext): Promise<Site[]> {
    await this.rbac.requirePermission(actor, "customer.read");
    return this.repo.listForTenant(actor.tenantId);
  }
  async listByCustomer(actor: ActorContext, customerId: string): Promise<Site[]> {
    await this.rbac.requirePermission(actor, "site.read");
    await this.customers.getAuthorized(actor, customerId);
    return this.repo.listByCustomer(customerId);
  }
}
