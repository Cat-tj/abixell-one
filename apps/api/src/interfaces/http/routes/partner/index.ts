import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PartnerCredentialService } from "../../../../application/integration/partner-credential.service.js";
import { registerPartnerApiRoutes } from "./partner-api.routes.js";
import { PARTNER_API_PREFIX, PARTNER_ROUTE_REGISTRY } from "./partner-registry.js";
import type { Container } from "../../../../composition-root.js";

/**
 * Wave A8 / WP-PLT-A8-01 — Partner API surface (ADR-0028).
 *
 * All partner routes live under `/api/partner/v1`. Machine authentication is
 * Basic (client_id + secret) and completely separate from `app.authenticate`
 * session auth: a partner credential never resolves to an interactive actor.
 * Tenant is derived from the credential only — never from a request
 * parameter — so cross-tenant access is not expressible in the contract.
 *
 * The registry (partner-registry.ts) enumerates the entire exposed surface;
 * the onReady check fails startup on any mismatch between the registry and
 * the declared routes.
 */

declare module "fastify" {
  interface FastifyRequest {
    partner?: { credentialId: string; tenantId: string; permissions: string[]; clientId: string };
  }
  interface FastifyInstance {
    authenticatePartner: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function registerPartnerApi(app: FastifyInstance, container: Container): void {
  const credentials = new PartnerCredentialService(container.rbac, container.audit);

  app.decorate("authenticatePartner", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Basic ")) {
      return reply.status(401).send({ error: "Missing Basic credentials" });
    }
    let clientId = "";
    let secret = "";
    try {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep < 0) throw new Error("no separator");
      clientId = decoded.slice(0, sep);
      secret = decoded.slice(sep + 1);
    } catch {
      return reply.status(401).send({ error: "Invalid Basic credentials" });
    }
    try {
      const credential = await credentials.authenticate(clientId, secret);
      request.partner = {
        credentialId: credential.id,
        tenantId: credential.tenantId,
        permissions: credential.permissions,
        clientId: credential.clientId,
      };
    } catch {
      // Single generic failure: unknown, revoked, and wrong-secret are
      // indistinguishable (ADR-0028 §2 — no state probing).
      return reply.status(401).send({ error: "Invalid partner credentials" });
    }
  });

  app.register(async (scoped) => {
    registerPartnerApiRoutes(scoped, container, credentials);
  });

  // Contract-stability check (ADR-0028 §4): the routes ACTUALLY registered
  // under the partner prefix (collected via onRoute, so an unregistered route
  // is visible) are compared with the registry in both directions. A mismatch
  // fails startup loudly rather than silently widening or shrinking the
  // published contract. HEAD (auto-added for each GET) is normalized away.
  const actuallyRegistered = new Set<string>();
  app.addHook("onRoute", (routeOptions) => {
    if (!routeOptions.url.startsWith(PARTNER_API_PREFIX)) return;
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const m of methods) {
      if (m === "HEAD") continue;
      actuallyRegistered.add(`${m} ${routeOptions.url}`);
    }
  });

  app.addHook("onReady", async () => {
    const registry = new Set(PARTNER_ROUTE_REGISTRY.map((r) => `${r.method} ${r.path}`));
    for (const d of actuallyRegistered) {
      if (!registry.has(d)) {
        throw new Error(`Partner API route ${d} is not registered in PARTNER_ROUTE_REGISTRY`);
      }
    }
    for (const r of registry) {
      if (!actuallyRegistered.has(r)) {
        throw new Error(`Partner route ${r} is in PARTNER_ROUTE_REGISTRY but not declared`);
      }
    }
  });
}
