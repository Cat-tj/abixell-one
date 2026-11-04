import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../composition-root.js";
import type { Locale } from "../../../domain/identity/user.entity.js";
import { hashPassword } from "../../../infrastructure/security/password.js";
import {
  getLoginRateLimitConfig,
  getProfileUpdateRateLimitConfig,
  getSwitchRoleRateLimitConfig,
} from "../../../infrastructure/security/http-hardening.js";
import { ValidationError } from "../../../domain/shared-kernel/errors.js";

// `tenantCode`/`tenantId` are optional: the login form now collects only
// email + password, and tenant resolution either falls out of the email
// (single match) or is chosen by the user after the password verifies
// (multiple matches). Both remain accepted for explicit targeting — the
// integration suite and any host-mounted client still send `tenantCode`.
const loginSchema = z
  .object({
    tenantCode: z.string().min(1).optional(),
    tenantId: z.string().uuid().optional(),
    email: z.string().email(),
    password: z.string().min(1),
  })
  .refine((body) => !(body.tenantCode && body.tenantId), {
    message: "Provide either tenantCode or tenantId, not both",
  });

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

const switchRoleSchema = z.object({
  assignmentId: z.string().uuid(),
});

export function registerAuthRoutes(app: FastifyInstance, container: Container) {
  // Security (Checkpoint 0F): a much tighter per-route rate limit than
  // the global default — login is the one endpoint where an attacker can
  // profitably guess credentials, so it gets its own budget (per IP, per
  // Fastify/rate-limit default keying).
  app.post(
    "/auth/login",
    { config: { rateLimit: getLoginRateLimitConfig() } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      // Both result shapes carry a `status` discriminator — either the token
      // pair (`authenticated`) or the verified-tenant list to choose from
      // (`tenant_selection_required`, no credential issued yet).
      const result = await container.auth.login({ ...body, ip: request.ip });
      return reply.send(result);
    },
  );

  app.post("/auth/refresh", async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const result = await container.auth.refresh(body.refreshToken);
    return reply.send(result);
  });

  // Frontend token/session persistence (Checkpoint 0F) means a refresh
  // token can now live in the browser across reloads for up to 7 days —
  // logout must actively revoke it server-side, not just discard it
  // client-side, or a stolen/leftover token would keep working after the
  // user believes they signed out.
  app.post("/auth/logout", async (request, reply) => {
    const body = logoutSchema.parse(request.body);
    await container.auth.logout(body.refreshToken);
    return reply.status(204).send();
  });

  // Epic 1 (§4.1 E) — switch the session's active Role without re-login.
  // The assignment must be one the caller holds AND that is currently
  // effective; `switchRole` answers both in the same statement that performs
  // the write, so a foreign or just-revoked assignment cannot be probed.
  // The response is the new actor context, not a token: the access token
  // identifies the session, and the session now names a different Role.
  app.post(
    "/auth/switch-role",
    {
      preHandler: app.authenticate,
      config: { rateLimit: getSwitchRoleRateLimitConfig() },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const body = switchRoleSchema.parse(request.body);
      const next = await container.auth.switchRole(actor, body.assignmentId);
      return reply.send({
        sessionId: next.sessionId,
        activeAssignmentId: next.assignmentId,
        roleId: next.roleId,
        roleCode: next.roleCode,
        scopeType: next.scopeType,
        scopeLegalEntityId: next.scopeLegalEntityId,
        scopeOrganizationUnitId: next.scopeOrganizationUnitId,
        scopeCustomerId: next.scopeCustomerId,
      });
    },
  );

  // Self-service profile edit. Deliberately narrower than the admin
  // PATCH /users/:id: `email` is not accepted here at all (it stays an
  // admin action behind user.email.update), and a password change must
  // carry the caller's current password.
  const patchMeSchema = z
    .object({
      fullName: z.string().trim().min(1).max(200).optional(),
      password: z.string().min(8).optional(),
      currentPassword: z.string().min(1).optional(),
      preferredLocale: z.enum(["en", "id"]).optional(),
    })
    .strict()
    .refine((body) => body.currentPassword === undefined || body.password !== undefined, {
      message: "currentPassword is only valid together with a password change",
    })
    .refine((body) => body.fullName !== undefined || body.password !== undefined || body.preferredLocale !== undefined, {
      message: "Supply fullName, password, or preferredLocale",
    })
    .refine((body) => body.password === undefined || body.currentPassword !== undefined, {
      message: "currentPassword is required when changing password",
    });

  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const actor = request.actor!;
    const [user, myAssignments, activeModuleCodes] = await Promise.all([
      container.user.getMe(actor),
      container.rbac.getMyAssignmentsWithScopeNames(actor.userId),
      container.configuration.listActiveModuleCodesForTenant(actor.tenantId),
    ]);

    // Epic 1 (§4.1 B/C) — the active Role is SERVER-SIDE session state. The
    // response reports the session's active assignment, resolved by the auth
    // plugin from the `sessions` row, and the ACTIVE Role's permission codes.
    // The `?assignmentId=` query narrowing is gone: the client switches
    // context through POST /auth/switch-role, which changes the session row
    // itself, and the next /me reflects it. The full assignment list is still
    // reported so the picker can offer the switch.
    const picked = actor.assignmentId
      ? myAssignments.find((a) => a.id === actor.assignmentId) ?? null
      : null;
    const effectivePermissions = picked
      ? await container.rbac.getPermissionsForRole(actor.tenantId, picked.roleCode)
      : new Set<string>();
    const activeAssignmentName = picked?.roleName ?? null;
    const activeRoleCode = picked?.roleCode ?? null;
    const activeScopeName =
      picked?.scopeType === "tenant"
        ? picked.scopeType
        : picked?.scopeLegalEntityName ??
          picked?.scopeOrganizationUnitName ??
          picked?.scopeCustomerName ??
          null;

    // Checkpoint 1C.3 — the distinct Data-Scope types of the ACTIVE
    // assignment only. The pre-Epic-1 union form would have told a Customer
    // User "internal" menus exist because some other Role the user holds
    // carries an internal scope.
    const scopeTypes = picked ? [picked.scopeType] : [];

    // Wave 2 (§4.3 step 7): the menu is filtered SERVER-SIDE, in the fixed
    // order external whitelist → module status → role rights, from exactly
    // the inputs this response reports. A caller holding no internal Data
    // Scope receives only whitelisted menus — internal ones never reach their
    // browser, not even disabled.
    const menu = await container.appMetadata.listMenuTree(actor, {
      permissions: Array.from(effectivePermissions),
      scopeTypes,
      activeModuleCodes,
    });

    // The navigation tree this caller receives (§4.3 steps 4 and 7). Served on
    // `/me` because the shell already awaits this call before rendering and
    // already receives `activeModuleCodes` and `permissions` from it — a
    // separate endpoint would add a round trip for ~2.9 KB gzip on a payload
    // measured at ~0.6 KB gzip. Decision recorded from measurement, not
    // assumption (§4.3 open item 1). Wave 2 filters it per caller; the mirror
    // of the inputs is closed over as `effectivePermissions` and
    // `scopeTypes`, not re-derived downstream.
    return reply.send({
      userId: actor.userId,
      tenantId: actor.tenantId,
      sessionId: actor.sessionId,
      fullName: user.fullName,
      email: user.email,
      preferredLocale: user.preferredLocale,
      permissions: Array.from(effectivePermissions),
      scopeTypes,
      activeModuleCodes,
      menu,
      assignments: myAssignments,
      activeAssignmentId: actor.assignmentId,
      activeAssignmentName,
      activeRoleCode,
      activeScopeName,
    });
  });

  app.patch(
    "/me",
    {
      preHandler: app.authenticate,
      config: { rateLimit: getProfileUpdateRateLimitConfig() },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const parsed = patchMeSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid profile update");
      }
      const body = parsed.data;

      const updated = await container.user.updateOwnProfile(
        actor,
        {
          fullName: body.fullName,
          passwordHash:
            body.password === undefined ? undefined : await hashPassword(body.password),
          preferredLocale: body.preferredLocale,
        },
        body.currentPassword,
      );
      return reply.send(updated);
    },
  );
}
