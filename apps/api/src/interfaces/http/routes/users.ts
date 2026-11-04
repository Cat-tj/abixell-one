import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../composition-root.js";

// Checkpoint 1A / ADR-0011 — EXTERNAL Customer User provisioning, and nothing
// else. `scopeType` accepts one literal, so `tenant` and `organization_unit`
// are refused at the edge, before any service call. Internal Users are created
// through `POST /admin/users`, whose governed policy is the stricter of the two
// (§4.4 D: two doors must never mean two standards); keeping a second, weaker
// path for internal scope is what this narrows away.
const createExternalCustomerUserSchema = z
  .object({
    email: z.string().email(),
    fullName: z.string().min(1),
    password: z.string().min(8),
    roleCode: z.string().min(1),
    scopeType: z.literal("customer"),
    scopeCustomerId: z.string().uuid(),
  })
  .strict();

const updateSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    password: z.string().min(8).optional(),
  })
  .refine((body) => body.fullName !== undefined || body.email !== undefined || body.password !== undefined, {
    message: "At least one profile field is required",
  });

const idSchema = z.object({ id: z.string().uuid() });

export function registerUserRoutes(app: FastifyInstance, container: Container) {
  app.post("/users", { preHandler: app.authenticate }, async (request, reply) => {
    const body = createExternalCustomerUserSchema.parse(request.body);
    const actor = request.actor!;
    const { user, assignment } = await container.user.createExternalCustomerUser(actor, body);
    return reply.status(201).send({ user, assignment });
  });

  app.get("/users", { preHandler: app.authenticate }, async (request, reply) => {
    const actor = request.actor!;
    const list = await container.user.listForTenant(actor);
    return reply.send(list);
  });

  app.patch("/users/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const body = updateSchema.parse(request.body);
    const user = await container.user.updateProfile(request.actor!, id, body);
    return reply.send(user);
  });

  app.post("/users/:id/activate", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return reply.send(await container.user.setActive(request.actor!, id, true));
  });

  app.post("/users/:id/deactivate", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await container.user.setActive(request.actor!, id, false));
  });

  // Owner request: terminated users keep their records but can no longer
  // log in; the UI renders their name struck through. Admin-only action.
  app.post(
    "/users/:id/terminate",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().nullable().optional() }).parse(request.body ?? {});
      return reply.send(await container.user.terminate(request.actor!, id, body.reason ?? null));
    },
  );

  app.delete("/users/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    return reply.send(await container.user.softDelete(request.actor!, id));
  });
}
