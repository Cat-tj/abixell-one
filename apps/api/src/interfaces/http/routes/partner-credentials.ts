import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../composition-root.js";
import { PartnerCredentialService } from "../../../application/integration/partner-credential.service.js";

/**
 * Wave A8 / ADR-0028 §2 — governed lifecycle of partner credentials.
 *
 * Session-authenticated tenant-admin surface (NOT the partner surface). The
 * plaintext secret appears only in the issue/rotate response; list never
 * returns secrets or hashes. Permissions (`integration.partner_credential.*`)
 * are enforced in the service via the human RBAC path.
 */
const issueSchema = z.object({
  name: z.string().trim().min(1).max(120),
  permissions: z.array(z.string().min(1)).min(1),
});

export function registerPartnerCredentialRoutes(app: FastifyInstance, container: Container) {
  const credentials = new PartnerCredentialService(container.rbac, container.audit);

  app.get("/integration/partner-credentials", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await credentials.list(request.actor!));
  });

  app.post("/integration/partner-credentials", { preHandler: app.authenticate }, async (request, reply) => {
    const body = issueSchema.parse(request.body);
    const issued = await credentials.issue(request.actor!, body);
    return reply.status(201).send({
      credential: issued.credential,
      clientId: issued.clientId,
      secret: issued.secret,
    });
  });

  app.post(
    "/integration/partner-credentials/:id/rotate",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await credentials.rotate(request.actor!, id));
    },
  );

  app.post(
    "/integration/partner-credentials/:id/revoke",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await credentials.revoke(request.actor!, id);
      return reply.status(204).send();
    },
  );
}
