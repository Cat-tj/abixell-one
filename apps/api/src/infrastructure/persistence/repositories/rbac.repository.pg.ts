import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AdminRoleAssignmentSummary,
  AdminUserAccessSummary,
  AdminAssignmentRow,
  AssignmentOptions,
  AssignmentRoleOption,
  AssignmentScopeLegalEntityOption,
  AssignmentScopeUnitOption,
  AssignmentBatchResult,
  CreateGovernedUserInput,
  GovernedUserSummary,
  AssignRoleInput,
  CopyRoleDefinitionInput,
  CreateRoleDefinitionInput,
  GovernedRoleAssignmentInput,
  MyRoleAssignment,
  Permission,
  PermissionOption,
  PreviewRoleAssignmentsInput,
  RbacRepository,
  Role,
  RoleDefinition,
  RoleDefinitionOptions,
  RoleDefinitionPreview,
  RoleDefinitionPreviewInput,
  RolePermissionDetail,
  RoleSummary,
  ScopeType,
  UpdateRoleAssignmentsInput,
  UpdateRoleDefinitionInput,
  UserRoleAssignment,
  WindowAccessInput,
  WindowOption,
  GovernedActor,
} from "../../../domain/rbac/rbac.entity.js";
import type {
  AdministrativeVisibility,
  AssignmentBatchPreview,
  AssignmentPairSummary,
} from "../../../domain/rbac/visibility-scope.js";
import { computeAssignmentBatchHash } from "../../../domain/rbac/visibility-scope.js";
import { attributePermission } from "../../../domain/configuration/module-attribution.js";
import { hashPassword } from "../../security/password.js";
import { resolveRouteEntry } from "../../../domain/configuration/route-registry.js";
import { windowEnforcementStatus } from "../../../domain/configuration/window-enforcement.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../domain/shared-kernel/errors.js";

const USER_ROLE_MANAGE = "user.role.manage";
const ROLE_MANAGE = "role.manage";
const CONFIG_READ = "config.read";
const ADMIN_CONSOLE_READ = "admin.console.read";
const UNIQUE_VIOLATION = "23505";
/** The customer-scope exclusivity trigger's own constraint name. A BEFORE
 * trigger raises with this CONSTRAINT, so the write path can recognise it the
 * same way it recognises the exact-assignment unique index. */
const SCOPE_EXCLUSIVITY_CONSTRAINT =
  "user_role_assignments_scope_exclusivity_check";
/** The Segregation of Duties trigger's constraint name (WP-APR-03). A BEFORE
 * trigger raises with this CONSTRAINT + ERRCODE 23514, so every assignment
 * write path can map a violation to a 409 instead of a raw 500. */
const SOD_VIOLATION_CONSTRAINT = "user_role_assignments_sod_violation_check";
/** SoD violation message, shared across all assignment write paths so the
 * client gets one consistent 409 regardless of which surface tripped the
 * trigger. */
const SOD_VIOLATION_MESSAGE =
  "This role combination is forbidden by a Segregation of Duties rule in this tenant";

/** Permissions whose combined presence defines Role Definition authority.
 * Removing any of them from a Role is the class of edit that can strand a
 * tenant or strip the actor's own management power, so §4.4 F protects the
 * post-change authority shape here. */
const ROLE_DEFINITION_AUTHORITY_PERMISSIONS = [
  ADMIN_CONSOLE_READ,
  CONFIG_READ,
  ROLE_MANAGE,
] as const;

/** §4.4 decision 2 — the Service Operation permission set governed by the
 * customer-scope ceiling. Only these eight are bounded: permissions from
 * other modules (customer.read, contract.read, project.read, site.read,
 * service.read) are what the Customer User portal is built on, and reading
 * a customer's own row is not what this ceiling bounds. */
/** Message for scope exclusivity, shared by the pre-check and the trigger
 * backstop so the client cannot tell which one refused. */
const SCOPE_EXCLUSIVITY_MESSAGE =
  "A User may not hold customer-scope and internal assignments at the same time";

/** §4.4 decision 6 — customer scope never coexists with tenant or
 * organization-unit scope for one user. The trigger
 * (user_role_assignments_customer_scope_exclusivity) enforces it in the
 * database; this pre-check gives the write path a clean 409 with the same
 * message instead of a raw trigger error surfacing as a 500, and is the
 * race backstop's counterpart, not its replacement. Only LIVE rows
 * conflict: a revoked or invalidated grant grants nothing. */
async function assertNoScopeExclusivityConflict(
  client: { query: PoolClient["query"] },
  targetUserId: string,
  scopeType: ScopeType,
): Promise<void> {
  const conflicting = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
              SELECT 1
                FROM user_role_assignments ura
               WHERE ura.user_id = $1
                 AND ura.scope_invalidated_at IS NULL
                 AND ura.revoked_at IS NULL
                 AND ura.scope_type ${scopeType === "customer" ? "<>" : "="} 'customer'
           ) AS exists`,
    [targetUserId],
  );
  if (conflicting.rows[0]?.exists) {
    throw new ConflictError(SCOPE_EXCLUSIVITY_MESSAGE);
  }
}

/** The default customer-scope ceiling: exactly these two Service Operation
 * permissions are grantable at customer scope while the flag is off, and the
 * other six are refused. Decision 2's "default read ceiling" is the pair, not
 * the whole module, so this list is the allowlist and the list below is the
 * governed set it is drawn from. */
const CUSTOMER_SCOPE_DEFAULT_PERMISSION_CODES: readonly string[] = [
  "service_operations.read",
  "service_operations.optimization.read",
];

/** Every Service Operation permission the ceiling governs. A code in this set
 * that is NOT in the default allowlist is refused at customer scope while the
 * flag is off. Permissions from other modules (customer.read, contract.read,
 * project.read, site.read, service.read) are never bounded here. */
const CUSTOMER_SCOPE_SERVICE_OPERATION_PERMISSION_CODES: readonly string[] = [
  "service_operations.read",
  "service_operations.optimization.read",
  "service_operations.manage",
  "service_operations.execute",
  "service_operations.configure",
  "service_operations.verify",
  "service_operations.pack.manage",
  "service_operations.optimization.apply",
];

/** Registration statuses under which a window is a real, addressable surface.
 * `belum_terdaftar` is reported by the guard but is not lockable (§4.2/§4.3). */
const REGISTERED_WINDOW_STATUSES = ["di_menu", "tersembunyi"] as const;

/** The wildcard registry entry is stored as a route window row but is a
 * deliberate non-match at runtime and must never become a grantable window. */
const WILDCARD_WINDOW_CODE = "route:*";

const WINDOW_CODE_PREFIX = "route:";

/** Deterministic content address for a proposed Role definition. The commit
 * path recomputes it from the definition the server is about to write, so a
 * preview approved against one set of grants can never be applied to another.
 *
 * Deliberately covers the DEFINITION only. Assignments may legitimately move
 * between preview and commit (§4.4 B); the commit revalidates authority and
 * protection rules anyway and records the ACTUAL affected-user count to the
 * audit trail, so assignment drift is reported there, never turned into a
 * 409. */
function computeDefinitionHash(
  name: string,
  permissionCodes: string[],
  windows: WindowAccessInput[],
): string {
  const canonical = {
    name,
    permissionCodes: [...new Set(permissionCodes)].sort(),
    windows: [...windows]
      .map((w) => ({
        windowCode: w.windowCode,
        isReadWrite: w.isReadWrite,
        isActive: w.isActive,
      }))
      .sort((a, b) =>
        a.windowCode < b.windowCode ? -1 : a.windowCode > b.windowCode ? 1 : 0,
      ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Sorted-array equality. Both sides are produced sorted (validateProposed*
 * sorts its output; loadRoleDefinition orders its SQL), so elementwise
 * comparison is enough for the no-op detection in updateRoleDefinition. */
function sameStringArrays(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Same rule for window rows; both sides are sorted by windowCode. */
function sameWindows(
  a: readonly WindowAccessInput[],
  b: readonly WindowAccessInput[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (w, index) =>
        w.windowCode === b[index].windowCode &&
        w.isReadWrite === b[index].isReadWrite &&
        w.isActive === b[index].isActive,
    )
  );
}

/** Derive whether a window is a detail/tool page from the canonical route
 * registry's `parentPath`, never from its status and never from a `.manage`
 * string in the permission list. */
function isDetailWindow(windowCode: string): boolean {
  if (!windowCode.startsWith(WINDOW_CODE_PREFIX)) return false;
  const entry = resolveRouteEntry(windowCode.slice(WINDOW_CODE_PREFIX.length));
  return entry?.parentPath !== undefined;
}

/** `pg` hands back `timestamptz` as a JS Date while the projection is typed as
 * an ISO string; normalize here so an INSERT's RETURNING and a later SELECT
 * describe the same moment the same way. */
function toIsoStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapAdminAssignment(
  row: Record<string, unknown>,
): AdminRoleAssignmentSummary {
  return {
    id: row.id as string,
    roleState: row.role_state as AdminRoleAssignmentSummary["roleState"],
    roleCode: (row.role_code as string | null) ?? null,
    roleName: (row.role_name as string | null) ?? null,
    scopeType: row.scope_type as AdminRoleAssignmentSummary["scopeType"],
    scopeState: row.scope_state as AdminRoleAssignmentSummary["scopeState"],
    scopeLegalEntityId: (row.scope_legal_entity_id as string | null) ?? null,
    scopeLegalEntityName: (row.scope_legal_entity_name as string | null) ?? null,
    scopeOrganizationUnitId:
      (row.scope_organization_unit_id as string | null) ?? null,
    scopeOrganizationUnitName:
      (row.scope_organization_unit_name as string | null) ?? null,
    scopeCustomerId: (row.scope_customer_id as string | null) ?? null,
    scopeCustomerName: (row.scope_customer_name as string | null) ?? null,
    assignmentState: assignmentLifecycleState(row),
    assignedAt: toIsoStringOrNull(row.created_at),
    assignedBy: (row.created_by as string | null) ?? null,
    revokedAt: toIsoStringOrNull(row.revoked_at),
    revokedBy: (row.revoked_by as string | null) ?? null,
    revokeReason: (row.revoke_reason as string | null) ?? null,
  };
}

/** Epic 4 Wave 3 step 20 — the row lifecycle, kept separate from role/scope
 * availability: a manual revoke (`revoked_at`) and a system invalidation
 * (`scope_invalidated_at`) are different events with different provenance.
 * Rows written before this projection existed (or by the batch writer's
 * RETURNING, which has no lifecycle columns) lack both timestamps and read as
 * `active` unless their role/scope is unavailable. */
function assignmentLifecycleState(
  row: Record<string, unknown>,
): AdminRoleAssignmentSummary["assignmentState"] {
  if (row.revoked_at != null) return "revoked";
  if (row.scope_invalidated_at != null) return "invalidated";
  if (row.role_state !== "available" || row.scope_state !== "available") {
    return "unavailable";
  }
  return "active";
}

/** The actor's own Organization Unit anchors for one permission, unexpanded.
 * Module-level so both the transaction-scoped and pool-scoped callers ask the
 * same question (§4.4 E: the hierarchy rule exists in exactly one place).
 *
 * Epic 1 (§4.1 C): pinned to the SESSION'S ACTIVE assignment. An admin who
 * switched into a Customer-context Role must not keep region-admin visibility
 * through an Organization-Unit Role they are no longer working as.
 *
 * Epic 5 G3: a `legal_entity` assignment's anchors are EVERY Organization
 * Unit of that Legal Entity — the anchors exist to be expanded downward, and
 * "everything in this Legal Entity" is exactly that set. The caller expands
 * them once more with `listOrganizationUnitSubtreeIdsIn` (a no-op for units
 * that are already leaves), so both scope families flow through the one
 * expansion ADR-0009 established. */
async function listActorOrganizationUnitAnchorsIn(
  client: Pool | PoolClient,
  tenantId: string,
  assignmentId: string | null,
  permissionCode: string,
): Promise<string[]> {
  if (assignmentId === null) return [];
  const result = await client.query<{ id: string }>(
    `SELECT DISTINCT anchor_id AS id
       FROM (
         SELECT aura.scope_organization_unit_id AS anchor_id
           FROM authorization_effective_user_role_assignments aura
           JOIN role_permissions rp ON rp.role_id = aura.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE aura.tenant_id = $1
            AND aura.id = $2
            AND aura.scope_type = 'organization_unit'
            AND aura.scope_organization_unit_id IS NOT NULL
            AND p.code = $3
         UNION
         SELECT ou.id AS anchor_id
           FROM authorization_effective_user_role_assignments aura
           JOIN role_permissions rp ON rp.role_id = aura.role_id
           JOIN permissions p ON p.id = rp.permission_id
           JOIN organization_units ou
             ON ou.legal_entity_id = aura.scope_legal_entity_id
            AND ou.tenant_id = aura.tenant_id
            AND ou.deleted_at IS NULL
          WHERE aura.tenant_id = $1
            AND aura.id = $2
            AND aura.scope_type = 'legal_entity'
            AND aura.scope_legal_entity_id IS NOT NULL
            AND p.code = $3
       ) anchors
      ORDER BY id`,
    [tenantId, assignmentId, permissionCode],
  );
  return result.rows.map((row) => row.id);
}

/** Downward `parent_id` walk (ADR-0009 hierarchical Data Scope): an authority
 * on a unit covers every unit beneath it. `UNION` rather than `UNION ALL` so a
 * cycle cannot turn into an infinite scan. */
async function listOrganizationUnitSubtreeIdsIn(
  client: Pool | PoolClient,
  tenantId: string,
  rootOrganizationUnitIds: readonly string[],
): Promise<string[]> {
  const roots = [...new Set(rootOrganizationUnitIds)];
  if (roots.length === 0) return [];
  const result = await client.query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id
         FROM organization_units
        WHERE tenant_id = $1
          AND id = ANY($2::uuid[])
          AND deleted_at IS NULL
       UNION
       SELECT child.id
         FROM organization_units child
         JOIN subtree parent ON child.parent_id = parent.id
        WHERE child.tenant_id = $1
          AND child.deleted_at IS NULL
     )
     SELECT id FROM subtree ORDER BY id`,
    [tenantId, roots],
  );
  return result.rows.map((row) => row.id);
}

/** Epic 5 G3 — every live Organization Unit inside one Legal Entity. The
 * downward half of the coverage chain tenant → Legal Entity → Organization
 * Unit (§4.5 principle 9): a `legal_entity` assignment covers all of these,
 * which is why the administrative visibility, the assignment picker and the
 * delegation check all read this one query instead of restating the rule.
 * `deleted_at IS NULL` is the same availability filter the subtree walk and
 * the product's other scope queries use; lifecycle state is decided by the
 * authorization projection, not here. */
async function listOrganizationUnitIdsForLegalEntityIn(
  client: Pool | PoolClient,
  tenantId: string,
  legalEntityId: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM organization_units
      WHERE tenant_id = $1
        AND legal_entity_id = $2
        AND deleted_at IS NULL
      ORDER BY id`,
    [tenantId, legalEntityId],
  );
  return result.rows.map((row) => row.id);
}

/** Same-assignment visibility (§4.4 risk row 3): only an assignment that
 * ALREADY CARRIES `permissionCode` may contribute scope. A tenant-wide grant
 * therefore has to carry the permission itself — the aggregate-token
 * regression pins exactly that.
 *
 * Epic 1 (§4.1 C): the single contributing assignment is the session's
 * ACTIVE one, named by `assignmentId`. A tenant-wide admin visibility a user
 * holds only through a switched-away Role is invisible here. */
async function resolveAdministrativeVisibilityIn(
  client: Pool | PoolClient,
  actor: GovernedActor,
  permissionCode: string,
): Promise<AdministrativeVisibility> {
  if (actor.assignmentId === null) return { kind: "units", organizationUnitIds: [] };
  const tenantScope = await client.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM authorization_effective_user_role_assignments aura
         JOIN role_permissions rp ON rp.role_id = aura.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE aura.tenant_id = $1
          AND aura.id = $2
          AND aura.scope_type = 'tenant'
          AND aura.scope_organization_unit_id IS NULL
          AND aura.scope_customer_id IS NULL
          AND p.code = $3
     ) AS allowed`,
    [actor.tenantId, actor.assignmentId, permissionCode],
  );
  if (tenantScope.rows[0]?.allowed === true) return { kind: "tenant" };

  const anchors = await listActorOrganizationUnitAnchorsIn(
    client,
    actor.tenantId,
    actor.assignmentId,
    permissionCode,
  );
  return {
    kind: "units",
    organizationUnitIds: await listOrganizationUnitSubtreeIdsIn(
      client,
      actor.tenantId,
      anchors,
    ),
  };
}

/** Visibility, or a refusal. An empty `units` list is NO authority, not a
 * narrow one, and the two must not look alike: returning an empty page would
 * tell an actor "there are no Users here" when the truth is "you may not ask".
 * §4.4 H step 3 puts this before any target resolution. */
async function requireAdministrativeVisibilityIn(
  client: Pool | PoolClient,
  actor: GovernedActor,
  permissionCode: string,
): Promise<AdministrativeVisibility> {
  const visibility = await resolveAdministrativeVisibilityIn(
    client,
    actor,
    permissionCode,
  );
  if (visibility.kind === "units" && visibility.organizationUnitIds.length === 0) {
    throw new ForbiddenError(
      `Missing permission or Data Scope for '${permissionCode}'`,
    );
  }
  return visibility;
}

/** Is `user` inside `visibility`? The same predicate the list read applies in
 * SQL (§4.4 step 16), asked here about one target so a write cannot reach a
 * User the read could not show. Only live Organization Unit assignments
 * count; a `customer` assignment confers no internal-User visibility. */
function isUserWithinVisibility(
  visibility: AdministrativeVisibility,
  organizationUnitIds: readonly (string | null)[],
): boolean {
  if (visibility.kind === "tenant") return true;
  const visible = new Set(visibility.organizationUnitIds);
  return organizationUnitIds.some((id) => id !== null && visible.has(id));
}

