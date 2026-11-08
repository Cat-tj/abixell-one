import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../../composition-root.js";

/**
 * Supply Chain HTTP surface (Phase 4). Follows the existing API conventions:
 * `app.authenticate` preHandler, zod validation, `request.actor!`, central
 * error mapping.
 *
 * Deliberately narrow: items, suppliers, stock, purchase requests, purchase
 * orders and receipts. No RFQ, tender, warehouse, batch, or valuation
 * endpoints exist.
 */

const gradeSchema = z.enum(["food", "non_food"]);

const itemSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  unitOfMeasure: z.string().min(1),
  grade: gradeSchema.nullable().optional(),
});

const itemUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  grade: gradeSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

const supplierSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

const supplierUpdateSchema = supplierSchema.partial().omit({ code: true }).extend({
  isActive: z.boolean().optional(),
});

const movementSchema = z.object({
  itemCode: z.string().min(1),
  siteId: z.string().uuid().nullable().optional(),
  quantity: z.number().positive(),
  reference: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

const purchaseRequestSchema = z.object({
  organizationUnitId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
  justification: z.string().min(1),
  requiredDate: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        itemCode: z.string().min(1),
        quantity: z.number().positive(),
        note: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const commentSchema = z.object({ comment: z.string().nullable().optional() });

const purchaseOrderSchema = z.object({
  supplierCode: z.string().min(1),
  purchaseRequestId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
  currency: z.string().nullable().optional(),
  orderDate: z.string().nullable().optional(),
  expectedDate: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        itemCode: z.string().min(1),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative().nullable().optional(),
      }),
    )
    .optional(),
});

const receiptSchema = z.object({
  lineId: z.string().uuid(),
  quantity: z.number().positive(),
  note: z.string().nullable().optional(),
});

const cancelSchema = z.object({ reason: z.string().nullable().optional() });

export function registerSupplyChainRoutes(app: FastifyInstance, container: Container) {
  const svc = () => container.supplyChain;

  // --- Items (SCM-CORE-001) -------------------------------------------

  app.post("/items", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.status(201).send(await svc().createItem(request.actor!, itemSchema.parse(request.body)));
  });

  app.get("/items", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { search?: string; activeOnly?: string };
    return reply.send(
      await svc().listItems(request.actor!, { search: query.search, activeOnly: query.activeOnly === "true" }),
    );
  });

  app.get("/items/:code", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    return reply.send(await svc().getItem(request.actor!, code));
  });

  app.patch("/items/:code", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    return reply.send(await svc().updateItem(request.actor!, code, itemUpdateSchema.parse(request.body)));
  });

  // --- Suppliers (SCM-CORE-002) ----------------------------------------

  app.post("/suppliers", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.status(201).send(await svc().createSupplier(request.actor!, supplierSchema.parse(request.body)));
  });

  app.get("/suppliers", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { search?: string };
    return reply.send(await svc().listSuppliers(request.actor!, { search: query.search }));
  });

  app.patch("/suppliers/:code", { preHandler: app.authenticate }, async (request, reply) => {
    const { code } = request.params as { code: string };
    return reply.send(await svc().updateSupplier(request.actor!, code, supplierUpdateSchema.parse(request.body)));
  });

  // --- Stock (SCM-CORE-003…006) ----------------------------------------

  app.get("/stock/balances", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { itemCode?: string; siteId?: string };
    return reply.send(await svc().listBalances(request.actor!, query));
  });

  app.get("/stock/movements", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { itemCode?: string; limit?: string };
    return reply.send(
      await svc().listMovements(request.actor!, {
        itemCode: query.itemCode,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    );
  });

  app.post("/stock/goods-in", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.status(201).send(await svc().recordGoodsIn(request.actor!, movementSchema.parse(request.body)));
  });

  app.post("/stock/goods-out", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.status(201).send(await svc().recordGoodsOut(request.actor!, movementSchema.parse(request.body)));
  });

  // --- Purchase Requests (SCM-CORE-007/008) -----------------------------

  app.post("/purchase-requests", { preHandler: app.authenticate }, async (request, reply) => {
    return reply
      .status(201)
      .send(await svc().createPurchaseRequest(request.actor!, purchaseRequestSchema.parse(request.body)));
  });

  app.get("/purchase-requests", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await svc().listPurchaseRequests(request.actor!));
  });

  app.get("/purchase-requests/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().getPurchaseRequest(request.actor!, id));
  });

  /** Generic lifecycle dispatch — the Workflow Engine validates the
   * transition; this module never encodes the Step graph. */
  app.post(
    "/purchase-requests/:id/actions/:actionCode",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, actionCode } = request.params as { id: string; actionCode: string };
      const { comment } = commentSchema.parse(request.body ?? {});
      return reply.send(await svc().actOnPurchaseRequest(request.actor!, id, actionCode, comment ?? null));
    },
  );

  // --- Purchase Orders (SCM-CORE-009/010) -------------------------------

  app.post("/purchase-orders", { preHandler: app.authenticate }, async (request, reply) => {
    return reply
      .status(201)
      .send(await svc().createPurchaseOrder(request.actor!, purchaseOrderSchema.parse(request.body)));
  });

  app.get("/purchase-orders", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await svc().listPurchaseOrders(request.actor!));
  });

  app.get("/purchase-orders/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().getPurchaseOrder(request.actor!, id));
  });

  app.post("/purchase-orders/:id/issue", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await svc().issuePurchaseOrder(request.actor!, id));
  });

  app.post("/purchase-orders/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = cancelSchema.parse(request.body ?? {});
    return reply.send(await svc().cancelPurchaseOrder(request.actor!, id, reason ?? null));
  });

  app.post("/purchase-orders/:id/receipts", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.status(201).send(await svc().receiveAgainstOrder(request.actor!, id, receiptSchema.parse(request.body)));
  });
}
