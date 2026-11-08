import type { FastifyInstance } from "fastify";
import type { Customer } from "../../../../domain/customer/customer.entity.js";
import type { Container } from "../../../../composition-root.js";
import { PartnerCredentialService } from "../../../../application/integration/partner-credential.service.js";
import { PARTNER_ROUTE_REGISTRY } from "./partner-registry.js";

/**
 * Wave A8 / WP-PLT-A8-01 — Partner route implementations (ADR-0028).
 *
 * Partner routes call the SAME application services as internal routes —
 * no forked business logic. Authorization is decided here, per route, from the credential's explicit
 * permission set (the registry's `permission`, enforced in `onRoute`). Handlers
 * then call TRUSTED-CALLER, tenant-scoped service reads (`*ForPartner`) with the
 * tenant taken from the credential row only. There is deliberately no synthetic
 * machine actor: human RBAC (`requirePermission`, assignment Data Scope) is
 * untouched and a credential can never be mistaken for an interactive actor.
 */

/** Partner DTOs are their own contract — internal entity shapes are mapped,
 * so an internal refactor cannot silently change what partners see. */
function toCustomerDto(c: Customer) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    status: c.status,
    createdAt: c.createdAt,
  };
}

export function registerPartnerApiRoutes(
  app: FastifyInstance,
  container: Container,
  credentials: PartnerCredentialService,
) {
  const requirePartnerPermission = (permission: string) => {
    return async (request: Parameters<Parameters<FastifyInstance["addHook"]>[1]>[0] & { partner?: { permissions: string[] } }, reply: import("fastify").FastifyReply) => {
      if (!request.partner?.permissions.includes(permission)) {
        return reply.status(403).send({ error: "Credential lacks the required permission" });
      }
    };
  };

  const registered = new Map<string, string>(
    PARTNER_ROUTE_REGISTRY.map((r) => [`${r.method} ${r.path}`, r.permission]),
  );

  app.addHook("onRoute", (routeOptions) => {
    // Attach the registry's permission requirement to each partner route so
    // no implementation can forget it: the route handler only needs to call
    // the service.
    if (routeOptions.url?.startsWith("/api/partner/v1")) {
      const method = routeOptions.method === "HEAD" ? "GET" : routeOptions.method;
      const permission = registered.get(`${method} ${routeOptions.url}`);
      if (!permission) {
        throw new Error(`Partner route ${routeOptions.method} ${routeOptions.url} must be in PARTNER_ROUTE_REGISTRY`);
      }
      const existing = routeOptions.preHandler;
      const gate = requirePartnerPermission(permission);
      routeOptions.preHandler = existing
        ? Array.isArray(existing)
          ? [...existing, gate]
          : [existing, gate]
        : gate;
    }
  });

  app.get("/api/partner/v1/customers", { preHandler: app.authenticatePartner }, async (request) => {
    const list = await container.customer.listForPartner(request.partner!.tenantId);
    return list.map(toCustomerDto);
  });

  app.get("/api/partner/v1/customers/:id", { preHandler: app.authenticatePartner }, async (request, reply) => {
    const customer = await container.customer.getForPartner(
      request.partner!.tenantId,
      (request.params as { id: string }).id,
    );
    return reply.send(toCustomerDto(customer));
  });

  void credentials;
}