/** A pair's identity, matching the `NULLS NOT DISTINCT` comparison the unique
 * index uses. Used both to reject a repeated pair inside one request and to
 * match an `INSERT ... RETURNING` row back to the pair that produced it. */
function assignmentKey(
  roleId: string,
  scopeType: string,
  scopeId: string | null,
): string {
  return `${roleId}|${scopeType}|${scopeId ?? ""}`;
}

/** The scope target of one PROPOSED pair, whichever family it belongs to. Each
 * family stores its target in its own column, so "the target of this pair"
 * has to be asked once, in one place: the batch writer keys its pairs and its
 * `RETURNING` rows by the same triple, and a family that fell through to the
 * wrong column would silently pair two grants with the wrong summaries. */
function pairScopeId(pair: GovernedRoleAssignmentInput): string | null {
  switch (pair.scopeType) {
    case "tenant":
      return null;
    case "legal_entity":
      return pair.scopeLegalEntityId;
    case "organization_unit":
      return pair.scopeOrganizationUnitId;
    case "customer":
      return pair.scopeCustomerId;
  }
}

/** The same question asked of an inserted/reloaded row. */
function rowScopeId(row: Record<string, unknown>): string | null {
  switch (row.scope_type as string) {
    case "legal_entity":
      return (row.scope_legal_entity_id as string | null) ?? null;
    case "organization_unit":
      return (row.scope_organization_unit_id as string | null) ?? null;
    case "customer":
      return (row.scope_customer_id as string | null) ?? null;
    default:
      return null;
  }
}

/**
 * §4.4 C: one batch is one transaction and one confirmation, so a pair repeated
 * inside the request is a malformed request — not a pair to be silently
 * deduplicated. Deduplication would also change the set the preview addressed,
 * which is exactly what `previewHash` exists to prevent.
 */
function normalizeAssignmentPairs(
  pairs: readonly GovernedRoleAssignmentInput[],
): GovernedRoleAssignmentInput[] {
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = assignmentKey(pair.roleCode, pair.scopeType, pairScopeId(pair));
    if (seen.has(key)) {
      throw new ValidationError(
        `Duplicate assignment pair for Role '${pair.roleCode}' and the same scope`,
      );
    }
    seen.add(key);
  }
  return [...pairs];
}

/** One joined access-projection row → the public assignment shape. Extracted
 * so the User-centric read, the assignment-centric read, and the batch writer
 * cannot drift apart in what they project. */
function projectAdminAssignment(
  row: Record<string, unknown>,
): AdminRoleAssignmentSummary {
  return mapAdminAssignment({
    id: row.assignment_id,
    role_state: row.role_state,
    role_code: row.role_code,
    role_name: row.role_name,
    scope_type: row.scope_type,
    scope_state: row.scope_state,
    scope_legal_entity_id: row.scope_legal_entity_id,
    scope_legal_entity_name: row.scope_legal_entity_name,
    scope_organization_unit_id: row.scope_organization_unit_id,
    scope_organization_unit_name: row.scope_organization_unit_name,
    scope_customer_id: row.scope_customer_id,
    scope_customer_name: row.scope_customer_name,
    scope_invalidated_at: row.scope_invalidated_at,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    revoke_reason: row.revoke_reason,
    created_at: row.created_at,
    created_by: row.created_by,
  });
}

/** §4.4 D "satu audit batch": the whole confirmed batch is one audit event
 * carrying every pair, so an operator reads one line per confirmation rather
 * than reconstructing the batch from timestamps. */
async function recordAssignmentBatchAudit(
  client: PoolClient,
  input: {
    tenantId: string;
    actorUserId: string;
    targetUserId: string;
    pairs: readonly AssignmentPairSummary[];
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'user.role_assigned', 'user', $3, $4::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.targetUserId,
      JSON.stringify({
        targetUserId: input.targetUserId,
        batchSize: input.pairs.length,
        pairs: input.pairs.map((pair) => ({
          roleCode: pair.roleCode,
          scopeType: pair.scopeType,
          scopeOrganizationUnitId: pair.scopeOrganizationUnitId,
          scopeCustomerId: pair.scopeCustomerId,
        })),
      }),
    ],
  );
}

/** The lifecycle half of an assignment, shaped for the audit payload. Role and
 * scope identity live at the top level of the same event; this carries only
 * what changed, so `before` and `after` read as one transition. */
function auditLifecycleSnapshot(assignment: AdminRoleAssignmentSummary) {
  return {
    status: assignment.assignmentState,
    revokedAt: assignment.revokedAt,
    revokedBy: assignment.revokedBy,
    revokeReason: assignment.revokeReason,
  };
}

export class PgRbacRepository implements RbacRepository {
  constructor(private readonly pool: Pool) {}

