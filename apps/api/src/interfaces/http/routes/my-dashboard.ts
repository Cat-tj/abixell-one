import type { FastifyInstance } from "fastify";
import type { Container } from "../../../composition-root.js";

/**
 * GET /my/dashboard — one aggregate for the role-aware landing page.
 *
 * The frontend builds the landing from the caller's PERMISSIONS (already in
 * /me), so it only asks for the numbers it is allowed to see. Each block is
 * computed best-effort: an error in one block omits that block rather than
 * failing the whole response. Everything here re-reads through the same
 * services the module routes use — this endpoint never widens access, it
 * only batches reads the caller could have made one by one.
 */
export function registerMyDashboardRoutes(app: FastifyInstance, container: Container) {
  app.get("/my/dashboard", { preHandler: app.authenticate }, async (request, reply) => {
    const actor = request.actor!;
    const permissions = new Set(
      actor.roleCode
        ? await container.rbac.getPermissionsForRole(actor.tenantId, actor.roleCode)
        : [],
    );

    const blocks: Record<string, unknown> = {};

    // Customer User: their own complaints via their Customer Data Scope —
    // same read listByCustomer already permits them, just batched here. The
    // role dashboard's "Keluhan Saya" card reads this block.
    if (actor.scopeType === "customer" && actor.scopeCustomerId && permissions.has("complaint.read")) {
      try {
        const mine = await container.complaint.listByCustomer(actor, actor.scopeCustomerId);
        blocks.myComplaints = { total: mine.length };
      } catch {
        /* omit */
      }
    }

    if (permissions.has("complaint.dashboard.read")) {
      try {
        blocks.complaints = await container.complaintDashboard.getDashboard(actor, {});
      } catch {
        /* omit */
      }
    }

    if (permissions.has("complaint.read")) {
      try {
        const queue = await container.complaint.listOperationalQueue(actor, {}, { limit: 1 });
        blocks.myQueue = { count: queue.total };
      } catch {
        /* omit */
      }
    }

    if (permissions.has("notification.read")) {
      try {
        const list = await container.notification.listMyNotifications(actor);
        const unread = (list as Array<{ readAt?: string | null }>).filter((n) => !n.readAt).length;
        blocks.notifications = { unread, total: list.length };
      } catch {
        /* omit */
      }
    }

    if (permissions.has("service_operations.read")) {
      try {
        const orders = await container.serviceOperations.listWorkOrders(actor);
        blocks.workOrders = { total: orders.length };
      } catch {
        /* omit */
      }
    }

    if (permissions.has("user.read")) {
      try {
        const users = await container.user.listForTenant(actor);
        blocks.administration = { users: users.length };
      } catch {
        /* omit */
      }
    }

    return reply.send({ blocks });
  });
}
