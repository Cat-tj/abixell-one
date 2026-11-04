import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../../composition-root.js";

/**
 * WP-FIN-A6-02 — AP/AR open-item settlement HTTP surface (ADR-0017).
 *
 * Same conventions as the accounting kernel routes: `app.authenticate`
 * preHandler, zod validation, `request.actor!`, central error mapping. Money
 * is a string in and out at 4 decimals (source-document precision); dates are
 * YYYY-MM-DD.
 */

const moneySchema = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/, "expected a money string with at most 4 decimals");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const uuidSchema = z.string().uuid();

const createItemSchema = z.object({
  legalEntityId: uuidSchema,
  side: z.enum(["AR", "AP"]),
  direction: z.enum(["debit", "credit"]),
  sourceKind: z.enum(["invoice", "payment", "credit_note", "debit_note", "down_payment", "withholding", "unapplied"]),
  sourceRefTable: z.string().min(1),
  sourceRefId: uuidSchema,
  partyType: z.enum(["customer", "supplier"]),
  partyId: uuidSchema,
  documentNo: z.string().min(1),
  documentDate: dateSchema,
  dueDate: dateSchema.nullable().optional(),
  currency: z.string().length(3),
  originalAmount: moneySchema,
});

const allocateSchema = z.object({
  legalEntityId: uuidSchema,
  sourceOpenItemId: uuidSchema,
  targetOpenItemId: uuidSchema,
  amount: moneySchema,
  allocationDate: dateSchema,
  idempotencyKey: z.string().min(1).max(120),
});

const reverseSchema = z.object({
  reversalReason: z.string().min(1),
});

const agingQuerySchema = z.object({
  side: z.enum(["AR", "AP"]),
  asOfDate: dateSchema,
  currency: z.string().length(3),
});

export function registerOpenItemRoutes(app: FastifyInstance, container: Container) {
  const svc = () => container.openItem;

  app.post("/accounting/open-items", { preHandler: app.authenticate }, async (request, reply) => {
    const input = createItemSchema.parse(request.body);
    const item = await svc().createOpenItem(request.actor!, {
      ...input,
      dueDate: input.dueDate ?? null,
    });
    return reply.status(201).send(item);
  });

  app.get("/accounting/open-items", { preHandler: app.authenticate }, async (request, reply) => {
    const query = z
      .object({
        side: z.enum(["AR", "AP"]).optional(),
        partyType: z.enum(["customer", "supplier"]).optional(),
        partyId: uuidSchema.optional(),
        legalEntityId: uuidSchema.optional(),
      })
      .parse(request.query);
    return reply.send(await svc().listOpenItems(request.actor!, query));
  });

  app.get("/accounting/open-items/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    return reply.send(await svc().getOpenItem(request.actor!, id));
  });

  app.get("/accounting/open-items/:id/allocations", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    return reply.send(await svc().listAllocations(request.actor!, id));
  });

  /** Tahap B8 — mark a Customer Invoice settled once fully allocated. */
  app.post(
    "/accounting/invoices/:id/settle",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send(await svc().settleInvoice(request.actor!, id));
    },
  );

  app.post("/accounting/open-items/allocate", { preHandler: app.authenticate }, async (request, reply) => {
    const input = allocateSchema.parse(request.body);
    return reply.status(201).send(await svc().allocate(request.actor!, input));
  });

  app.post("/accounting/allocations/:id/reverse", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = z.object({ id: uuidSchema }).parse(request.params);
    const input = reverseSchema.parse(request.body);
    return reply.status(201).send(await svc().reverseAllocation(request.actor!, id, input));
  });

  app.get("/accounting/aging", { preHandler: app.authenticate }, async (request, reply) => {
    const query = agingQuerySchema.parse(request.query);
    return reply.send(await svc().aging(request.actor!, query));
  });
}