  async listRoleSummaries(tenantId: string): Promise<RoleSummary[]> {
    // Phase 11C — Business Admin Console. Counted with correlated subqueries
    // rather than JOIN + GROUP BY so the two counts stay independent: a JOIN
    // across both role_permissions and user_role_assignments would multiply
    // the rows and inflate each count by the other's cardinality. The assigned
    // user count is retained administrative inventory, not effective access;
    // authorization decisions use the effective-assignment view instead.
    const result = await this.pool.query(
      `SELECT r.id,
              r.code,
              r.name,
              r.description,
              r.is_active,
              COALESCE(r.is_full_access, false) AS is_full_access,
              (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id)::int
                AS permission_count,
              (SELECT COUNT(DISTINCT ura.user_id)
                 FROM user_role_assignments ura
                 JOIN users u ON u.id = ura.user_id
                WHERE ura.role_id = r.id
                  AND u.tenant_id = r.tenant_id
                  AND u.deleted_at IS NULL)::int
                AS assigned_user_count
         FROM roles r
        WHERE r.tenant_id = $1
        ORDER BY r.code`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      isActive: row.is_active,
      isFullAccess: row.is_full_access,
      permissionCount: row.permission_count,
      assignedUserCount: row.assigned_user_count,
    }));
  }

  async listPermissionCatalog(): Promise<Permission[]> {
    const result = await this.pool.query(
      `SELECT code, description FROM permissions ORDER BY code`,
    );
    return result.rows.map((row) => ({
      code: row.code,
      description: row.description,
    }));
  }

  async hasPermissionSetOnSameAssignment(
    userId: string,
    permissionCodes: readonly string[],
  ): Promise<boolean> {
    const requiredCodes = [...new Set(permissionCodes)];
    if (requiredCodes.length === 0) return true;

    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM authorization_effective_user_role_assignments aura
           JOIN role_permissions rp ON rp.role_id = aura.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE aura.user_id = $1
            AND p.code = ANY($2::text[])
          GROUP BY aura.id
         HAVING COUNT(DISTINCT p.code) = $3
       ) AS allowed`,
      [userId, requiredCodes, requiredCodes.length],
    );
    return result.rows[0]?.allowed === true;
  }

  async hasTenantScopedPermission(
    tenantId: string,
    userId: string,
    permissionCode: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM authorization_effective_user_role_assignments aura
           JOIN role_permissions rp ON rp.role_id = aura.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE aura.user_id = $2
            AND aura.tenant_id = $1
            AND aura.scope_type = 'tenant'
            AND aura.scope_organization_unit_id IS NULL
            AND aura.scope_customer_id IS NULL
            AND p.code = $3
       ) AS allowed`,
      [tenantId, userId, permissionCode],
    );
    return result.rows[0]?.allowed === true;
  }

  async hasPermissionSetForAssignment(
    tenantId: string,
    assignmentId: string | null,
    permissionCodes: readonly string[],
  ): Promise<boolean> {
    const requiredCodes = [...new Set(permissionCodes)];
    if (requiredCodes.length === 0) return true;
    if (assignmentId === null) return false;
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM authorization_effective_user_role_assignments aura
           JOIN role_permissions rp ON rp.role_id = aura.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE aura.tenant_id = $1
            AND aura.id = $2
            AND p.code = ANY($3::text[])
          GROUP BY aura.id
         HAVING COUNT(DISTINCT p.code) = $4
       ) AS allowed`,
      [tenantId, assignmentId, requiredCodes, requiredCodes.length],
    );
    return result.rows[0]?.allowed === true;
  }

  async hasTenantScopedPermissionForAssignment(
    tenantId: string,
    assignmentId: string | null,
    permissionCode: string,
  ): Promise<boolean> {
    if (assignmentId === null) return false;
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM authorization_effective_user_role_assignments aura
           JOIN role_permissions rp ON rp.role_id = aura.role_id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE aura.id = $2
            AND aura.tenant_id = $1
            AND aura.scope_type = 'tenant'
            AND aura.scope_organization_unit_id IS NULL
            AND aura.scope_customer_id IS NULL
            AND p.code = $3
       ) AS allowed`,
      [tenantId, assignmentId, permissionCode],
    );
    return result.rows[0]?.allowed === true;
  }

  /**
   * Epic 4 step 11b — the Window lock read, for one actor and one Window.
   *
   * Anchored on `authorization_effective_user_role_assignments` for the same
   * reason every other predicate here is: an assignment whose scope was
   * invalidated, whose Role was revoked, or whose User is inactive or deleted
   * must not confer a write. Reading `user_role_assignments` directly would
   * let a revoked Role keep writing until the next login.
   *
   * One query, two answers, so the caller cannot observe a state the database
   * never had. `configured` and `writable` are aggregated over the same row
   * set: a Window with no configured Role stays outside the lock entirely
   * (absence is not read-only), and a single writable, active assignment is
   * enough however many read-only ones the user also holds (union allow).
   *
   * `scope_type` is deliberately not filtered here, unlike the tenant-scope
   * permission predicates above. The Window lock is a per-Window mode, not a
   * data-scope grant; the scope layer is a separate question answered
   * elsewhere, and intersecting them here would silently narrow the lock.
   */
  async getWindowAccessState(
    tenantId: string,
    userId: string,
    windowCode: string,
  ): Promise<{ configured: boolean; writable: boolean }> {
    const result = await this.pool.query(
      `SELECT COUNT(*) > 0 AS configured,
              COALESCE(BOOL_OR(rwa.is_read_write AND rwa.is_active), false) AS writable
         FROM authorization_effective_user_role_assignments aura
         JOIN role_window_access rwa
           ON rwa.tenant_id = aura.tenant_id
          AND rwa.role_id = aura.role_id
        WHERE aura.user_id = $2
          AND aura.tenant_id = $1
          AND rwa.window_code = $3`,
      [tenantId, userId, windowCode],
    );
    return {
      configured: result.rows[0]?.configured === true,
      writable: result.rows[0]?.writable === true,
    };
  }

  async getWindowAccessStateForAssignment(
    tenantId: string,
    assignmentId: string | null,
    windowCode: string,
  ): Promise<{ configured: boolean; writable: boolean }> {
    if (assignmentId === null) return { configured: false, writable: false };
    const result = await this.pool.query(
      `SELECT COUNT(*) > 0 AS configured,
              COALESCE(BOOL_OR(rwa.is_read_write AND rwa.is_active), false) AS writable
         FROM authorization_effective_user_role_assignments aura
         JOIN role_window_access rwa
           ON rwa.tenant_id = aura.tenant_id
          AND rwa.role_id = aura.role_id
        WHERE aura.tenant_id = $1
          AND aura.id = $2
          AND rwa.window_code = $3`,
      [tenantId, assignmentId, windowCode],
    );
    return {
      configured: result.rows[0]?.configured === true,
      writable: result.rows[0]?.writable === true,
    };
  }

  async getAssignmentsWithPermission(
    userId: string,
    permissionCode: string,
  ): Promise<UserRoleAssignment[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT aura.id, aura.user_id, aura.role_id, r.code AS role_code,
              aura.scope_type, aura.scope_legal_entity_id,
              aura.scope_organization_unit_id, aura.scope_customer_id
         FROM authorization_effective_user_role_assignments aura
         JOIN roles r ON r.id = aura.role_id
         JOIN role_permissions rp ON rp.role_id = aura.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE aura.user_id = $1 AND p.code = $2`,
      [userId, permissionCode],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      roleId: row.role_id,
      roleCode: row.role_code,
      scopeType: row.scope_type,
      scopeLegalEntityId: row.scope_legal_entity_id,
      scopeOrganizationUnitId: row.scope_organization_unit_id,
      scopeCustomerId: row.scope_customer_id,
    }));
  }

  async listAdminUserAccess(
    tenantId: string,
    visibility: AdministrativeVisibility,
  ): Promise<AdminUserAccessSummary[]> {
    const rows = await this.listAdminUserAccessRows(tenantId, visibility);
    return this.mapAdminUserAccessRows(rows);
  }

  async getAdminUserAccess(
    tenantId: string,
    userId: string,
    visibility: AdministrativeVisibility,
  ): Promise<AdminUserAccessSummary | null> {
    const rows = await this.listAdminUserAccessRows(tenantId, visibility, userId);
    return this.mapAdminUserAccessRows(rows)[0] ?? null;
  }

  async listOrganizationUnitSubtreeIds(
    tenantId: string,
    rootOrganizationUnitIds: readonly string[],
  ): Promise<string[]> {
    return listOrganizationUnitSubtreeIdsIn(this.pool, tenantId, rootOrganizationUnitIds);
  }

  async listOrganizationUnitIdsForLegalEntity(
    tenantId: string,
    legalEntityId: string,
  ): Promise<string[]> {
    return listOrganizationUnitIdsForLegalEntityIn(this.pool, tenantId, legalEntityId);
  }

  async listActorOrganizationUnitAnchors(
    actor: GovernedActor,
    permissionCode: string,
  ): Promise<string[]> {
    return listActorOrganizationUnitAnchorsIn(
      this.pool,
      actor.tenantId,
      actor.assignmentId,
      permissionCode,
    );
  }

  async resolveAdministrativeVisibility(
    actor: GovernedActor,
    permissionCode: string,
  ): Promise<AdministrativeVisibility> {
    return resolveAdministrativeVisibilityIn(
      this.pool,
      actor,
      permissionCode,
    );
  }

  async listAdminAssignments(
    tenantId: string,
    visibility: AdministrativeVisibility,
  ): Promise<AdminAssignmentRow[]> {
    const rows = await this.listAdminUserAccessRows(tenantId, visibility);
    return rows
      .filter((row) => row.assignment_id)
      .map((row) => ({
        userId: row.user_id as string,
        userName: row.full_name as string,
        userEmail: row.email as string,
        userStatus: row.status as string,
        ...projectAdminAssignment(row),
      }));
  }

  private async listAdminUserAccessRows(
    tenantId: string,
    visibility: AdministrativeVisibility,
    userId?: string,
    visibleRoleIds: readonly string[] = [],
  ): Promise<Record<string, unknown>[]> {
    const visibleUnitIds =
      visibility.kind === "units" ? visibility.organizationUnitIds : [];
    if (visibility.kind === "units" && visibleUnitIds.length === 0) return [];

    const result = await this.pool.query(
      `SELECT u.id AS user_id,
              u.full_name,
              u.email,
              u.status,
              access.id AS assignment_id,
              access.role_state,
              access.role_code,
              access.role_name,
              access.scope_type,
              access.scope_state,
              access.scope_legal_entity_id,
              access.scope_legal_entity_name,
              access.scope_organization_unit_id,
              access.scope_organization_unit_name,
              access.scope_customer_id,
              access.scope_customer_name,
              access.scope_invalidated_at,
              access.created_at,
              access.created_by,
              access.revoked_at,
              access.revoked_by,
              access.revoke_reason
         FROM users u
         LEFT JOIN LATERAL (
           SELECT ura.id,
                  ura.role_id,
                  ura.created_at,
                  ura.created_by,
                  ura.scope_invalidated_at,
                  ura.revoked_at,
                  ura.revoked_by,
                  ura.revoke_reason,
                  -- Inactive Roles read as "unavailable" here, the same generic
                  -- state as missing/foreign Roles: the projection keeps naming
                  -- the Role while the grant it carries stops authorizing, which
                  -- is exactly the same split revocation established.
                  CASE WHEN r.id IS NOT NULL AND r.is_active THEN 'available' ELSE 'unavailable' END
                    AS role_state,
                  r.code AS role_code,
                  r.name AS role_name,
                  ura.scope_type,
                  CASE
                    WHEN ura.scope_invalidated_at IS NULL
                     AND ura.revoked_at IS NULL
                     AND r.id IS NOT NULL
                     AND r.is_active
                     AND (
                       (
                         ura.scope_type = 'tenant'
                         AND ura.scope_organization_unit_id IS NULL
                         AND ura.scope_customer_id IS NULL
                       )
                       OR (ura.scope_type = 'legal_entity' AND le.id IS NOT NULL)
                       OR (ura.scope_type = 'organization_unit' AND ou.id IS NOT NULL)
                       OR (ura.scope_type = 'customer' AND c.id IS NOT NULL)
                     )
                    THEN 'available'
                    ELSE 'unavailable'
                  END AS scope_state,
                  ura.scope_legal_entity_id,
                  CASE
                    WHEN ura.scope_invalidated_at IS NULL
                      AND ura.revoked_at IS NULL
                      AND r.id IS NOT NULL
                      AND r.is_active
                      THEN le.name
                    ELSE NULL
                  END AS scope_legal_entity_name,
                  ura.scope_organization_unit_id,
                  CASE
                    WHEN ura.scope_invalidated_at IS NULL
                      AND ura.revoked_at IS NULL
                      AND r.id IS NOT NULL
                      AND r.is_active
                      THEN ou.name
                    ELSE NULL
                  END AS scope_organization_unit_name,
                  ura.scope_customer_id,
                  CASE
                    WHEN ura.scope_invalidated_at IS NULL
                      AND ura.revoked_at IS NULL
                      AND r.id IS NOT NULL
                      AND r.is_active
                      THEN c.name
                    ELSE NULL
                  END AS scope_customer_name
             FROM user_role_assignments ura
             LEFT JOIN roles r
               ON r.id = ura.role_id
              AND r.tenant_id = u.tenant_id
             LEFT JOIN legal_entities le
               ON le.id = ura.scope_legal_entity_id
              AND le.tenant_id = u.tenant_id
              AND le.deleted_at IS NULL
             LEFT JOIN organization_units ou
               ON ou.id = ura.scope_organization_unit_id
              AND ou.tenant_id = u.tenant_id
              AND ou.deleted_at IS NULL
             LEFT JOIN customers c
               ON c.id = ura.scope_customer_id
              AND c.tenant_id = u.tenant_id
              AND c.deleted_at IS NULL
            WHERE ura.user_id = u.id
         ) access ON true
        WHERE u.tenant_id = $1
          AND u.deleted_at IS NULL
          AND u.status = 'active'
          AND ($2::uuid IS NULL OR u.id = $2::uuid)
          AND (cardinality($5::uuid[]) = 0 OR access.role_id = ANY($5::uuid[]))
          AND (
            $3::boolean
            OR EXISTS (
              SELECT 1
                FROM user_role_assignments target_assignment
               WHERE target_assignment.user_id = u.id
                 AND target_assignment.scope_type = 'organization_unit'
                 AND target_assignment.scope_invalidated_at IS NULL
                 AND target_assignment.revoked_at IS NULL
                 AND target_assignment.scope_organization_unit_id = ANY($4::uuid[])
            )
            -- Epic 5 G3 — a target whose only live assignment is Legal Entity
            -- scoped is visible to the administrator whose covered units
            -- include a unit of that Legal Entity. Without this branch the
            -- write path and the list would disagree about which Users exist:
            -- the write's anchor check counts the Legal Entity family, so the
            -- read must too.
            OR EXISTS (
              SELECT 1
                FROM user_role_assignments target_assignment
                JOIN organization_units target_unit
                  ON target_unit.legal_entity_id = target_assignment.scope_legal_entity_id
                 AND target_unit.tenant_id = u.tenant_id
                 AND target_unit.deleted_at IS NULL
               WHERE target_assignment.user_id = u.id
                 AND target_assignment.scope_type = 'legal_entity'
                 AND target_assignment.scope_invalidated_at IS NULL
                 AND target_assignment.revoked_at IS NULL
                 AND target_unit.id = ANY($4::uuid[])
            )
          )
        ORDER BY u.full_name,
                 u.id,
                 access.role_code,
                 access.created_at,
                 access.id`,
      [
        tenantId,
        userId ?? null,
        visibility.kind === "tenant",
        visibleUnitIds,
        visibleRoleIds,
      ],
    );
    return result.rows as Record<string, unknown>[];
  }

  private mapAdminUserAccessRows(
    rows: readonly Record<string, unknown>[],
  ): AdminUserAccessSummary[] {
    const users = new Map<string, AdminUserAccessSummary>();
    for (const row of rows) {
      const userId = row.user_id as string;
      let user = users.get(userId);
      if (!user) {
        user = {
          id: userId,
          fullName: row.full_name as string,
          email: row.email as string,
          status: row.status as string,
          roleAssignments: [],
        };
        users.set(userId, user);
      }
      if (row.assignment_id) {
        user.roleAssignments.push(projectAdminAssignment(row));
      }
    }
    return [...users.values()];
  }

  async getRolePermissionDetail(
    tenantId: string,
    roleCode: string,
  ): Promise<RolePermissionDetail | null> {
    const result = await this.pool.query(
      `SELECT r.code AS role_code,
              r.name AS role_name,
              COALESCE(r.is_full_access, false) AS is_full_access,
              p.code AS permission_code,
              p.description AS permission_description
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE r.tenant_id = $1
          AND r.code = $2
        ORDER BY p.code`,
      [tenantId, roleCode],
    );
    if (!result.rows[0]) return null;
    return {
      roleCode: result.rows[0].role_code,
      roleName: result.rows[0].role_name,
      isFullAccess: result.rows[0].is_full_access,
      permissions: result.rows
        .filter((row) => row.permission_code !== null)
        .map((row) => ({
          code: row.permission_code,
          description: row.permission_description,
        })),
    };
  }

  async createGovernedRoleAssignment(
    actor: GovernedActor,
    targetUserId: string,
    input: GovernedRoleAssignmentInput,
  ): Promise<AdminRoleAssignmentSummary> {
    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      // §4.4 D rewire — the same visibility policy as the Wave 2 surface: the
      // entry ticket at any scope, then the actor's own permission-bearing
      // visibility decides which targets exist for them.
      await this.requireTransactionConsoleEntry(client, actor);
      const visibility = await         requireAdministrativeVisibilityIn(
        client,
        actor,
        USER_ROLE_MANAGE,
      );

      const target = await client.query<{ organization_unit_ids: string[] }>(
        // Epic 5 G3 — the target's ANCHOR units, which is what the visibility
        // intersection is asked about: an Organization Unit assignment anchors
        // its unit, and a Legal Entity assignment anchors every unit inside
        // that Legal Entity (§4.5 principle 9). Without the second family a
        // User whose only assignment is Legal Entity-scoped would be invisible
        // to the very administrator whose Data Scope covers them.
        `SELECT ARRAY(
                  SELECT anchor_id
                    FROM (
                      SELECT ura.scope_organization_unit_id AS anchor_id
                        FROM user_role_assignments ura
                       WHERE ura.user_id = users.id
                         AND ura.scope_type = 'organization_unit'
                         AND ura.scope_invalidated_at IS NULL
                         AND ura.revoked_at IS NULL
                      UNION
                      SELECT ou.id AS anchor_id
                        FROM user_role_assignments ura
                        JOIN organization_units ou
                          ON ou.legal_entity_id = ura.scope_legal_entity_id
                         AND ou.tenant_id = users.tenant_id
                         AND ou.deleted_at IS NULL
                       WHERE ura.user_id = users.id
                         AND ura.scope_type = 'legal_entity'
                         AND ura.scope_invalidated_at IS NULL
                         AND ura.revoked_at IS NULL
                    ) anchors
                ) AS organization_unit_ids
           FROM users
          WHERE id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
            AND status = 'active'`,
        [targetUserId, actor.tenantId],
      );
      if (
        !target.rows[0] ||
        !isUserWithinVisibility(visibility, target.rows[0].organization_unit_ids)
      ) {
        throw new NotFoundError("User", targetUserId);
      }
      if (input.scopeType === "tenant" && visibility.kind !== "tenant") {
        throw new ForbiddenError(
          "Tenant-wide assignment requires tenant-wide authority",
        );
      }
      // Epic 5 G3 — one level below tenant: a `legal_entity` grant is only
      // delegable to an actor whose own Data Scope already reaches the whole
      // Legal Entity (see `resolveLegalEntityScopeTarget`).

      const roleResult = await client.query(
        `SELECT id, code, name, is_active
           FROM roles
          WHERE tenant_id = $1
            AND code = $2`,
        [actor.tenantId, input.roleCode],
      );
      const role = roleResult.rows[0];
      if (!role) throw new NotFoundError("Role", input.roleCode);
      // Epic 4 open item 2 — the picker marks a deactivated Role
      // `selectable: false`; this is the same refusal on the write path, so a
      // direct API call cannot do what the console will not offer.
      if (!role.is_active) {
        throw new ValidationError(
          `Role '${input.roleCode}' is deactivated and cannot be assigned`,
        );
      }

      if (input.scopeType === "organization_unit" && visibility.kind === "units") {
        // ADR-0009: authority on a unit reaches everything beneath it, so the
        // whole subtree must sit inside the actor's own subtree set.
        const subtree = await listOrganizationUnitSubtreeIdsIn(
          client,
          actor.tenantId,
          [input.scopeOrganizationUnitId],
        );
        if (!subtree.every((id) => visibility.organizationUnitIds.includes(id))) {
          throw new ForbiddenError(
            "Assignment target is outside your Data Scope",
          );
        }
      }

      // §4.4 D — the single-assignment write answers the same delegation and
      // module questions the batch path asks, so neither route is stronger
      // merely because its route differs. One pair, one loop, ceilings once.
      const delegable = await this.assignmentDelegablePermissionCodes(client, actor);
      const activeModules = await this.activeModuleCodes(client, actor.tenantId);
      const granted = await client.query<{ code: string }>(
        `SELECT p.code
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = $1`,
        [role.id],
      );
      // §4.4 decision 2 — the customer-scope permission ceiling, checked on
      // the same pass as the delegation and module questions. Tenant-wide
      // override wins, catalog default otherwise; default is false, so a
      // tenant that never touches the flag gets the restricted set.
      const fullSetOpen = await client.query<{ is_enabled: boolean | null }>(
        `SELECT COALESCE(
                  (SELECT tff.is_enabled
                     FROM tenant_feature_flags tff
                     JOIN feature_flags ff ON ff.id = tff.feature_flag_id
                    WHERE tff.tenant_id = $1
                      AND ff.code = 'customer_scope_full_permission_set'
                      AND tff.scope_type = 'tenant'),
                  (SELECT ff.default_enabled
                     FROM feature_flags ff
                    WHERE ff.code = 'customer_scope_full_permission_set')
                ) AS is_enabled`,
        [actor.tenantId],
      );
      for (const { code } of granted.rows) {
        if (
          input.scopeType === "customer" &&
          !fullSetOpen.rows[0]?.is_enabled &&
          CUSTOMER_SCOPE_SERVICE_OPERATION_PERMISSION_CODES.includes(code) &&
          !CUSTOMER_SCOPE_DEFAULT_PERMISSION_CODES.includes(code)
        ) {
          throw new ValidationError(
            `Role '${role.code}' cannot be assigned at customer scope while it carries '${code}' — customer scope is limited to service_operations.read and service_operations.optimization.read unless the customer permission set is opened in Feature Flags`,
          );
        }
        if (!delegable.has(code)) {
          throw new ValidationError(
            `Role '${role.code}' carries permission '${code}' outside your delegation authority`,
          );
        }
        const moduleCode = attributePermission(code);
        if (moduleCode === undefined) {
          throw new ValidationError(`Permission '${code}' has no owning module`);
        }
        if (moduleCode !== "platform" && !activeModules.has(moduleCode)) {
          throw new ValidationError(
            `Role '${role.code}' needs module '${moduleCode}' which is not active for this tenant`,
          );
        }
      }

      let organizationUnitName: string | null = null;
      let customerName: string | null = null;
      const organizationUnitId =
        input.scopeType === "organization_unit"
          ? input.scopeOrganizationUnitId
          : null;
      const customerId =
        input.scopeType === "customer" ? input.scopeCustomerId : null;
      const legalEntityId =
        input.scopeType === "legal_entity" ? input.scopeLegalEntityId : null;
      let legalEntityName: string | null = null;

      if (legalEntityId) {
        legalEntityName = await this.resolveLegalEntityScopeTarget(
          client,
          actor,
          visibility,
          legalEntityId,
        );
      }

      if (organizationUnitId) {
        const organizationUnit = await client.query(
          `SELECT name
             FROM organization_units
            WHERE id = $1
              AND tenant_id = $2
              AND deleted_at IS NULL`,
          [organizationUnitId, actor.tenantId],
        );
        if (!organizationUnit.rows[0]) {
          throw new NotFoundError("Organization Unit", organizationUnitId);
        }
        organizationUnitName = organizationUnit.rows[0].name;
      }

      if (customerId) {
        const customer = await client.query(
          `SELECT name
             FROM customers
            WHERE id = $1
              AND tenant_id = $2
              AND deleted_at IS NULL`,
          [customerId, actor.tenantId],
        );
        if (!customer.rows[0]) throw new NotFoundError("Customer", customerId);
        customerName = customer.rows[0].name;
      }

      // §4.4 decision 6 — refuse the mix before the INSERT so the client gets
      // the same 409 both directions, instead of only the customer-after-
      // internal direction firing the trigger.
      await assertNoScopeExclusivityConflict(
        client,
        targetUserId,
        input.scopeType,
      );

      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO user_role_assignments
             (user_id, role_id, scope_type, scope_legal_entity_id,
              scope_organization_unit_id, scope_customer_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, scope_type, scope_legal_entity_id,
                     scope_organization_unit_id, scope_customer_id,
                     created_at, created_by`,
          [
            targetUserId,
            role.id,
            input.scopeType,
            legalEntityId,
            organizationUnitId,
            customerId,
            actor.userId,
          ],
        );
      } catch (error) {
        const databaseError = error as { code?: string; constraint?: string };
        if (
          databaseError.code === UNIQUE_VIOLATION &&
          databaseError.constraint ===
            "user_role_assignments_exact_assignment_unique"
        ) {
          throw new ConflictError("This exact Role assignment already exists");
        }
        // Race backstop for the exclusivity trigger: two grants passing the
        // pre-check concurrently both land here, exactly one row at a time.
        if (databaseError.constraint === SCOPE_EXCLUSIVITY_CONSTRAINT) {
          throw new ConflictError(SCOPE_EXCLUSIVITY_MESSAGE);
        }
        if (databaseError.constraint === SOD_VIOLATION_CONSTRAINT) {
          throw new ConflictError(SOD_VIOLATION_MESSAGE);
        }
        throw error;
      }

      const row = inserted.rows[0];
      const assignment = mapAdminAssignment({
        id: row.id,
        role_state: "available",
        role_code: role.code,
        role_name: role.name,
        scope_type: row.scope_type,
        scope_state: "available",
        scope_legal_entity_id: row.scope_legal_entity_id,
        scope_legal_entity_name: legalEntityName,
        scope_organization_unit_id: row.scope_organization_unit_id,
        scope_organization_unit_name: organizationUnitName,
        scope_customer_id: row.scope_customer_id,
        scope_customer_name: customerName,
        // Wave 3 — the INSERT's own RETURNING supplies the grant provenance so
        // the 201 payload carries the same lifecycle fields a reload would.
        created_at: row.created_at,
        created_by: row.created_by,
      });

      await this.recordGovernedAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        targetUserId,
        action: "user.role_assigned",
        after: assignment,
      });
      return assignment;
    });
  }

  async revokeGovernedRoleAssignment(
    actor: GovernedActor,
    targetUserId: string,
    assignmentId: string,
    reason: string,
  ): Promise<void> {
    await this.inGovernedTransaction(actor.tenantId, async (client) => {
      // §4.4 D rewire — see createGovernedRoleAssignment.
      await this.requireTransactionConsoleEntry(client, actor);
      const visibility = await         requireAdministrativeVisibilityIn(
        client,
        actor,
        USER_ROLE_MANAGE,
      );

      const target = await client.query<{ organization_unit_ids: string[] }>(
        // Epic 5 G3 — the target's ANCHOR units, which is what the visibility
        // intersection is asked about: an Organization Unit assignment anchors
        // its unit, and a Legal Entity assignment anchors every unit inside
        // that Legal Entity (§4.5 principle 9). Without the second family a
        // User whose only assignment is Legal Entity-scoped would be invisible
        // to the very administrator whose Data Scope covers them.
        `SELECT ARRAY(
                  SELECT anchor_id
                    FROM (
                      SELECT ura.scope_organization_unit_id AS anchor_id
                        FROM user_role_assignments ura
                       WHERE ura.user_id = users.id
                         AND ura.scope_type = 'organization_unit'
                         AND ura.scope_invalidated_at IS NULL
                         AND ura.revoked_at IS NULL
                      UNION
                      SELECT ou.id AS anchor_id
                        FROM user_role_assignments ura
                        JOIN organization_units ou
                          ON ou.legal_entity_id = ura.scope_legal_entity_id
                         AND ou.tenant_id = users.tenant_id
                         AND ou.deleted_at IS NULL
                       WHERE ura.user_id = users.id
                         AND ura.scope_type = 'legal_entity'
                         AND ura.scope_invalidated_at IS NULL
                         AND ura.revoked_at IS NULL
                    ) anchors
                ) AS organization_unit_ids
           FROM users
          WHERE id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
            AND status = 'active'`,
        [targetUserId, actor.tenantId],
      );
      if (
        !target.rows[0] ||
        !isUserWithinVisibility(visibility, target.rows[0].organization_unit_ids)
      ) {
        throw new NotFoundError("User", targetUserId);
      }

      const assignmentResult = await client.query(
        `SELECT ura.id,
                CASE WHEN r.id IS NOT NULL THEN 'available' ELSE 'unavailable' END
                  AS role_state,
                ura.scope_type,
                CASE
                  WHEN ura.scope_invalidated_at IS NULL
                   AND ura.revoked_at IS NULL
                   AND r.id IS NOT NULL
                   AND (
                     (
                       ura.scope_type = 'tenant'
                       AND ura.scope_organization_unit_id IS NULL
                       AND ura.scope_customer_id IS NULL
                     )
                     OR (ura.scope_type = 'legal_entity' AND le.id IS NOT NULL)
                     OR (ura.scope_type = 'organization_unit' AND ou.id IS NOT NULL)
                     OR (ura.scope_type = 'customer' AND c.id IS NOT NULL)
                   )
                  THEN 'available'
                  ELSE 'unavailable'
                END AS scope_state,
                ura.scope_legal_entity_id,
                CASE
                  WHEN ura.scope_invalidated_at IS NULL
                    AND ura.revoked_at IS NULL
                    AND r.id IS NOT NULL
                    THEN le.name
                  ELSE NULL
                END AS scope_legal_entity_name,
                ura.scope_organization_unit_id,
                CASE
                  WHEN ura.scope_invalidated_at IS NULL
                    AND ura.revoked_at IS NULL
                    AND r.id IS NOT NULL
                    THEN ou.name
                  ELSE NULL
                END AS scope_organization_unit_name,
                ura.scope_customer_id,
                CASE
                  WHEN ura.scope_invalidated_at IS NULL
                    AND ura.revoked_at IS NULL
                    AND r.id IS NOT NULL
                    THEN c.name
                  ELSE NULL
                END AS scope_customer_name,
                ura.created_at,
                ura.created_by,
                ura.scope_invalidated_at,
                ura.revoked_at,
                ura.revoked_by,
                ura.revoke_reason,
                r.code AS role_code,
                r.name AS role_name,
                EXISTS (
                  SELECT 1
                    FROM role_permissions manager_rp
                    JOIN permissions manager_p ON manager_p.id = manager_rp.permission_id
                   WHERE manager_rp.role_id = r.id
                     AND manager_p.code = $4
                ) AS grants_user_role_manage
           FROM user_role_assignments ura
           JOIN users u
             ON u.id = ura.user_id
            AND u.tenant_id = $2
            AND u.deleted_at IS NULL
            AND u.status = 'active'
           LEFT JOIN roles r
             ON r.id = ura.role_id
            AND r.tenant_id = u.tenant_id
           LEFT JOIN legal_entities le
             ON le.id = ura.scope_legal_entity_id
            AND le.tenant_id = u.tenant_id
            AND le.deleted_at IS NULL
           LEFT JOIN organization_units ou
             ON ou.id = ura.scope_organization_unit_id
            AND ou.tenant_id = u.tenant_id
            AND ou.deleted_at IS NULL
           LEFT JOIN customers c
             ON c.id = ura.scope_customer_id
            AND c.tenant_id = u.tenant_id
            AND c.deleted_at IS NULL
          WHERE ura.id = $1
            AND ura.user_id = $3`,
        [assignmentId, actor.tenantId, targetUserId, USER_ROLE_MANAGE],
      );
      const row = assignmentResult.rows[0];
      if (!row) throw new NotFoundError("Role assignment", assignmentId);

      const removesTenantManager =
        row.scope_state === "available" &&
        row.grants_user_role_manage === true &&
        row.scope_type === "tenant" &&
        row.scope_organization_unit_id === null &&
        row.scope_customer_id === null;
      if (removesTenantManager && targetUserId === actor.userId) {
        throw new ConflictError(
          "You cannot remove your own tenant manager assignment",
        );
      }

      if (removesTenantManager) {
        const remainingManagers = await client.query(
          `SELECT COUNT(DISTINCT manager_aura.user_id)::int AS count
             FROM authorization_effective_user_role_assignments manager_aura
             JOIN role_permissions manager_rp ON manager_rp.role_id = manager_aura.role_id
             JOIN permissions manager_p ON manager_p.id = manager_rp.permission_id
            WHERE manager_aura.tenant_id = $1
              AND manager_aura.scope_type = 'tenant'
              AND manager_aura.scope_organization_unit_id IS NULL
              AND manager_aura.scope_customer_id IS NULL
              AND manager_p.code = $2
              AND manager_aura.user_id <> $3`,
          [actor.tenantId, USER_ROLE_MANAGE, targetUserId],
        );
        if (remainingManagers.rows[0].count === 0) {
          throw new ConflictError(
            "Cannot remove the final active tenant manager assignment",
          );
        }
      }

      // §4.4 step 18 — soft revoke: the row and its history are retained; the
      // grant becomes inert on the next authorization check. A second revoke
      // of the same row is a conflict, not a second history event.
      if (row.revoked_at != null) {
        throw new ConflictError("This Role assignment is already revoked");
      }

      const before = mapAdminAssignment(row);
      const revoked = await client.query<{ revoked_at: Date }>(
        `UPDATE user_role_assignments
            SET revoked_at = statement_timestamp(),
                revoked_by = $3,
                revoke_reason = $4
          WHERE id = $1
            AND user_id = $2
            AND revoked_at IS NULL
          RETURNING revoked_at`,
        [assignmentId, targetUserId, actor.userId, reason],
      );
      if (revoked.rows.length === 0) {
        // Lost a race inside the same transaction window: the row was revoked
        // between the SELECT and this UPDATE by a concurrent governed write.
        throw new ConflictError("This Role assignment is already revoked");
      }

      const after = mapAdminAssignment({
        ...row,
        revoked_at: revoked.rows[0].revoked_at,
        revoked_by: actor.userId,
        revoke_reason: reason,
      });
      await this.recordGovernedAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        targetUserId,
        action: "user.role_revoked",
        before,
        after,
      });
    });
  }

  // ==========================================================================
  // Epic 4 Wave 2 — User and internal assignment management (CORE-ROADMAP.md
  // §4.4, Gelombang 2 steps 11–16). Both surfaces — the User-centric one and
  // the assignment-centric one — call these methods with the same policy: the
  // actor's visibility is resolved from their OWN permission-bearing
  // assignments (same-assignment rule, §4.4 risk row 3), an empty visibility is
  // a refusal rather than an empty page, targets are narrowed in SQL, and every
  // write owns one transaction with one batch audit row (§4.4 D/E).
  // ==========================================================================

  async listAssignmentOptions(
    actor: GovernedActor,
  ): Promise<AssignmentOptions> {
    const client = await this.pool.connect();
    try {
      // §4.4 D — the picker answers to the same policy as the write it feeds:
      // the console entry ticket at any Data Scope, then the actor's own
      // permission-bearing visibility. `canAssignTenantScope` and every
      // `selectable` below are derived from that visibility, so a region
      // administrator gets the subtree they may really assign to.
      await this.requireTransactionConsoleEntry(client, actor);
      const visibility = await resolveAdministrativeVisibilityIn(
        client,
        actor,
        USER_ROLE_MANAGE,
      );
      const canAssignTenantScope = visibility.kind === "tenant";

      // One read for every Role and its permission codes, so the ceiling is
      // decided in one place and the picker cannot offer a Role the write path
      // would then refuse (§4.4 step 15).
      const rolePermissions = await client.query<{
        role_id: string;
        code: string;
        role_code: string;
        role_name: string;
        is_active: boolean;
        permission_code: string;
      }>(
        `SELECT r.id AS role_id,
                r.code,
                r.name AS role_name,
                r.code AS role_code,
                r.is_active,
                p.code AS permission_code
           FROM roles r
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE r.tenant_id = $1
          ORDER BY r.code, p.code`,
        [actor.tenantId],
      );
      const emptyRoles = await client.query<{ role_id: string; role_code: string; role_name: string; is_active: boolean }>(
        `SELECT r.id AS role_id, r.code AS role_code, r.name AS role_name, r.is_active
           FROM roles r
          WHERE r.tenant_id = $1
            AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id)
          ORDER BY r.code`,
        [actor.tenantId],
      );

      const delegable = await this.assignmentDelegablePermissionCodes(client, actor);
      const codesByRole = new Map<string, string[]>();
      const labelByRole = new Map<string, { code: string; name: string; isActive: boolean }>();
      for (const row of rolePermissions.rows) {
        const codes = codesByRole.get(row.role_id) ?? [];
        codes.push(row.permission_code);
        codesByRole.set(row.role_id, codes);
        labelByRole.set(row.role_id, { code: row.code, name: row.role_name, isActive: row.is_active });
      }
      for (const row of emptyRoles.rows) {
        codesByRole.set(row.role_id, []);
        labelByRole.set(row.role_id, { code: row.role_code, name: row.role_name, isActive: row.is_active });
      }

      const roles: AssignmentRoleOption[] = [...codesByRole.entries()]
        .map(([roleId, codes]) => ({
          code: labelByRole.get(roleId)!.code,
          name: labelByRole.get(roleId)!.name,
          permissionCount: codes.length,
          // Deactivated Roles stay VISIBLE (an operator comparing options needs
          // to see them) but are not offered: the picker never offers a grant
          // the API would refuse.
          selectable:
            labelByRole.get(roleId)!.isActive &&
            codes.every((code) => delegable.has(code)),
        }))
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

      // The tree is tenant-wide because the browser renders the hierarchy; what
      // the actor may CHOOSE is narrower (§4.4 E). An ancestor above the
      // actor's authority is context with `selectable: false`.
      const units = await client.query<{
        id: string;
        name: string;
        parent_id: string | null;
        depth: number;
      }>(
        `WITH RECURSIVE tree AS (
           SELECT id, name, parent_id, 0 AS depth
             FROM organization_units
            WHERE tenant_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
           UNION ALL
           SELECT child.id, child.name, child.parent_id, tree.depth + 1
             FROM organization_units child
             JOIN tree ON child.parent_id = tree.id
            WHERE child.tenant_id = $1 AND child.deleted_at IS NULL
         )
         SELECT id, name, parent_id, depth FROM tree ORDER BY depth, name`,
        [actor.tenantId],
      );
      const assignableUnits =
        visibility.kind === "units"
          ? new Set(visibility.organizationUnitIds)
          : null;

      const organizationUnits: AssignmentScopeUnitOption[] = units.rows.map(
        (row) => ({
          id: row.id,
          name: row.name,
          parentId: row.parent_id,
          depth: row.depth,
          selectable:
            canAssignTenantScope || (assignableUnits?.has(row.id) ?? false),
        }),
      );

      // Epic 5 G3 — the same universe one level up. Every Legal Entity of the
      // Tenant is listed (the scope picker shows the structure it is choosing
      // within), but only ones the actor may really scope to are selectable:
      // an ACTIVE Legal Entity whose whole Organization Unit set already sits
      // inside the actor's own covered units when the actor is not tenant-wide.
      // A deactivated Legal Entity is never offered — the write path refuses it
      // by name, so the picker must not pretend otherwise.
      const legalEntityRows = await client.query<{
        id: string;
        name: string;
        status: string;
      }>(
        `SELECT id, name, status
           FROM legal_entities
          WHERE tenant_id = $1
            AND deleted_at IS NULL
          ORDER BY name, id`,
        [actor.tenantId],
      );
      const assignableLegalEntityIds = new Set<string>();
      if (!canAssignTenantScope) {
        for (const row of legalEntityRows.rows) {
          if (row.status !== "active") continue;
          const unitIds = await listOrganizationUnitIdsForLegalEntityIn(
            client,
            actor.tenantId,
            row.id,
          );
          if (unitIds.every((id) => assignableUnits?.has(id) ?? false)) {
            assignableLegalEntityIds.add(row.id);
          }
        }
      }
      const legalEntities: AssignmentScopeLegalEntityOption[] =
        legalEntityRows.rows.map((row) => ({
          id: row.id,
          name: row.name,
          selectable:
            row.status === "active" &&
            (canAssignTenantScope || assignableLegalEntityIds.has(row.id)),
        }));

      return { canAssignTenantScope, organizationUnits, legalEntities, roles };
    } finally {
      client.release();
    }
  }

  /**
   * Resolve, validate, and name every pair of a proposed batch, in §4.4 H
   * order: authority, target visibility, per-pair scope, then the Role's
   * delegation and module ceilings. The preview and the confirmation call this,
   * so both answer the same questions and the confirmed set is the previewed
   * set. Returns the display summaries in request order plus the validated rows
   * to insert.
   *
   * `targetUserId` is the User the batch is FOR, and is `null` only on the
   * create path, where the User is created by the caller inside this same
   * transaction and therefore cannot be looked up, cannot already hold an
   * Organization Unit assignment, and cannot be someone else's to govern.
   * §4.4 step 3's target check is skipped there; every pair's scope is not.
   */
  private async resolveAssignmentBatch(
    client: PoolClient,
    actor: GovernedActor,
    targetUserId: string | null,
    pairs: readonly GovernedRoleAssignmentInput[],
    resolvedVisibility?: AdministrativeVisibility,
  ): Promise<{
    summaries: AssignmentPairSummary[];
    writePairs: {
      roleId: string;
      scopeType: ScopeType;
      scopeLegalEntityId: string | null;
      scopeOrganizationUnitId: string | null;
    }[];
  }> {
    if (pairs.length === 0) {
      throw new ValidationError("At least one assignment pair is required");
    }
    const visibility =
      resolvedVisibility ??
      (await requireAdministrativeVisibilityIn(
        client,
        actor,
        USER_ROLE_MANAGE,
      ));

    if (targetUserId !== null) {
      const target = await client.query<{ organization_unit_ids: string[] }>(
        // Epic 5 G3 — the target's ANCHOR units, which is what the visibility
        // intersection is asked about: an Organization Unit assignment anchors
        // its unit, and a Legal Entity assignment anchors every unit inside
        // that Legal Entity (§4.5 principle 9). Without the second family a
        // User whose only assignment is Legal Entity-scoped would be invisible
        // to the very administrator whose Data Scope covers them.
        `SELECT ARRAY(
                  SELECT anchor_id
                    FROM (
                      SELECT ura.scope_organization_unit_id AS anchor_id
                        FROM user_role_assignments ura
                       WHERE ura.user_id = users.id
                         AND ura.scope_type = 'organization_unit'
                         AND ura.scope_invalidated_at IS NULL
                         AND ura.revoked_at IS NULL
                      UNION
                      SELECT ou.id AS anchor_id
                        FROM user_role_assignments ura
                        JOIN organization_units ou
                          ON ou.legal_entity_id = ura.scope_legal_entity_id
                         AND ou.tenant_id = users.tenant_id
                         AND ou.deleted_at IS NULL
                       WHERE ura.user_id = users.id
                         AND ura.scope_type = 'legal_entity'
                         AND ura.scope_invalidated_at IS NULL
                         AND ura.revoked_at IS NULL
                    ) anchors
                ) AS organization_unit_ids
           FROM users
          WHERE id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
            AND status = 'active'`,
        [targetUserId, actor.tenantId],
      );
      if (
        !target.rows[0] ||
        !isUserWithinVisibility(visibility, target.rows[0].organization_unit_ids)
      ) {
        // Out of visibility is indistinguishable from missing (§4.4 risk row 1).
        throw new NotFoundError("User", targetUserId);
      }
      // §4.4 decision 6 — this surface only writes internal scopes, so the
      // conflict it can create is the internal-after-customer one. Refused
      // before the INSERT; the trigger stays the race backstop.
      await assertNoScopeExclusivityConflict(
        client,
        targetUserId,
        "organization_unit",
      );
    }

    const roleRows = await client.query<{ id: string; code: string; name: string; is_active: boolean }>(
      `SELECT id, code, name, is_active
         FROM roles
        WHERE tenant_id = $1 AND code = ANY($2::text[])`,
      [actor.tenantId, [...new Set(pairs.map((p) => p.roleCode))]],
    );
    const roleByCode = new Map(roleRows.rows.map((r) => [r.code, r]));
    const codeByRoleId = new Map(roleRows.rows.map((r) => [r.id, r.code]));

    const unitIds = [
      ...new Set(
        pairs.flatMap((p) =>
          p.scopeType === "organization_unit" ? [p.scopeOrganizationUnitId] : [],
        ),
      ),
    ];
    const unitNames = new Map<string, string>();
    if (unitIds.length > 0) {
      const unitRows = await client.query<{ id: string; name: string }>(
        `SELECT id, name
           FROM organization_units
          WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [actor.tenantId, unitIds],
      );
      for (const row of unitRows.rows) unitNames.set(row.id, row.name);
    }

    const visibleUnits =
      visibility.kind === "units"
        ? new Set(visibility.organizationUnitIds)
        : new Set<string>();
    const summaries: AssignmentPairSummary[] = [];
    const writePairs: {
      roleId: string;
      scopeType: ScopeType;
      scopeLegalEntityId: string | null;
      scopeOrganizationUnitId: string | null;
    }[] = [];

    for (const pair of pairs) {
      const role = roleByCode.get(pair.roleCode);
      if (!role) throw new NotFoundError("Role", pair.roleCode);
      // Epic 4 open item 2 — same refusal as the single-assignment path.
      if (!role.is_active) {
        throw new ValidationError(
          `Role '${pair.roleCode}' is deactivated and cannot be assigned`,
        );
      }

      if (pair.scopeType === "tenant") {
        if (visibility.kind !== "tenant") {
          throw new ForbiddenError(
            "Tenant-wide assignment requires tenant-wide authority",
          );
        }
        summaries.push({
          roleCode: role.code,
          roleName: role.name,
          scopeType: "tenant",
          scopeLegalEntityId: null,
          scopeLegalEntityName: null,
          scopeOrganizationUnitId: null,
          scopeOrganizationUnitName: null,
          scopeCustomerId: null,
          scopeCustomerName: null,
        });
        writePairs.push({
          roleId: role.id,
          scopeType: "tenant",
          scopeLegalEntityId: null,
          scopeOrganizationUnitId: null,
        });
        continue;
      }

      // Epic 5 G3 — the Legal Entity family. Delegation and target resolution
      // are the same question the single-grant path asks, so it asks it with
      // the same method: only the summary and the pair it writes are new.
      if (pair.scopeType === "legal_entity") {
        const name = await this.resolveLegalEntityScopeTarget(
          client,
          actor,
          visibility,
          pair.scopeLegalEntityId,
        );
        summaries.push({
          roleCode: role.code,
          roleName: role.name,
          scopeType: "legal_entity",
          scopeLegalEntityId: pair.scopeLegalEntityId,
          scopeLegalEntityName: name,
          scopeOrganizationUnitId: null,
          scopeOrganizationUnitName: null,
          scopeCustomerId: null,
          scopeCustomerName: null,
        });
        writePairs.push({
          roleId: role.id,
          scopeType: "legal_entity",
          scopeLegalEntityId: pair.scopeLegalEntityId,
          scopeOrganizationUnitId: null,
        });
        continue;
      }

      if (pair.scopeType === "organization_unit") {
        const name = unitNames.get(pair.scopeOrganizationUnitId);
        if (!name) {
          throw new NotFoundError("Organization Unit", pair.scopeOrganizationUnitId);
        }
        if (
          visibility.kind === "units" &&
          !visibleUnits.has(pair.scopeOrganizationUnitId)
        ) {
          // ADR-0009: authority on a unit reaches everything beneath it. The
          // actor's own set is already closed downward, so membership of the
          // TARGET unit is equivalent to "the whole target subtree is inside
          // the actor's authority" — and it costs no extra query.
          throw new ForbiddenError(
            "Assignment target is outside your Data Scope",
          );
        }
        summaries.push({
          roleCode: role.code,
          roleName: role.name,
          scopeType: "organization_unit",
          scopeLegalEntityId: null,
          scopeLegalEntityName: null,
          scopeOrganizationUnitId: pair.scopeOrganizationUnitId,
          scopeOrganizationUnitName: name,
          scopeCustomerId: null,
          scopeCustomerName: null,
        });
        writePairs.push({
          roleId: role.id,
          scopeType: "organization_unit",
          scopeLegalEntityId: null,
          scopeOrganizationUnitId: pair.scopeOrganizationUnitId,
        });
        continue;
      }

      // §4.4 E keeps Customer scope out of the Epic 4 UI until the Service
      // Operation session closes, so no actor may reach it through this
      // governed surface in Wave 2. Refused by name, not silently dropped.
      throw new ValidationError(
        "Customer-scope assignment is not available through this surface",
      );
    }

    // Ceilings, once per distinct Role rather than once per pair.
    const distinctRoleIds = [...new Set(writePairs.map((p) => p.roleId))];
    const grantedRows = await client.query<{ role_id: string; permission_code: string }>(
      `SELECT rp.role_id, p.code AS permission_code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ANY($1::uuid[])`,
      [distinctRoleIds],
    );
    const codesByRole = new Map<string, string[]>();
    for (const row of grantedRows.rows) {
      const codes = codesByRole.get(row.role_id) ?? [];
      codes.push(row.permission_code);
      codesByRole.set(row.role_id, codes);
    }
    const delegable = await this.assignmentDelegablePermissionCodes(client, actor);
    const activeModules = await this.activeModuleCodes(client, actor.tenantId);
    for (const roleId of distinctRoleIds) {
      const roleCode = codeByRoleId.get(roleId)!;
      for (const code of codesByRole.get(roleId) ?? []) {
        if (!delegable.has(code)) {
          throw new ValidationError(
            `Role '${roleCode}' carries permission '${code}' outside your delegation authority`,
          );
        }
        // The owning module is a code-owned fact (`module-attribution.ts`),
        // never a database column, so it is resolved in TypeScript.
        const moduleCode = attributePermission(code);
        if (moduleCode === undefined) {
          throw new ValidationError(`Permission '${code}' has no owning module`);
        }
        // §4.4 step 23: an inactive module is refused with its own reason, not
        // folded into the delegation refusal.
        if (moduleCode !== "platform" && !activeModules.has(moduleCode)) {
          throw new ValidationError(
            `Role '${roleCode}' needs module '${moduleCode}' which is not active for this tenant`,
          );
        }
      }
    }

    return { summaries, writePairs };
  }

  async previewRoleAssignments(
    actor: GovernedActor,
    targetUserId: string,
    input: PreviewRoleAssignmentsInput,
  ): Promise<AssignmentBatchPreview> {
    normalizeAssignmentPairs(input.pairs);
    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      // §4.4 D — the entry ticket only; `resolveAssignmentBatch` resolves the
      // actor's visibility and refuses a target outside it, so the preview
      // answers exactly the questions the confirmation will answer.
      await this.requireTransactionConsoleEntry(client, actor);
      const { summaries } = await this.resolveAssignmentBatch(
        client,
        actor,
        targetUserId,
        input.pairs,
      );
      return {
        previewHash: computeAssignmentBatchHash(
          actor.userId,
          targetUserId,
          input.pairs,
        ),
        targetUserId,
        pairs: summaries,
      };
    });
  }

  async updateRoleAssignments(
    actor: GovernedActor,
    targetUserId: string,
    input: UpdateRoleAssignmentsInput,
  ): Promise<AssignmentBatchResult> {
    if (input.confirm !== true) {
      throw new ValidationError("Confirmation flag is required");
    }
    normalizeAssignmentPairs(input.pairs);
    // The content address binds actor, target, and pairs. Recomputed here from
    // what is about to be written, so a review approved against one batch can
    // never be replayed onto another.
    if (
      computeAssignmentBatchHash(actor.userId, targetUserId, input.pairs) !==
      input.previewHash
    ) {
      throw new ConflictError(
        "The previewed assignment batch no longer matches this request",
      );
    }

    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      // §4.4 D — same policy as the preview above; the hash comparison already
      // happened outside the transaction, the visibility check happens inside
      // it, right here, against live data.
      await this.requireTransactionConsoleEntry(client, actor);
      const { summaries, writePairs } = await this.resolveAssignmentBatch(
        client,
        actor,
        targetUserId,
        input.pairs,
      );

      // One multi-row INSERT. Deliberately NOT `ON CONFLICT DO NOTHING`: §4.4 C
      // requires all-or-nothing, so an existing pair must abort the batch with
      // a conflict, and the 23505 catch below is the race backstop rather than
      // the primary check.
      let inserted;
      try {
        inserted = await client.query<{
          id: string;
          role_id: string;
          scope_type: ScopeType;
          scope_legal_entity_id: string | null;
          scope_organization_unit_id: string | null;
          created_at: Date;
          created_by: string;
        }>(
          `INSERT INTO user_role_assignments
             (user_id, role_id, scope_type, scope_legal_entity_id,
              scope_organization_unit_id, scope_customer_id, created_by)
           SELECT $1, r.id, p.scope_type, p.scope_legal_entity_id,
                  p.scope_organization_unit_id, NULL, $2
             FROM unnest($3::uuid[], $4::text[], $5::uuid[], $6::uuid[])
               AS p(role_id, scope_type, scope_legal_entity_id,
                    scope_organization_unit_id)
             JOIN roles r ON r.id = p.role_id
           RETURNING id, role_id, scope_type, scope_legal_entity_id,
                     scope_organization_unit_id, created_at, created_by`,
          [
            targetUserId,
            actor.userId,
            writePairs.map((p) => p.roleId),
            writePairs.map((p) => p.scopeType),
            writePairs.map((p) => p.scopeLegalEntityId),
            writePairs.map((p) => p.scopeOrganizationUnitId),
          ],
        );
      } catch (error) {
        const databaseError = error as { code?: string; constraint?: string };
        if (
          databaseError.code === UNIQUE_VIOLATION &&
          databaseError.constraint ===
            "user_role_assignments_exact_assignment_unique"
        ) {
          throw new ConflictError(
            "One or more of these Role assignments already exist for this User",
          );
        }
        // Race backstop for the exclusivity trigger, same as the single path.
        if (databaseError.constraint === SCOPE_EXCLUSIVITY_CONSTRAINT) {
          throw new ConflictError(SCOPE_EXCLUSIVITY_MESSAGE);
        }
        if (databaseError.constraint === SOD_VIOLATION_CONSTRAINT) {
          throw new ConflictError(SOD_VIOLATION_MESSAGE);
        }
        throw error;
      }

      await recordAssignmentBatchAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        targetUserId,
        pairs: summaries,
      });

      const indexByKey = new Map(
        writePairs.map((pair, index) => [
          assignmentKey(
            pair.roleId,
            pair.scopeType,
            pair.scopeLegalEntityId ?? pair.scopeOrganizationUnitId,
          ),
          index,
        ]),
      );
      const created = inserted.rows.map((row) => {
        const summary =
          summaries[
            indexByKey.get(
              assignmentKey(row.role_id, row.scope_type, rowScopeId(row)),
            )!
          ];
        return mapAdminAssignment({
          id: row.id,
          role_state: "available",
          role_code: summary.roleCode,
          role_name: summary.roleName,
          scope_type: row.scope_type,
          scope_state: "available",
          scope_legal_entity_id: row.scope_legal_entity_id,
          scope_legal_entity_name: summary.scopeLegalEntityName,
          scope_organization_unit_id: row.scope_organization_unit_id,
          scope_organization_unit_name: summary.scopeOrganizationUnitName,
          scope_customer_id: null,
          scope_customer_name: null,
          created_at: row.created_at,
          created_by: row.created_by,
        });
      });

      return { targetUserId, created };
    });
  }

  async createGovernedUserWithAssignments(
    actor: GovernedActor,
    input: CreateGovernedUserInput,
  ): Promise<{
    user: GovernedUserSummary;
    assignments: AdminRoleAssignmentSummary[];
  }> {
    if (input.pairs.length > 0) normalizeAssignmentPairs(input.pairs);

    // Hashed BEFORE the tenant lock. Hashing is CPU work measured in tens of
    // milliseconds; holding the serialization lock through it would stall every
    // other governed write in the tenant for no correctness gain.
    const passwordHash = await hashPassword(input.password);
    const email = input.email.toLowerCase();

    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      // §4.4 D — the entry ticket, then the actor's own permission-bearing
      // visibility. Resolved HERE, not by `resolveAssignmentBatch`, because
      // §4.4 step 3's target check cannot apply to a User this transaction is
      // about to create: they hold no Organization Unit assignment yet, so a
      // units actor would be refused their own new User. The pair ceilings
      // below still run against live data via the `null` target.
      await this.requireTransactionConsoleEntry(client, actor);
      const visibility = await resolveAdministrativeVisibilityIn(
        client,
        actor,
        USER_ROLE_MANAGE,
      );
      if (
        visibility.kind === "units" &&
        visibility.organizationUnitIds.length === 0
      ) {
        throw new ForbiddenError(
          "Missing permission or Data Scope for 'user.role.manage'",
        );
      }

      const emailConflict = await client.query(
        `SELECT 1
           FROM users
          WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL`,
        [actor.tenantId, email],
      );
      if (emailConflict.rows[0]) {
        throw new ConflictError(
          `Email '${input.email}' already exists in this Tenant`,
        );
      }

      let created: { id: string; status: string };
      try {
        const inserted = await client.query<{ id: string; status: string }>(
          `INSERT INTO users
             (tenant_id, email, password_hash, full_name, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5)
           RETURNING id, status`,
          [actor.tenantId, email, passwordHash, input.fullName, actor.userId],
        );
        created = inserted.rows[0];
      } catch (error) {
        // The pre-check lost a race. `users_tenant_email_unique` does not
        // exclude soft-deleted rows, so a raw 23505 here would otherwise
        // surface as a 500.
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictError(
            `Email '${input.email}' already exists in this Tenant`,
          );
        }
        throw error;
      }

      await client.query(
        `INSERT INTO audit_log
           (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'user.created', 'user', $3, $4::jsonb)`,
        [
          actor.tenantId,
          actor.userId,
          created.id,
          JSON.stringify({ email, fullName: input.fullName }),
        ],
      );

      let assignments: AdminRoleAssignmentSummary[] = [];
      if (input.pairs.length > 0) {
        const { summaries, writePairs } = await this.resolveAssignmentBatch(
          client,
          actor,
          null,
          input.pairs,
          visibility,
        );
        let insertedRows!: {
          id: string;
          role_id: string;
          scope_type: ScopeType;
          scope_legal_entity_id: string | null;
          scope_organization_unit_id: string | null;
          created_at: Date;
          created_by: string;
        }[];
        try {
          const inserted = await client.query<{
            id: string;
            role_id: string;
            scope_type: ScopeType;
            scope_legal_entity_id: string | null;
            scope_organization_unit_id: string | null;
            created_at: Date;
            created_by: string;
          }>(
            `INSERT INTO user_role_assignments
               (user_id, role_id, scope_type, scope_legal_entity_id,
                scope_organization_unit_id, scope_customer_id, created_by)
             SELECT $1, r.id, p.scope_type, p.scope_legal_entity_id,
                    p.scope_organization_unit_id, NULL, $2
               FROM unnest($3::uuid[], $4::text[], $5::uuid[], $6::uuid[])
                 AS p(role_id, scope_type, scope_legal_entity_id,
                      scope_organization_unit_id)
             JOIN roles r ON r.id = p.role_id
             RETURNING id, role_id, scope_type, scope_legal_entity_id,
                       scope_organization_unit_id, created_at, created_by`,
            [
              created.id,
              actor.userId,
              writePairs.map((p) => p.roleId),
              writePairs.map((p) => p.scopeType),
              writePairs.map((p) => p.scopeLegalEntityId),
              writePairs.map((p) => p.scopeOrganizationUnitId),
            ],
          );
          insertedRows = inserted.rows;
        } catch (error) {
          const databaseError = error as { code?: string; constraint?: string };
          if (
            databaseError.code === UNIQUE_VIOLATION &&
            databaseError.constraint ===
              "user_role_assignments_exact_assignment_unique"
          ) {
            throw new ConflictError(
              "One or more of these Role assignments already exist for this User",
            );
          }
          if (databaseError.constraint === SCOPE_EXCLUSIVITY_CONSTRAINT) {
            throw new ConflictError(SCOPE_EXCLUSIVITY_MESSAGE);
          }
          if (databaseError.constraint === SOD_VIOLATION_CONSTRAINT) {
            throw new ConflictError(SOD_VIOLATION_MESSAGE);
          }
          throw error;
        }

        await recordAssignmentBatchAudit(client, {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          targetUserId: created.id,
          pairs: summaries,
        });

        const indexByKey = new Map(
          writePairs.map((pair, index) => [
            assignmentKey(
              pair.roleId,
              pair.scopeType,
              pair.scopeLegalEntityId ?? pair.scopeOrganizationUnitId,
            ),
            index,
          ]),
        );
        assignments = insertedRows.map((row) => {
          const summary =
            summaries[
              indexByKey.get(
                assignmentKey(row.role_id, row.scope_type, rowScopeId(row)),
              )!
            ];
          return mapAdminAssignment({
            id: row.id,
            role_state: "available",
            role_code: summary.roleCode,
            role_name: summary.roleName,
            scope_type: row.scope_type,
            scope_state: "available",
            scope_legal_entity_id: row.scope_legal_entity_id,
            scope_legal_entity_name: summary.scopeLegalEntityName,
            scope_organization_unit_id: row.scope_organization_unit_id,
            scope_organization_unit_name: summary.scopeOrganizationUnitName,
            scope_customer_id: null,
            scope_customer_name: null,
            created_at: row.created_at,
            created_by: row.created_by,
          });
        });
      }

      return {
        user: {
          id: created.id,
          fullName: input.fullName,
          email,
          status: created.status,
        },
        assignments,
      };
    });
  }

  // Epic 4 Wave 1 — Role definition (CORE-ROADMAP.md §4.4, Gelombang 1 steps
  // 5–9). Every mutating method owns its complete transaction: tenant lock,
  // authority revalidation, ceiling validation, mutation, and an append-only
  // audit row carrying the before/after definition.
  //
  // Windows are CONFIGURED here; enforcement is step 11b, wired in
  // `window-access-plugin.ts`. `enforcementStatus` is read from that plugin's
  // census of the routes Fastify declared (`windowEnforcementStatus()`) so this
  // read cannot claim a state the server does not enforce. Both call sites
  // below run after boot, which is when the census has been filled.
  // ==========================================================================

  async getRoleDefinition(
    tenantId: string,
    roleCode: string,
  ): Promise<RoleDefinition | null> {
    const role = await this.pool.query(
      `SELECT id, tenant_id, code, name, description, is_active, COALESCE(is_full_access, false) AS is_full_access, version
         FROM roles
        WHERE tenant_id = $1 AND code = $2`,
      [tenantId, roleCode],
    );
    if (!role.rows[0]) return null;
    return this.loadRoleDefinition(this.pool, role.rows[0]);
  }

  async listRoleDefinitionOptions(actor: GovernedActor): Promise<RoleDefinitionOptions> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockTenant(client, actor.tenantId);
      await this.requireTransactionRoleDefinitionAuthority(client, actor);

      const delegable = await this.roleDefinitionDelegablePermissionCodes(client, actor);
      const activeModules = await this.activeModuleCodes(
        client,
        actor.tenantId,
      );
      const registered = await this.registeredProcessCodes(
        client,
        actor.tenantId,
      );

      const catalog = await client.query(
        `SELECT code, description FROM permissions ORDER BY code`,
      );
      const permissions: PermissionOption[] = catalog.rows.map(
        (row: { code: string; description: string }) => {
          const moduleCode = attributePermission(row.code) ?? null;
          return {
            code: row.code,
            description: row.description,
            moduleCode,
            isActive: moduleCode !== null && registered.has(row.code),
            selectable:
              moduleCode !== null &&
              registered.has(row.code) &&
              (moduleCode === "platform" || activeModules.has(moduleCode)) &&
              delegable.has(row.code),
          };
        },
      );

      const windows = await this.loadWindowOptions(
        client,
        actor.tenantId,
        activeModules,
        delegable,
      );
      await client.query("COMMIT");
      return { permissions, windows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createRoleDefinition(
    actor: GovernedActor,
    input: CreateRoleDefinitionInput,
  ): Promise<RoleDefinition> {
    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      await this.requireTransactionRoleDefinitionAuthority(client, actor);

      const existing = await client.query(
        `SELECT 1 FROM roles WHERE tenant_id = $1 AND code = $2`,
        [actor.tenantId, input.code],
      );
      if (existing.rows[0]) {
        throw new ConflictError(
          `A Role with code '${input.code}' already exists`,
        );
      }

      const permissionCodes = await this.validateProposedGrants(
        client,
        actor,
        input.permissionCodes,
        new Set(),
      );
      const windows = await this.validateProposedWindows(
        client,
        actor,
        input.windows,
        new Set(),
      );

      const inserted = await client.query(
        `INSERT INTO roles (tenant_id, code, name, description)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [actor.tenantId, input.code, input.name, input.description ?? null],
      );
      const roleId = inserted.rows[0].id as string;
      await this.writeRoleGrants(
        client,
        actor.tenantId,
        roleId,
        permissionCodes,
        windows,
      );

      const definition = await this.loadRoleDefinition(client, {
        id: roleId,
        tenant_id: actor.tenantId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        is_active: true,
        is_full_access: false,
        version: 1,
      });
      await this.recordRoleDefinitionAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        roleCode: input.code,
        roleId,
        action: "role.definition_created",
        before: null,
        after: definition,
      });
      return definition;
    });
  }

  async copyRoleDefinition(
    actor: GovernedActor,
    sourceCode: string,
    input: CopyRoleDefinitionInput,
  ): Promise<RoleDefinition> {
    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      await this.requireTransactionRoleDefinitionAuthority(client, actor);

      const source = await client.query(
        `SELECT id, description, COALESCE(is_full_access, false) AS is_full_access
           FROM roles WHERE tenant_id = $1 AND code = $2`,
        [actor.tenantId, sourceCode],
      );
      if (!source.rows[0]) throw new NotFoundError("Role", sourceCode);
      const sourceId = source.rows[0].id as string;

      const taken = await client.query(
        `SELECT 1 FROM roles WHERE tenant_id = $1 AND code = $2`,
        [actor.tenantId, input.code],
      );
      if (taken.rows[0])
        throw new ConflictError(
          `A Role with code '${input.code}' already exists`,
        );

      // Detached copy: the source's EXPLICIT rows are carried over as the new
      // Role's own rows. A full-access source is deliberately NOT copied as
      // full-access — the auto-grant flag is never inherited, so the copy holds
      // exactly the grants the source held explicitly at copy time (§4.4 C).
      const sourcePermissions = await client.query(
        `SELECT p.code
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = $1`,
        [sourceId],
      );
      const sourceWindows = await client.query(
        `SELECT window_code, is_read_write, is_active
           FROM role_window_access WHERE tenant_id = $1 AND role_id = $2`,
        [actor.tenantId, sourceId],
      );

      const forNew = new Set<string>();
      const permissionCodes = await this.validateProposedGrants(
        client,
        actor,
        sourcePermissions.rows.map((r: { code: string }) => r.code),
        forNew,
      );
      const windows = await this.validateProposedWindows(
        client,
        actor,
        sourceWindows.rows.map(
          (r: {
            window_code: string;
            is_read_write: boolean;
            is_active: boolean;
          }) => ({
            windowCode: r.window_code,
            isReadWrite: r.is_read_write,
            isActive: r.is_active,
          }),
        ),
        forNew,
      );

      // A copy carries the source's description unless the caller supplied one:
      // the copy dialog asks for a name, and a Role named after its source with
      // no text explaining what it is would be worse documented than what it
      // was cloned from. `description` is copied as METADATA only — it never
      // reaches the permission or window rows below.
      const copyDescription =
        input.description !== undefined
          ? input.description
          : (source.rows[0].description as string | null);

      const inserted = await client.query(
        `INSERT INTO roles (tenant_id, code, name, description)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [actor.tenantId, input.code, input.name, copyDescription],
      );
      const roleId = inserted.rows[0].id as string;
      await this.writeRoleGrants(
        client,
        actor.tenantId,
        roleId,
        permissionCodes,
        windows,
      );

      const definition = await this.loadRoleDefinition(client, {
        id: roleId,
        tenant_id: actor.tenantId,
        code: input.code,
        name: input.name,
        description: copyDescription,
        is_active: true,
        is_full_access: false,
        version: 1,
      });
      await this.recordRoleDefinitionAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        roleCode: input.code,
        roleId,
        action: "role.definition_copied",
        before: null,
        after: definition,
      });
      return definition;
    });
  }

  async previewRoleDefinition(
    actor: GovernedActor,
    roleCode: string,
    input: RoleDefinitionPreviewInput,
  ): Promise<RoleDefinitionPreview> {
    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      await this.requireTransactionRoleDefinitionAuthority(client, actor);

      const role = await this.loadRoleRow(client, actor.tenantId, roleCode);
      const current = await this.loadRoleDefinition(client, role);
      if (input.version !== current.version) {
        throw new ConflictError(
          `Role '${roleCode}' changed since it was loaded (expected version ${input.version}, current ${current.version})`,
        );
      }

      const existingCodes = new Set(current.permissionCodes);
      const existingWindows = new Set(current.windows.map((w) => w.windowCode));
      const permissionCodes = await this.validateProposedGrants(
        client,
        actor,
        input.permissionCodes,
        existingCodes,
      );
      const windows = await this.validateProposedWindows(
        client,
        actor,
        input.windows,
        existingWindows,
      );
      const affectedUserCount = await this.countRoleAssignments(
        client,
        actor.tenantId,
        role.id,
      );

      const preview: RoleDefinition = {
        id: role.id,
        tenantId: actor.tenantId,
        code: roleCode,
        name: input.name,
        description: input.description ?? null,
        isFullAccess: current.isFullAccess,
        isActive: current.isActive,
        version: input.version,
        permissionCodes,
        windows,
        enforcementStatus: windowEnforcementStatus(),
      };
      return {
        role: preview,
        // The hash deliberately covers ONLY the authorization fields (name,
        // permissions, windows). `description` is metadata: a typo fix must not
        // invalidate a preview that was approved for its permission change.
        // Version still moves on a description-only update, which is the token
        // keeping a stale preview out.
        previewHash: computeDefinitionHash(input.name, permissionCodes, windows),
        affectedUserCount,
      };
    });
  }

  async updateRoleDefinition(
    actor: GovernedActor,
    roleCode: string,
    input: UpdateRoleDefinitionInput,
  ): Promise<RoleDefinition> {
    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      await this.requireTransactionRoleDefinitionAuthority(client, actor);

      const role = await this.loadRoleRow(client, actor.tenantId, roleCode);
      const current = await this.loadRoleDefinition(client, role);
      if (input.version !== current.version) {
        throw new ConflictError(
          `Role '${roleCode}' changed since it was previewed (expected version ${input.version}, current ${current.version})`,
        );
      }
      const expectedHash = computeDefinitionHash(
        input.name,
        input.permissionCodes,
        input.windows,
      );
      if (expectedHash !== input.previewHash) {
        throw new ConflictError(
          "The previewed Role definition no longer matches this request",
        );
      }

      const existingCodes = new Set(current.permissionCodes);
      const existingWindows = new Set(current.windows.map((w) => w.windowCode));
      const permissionCodes = await this.validateProposedGrants(
        client,
        actor,
        input.permissionCodes,
        existingCodes,
      );
      const windows = await this.validateProposedWindows(
        client,
        actor,
        input.windows,
        existingWindows,
      );

      // §4.4 B: `version` is a concurrency token for DEFINITION changes. When
      // the accepted request re-states the definition the Role already holds,
      // nothing changed, so the token must not advance — moving it would
      // invalidate every other administrator's in-flight preview for no
      // reason. Return the stored definition untouched (no rewrite, no audit).
      const nextDescription = input.description ?? null;
      if (
        input.name === current.name &&
        nextDescription === current.description &&
        sameStringArrays(permissionCodes, current.permissionCodes) &&
        sameWindows(windows, current.windows)
      ) {
        return current;
      }

      await this.protectTenantManagers(client, actor, role.id, permissionCodes);

      const affectedUserCountBefore = await this.countRoleAssignments(
        client,
        actor.tenantId,
        role.id,
      );

      await client.query(
        `UPDATE roles SET name = $1, description = $2, version = version + 1 WHERE id = $3`,
        [input.name, nextDescription, role.id],
      );
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [
        role.id,
      ]);
      await client.query(
        `DELETE FROM role_window_access WHERE tenant_id = $1 AND role_id = $2`,
        [actor.tenantId, role.id],
      );
      await this.writeRoleGrants(
        client,
        actor.tenantId,
        role.id,
        permissionCodes,
        windows,
      );

      const after = await this.loadRoleDefinition(client, {
        id: role.id,
        tenant_id: actor.tenantId,
        code: roleCode,
        name: input.name,
        description: nextDescription,
        is_active: current.isActive,
        is_full_access: current.isFullAccess,
        version: current.version + 1,
      });
      await this.recordRoleDefinitionAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        roleCode,
        roleId: role.id,
        action: "role.definition_updated",
        before: current,
        after,
        affectedUserCount: affectedUserCountBefore,
      });
      return after;
    });
  }

  async deleteRoleDefinition(
    actor: GovernedActor,
    roleCode: string,
  ): Promise<void> {
    await this.inGovernedTransaction(actor.tenantId, async (client) => {
      await this.requireTransactionRoleDefinitionAuthority(client, actor);

      const role = await this.loadRoleRow(client, actor.tenantId, roleCode);
      const current = await this.loadRoleDefinition(client, role);

      // §4.4 G: a Role is deleted only when it is not in use. ANY retained
      // assignment ROW refuses the delete — invalidated ones and ones whose
      // user was soft-deleted included — because `user_role_assignments.
      // role_id` is ON DELETE CASCADE, so proceeding would erase access
      // history with no trace. Counting DISTINCT active users here would let
      // exactly those rows through.
      const retained = await this.countRetainedAssignments(
        client,
        actor.tenantId,
        role.id,
      );
      if (retained > 0) {
        throw new ConflictError(
          `Cannot delete Role '${roleCode}': ${retained} User assignment(s) still reference it`,
        );
      }

      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [
        role.id,
      ]);
      await client.query(
        `DELETE FROM role_window_access WHERE tenant_id = $1 AND role_id = $2`,
        [actor.tenantId, role.id],
      );
      await client.query(`DELETE FROM roles WHERE id = $1 AND tenant_id = $2`, [
        role.id,
        actor.tenantId,
      ]);
      await this.recordRoleDefinitionAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        roleCode,
        roleId: role.id,
        action: "role.definition_deleted",
        before: current,
        after: null,
      });
    });
  }

  /**
   * Epic 4 open item 2 — deactivate / reactivate a Role (§4.4).
   *
   * The guard is the mirror image of the delete guard, and the difference is
   * the point. Delete counts every RETAINED row because the FK would cascade
   * them away with no trace; deactivation keeps its rows, so only LIVE ones
   * matter — a revoked or scope-invalidated row grants nothing and must not
   * make a Role undeactivatable.
   *
   * The reference count on its own covers the lockout risk. A Role holding
   * Role-definition authority does so through an effective assignment, and an
   * effective assignment is live, so the last manager is already inside this
   * count. Checking `roleDefinitionAuthorityCountSql` on top would re-derive
   * the same refusal from a narrower population.
   *
   * Both directions are idempotent: asking for the state the Role is already
   * in returns the stored definition without advancing `version` or writing an
   * audit row, for the same reason the definition no-op path does — a token
   * that moves on nothing invalidates other administrators' previews for free.
   */
  async setRoleDefinitionActive(
    actor: GovernedActor,
    roleCode: string,
    isActive: boolean,
  ): Promise<RoleDefinition> {
    return this.inGovernedTransaction(actor.tenantId, async (client) => {
      await this.requireTransactionRoleDefinitionAuthority(client, actor);

      const role = await this.loadRoleRow(client, actor.tenantId, roleCode);
      const current = await this.loadRoleDefinition(client, role);

      if (current.isActive === isActive) return current;

      if (!isActive) {
        const live = await this.countLiveAssignments(
          client,
          actor.tenantId,
          role.id,
        );
        if (live > 0) {
          throw new ConflictError(
            `Cannot deactivate Role '${roleCode}': ${live} live User assignment(s) still reference it`,
          );
        }
      }

      // `version` advances here too. Deactivation is not a metadata edit: it
      // changes whether the Role authorizes at all, so any in-flight preview
      // approved against the previous state must be refused.
      await client.query(
        `UPDATE roles SET is_active = $1, version = version + 1 WHERE id = $2`,
        [isActive, role.id],
      );

      const after = await this.loadRoleDefinition(client, {
        id: role.id,
        tenant_id: actor.tenantId,
        code: roleCode,
        name: current.name,
        description: current.description,
        is_active: isActive,
        is_full_access: current.isFullAccess,
        version: current.version + 1,
      });
      await this.recordRoleDefinitionAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        roleCode,
        roleId: role.id,
        action: isActive
          ? "role.definition_activated"
          : "role.definition_deactivated",
        before: current,
        after,
      });
      return after;
    });
  }

  private async loadRoleRow(
    client: PoolClient | Pool,
    tenantId: string,
    roleCode: string,
  ): Promise<{
    id: string;
    tenant_id: string;
    code: string;
    name: string;
    description: string | null;
    is_active: boolean;
    is_full_access: boolean;
    version: number;
  }> {
    const result = await client.query(
      `SELECT id, tenant_id, code, name, description, is_active, COALESCE(is_full_access, false) AS is_full_access, version
         FROM roles
        WHERE tenant_id = $1 AND code = $2`,
      [tenantId, roleCode],
    );
    if (!result.rows[0]) throw new NotFoundError("Role", roleCode);
    return result.rows[0];
  }

  private async lockTenant(
    client: PoolClient,
    tenantId: string,
  ): Promise<void> {
    const lockedTenant = await client.query(
      `SELECT id FROM tenants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [tenantId],
    );
    if (!lockedTenant.rows[0]) throw new NotFoundError("Tenant", tenantId);
  }

  private async loadRoleDefinition(
    client: PoolClient | Pool,
    role: {
      id: string;
      tenant_id: string;
      code: string;
      name: string;
      description: string | null;
      is_active: boolean;
      is_full_access: boolean;
      version: number;
    },
  ): Promise<RoleDefinition> {
    const permissions = await client.query(
      `SELECT p.code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1
        ORDER BY p.code`,
      [role.id],
    );
    const windows = await client.query(
      `SELECT window_code, is_read_write, is_active
         FROM role_window_access
        WHERE tenant_id = $1 AND role_id = $2
        ORDER BY window_code`,
      [role.tenant_id, role.id],
    );
    return {
      id: role.id,
      tenantId: role.tenant_id,
      code: role.code,
      name: role.name,
      description: role.description,
      isActive: role.is_active,
      isFullAccess: role.is_full_access,
      version: role.version,
      permissionCodes: permissions.rows.map((r: { code: string }) => r.code),
      windows: windows.rows.map(
        (r: {
          window_code: string;
          is_read_write: boolean;
          is_active: boolean;
        }) => ({
          windowCode: r.window_code,
          isReadWrite: r.is_read_write,
          isActive: r.is_active,
        }),
      ),
      enforcementStatus: windowEnforcementStatus(),
    };
  }

  /**
   * Authority revalidation INSIDE the tenant lock, in the same shape as
   * `requireTransactionActorAuthority`: actor active in tenant, holding
   * `admin.console.read` from an effective assignment, AND holding BOTH
   * `role.manage` and `config.read` from ONE tenant-scoped assignment. The
   * single-assignment rule is what keeps delegation authority from being
   * manufactured out of unrelated Roles.
   */
  private async requireTransactionRoleDefinitionAuthority(
    client: PoolClient,
    actor: GovernedActor,
  ): Promise<void> {
    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1
           FROM users u
          WHERE u.id = $2
            AND u.tenant_id = $1
            AND u.deleted_at IS NULL
            AND u.status = 'active'
            AND EXISTS (
              SELECT 1
                FROM authorization_effective_user_role_assignments entry_aura
                JOIN role_permissions entry_rp ON entry_rp.role_id = entry_aura.role_id
                JOIN permissions entry_p ON entry_p.id = entry_rp.permission_id
               WHERE entry_aura.user_id = u.id
                 AND entry_aura.tenant_id = u.tenant_id
                 AND entry_p.code = $3
            )
            AND EXISTS (
              SELECT 1
                FROM authorization_effective_user_role_assignments manager_aura
                JOIN role_permissions manager_rp ON manager_rp.role_id = manager_aura.role_id
                JOIN permissions manager_p ON manager_p.id = manager_rp.permission_id
               WHERE manager_aura.user_id = u.id
                 AND manager_aura.tenant_id = u.tenant_id
                 AND manager_aura.scope_type = 'tenant'
                 AND manager_aura.scope_organization_unit_id IS NULL
                 AND manager_aura.scope_customer_id IS NULL
               GROUP BY manager_aura.id
              HAVING COUNT(DISTINCT CASE WHEN manager_p.code IN ($4, $5) THEN manager_p.code END) = 2
            )
       ) AS allowed`,
      [
        actor.tenantId,
        actor.userId,
        ADMIN_CONSOLE_READ,
        ROLE_MANAGE,
        CONFIG_READ,
      ],
    );
    if (result.rows[0]?.allowed !== true) {
      throw new ForbiddenError(
        "Admin Console access or Role definition management authority is missing",
      );
    }
  }

  /**
   * The ROLE-DEFINITION delegation ceiling (§4.4 A, Wave 1): the permission
   * set of the ONE tenant-scoped assignment that carries both `role.manage`
   * and `config.read`. Authority from other assignments is never unioned in.
   *
   * `role.manage` is the right anchor here because rewriting a Role definition
   * IS the act being authorized, and `config.read` is the Wave 1 gate's own
   * second token. The assignment surfaces use
   * `assignmentDelegablePermissionCodes` instead — the two ceilings answer
   * different questions and must not be swapped.
   */
  private async roleDefinitionDelegablePermissionCodes(
    client: PoolClient,
    actor: GovernedActor,
  ): Promise<Set<string>> {
    const result = await client.query(
      `SELECT DISTINCT p.code
         FROM authorization_effective_user_role_assignments aura
         JOIN role_permissions rp ON rp.role_id = aura.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE aura.user_id = $2
          AND aura.tenant_id = $1
          AND aura.scope_type = 'tenant'
          AND aura.scope_organization_unit_id IS NULL
          AND aura.scope_customer_id IS NULL
          AND aura.role_id IN (
            SELECT m.role_id
              FROM authorization_effective_user_role_assignments m
              JOIN role_permissions mrp ON mrp.role_id = m.role_id
              JOIN permissions mp ON mp.id = mrp.permission_id
             WHERE m.user_id = $2
               AND m.tenant_id = $1
               AND m.scope_type = 'tenant'
               AND m.scope_organization_unit_id IS NULL
               AND m.scope_customer_id IS NULL
             GROUP BY m.role_id
            HAVING COUNT(DISTINCT CASE WHEN mp.code IN ($3, $4) THEN mp.code END) = 2
          )`,
      [actor.tenantId, actor.userId, ROLE_MANAGE, CONFIG_READ],
    );
    return new Set(result.rows.map((r: { code: string }) => r.code));
  }

  /**
   * The delegation ceiling for the ASSIGNMENT surfaces (§4.4 H step 4): the
   * permission set of the actor's own effective, non-Customer assignments that
   * carry `user.role.manage`.
   *
   * The anchor permission is the one that authorizes the act being attempted.
   * A Role-definition ceiling anchored on `role.manage` answers a different
   * question — "may the actor rewrite a Role?" — and is a different helper
   * below. Reusing that one here made the assignment surfaces simultaneously
   * stricter than the Role surfaces and inconsistent with the single-assignment
   * route, which had no ceiling at all (§4.4 D forbids that).
   *
   * The anchor is deliberately NOT restricted to tenant scope. §4.4 E enables
   * an Admin Tenant whose `user.role.manage` sits on an Organization Unit; a
   * tenant-only anchor leaves that actor with an empty ceiling and a picker
   * where no Role is selectable, while `resolveAdministrativeVisibilityIn`
   * still hands them a subtree to administer. What they grant is already
   * bounded by that visibility, so the ceiling only has to answer "may the
   * actor hand this permission out at all" — and the honest answer is the
   * actor's own permission set, never the global catalog (§4.4 A).
   *
   * Customer-scoped assignments contribute nothing: they confer no internal
   * authority anywhere else in this repository, and letting one act as an
   * anchor would let a Customer-facing grant enlarge an internal one.
   */
  private async assignmentDelegablePermissionCodes(
    client: PoolClient,
    actor: GovernedActor,
  ): Promise<Set<string>> {
    const result = await client.query(
      `SELECT DISTINCT p.code
         FROM authorization_effective_user_role_assignments aura
         JOIN role_permissions rp ON rp.role_id = aura.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE aura.user_id = $2
          AND aura.tenant_id = $1
          AND aura.scope_customer_id IS NULL
          AND aura.role_id IN (
            SELECT anchor_rp.role_id
              FROM role_permissions anchor_rp
              JOIN permissions anchor_p ON anchor_p.id = anchor_rp.permission_id
             WHERE anchor_p.code = $3
          )`,
      [actor.tenantId, actor.userId, USER_ROLE_MANAGE],
    );
    return new Set(result.rows.map((r: { code: string }) => r.code));
  }

  private async activeModuleCodes(
    client: PoolClient,
    tenantId: string,
  ): Promise<Set<string>> {
    const result = await client.query(
      `SELECT m.code
         FROM modules m
         JOIN tenant_module_activations tma ON tma.module_id = m.id AND tma.tenant_id = $1
        WHERE tma.is_active = true`,
      [tenantId],
    );
    return new Set(result.rows.map((r: { code: string }) => r.code));
  }

  /**
   * Turn on every module for a freshly provisioned Tenant. See
   * TenantService.create: the module-activity write gate leaves a
   * zero-activation tenant unable to accept any write at all, which made
   * every new deployment land dead on arrival. Activation remains
   * reversible per module afterwards.
   */
  async activateAllModulesForTenant(tenantId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_module_activations (tenant_id, module_id, is_active, updated_by)
       SELECT $1, m.id, true, NULL
         FROM modules m
        WHERE m.code <> 'platform'
       ON CONFLICT (tenant_id, module_id) DO UPDATE SET is_active = true, updated_at = now()`,
      [tenantId],
    );
  }

  private async registeredProcessCodes(
    client: PoolClient,
    tenantId: string,
  ): Promise<Set<string>> {
    const result = await client.query(
      `SELECT code FROM app_processes WHERE tenant_id = $1 AND is_active = true`,
      [tenantId],
    );
    return new Set(result.rows.map((r: { code: string }) => r.code));
  }

  /**
   * Validate a proposed permission set. A code that is ALREADY on the Role may
   * be preserved even if its module was since deactivated; a NEW grant must be
   * attributable, registered as an active Process, fall inside an active module
   * (platform exempt), and sit within the delegation ceiling.
   */
  private async validateProposedGrants(
    client: PoolClient,
    actor: GovernedActor,
    proposed: readonly string[],
    existing: Set<string>,
  ): Promise<string[]> {
    const codes = [...new Set(proposed)];
    if (codes.length !== proposed.length) {
      throw new ValidationError("Duplicate permission codes are not allowed");
    }
    const delegable = await this.roleDefinitionDelegablePermissionCodes(client, actor);
    const activeModules = await this.activeModuleCodes(client, actor.tenantId);
    const registered = await this.registeredProcessCodes(
      client,
      actor.tenantId,
    );

    const catalog = await client.query(
      `SELECT code FROM permissions WHERE code = ANY($1::text[])`,
      [codes],
    );
    const known = new Set(catalog.rows.map((r: { code: string }) => r.code));

    for (const code of codes) {
      if (!known.has(code))
        throw new ValidationError(`Unknown permission code '${code}'`);
      if (!delegable.has(code)) {
        throw new ValidationError(
          `Permission '${code}' is outside your delegation authority`,
        );
      }
      if (existing.has(code)) continue;
      const moduleCode = attributePermission(code);
      if (moduleCode === undefined) {
        throw new ValidationError(`Permission '${code}' has no owning module`);
      }
      if (!registered.has(code)) {
        throw new ValidationError(
          `Permission '${code}' is not a registered active process`,
        );
      }
      if (moduleCode !== "platform" && !activeModules.has(moduleCode)) {
        throw new ValidationError(
          `Module '${moduleCode}' is not active for this tenant`,
        );
      }
    }
    return codes.sort();
  }

  /** Same preservation rule as permissions, applied to window access rows. */
  private async validateProposedWindows(
    client: PoolClient,
    actor: GovernedActor,
    proposed: readonly WindowAccessInput[],
    existing: Set<string>,
  ): Promise<WindowAccessInput[]> {
    const codes = proposed.map((w) => w.windowCode);
    if (new Set(codes).size !== codes.length) {
      throw new ValidationError("Duplicate window codes are not allowed");
    }
    const delegable = await this.roleDefinitionDelegablePermissionCodes(client, actor);
    const activeModules = await this.activeModuleCodes(client, actor.tenantId);

    const rows = await client.query(
      `SELECT code, module_code, registration_status, required_permissions
         FROM app_windows
        WHERE tenant_id = $1 AND code = ANY($2::text[]) AND is_active = true`,
      [actor.tenantId, [...new Set([...codes, ...existing])]],
    );
    const byCode = new Map<
      string,
      {
        module_code: string;
        registration_status: string;
        required_permissions: string[];
      }
    >();
    for (const row of rows.rows) {
      byCode.set(row.code, {
        module_code: row.module_code,
        registration_status: row.registration_status,
        required_permissions: row.required_permissions ?? [],
      });
    }

    for (const window of proposed) {
      if (window.windowCode === WILDCARD_WINDOW_CODE) {
        throw new ValidationError(
          "The wildcard route is not a grantable window",
        );
      }
      if (existing.has(window.windowCode)) continue;
      const row = byCode.get(window.windowCode);
      if (!row)
        throw new ValidationError(
          `Unknown or inactive window '${window.windowCode}'`,
        );
      if (
        !REGISTERED_WINDOW_STATUSES.includes(
          row.registration_status as "di_menu" | "tersembunyi",
        )
      ) {
        throw new ValidationError(
          `Window '${window.windowCode}' is not registered`,
        );
      }
      if (
        row.module_code !== "platform" &&
        !activeModules.has(row.module_code)
      ) {
        throw new ValidationError(
          `Module '${row.module_code}' is not active for this tenant`,
        );
      }
      for (const required of row.required_permissions) {
        if (!delegable.has(required)) {
          throw new ValidationError(
            `Window '${window.windowCode}' needs permission '${required}' outside your delegation authority`,
          );
        }
      }
    }
    return [...proposed].sort((a, b) =>
      a.windowCode < b.windowCode ? -1 : a.windowCode > b.windowCode ? 1 : 0,
    );
  }

  private async writeRoleGrants(
    client: PoolClient,
    tenantId: string,
    roleId: string,
    permissionCodes: readonly string[],
    windows: readonly WindowAccessInput[],
  ): Promise<void> {
    if (permissionCodes.length > 0) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, p.id FROM permissions p WHERE p.code = ANY($2::text[])`,
        [roleId, [...permissionCodes]],
      );
    }
    for (const window of windows) {
      await client.query(
        `INSERT INTO role_window_access (tenant_id, role_id, window_code, is_read_write, is_active)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          roleId,
          window.windowCode,
          window.isReadWrite,
          window.isActive,
        ],
      );
    }
  }

  /** Every retained assignment ROW for a Role, invalidated and soft-deleted
   * user included. This is the delete guard's whole population: the FK from
   * `user_role_assignments` to `roles` is ON DELETE CASCADE, so any row left
   * out of the count is a row that would vanish silently with the Role. */
  private async countRetainedAssignments(
    client: PoolClient,
    tenantId: string,
    roleId: string,
  ): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM user_role_assignments ura
         JOIN users u ON u.id = ura.user_id AND u.tenant_id = $1
        WHERE ura.role_id = $2`,
      [tenantId, roleId],
    );
    return result.rows[0].count as number;
  }

  private async countRoleAssignments(
    client: PoolClient,
    tenantId: string,
    roleId: string,
  ): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(DISTINCT ura.user_id)::int AS count
         FROM user_role_assignments ura
         JOIN users u ON u.id = ura.user_id AND u.tenant_id = $1 AND u.deleted_at IS NULL
        WHERE ura.role_id = $2`,
      [tenantId, roleId],
    );
    return result.rows[0].count as number;
  }

  /** LIVE assignment rows for a Role: not revoked, not scope-invalidated. The
   * deactivation guard's population — unlike the delete guard's retained-row
   * count, dead rows do not block deactivation because deactivation keeps
   * them, and they grant nothing. */
  private async countLiveAssignments(
    client: PoolClient,
    tenantId: string,
    roleId: string,
  ): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM user_role_assignments ura
         JOIN users u ON u.id = ura.user_id AND u.tenant_id = $1
        WHERE ura.role_id = $2
          AND ura.revoked_at IS NULL
          AND ura.scope_invalidated_at IS NULL`,
      [tenantId, roleId],
    );
    return result.rows[0].count as number;
  }

  /**
   * How many active Users still hold Role definition authority once the Role
   * under edit ($2) carries the proposed permission set ($3).
   *
   * Authority is a SHAPE, not a label, and it is reproduced here exactly as
   * `requireTransactionRoleDefinitionAuthority` checks it: an effective
   * `admin.console.read` ticket ($4) plus ONE tenant-scoped assignment
   * carrying both `role.manage` and `config.read` ($5, $6). The Role being
   * edited is scored with the proposed grants, every other Role with its
   * stored rows, so the result is the post-commit reality rather than a
   * per-permission headcount — a Role left holding only half the tuple counts
   * as holding none of the authority. `$7` restricts the scan to one User.
   */
  private roleDefinitionAuthorityCountSql = `
    WITH role_grants(role_id, permission_id) AS (
      SELECT $2::uuid, p.id FROM permissions p WHERE p.code = ANY($3::text[])
      UNION ALL
      SELECT rp.role_id, rp.permission_id
        FROM role_permissions rp
       WHERE rp.role_id <> $2::uuid
    )
    SELECT COUNT(*)::int AS count
      FROM users u
     WHERE u.tenant_id = $1
       AND u.deleted_at IS NULL
       AND u.status = 'active'
       AND ($7::uuid IS NULL OR u.id = $7)
       AND EXISTS (
         SELECT 1
           FROM authorization_effective_user_role_assignments entry_aura
           JOIN role_grants entry_grants ON entry_grants.role_id = entry_aura.role_id
           JOIN permissions entry_p ON entry_p.id = entry_grants.permission_id
          WHERE entry_aura.user_id = u.id
            AND entry_aura.tenant_id = u.tenant_id
            AND entry_p.code = $4
       )
       AND EXISTS (
         SELECT 1
           FROM authorization_effective_user_role_assignments manager_aura
           JOIN role_grants manager_grants ON manager_grants.role_id = manager_aura.role_id
           JOIN permissions manager_p ON manager_p.id = manager_grants.permission_id
          WHERE manager_aura.user_id = u.id
            AND manager_aura.tenant_id = u.tenant_id
            AND manager_aura.scope_type = 'tenant'
            AND manager_aura.scope_organization_unit_id IS NULL
            AND manager_aura.scope_customer_id IS NULL
          GROUP BY manager_aura.id
         HAVING COUNT(DISTINCT CASE WHEN manager_p.code IN ($5, $6) THEN manager_p.code END) = 2
       )`;

  /**
   * §4.4 F — self-management and final-manager protection.
   *
   * The previous guard watched only the two manager labels, so it let the
   * actor remove `config.read` (or `admin.console.read`) from the very Role
   * they manage Roles with: every per-permission count still found a holder,
   * and the next request 403'd. The check below asks the only question that
   * matters — how many Users satisfy the whole shape after the commit.
   *
   * That single number carries both duties. This guard runs inside the same
   * transaction as `requireTransactionRoleDefinitionAuthority`, so the caller
   * provably satisfies the shape at entry. A post-change count of zero
   * therefore means the actor has just stripped their own authority AND that
   * the tenant is left with no Role definition manager; one or more means the
   * actor provably kept it. There is no third case, so there is no second
   * query. Adding a call site that skips the entry check would break that
   * reasoning, so it must come with the actor-scoped count instead.
   */
  private async protectTenantManagers(
    client: PoolClient,
    actor: GovernedActor,
    roleId: string,
    proposed: readonly string[],
  ): Promise<void> {
    const removed = await this.findRemovedAuthorityPermissions(
      client,
      roleId,
      proposed,
    );
    if (removed.length === 0) return;

    const remaining = await client.query(this.roleDefinitionAuthorityCountSql, [
      actor.tenantId,
      roleId,
      [...proposed],
      ADMIN_CONSOLE_READ,
      ROLE_MANAGE,
      CONFIG_READ,
      null,
    ]);
    if ((remaining.rows[0].count as number) > 0) return;

    throw new ConflictError(
      `Cannot remove ${removed.map((code) => `'${code}'`).join(", ")}: ` +
        "no active User would retain Role definition authority, which would " +
        "strip your own access to this screen as well",
    );
  }

  /** Which authority permissions the commit would remove from the Role. When
   * this is empty the post-change shape cannot differ from the stored one,
   * because nothing in the shape was touched. */
  private async findRemovedAuthorityPermissions(
    client: PoolClient,
    roleId: string,
    proposed: readonly string[],
  ): Promise<string[]> {
    const existing = await client.query(
      `SELECT p.code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 AND p.code = ANY($2::text[])`,
      [roleId, [...ROLE_DEFINITION_AUTHORITY_PERMISSIONS]],
    );
    const proposedSet = new Set(proposed);
    return existing.rows
      .map((r: { code: string }) => r.code)
      .filter((code: string) => !proposedSet.has(code));
  }

  private async loadWindowOptions(
    client: PoolClient,
    tenantId: string,
    activeModules: Set<string>,
    delegable: Set<string>,
  ): Promise<WindowOption[]> {
    const result = await client.query(
      `SELECT code, name, module_code, registration_status, required_permissions, parent_path
         FROM app_windows
        WHERE tenant_id = $1 AND is_active = true
          AND code <> $2
        ORDER BY code`,
      [tenantId, WILDCARD_WINDOW_CODE],
    );
    const options: WindowOption[] = [];
    for (const row of result.rows) {
      if (
        !REGISTERED_WINDOW_STATUSES.includes(
          row.registration_status as "di_menu" | "tersembunyi",
        )
      ) {
        continue;
      }
      const required: string[] = row.required_permissions ?? [];
      const selectable =
        (row.module_code === "platform" ||
          activeModules.has(row.module_code)) &&
        required.every((code) => delegable.has(code));
      options.push({
        code: row.code,
        name: row.name,
        moduleCode: row.module_code,
        registrationStatus: row.registration_status,
        requiredPermissions: required,
        parentPath: row.parent_path ?? null,
        isDetail: isDetailWindow(row.code),
        selectable,
      });
    }
    return options;
  }

  private async recordRoleDefinitionAudit(
    client: PoolClient,
    input: {
      tenantId: string;
      actorUserId: string;
      roleCode: string;
      roleId: string;
      action:
        | "role.definition_created"
        | "role.definition_copied"
        | "role.definition_updated"
        | "role.definition_deleted"
        | "role.definition_deactivated"
        | "role.definition_activated";
      before: RoleDefinition | null;
      after: RoleDefinition | null;
      affectedUserCount?: number;
    },
  ): Promise<void> {
    const metadata = {
      roleCode: input.roleCode,
      before: input.before
        ? {
            name: input.before.name,
            description: input.before.description,
            isActive: input.before.isActive,
            permissionCodes: input.before.permissionCodes,
            windows: input.before.windows,
            version: input.before.version,
          }
        : null,
      after: input.after
        ? {
            name: input.after.name,
            description: input.after.description,
            isActive: input.after.isActive,
            permissionCodes: input.after.permissionCodes,
            windows: input.after.windows,
            version: input.after.version,
          }
        : null,
      ...(input.affectedUserCount === undefined
        ? {}
        : { affectedUserCount: input.affectedUserCount }),
    };
    await client.query(
      `INSERT INTO audit_log
         (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, 'role', $4, $5::jsonb)`,
      [
        input.tenantId,
        input.actorUserId,
        input.action,
        input.roleId,
        JSON.stringify(metadata),
      ],
    );
  }

  private async inGovernedTransaction<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockTenant(client, tenantId);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireTransactionActorAuthority(
    client: PoolClient,
    actor: GovernedActor,
  ): Promise<void> {
    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1
           FROM users u
          WHERE u.id = $2
            AND u.tenant_id = $1
            AND u.deleted_at IS NULL
            AND u.status = 'active'
            AND EXISTS (
              SELECT 1
                FROM authorization_effective_user_role_assignments entry_aura
                JOIN role_permissions entry_rp ON entry_rp.role_id = entry_aura.role_id
                JOIN permissions entry_p ON entry_p.id = entry_rp.permission_id
               WHERE entry_aura.user_id = u.id
                 AND entry_aura.tenant_id = u.tenant_id
                 AND entry_p.code = $3
            )
            AND EXISTS (
              SELECT 1
                FROM authorization_effective_user_role_assignments manager_aura
                JOIN role_permissions manager_rp ON manager_rp.role_id = manager_aura.role_id
                JOIN permissions manager_p ON manager_p.id = manager_rp.permission_id
               WHERE manager_aura.user_id = u.id
                 AND manager_aura.tenant_id = u.tenant_id
                 AND manager_aura.scope_type = 'tenant'
                 AND manager_aura.scope_organization_unit_id IS NULL
                 AND manager_aura.scope_customer_id IS NULL
                 AND manager_p.code = $4
            )
       ) AS allowed`,
      [actor.tenantId, actor.userId, "admin.console.read", USER_ROLE_MANAGE],
    );
    if (result.rows[0]?.allowed !== true) {
      throw new ForbiddenError(
        "Admin Console access or tenant-scoped User access management authority is missing",
      );
    }
  }

  /**
   * Epic 5 G3 — resolve one Legal Entity scope target for a governed write.
   *
   * Three questions, in the order the other scope families ask them:
   *
   * 1. does the Legal Entity exist in the actor's Tenant and is it not
   *    deleted? (a foreign or missing target must be indistinguishable — the
   *    same 404 the Organization Unit branch raises);
   * 2. is it ACTIVE? §4.5 Putaran 6: an inactive Legal Entity "tidak boleh
   *    dipakai transaksi baru", and a grant is the creation of new authority.
   *    The refusal names the lifecycle, not a mystery 422;
   * 3. is it inside the actor's own administrative visibility? A units actor
   *    may scope to a Legal Entity only when every Organization Unit of that
   *    Legal Entity is already inside the units they cover — the Legal Entity
   *    scope resolves to exactly those units, so anything less would let them
   *    grant authority over units they cannot see.
   *
   * Returns the display name so the caller's projection names the target
   * without a second query.
   */
  private async resolveLegalEntityScopeTarget(
    client: PoolClient,
    actor: GovernedActor,
    visibility: AdministrativeVisibility,
    legalEntityId: string,
  ): Promise<string> {
    const target = await client.query<{ name: string; status: string }>(
      `SELECT name, status
         FROM legal_entities
        WHERE id = $1
          AND tenant_id = $2
          AND deleted_at IS NULL`,
      [legalEntityId, actor.tenantId],
    );
    const legalEntity = target.rows[0];
    if (!legalEntity) throw new NotFoundError("Legal Entity", legalEntityId);
    if (legalEntity.status !== "active") {
      throw new ValidationError(
        "A Legal Entity must be active before Role assignments can be scoped to it",
      );
    }
    if (visibility.kind === "units") {
      const unitIds = await listOrganizationUnitIdsForLegalEntityIn(
        client,
        actor.tenantId,
        legalEntityId,
      );
      if (!unitIds.every((id) => visibility.organizationUnitIds.includes(id))) {
        throw new ForbiddenError("Assignment target is outside your Data Scope");
      }
    }
    return legalEntity.name;
  }

  /**
   * Epic 4 Wave 2 rewire of the Phase 11F write gates (§4.4 D): the console
   * entry ticket alone, at ANY Data Scope. The tenant-scoped
   * `user.role.manage` requirement it used to bundle moved to
   * `requireAdministrativeVisibilityIn`, which accepts the narrower
   * Organization Unit authority and returns the visibility that governs which
   * targets the actor may reach — so a narrow actor is refused by target (404),
   * not by gate (403).
   */
  private async requireTransactionConsoleEntry(
    client: PoolClient,
    actor: GovernedActor,
  ): Promise<void> {
    const result = await client.query(
      `SELECT EXISTS (
         SELECT 1
           FROM users u
          WHERE u.id = $2
            AND u.tenant_id = $1
            AND u.deleted_at IS NULL
            AND u.status = 'active'
            AND EXISTS (
              SELECT 1
                FROM authorization_effective_user_role_assignments entry_aura
                JOIN role_permissions entry_rp ON entry_rp.role_id = entry_aura.role_id
                JOIN permissions entry_p ON entry_p.id = entry_rp.permission_id
               WHERE entry_aura.user_id = u.id
                 AND entry_aura.tenant_id = u.tenant_id
                 AND entry_p.code = $3
            )
       ) AS allowed`,
      [actor.tenantId, actor.userId, ADMIN_CONSOLE_READ],
    );
    if (result.rows[0]?.allowed !== true) {
      throw new ForbiddenError("Admin Console access is missing");
    }
  }

  private async recordGovernedAudit(
    client: PoolClient,
    input: {
      tenantId: string;
      actorUserId: string;
      targetUserId: string;
      action: "user.role_assigned" | "user.role_revoked";
      /** §4.4 step 21 — before/after, not just the resulting state. A revoke
       * keeps its row, so the audit has to say what the grant was and what it
       * became, alongside the operator's reason. */
      before?: AdminRoleAssignmentSummary;
      after?: AdminRoleAssignmentSummary;
    },
  ): Promise<void> {
    const metadata = {
      targetUserId: input.targetUserId,
      roleCode: input.after?.roleCode ?? input.before?.roleCode ?? null,
      scopeType: input.after?.scopeType ?? input.before?.scopeType ?? null,
      scopeOrganizationUnitId:
        input.after?.scopeOrganizationUnitId ??
        input.before?.scopeOrganizationUnitId ??
        null,
      scopeCustomerId:
        input.after?.scopeCustomerId ?? input.before?.scopeCustomerId ?? null,
      ...(input.before && input.after
        ? {
            before: auditLifecycleSnapshot(input.before),
            after: auditLifecycleSnapshot(input.after),
            reason: input.after.revokeReason,
            assignmentId: input.after.id,
          }
        : {}),
    };
    await client.query(
      `INSERT INTO audit_log
         (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, 'user', $4, $5::jsonb)`,
      [
        input.tenantId,
        input.actorUserId,
        input.action,
        input.targetUserId,
        JSON.stringify(metadata),
      ],
    );
  }

  async listUserIdsWithPermissionInTenant(
    tenantId: string,
    permissionCode: string,
  ): Promise<string[]> {
    // Capability-based recipient resolution (Checkpoint 1E.2). Internal
    // scopes only — `customer`-scoped assignments are deliberately excluded
    // so a Customer User can never be an internal management recipient. The
    // three internal families are tenant, legal_entity (Epic 5 G3) and
    // organization_unit.
    const result = await this.pool.query(
      `SELECT DISTINCT aura.user_id
         FROM authorization_effective_user_role_assignments aura
         JOIN role_permissions rp ON rp.role_id = aura.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE aura.tenant_id = $1
          AND p.code = $2
          AND aura.scope_type IN ('tenant', 'legal_entity', 'organization_unit')`,
      [tenantId, permissionCode],
    );
    return result.rows.map((r) => r.user_id);
  }

  async getEffectivePermissionCodes(userId: string): Promise<Set<string>> {
    const result = await this.pool.query(
      `SELECT DISTINCT p.code
         FROM authorization_effective_user_role_assignments aura
         JOIN role_permissions rp ON rp.role_id = aura.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE aura.user_id = $1`,
      [userId],
    );
    return new Set(result.rows.map((r) => r.code));
  }

  /**
   * Included-role closure (AD_Role_Included parity): all role ids a role
   * inherits from, depth-limited to guard against cycles. Own id first,
   * then every included role transitively.
   */
  async resolveIncludedRoleIds(tenantId: string, roleId: string): Promise<string[]> {
    const seen = new Set<string>([roleId]);
    let frontier = [roleId];
    for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
      const r = await this.pool.query(
        `SELECT included_role_id FROM role_included
          WHERE tenant_id = $1 AND parent_role_id = ANY($2::uuid[])`,
        [tenantId, frontier],
      );
      frontier = r.rows
        .map((row: { included_role_id: string }) => row.included_role_id)
        .filter((id: string) => !seen.has(id));
      for (const id of frontier) seen.add(id);
    }
    return [...seen];
  }

  /** Window access for a role including its included roles (union). */
  async getWindowAccessForRole(tenantId: string, roleId: string): Promise<{ windowCode: string; isReadWrite: boolean; accessTypes: string[] }[]> {
    const roleIds = await this.resolveIncludedRoleIds(tenantId, roleId);
    const r = await this.pool.query(
      `SELECT wa.window_code, wa.is_read_write,
              COALESCE(array_agg(wat.access_type) FILTER (WHERE wat.access_type IS NOT NULL), '{}') AS access_types
         FROM window_access wa
         LEFT JOIN window_access_types wat ON wat.window_access_id = wa.id
        WHERE wa.tenant_id = $1 AND wa.role_id = ANY($2::uuid[]) AND wa.revoked_at IS NULL
        GROUP BY wa.window_code, wa.is_read_write`,
      [tenantId, roleIds],
    );
    return r.rows.map((row: { window_code: string; is_read_write: boolean; access_types: string[] }) => ({
      windowCode: row.window_code,
      isReadWrite: row.is_read_write,
      accessTypes: row.access_types ?? [],
    }));
  }
  async getEffectivePermissionCodesForAssignment(
    tenantId: string,
    assignmentId: string | null,
  ): Promise<Set<string>> {
    // Null assignmentId = session holds no effective assignment: the empty
    // set, so every permissioned route fails closed rather than opening up.
    if (assignmentId === null) return new Set();
    const result = await this.pool.query(
      `SELECT DISTINCT p.code
         FROM authorization_effective_user_role_assignments aura
         JOIN role_permissions rp ON rp.role_id = aura.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE aura.tenant_id = $1
          AND aura.id = $2`,
      [tenantId, assignmentId],
    );
    return new Set(result.rows.map((r) => r.code));
  }

  async getAssignments(userId: string): Promise<UserRoleAssignment[]> {
    const result = await this.pool.query(
      `SELECT aura.id, aura.user_id, aura.role_id, r.code AS role_code,
              aura.scope_type, aura.scope_legal_entity_id,
              aura.scope_organization_unit_id, aura.scope_customer_id
         FROM authorization_effective_user_role_assignments aura
         JOIN roles r ON r.id = aura.role_id
        WHERE aura.user_id = $1`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      roleId: row.role_id,
      roleCode: row.role_code,
      scopeType: row.scope_type,
      scopeLegalEntityId: row.scope_legal_entity_id,
      scopeOrganizationUnitId: row.scope_organization_unit_id,
      scopeCustomerId: row.scope_customer_id,
    }));
  }

  /** Phase 11F (self-service): the caller's OWN authorization-effective
   * assignments with role and scope display names resolved, so a post-login
   * "select role & site" screen can present them without holding any admin
   * permission. Unlike `listAdminUserAccess` this uses the effective view,
   * so invalidated/unavailable rows are already excluded — a user is never
   * offered a context they cannot actually act in. */
  async getMyAssignmentsWithScopeNames(
    userId: string,
  ): Promise<MyRoleAssignment[]> {
    const result = await this.pool.query(
      `SELECT aura.id,
              aura.role_id,
              r.code AS role_code,
              r.name AS role_name,
              aura.scope_type,
              aura.scope_legal_entity_id,
              le.name AS scope_legal_entity_name,
              aura.scope_organization_unit_id,
              ou.name AS scope_organization_unit_name,
              aura.scope_customer_id,
              c.name AS scope_customer_name
         FROM authorization_effective_user_role_assignments aura
         JOIN roles r ON r.id = aura.role_id
         LEFT JOIN legal_entities le
           ON le.id = aura.scope_legal_entity_id
          AND le.deleted_at IS NULL
         LEFT JOIN organization_units ou
           ON ou.id = aura.scope_organization_unit_id
          AND ou.deleted_at IS NULL
         LEFT JOIN customers c
           ON c.id = aura.scope_customer_id
          AND c.deleted_at IS NULL
        WHERE aura.user_id = $1
        ORDER BY r.name, aura.id`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      roleId: row.role_id,
      roleCode: row.role_code,
      roleName: row.role_name,
      scopeType: row.scope_type,
      scopeLegalEntityId: row.scope_legal_entity_id,
      scopeLegalEntityName: row.scope_legal_entity_name,
      scopeOrganizationUnitId: row.scope_organization_unit_id,
      scopeOrganizationUnitName: row.scope_organization_unit_name,
      scopeCustomerId: row.scope_customer_id,
      scopeCustomerName: row.scope_customer_name,
    }));
  }

  async findRoleByCode(tenantId: string, code: string): Promise<Role | null> {
    const result = await this.pool.query(
      `SELECT * FROM roles WHERE tenant_id = $1 AND code = $2`,
      [tenantId, code],
    );
    if (!result.rows[0]) return null;
    return {
      id: result.rows[0].id,
      tenantId: result.rows[0].tenant_id,
      code: result.rows[0].code,
      name: result.rows[0].name,
    };
  }

  /**
   * The one assignment writer outside the Admin Console (User creation with
   * an initial assignment, §4.4 C). It runs inside the SAME tenant lock the
   * governed paths take, because `user_role_assignments.role_id` is
   * ON DELETE CASCADE: without the lock, a Role delete can count zero
   * assignments, commit, and take a concurrently inserted assignment with it
   * — silently, with no audit.
   *
   * The role is re-resolved INSIDE the lock rather than trusted from the
   * caller's earlier lookup, so a Role deleted since that lookup is a clean
   * 404 here instead of a foreign-key error.
   */
  async assignRole(
    tenantId: string,
    input: AssignRoleInput,
    createdBy: string | null,
  ): Promise<UserRoleAssignment> {
    return this.inGovernedTransaction(tenantId, async (client) => {
      const roleResult = await client.query(
        `SELECT code FROM roles WHERE id = $1 AND tenant_id = $2`,
        [input.roleId, tenantId],
      );
      if (!roleResult.rows[0]) throw new NotFoundError("Role", input.roleId);

      let row!: {
        id: string;
        user_id: string;
        role_id: string;
        scope_type: ScopeType;
        scope_legal_entity_id: string | null;
        scope_organization_unit_id: string | null;
        scope_customer_id: string | null;
      };
      try {
        const result = await client.query<typeof row>(
          `INSERT INTO user_role_assignments
             (user_id, role_id, scope_type, scope_legal_entity_id,
              scope_organization_unit_id, scope_customer_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, user_id, role_id, scope_type, scope_legal_entity_id,
                     scope_organization_unit_id, scope_customer_id`,
          [
            input.userId,
            input.roleId,
            input.scopeType,
            input.scopeLegalEntityId ?? null,
            input.scopeOrganizationUnitId ?? null,
            input.scopeCustomerId ?? null,
            createdBy,
          ],
        );
        row = result.rows[0];
      } catch (error) {
        const databaseError = error as { code?: string; constraint?: string };
        if (
          databaseError.code === UNIQUE_VIOLATION &&
          databaseError.constraint ===
            "user_role_assignments_exact_assignment_unique"
        ) {
          throw new ConflictError("This exact Role assignment already exists");
        }
        if (databaseError.constraint === SCOPE_EXCLUSIVITY_CONSTRAINT) {
          throw new ConflictError(SCOPE_EXCLUSIVITY_MESSAGE);
        }
        if (databaseError.constraint === SOD_VIOLATION_CONSTRAINT) {
          throw new ConflictError(SOD_VIOLATION_MESSAGE);
        }
        throw error;
      }
      return {
        id: row.id,
        userId: row.user_id,
        roleId: row.role_id,
        roleCode: roleResult.rows[0].code as string,
        scopeType: row.scope_type,
        scopeLegalEntityId: row.scope_legal_entity_id,
        scopeOrganizationUnitId: row.scope_organization_unit_id,
        scopeCustomerId: row.scope_customer_id,
      };
    });
  }

  async listUserIdsWithRoleInScope(
    tenantId: string,
    roleCode: string,
    organizationUnitId: string | null,
  ): Promise<string[]> {
    // Checkpoint 0F / ADR-0009 (Hierarchical Data Scope): a role+scope
    // holder assigned to any ANCESTOR of `organizationUnitId` is also
    // eligible, not just an exact match — computed here with the same
    // upward `parent_id` walk `OrganizationUnitRepository.listAncestorIds`
    // uses, kept self-contained in this query (a single JOIN) rather than
    // a second round-trip, since this method is already tenant/role
    // scoped SQL.
    //
    // Epic 5 G3: a `legal_entity` holder of the role is eligible for a target
    // unit inside that Legal Entity — the coverage chain tenant → Legal Entity
    // → Organization Unit, resolved from the target unit's own row so this
    // query keeps the same shape (one statement, no extra round trip).
    const result = await this.pool.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id, legal_entity_id
           FROM organization_units
          WHERE id = $3
            AND tenant_id = $1
            AND deleted_at IS NULL
         UNION ALL
         SELECT ou.id, ou.parent_id, ou.legal_entity_id
           FROM organization_units ou
           JOIN ancestors a ON ou.id = a.parent_id
          WHERE ou.tenant_id = $1
            AND ou.deleted_at IS NULL
       )
       SELECT DISTINCT aura.user_id
         FROM authorization_effective_user_role_assignments aura
         JOIN roles r ON r.id = aura.role_id
        WHERE aura.tenant_id = $1
          AND r.code = $2
          AND (
            aura.scope_type = 'tenant'
            OR (
              $3::uuid IS NOT NULL
              AND aura.scope_type = 'organization_unit'
              AND aura.scope_organization_unit_id IN (SELECT id FROM ancestors)
            )
            OR (
              $3::uuid IS NOT NULL
              AND aura.scope_type = 'legal_entity'
              AND aura.scope_legal_entity_id = (
                SELECT legal_entity_id FROM ancestors WHERE id = $3::uuid
              )
            )
          )`,
      [tenantId, roleCode, organizationUnitId],
    );
    return result.rows.map((r) => r.user_id);
  }
}
