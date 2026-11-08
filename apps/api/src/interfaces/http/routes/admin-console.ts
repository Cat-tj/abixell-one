import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../../composition-root.js";

const roleCodeParamsSchema = z.object({ roleCode: z.string().min(1) }).strict();
const userParamsSchema = z.object({ userId: z.string().uuid() }).strict();
const assignmentParamsSchema = z
  .object({ userId: z.string().uuid(), assignmentId: z.string().uuid() })
  .strict();

const assignRoleSchema = z.discriminatedUnion("scopeType", [
  z
    .object({ roleCode: z.string().min(1), scopeType: z.literal("tenant") })
    .strict(),
  z
    .object({
      roleCode: z.string().min(1),
      scopeType: z.literal("legal_entity"),
      scopeLegalEntityId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      roleCode: z.string().min(1),
      scopeType: z.literal("organization_unit"),
      scopeOrganizationUnitId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      roleCode: z.string().min(1),
      scopeType: z.literal("customer"),
      scopeCustomerId: z.string().uuid(),
    })
    .strict(),
]);

// --- Epic 4 Wave 2: User and assignment bodies ----------------------------
// The pair vocabulary is the SAME one the Phase 11F single-assignment route
// uses, so an operator sees one shape on both surfaces. The vocabulary carries
// every scope family the repository understands — including customer scope,
// which the governed batch refuses (§4.4 E) because the repository is the
// authority on which scopes a batch may reach; narrowing here instead would
// move that refusal into a schema error and make the boundary depend on which
// route was called. `legal_entity` joined the vocabulary in Epic 5 G3.

const MAX_ASSIGNMENT_PAIRS = 50;
const MAX_FULL_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const MAX_HASH_LENGTH = 128;

const assignmentPairsSchema = z
  .array(assignRoleSchema)
  .min(1)
  .max(MAX_ASSIGNMENT_PAIRS)
  .superRefine((pairs, ctx) => {
    const keys = pairs.map(
      (pair) =>
        `${pair.roleCode}|${pair.scopeType}|${
          pair.scopeType === "tenant"
            ? ""
            : pair.scopeType === "legal_entity"
              ? pair.scopeLegalEntityId
              : pair.scopeType === "organization_unit"
                ? pair.scopeOrganizationUnitId
                : pair.scopeCustomerId
        }`,
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The same Role and scope may not appear twice in one batch",
      });
    }
  });

const previewUserAssignmentsSchema = z
  .object({ pairs: assignmentPairsSchema })
  .strict();

// Epic 4 Wave 3 step 18 — every revoke carries an operator reason. Bounded so
// the audit row cannot be used as free-form storage.
const MAX_REVOKE_REASON_LENGTH = 500;

const revokeAssignmentSchema = z
  .object({
    reason: z.string().trim().min(1).max(MAX_REVOKE_REASON_LENGTH),
  })
  .strict();

const confirmUserAssignmentsSchema = z
  .object({
    pairs: assignmentPairsSchema,
    previewHash: z.string().min(1).max(MAX_HASH_LENGTH),
    confirm: z.literal(true),
  })
  .strict();

const createGovernedUserSchema = z
  .object({
    email: z.string().email().max(MAX_EMAIL_LENGTH),
    fullName: z.string().min(1).max(MAX_FULL_NAME_LENGTH),
    password: z.string().min(8),
    // Step 11: the initial assignment is OPTIONAL — a User with none is valid
    // and has no effective access.
    pairs: z.array(assignRoleSchema).max(MAX_ASSIGNMENT_PAIRS).default([]),
  })
  .strict();

// --- Epic 4 Wave 1: Role definition bodies --------------------------------
// Every body is `.strict()`, every array and string bounded, and duplicate
// codes rejected before the request reaches the service.

const MAX_ROLE_CODE_LENGTH = 100;
const MAX_ROLE_NAME_LENGTH = 200;
const MAX_ROLE_DESCRIPTION_LENGTH = 500;
const MAX_GRANT_CODES = 500;
const MAX_WINDOWS = 500;
const MAX_INCLUDED_ROLES = 50;

const windowAccessSchema = z
  .object({
    windowCode: z.string().min(1).max(200),
    isReadWrite: z.boolean(),
    isActive: z.boolean(),
  })
  .strict();

function rejectDuplicates(
  value: {
    permissionCodes: string[];
    windows: { windowCode: string }[];
    includedRoleCodes: string[];
  },
  ctx: z.RefinementCtx,
) {
  if (new Set(value.permissionCodes).size !== value.permissionCodes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Duplicate permission codes are not allowed",
      path: ["permissionCodes"],
    });
  }
  const windowCodes = value.windows.map((w) => w.windowCode);
  if (new Set(windowCodes).size !== windowCodes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Duplicate window codes are not allowed",
      path: ["windows"],
    });
  }
  const includedCodes = value.includedRoleCodes;
  if (new Set(includedCodes).size !== includedCodes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Duplicate included role codes are not allowed",
      path: ["includedRoleCodes"],
    });
  }
}

const definitionFields = {
  name: z.string().min(1).max(MAX_ROLE_NAME_LENGTH),
  permissionCodes: z
    .array(z.string().min(1).max(MAX_ROLE_CODE_LENGTH))
    .max(MAX_GRANT_CODES),
  windows: z.array(windowAccessSchema).max(MAX_WINDOWS),
  includedRoleCodes: z
    .array(z.string().min(1).max(MAX_ROLE_CODE_LENGTH))
    .max(MAX_INCLUDED_ROLES)
    .default([]),
};

/** Epic 4 open item 1 — operator-authored Role metadata. `.nullable()` because
 * `null` (never had a description) is a fact the API preserves and never
 * flattens into `""`. The length cap matches the column's CHECK constraint, so
 * the database never sees a value the schema would have refused. */
const roleDescriptionSchema = z
  .string()
  .max(MAX_ROLE_DESCRIPTION_LENGTH)
  .nullable();

const createRoleDefinitionSchema = z
  .object({
    code: z.string().min(1).max(MAX_ROLE_CODE_LENGTH),
    description: roleDescriptionSchema.optional(),
    ...definitionFields,
  })
  .strict()
  .superRefine(rejectDuplicates);

const copyRoleDefinitionSchema = z
  .object({
    code: z.string().min(1).max(MAX_ROLE_CODE_LENGTH),
    name: z.string().min(1).max(MAX_ROLE_NAME_LENGTH),
    /** Omitted means "carry the source's description". */
    description: roleDescriptionSchema.optional(),
  })
  .strict();

// Preview and update state the WHOLE definition, so `description` is required
// here (nullable, not optional). Omitting it would otherwise clear the field
// silently — and because the preview hash deliberately covers only the
// authorization fields, nothing downstream would catch the accidental blank.
// A 400 is the honest failure; a quiet clear is not.
const previewRoleDefinitionSchema = z
  .object({
    version: z.number().int().positive(),
    description: roleDescriptionSchema,
    ...definitionFields,
  })
  .strict()
  .superRefine(rejectDuplicates);

const updateRoleDefinitionSchema = z
  .object({
    version: z.number().int().positive(),
    description: roleDescriptionSchema,
    ...definitionFields,
    previewHash: z.string().min(1).max(MAX_HASH_LENGTH),
    confirm: z.literal(true),
  })
  .strict()
  .superRefine(rejectDuplicates);

const setRoleActiveSchema = z
  .object({
    isActive: z.boolean(),
  })
  .strict();

/** Business Admin Console routes. Phase 11F adds only governed User Role
 * assignment access; all pre-existing Phase 11C reads remain unchanged. */
export function registerAdminConsoleRoutes(
  app: FastifyInstance,
  container: Container,
) {
  const svc = () => container.adminConsole;

  app.get(
    "/admin/overview",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().getOverview(request.actor!));
    },
  );

  app.get(
    "/admin/roles",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listRoles(request.actor!));
    },
  );

  app.get(
    "/admin/permissions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listPermissions(request.actor!));
    },
  );

  app.get(
    "/admin/modules",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listModules(request.actor!));
    },
  );

  app.get(
    "/admin/workflows",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listWorkflows(request.actor!));
    },
  );

  app.get(
    "/admin/audit/recent",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listRecentAudit(request.actor!));
    },
  );

  // Phase 11F governed access surface: exactly two reads and two writes.
  app.get(
    "/admin/users",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listUserAccess(request.actor!));
    },
  );

  app.get(
    "/admin/roles/:roleCode/permissions",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { roleCode } = roleCodeParamsSchema.parse(request.params);
      return reply.send(
        await svc().getRolePermissions(request.actor!, roleCode),
      );
    },
  );

  app.post(
    "/admin/users/:userId/role-assignments",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { userId } = userParamsSchema.parse(request.params);
      const body = assignRoleSchema.parse(request.body);
      const assignment = await svc().assignUserRole(
        request.actor!,
        userId,
        body,
      );
      return reply.status(201).send(assignment);
    },
  );

  // Epic 4 Wave 3 step 18 — revoke is a governed state transition, not a
  // delete: the row is retained for history, so the verb is POST with a
  // reason. The reason is mandatory (§4.4 open item #3, settled for this
  // surface: every revoke carries an operator explanation).
  app.post(
    "/admin/users/:userId/role-assignments/:assignmentId/revoke",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { userId, assignmentId } = assignmentParamsSchema.parse(
        request.params,
      );
      const body = revokeAssignmentSchema.parse(request.body);
      await svc().revokeUserRole(
        request.actor!,
        userId,
        assignmentId,
        body.reason,
      );
      return reply.status(204).send();
    },
  );

  // --- Epic 4 Wave 2: User and assignment surfaces -------------------------
  // Two surfaces (§4.4 steps 12 and 13) over the same service and the same
  // repository policy, so neither can be stronger merely because its route
  // differs (§4.4 D). Order matters: Fastify resolves `/admin/users/:userId`
  // and `/admin/users/:userId/access` as distinct static tails, and
  // `/admin/assignments` is a sibling of `/admin/users`, not a suffix of it.

  app.get(
    "/admin/users/:userId/access",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { userId } = userParamsSchema.parse(request.params);
      return reply.send(await svc().getUserAccess(request.actor!, userId));
    },
  );

  app.get(
    "/admin/assignments",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listAdminAssignments(request.actor!));
    },
  );

  app.get(
    "/admin/assignment-options",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().assignmentOptions(request.actor!));
    },
  );

  app.post(
    "/admin/users/:userId/assignment-previews",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { userId } = userParamsSchema.parse(request.params);
      const body = previewUserAssignmentsSchema.parse(request.body);
      return reply.send(
        await svc().previewUserAssignments(request.actor!, userId, body),
      );
    },
  );

  app.post(
    "/admin/users/:userId/assignment-batches",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { userId } = userParamsSchema.parse(request.params);
      const body = confirmUserAssignmentsSchema.parse(request.body);
      return reply
        .status(201)
        .send(await svc().confirmUserAssignments(request.actor!, userId, body));
    },
  );

  app.post(
    "/admin/users",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = createGovernedUserSchema.parse(request.body);
      return reply
        .status(201)
        .send(await svc().createUserWithAssignments(request.actor!, body));
    },
  );

  // --- Epic 4 Wave 1: Role definition routes ------------------------------
  // `GET /admin/roles/permissions` stays absent (registered nowhere) so it
  // continues to 404; the definition resource is a distinct path.

  app.get(
    "/admin/roles/:roleCode/definition",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { roleCode } = roleCodeParamsSchema.parse(request.params);
      return reply.send(
        await svc().getRoleDefinition(request.actor!, roleCode),
      );
    },
  );

  app.get(
    "/admin/role-definition-options",
    { preHandler: app.authenticate },
    async (request, reply) => {
      return reply.send(await svc().listRoleDefinitionOptions(request.actor!));
    },
  );

  app.post(
    "/admin/roles",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = createRoleDefinitionSchema.parse(request.body);
      return reply
        .status(201)
        .send(await svc().createRoleDefinition(request.actor!, body));
    },
  );

  app.post(
    "/admin/roles/:roleCode/copy",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { roleCode } = roleCodeParamsSchema.parse(request.params);
      const body = copyRoleDefinitionSchema.parse(request.body);
      return reply
        .status(201)
        .send(await svc().copyRoleDefinition(request.actor!, roleCode, body));
    },
  );

  app.post(
    "/admin/roles/:roleCode/preview",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { roleCode } = roleCodeParamsSchema.parse(request.params);
      const body = previewRoleDefinitionSchema.parse(request.body);
      return reply.send(
        await svc().previewRoleDefinition(request.actor!, roleCode, body),
      );
    },
  );

  app.put(
    "/admin/roles/:roleCode/definition",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { roleCode } = roleCodeParamsSchema.parse(request.params);
      const body = updateRoleDefinitionSchema.parse(request.body);
      return reply.send(
        await svc().updateRoleDefinition(request.actor!, roleCode, body),
      );
    },
  );

  app.delete(
    "/admin/roles/:roleCode/definition",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { roleCode } = roleCodeParamsSchema.parse(request.params);
      await svc().deleteRoleDefinition(request.actor!, roleCode);
      return reply.status(204).send();
    },
  );

  // Epic 4 open item 2 — one route for both directions, because a Role's
  // lifecycle state is a single fact, not two independent ones. Deactivation is
  // refused (409) while any live assignment still references the Role;
  // activation has no precondition beyond the write authority.
  app.post(
    "/admin/roles/:roleCode/active-state",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { roleCode } = roleCodeParamsSchema.parse(request.params);
      const { isActive } = setRoleActiveSchema.parse(request.body);
      return reply.send(
        await svc().setRoleDefinitionActive(
          request.actor!,
          roleCode,
          isActive,
        ),
      );
    },
  );
}
