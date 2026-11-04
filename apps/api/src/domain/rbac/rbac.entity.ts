import type { WindowEnforcementStatus } from "../configuration/window-enforcement.js";
import type { ActorContext } from "../shared-kernel/audit-context.js";
import type {
  AdministrativeVisibility,
  AssignmentBatchPreview,
} from "./visibility-scope.js";

/** Epic 1 (§4.1 C) — the subset of ActorContext governed writes need: who
 * they act for and which assignment is ACTIVE. Kept as an alias so a caller
 * holding a full ActorContext passes it unchanged, while the structural type
 * still accepts test harnesses that construct only these three fields. */
export type GovernedActor = Pick<
  ActorContext,
  "tenantId" | "userId" | "assignmentId"
>;

export interface Role {
  id: string;
  tenantId: string;
  code: string;
  name: string;
}

export interface Permission {
  code: string;
  description: string;
}

/** The four Data Scope families an assignment may carry (Epic 5 §4.5
 * Putaran 4 adds `legal_entity`). Named once so every projection, input and
 * hash in this module states the same set. */
export type ScopeType = "tenant" | "legal_entity" | "organization_unit" | "customer";

/** One row of a user's effective assignment: a Role plus the Data Scope it grants. */
export interface UserRoleAssignment {
  id: string;
  userId: string;
  roleId: string;
  roleCode: string;
  scopeType: ScopeType;
  /** Epic 5 G3 — set when scopeType === "legal_entity". */
  scopeLegalEntityId?: string | null;
  scopeOrganizationUnitId: string | null;
  /** Checkpoint 1A / ADR-0011 — set when scopeType === "customer". */
  scopeCustomerId: string | null;
}

/** Self-service projection of the CALLER's own assignment — same shape as
 * `AdminRoleAssignmentSummary` but scoped to one user and read from the
 * authorization-effective view, so every row is one the user can act in.
 * Used by the post-login role & site selection screen. */
export interface MyRoleAssignment {
  id: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  scopeType: ScopeType;
  scopeLegalEntityId?: string | null;
  scopeLegalEntityName?: string | null;
  scopeOrganizationUnitId: string | null;
  scopeOrganizationUnitName: string | null;
  scopeCustomerId: string | null;
  scopeCustomerName: string | null;
}

export interface AssignRoleInput {
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeLegalEntityId?: string | null;
  scopeOrganizationUnitId?: string | null;
  scopeCustomerId?: string | null;
}

/** Strict application input for the governed Admin assignment surface. */
export type GovernedRoleAssignmentInput =
  | { roleCode: string; scopeType: "tenant" }
  | {
      roleCode: string;
      scopeType: "legal_entity";
      scopeLegalEntityId: string;
    }
  | {
      roleCode: string;
      scopeType: "organization_unit";
      scopeOrganizationUnitId: string;
    }
  | { roleCode: string; scopeType: "customer"; scopeCustomerId: string };

/**
 * Epic 4 Wave 2 step 14 — one reviewable, confirmable batch. `pairs` is the
 * complete desired ADDITION for this confirmation (§4.4 C keeps Wave 2
 * append-only: revocation is Wave 3's soft-revoke model). `previewHash` and
 * `confirm` make the confirmation explicit and unforgeable; the commit
 * recomputes the hash from the pairs it is about to write, so a review approved
 * against one batch can never be applied to another.
 */
export interface UpdateRoleAssignmentsInput {
  pairs: GovernedRoleAssignmentInput[];
  previewHash: string;
  confirm: true;
}

/** Step 14's review step: the proposed pairs alone. `confirm` and
 * `previewHash` are deliberately absent — a preview cannot carry the token
 * that authorizes the write, or one body would mean both review and commit. */
export interface PreviewRoleAssignmentsInput {
  pairs: GovernedRoleAssignmentInput[];
}

/** The persisted outcome of one confirmed batch. */
export interface AssignmentBatchResult {
  targetUserId: string;
  created: AdminRoleAssignmentSummary[];
}

/** Basics accepted when creating a User. No `status` field: §4.4 C fixes the
 * initial status by the identity rules, not by the administrator's browser. */
export interface CreateGovernedUserInput {
  email: string;
  fullName: string;
  password: string;
  pairs: GovernedRoleAssignmentInput[];
}

/** Privacy-minimized projection of a newly created User — the same five keys
 * the access projection uses, never credential material. */
export interface GovernedUserSummary {
  id: string;
  fullName: string;
  email: string;
  status: string;
}

/** One assignment flattened with the User it belongs to (step 13). */
export interface AdminAssignmentRow extends AdminRoleAssignmentSummary {
  userId: string;
  userName: string;
  userEmail: string;
  userStatus: string;
}

/** Step 15 — the picker universe. `organizationUnits` carries the actor's
 * assignable units with their tenant-wide tree context; `legalEntities`
 * carries the same answer one level up (Epic 5 G3); `roles` carries only
 * Roles the actor may delegate. */
export interface AssignmentOptions {
  canAssignTenantScope: boolean;
  organizationUnits: AssignmentScopeUnitOption[];
  legalEntities: AssignmentScopeLegalEntityOption[];
  roles: AssignmentRoleOption[];
}

/** Epic 5 G3 — one Legal Entity the actor may scope an assignment to. */
export interface AssignmentScopeLegalEntityOption {
  id: string;
  name: string;
  /** False for a Legal Entity that exists as context but is outside the
   * actor's own Data Scope, or is not active: the picker never offers a grant
   * the API would refuse. */
  selectable: boolean;
}

export interface AssignmentScopeUnitOption {
  id: string;
  name: string;
  parentId: string | null;
  /** Depth from the tenant root, for rendering the tree without the browser
   * reconstructing the hierarchy itself. */
  depth: number;
  /** False for an ancestor shown only as context: §4.4 E lets an actor assign
   * to their own subtree, not to a unit above them. */
  selectable: boolean;
}

export interface AssignmentRoleOption {
  code: string;
  name: string;
  permissionCount: number;
  /** False when the Role carries a permission outside the actor's delegation
   * ceiling, so the picker never offers a grant the API would refuse. */
  selectable: boolean;
}

/** Privacy-minimized access projection: enough to govern access, no credentials
 * or user lifecycle/audit internals. */
export interface AdminUserAccessSummary {
  id: string;
  fullName: string;
  email: string;
  status: string;
  roleAssignments: AdminRoleAssignmentSummary[];
}

export interface AdminRoleAssignmentSummary {
  id: string;
  /** Role metadata is null when the stored role no longer resolves in the
   * assigned User's tenant; foreign role identity is never projected. */
  roleState: "available" | "unavailable";
  roleCode: string | null;
  roleName: string | null;
  scopeType: ScopeType;
  /** Availability is intentionally generic: deleted, missing, foreign, and
   * permanently invalidated scopes are indistinguishable to callers. */
  scopeState: "available" | "unavailable";
  /** Epic 5 G3 — the Legal Entity scope target and its display name, projected
   * under the same redaction rule as the other two scope families: a target
   * that does not resolve in the assigned User's tenant is named nowhere. */
  scopeLegalEntityId?: string | null;
  scopeLegalEntityName?: string | null;
  scopeOrganizationUnitId: string | null;
  scopeOrganizationUnitName: string | null;
  scopeCustomerId: string | null;
  scopeCustomerName: string | null;
  /** Epic 4 Wave 3 (§4.4 step 20) — the row's lifecycle, separate from
   * role/scope availability: an operator revocation and a system
   * invalidation are different events and stay distinguishable here even
   * though both make the grant inert. `unavailable` here means the same
   * retained-unavailable condition the states above already express. */
  assignmentState: "active" | "revoked" | "invalidated" | "unavailable";
  /** Grant provenance. */
  assignedAt: string | null;
  assignedBy: string | null;
  /** Operator revocation provenance, present only after a manual revoke. */
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

/** One tenant-owned Role and only the global catalog entries granted to it. */
export interface RolePermissionDetail {
  roleCode: string;
  roleName: string;
  isFullAccess: boolean;
  permissions: Permission[];
}

export interface WindowAccessInput {
  windowCode: string;
  isReadWrite: boolean;
  isActive: boolean;
}

export interface PermissionOption extends Permission {
  moduleCode: string | null;
  isActive: boolean;
  selectable: boolean;
}

export interface WindowOption {
  code: string;
  name: string;
  moduleCode: string;
  registrationStatus: string;
  requiredPermissions: string[];
  parentPath: string | null;
  isDetail: boolean;
  selectable: boolean;
}

export interface RoleDefinition {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  /** Epic 4 open item 1 — operator-authored metadata, nullable on purpose:
   * "never had a description" (null) is a different fact from "someone typed
   * an empty string", and the API surfaces that distinction. Metadata only;
   * nothing in authorization reads it. */
  description: string | null;
  isFullAccess: boolean;
  /** Epic 4 open item 2 — lifecycle switch: false means the Role exists
   * (history resolves, projections name it) but may not be granted again and
   * live grants referencing it stop authorizing on the next permission check. */
  isActive: boolean;
  version: number;
  permissionCodes: string[];
  windows: WindowAccessInput[];
  /** Epic 4 step 11b — derived from the API Resource → Window mapping, never
   * hard-coded: `"partial"` while any mutating route the server declared
   * resolves to no Window, `"enforced"` once every one does. See
   * `windowEnforcementStatus()`. */
  enforcementStatus: WindowEnforcementStatus;
}

export interface RoleDefinitionOptions {
  permissions: PermissionOption[];
  windows: WindowOption[];
}

export interface RoleDefinitionPreview {
  role: RoleDefinition;
  previewHash: string;
  affectedUserCount: number;
}

export interface CreateRoleDefinitionInput {
  code: string;
  name: string;
  /** Omitted or null both mean "no description"; the console form sends the
   * field only when the operator typed something. */
  description?: string | null;
  permissionCodes: string[];
  windows: WindowAccessInput[];
}

export interface CopyRoleDefinitionInput {
  code: string;
  name: string;
  /** A copy carries the source's description: the new Role starts as a copy
   * of the original in every operator-visible respect, and the copy dialog's
   * name field is the only thing the operator is asked for. */
  description?: string | null;
}

export interface RoleDefinitionPreviewInput {
  version: number;
  name: string;
  description?: string | null;
  permissionCodes: string[];
  windows: WindowAccessInput[];
}

export interface UpdateRoleDefinitionInput extends RoleDefinitionPreviewInput {
  previewHash: string;
  confirm: true;
}

export interface RoleDefinitionRepository {
  getRoleDefinition(
    tenantId: string,
    roleCode: string,
  ): Promise<RoleDefinition | null>;
  listRoleDefinitionOptions(actor: {
    tenantId: string;
    userId: string;
  }): Promise<RoleDefinitionOptions>;
  createRoleDefinition(
    actor: { tenantId: string; userId: string },
    input: CreateRoleDefinitionInput,
  ): Promise<RoleDefinition>;
  copyRoleDefinition(
    actor: { tenantId: string; userId: string },
    sourceCode: string,
    input: CopyRoleDefinitionInput,
  ): Promise<RoleDefinition>;
  previewRoleDefinition(
    actor: { tenantId: string; userId: string },
    roleCode: string,
    input: RoleDefinitionPreviewInput,
  ): Promise<RoleDefinitionPreview>;
  updateRoleDefinition(
    actor: { tenantId: string; userId: string },
    roleCode: string,
    input: UpdateRoleDefinitionInput,
  ): Promise<RoleDefinition>;
  deleteRoleDefinition(
    actor: { tenantId: string; userId: string },
    roleCode: string,
  ): Promise<void>;
  /** Epic 4 open item 2 — deactivate/activate. Deactivation is refused while
   * any LIVE assignment references the Role; a retained revoked or
   * scope-invalidated row does not block it, because it grants nothing. */
  setRoleDefinitionActive(
    actor: { tenantId: string; userId: string },
    roleCode: string,
    isActive: boolean,
  ): Promise<RoleDefinition>;
}

/** A Role plus the counts an administrator needs to understand it at a
 * glance. Phase 11C — summary only: the permission CODES a role grants are
 * deliberately not projected here, so the console never becomes a covert
 * permission-matrix export. */
export interface RoleSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isFullAccess: boolean;
  /** False while deactivated: the list must show inactive Roles (they still
   * own history) but the console must not offer them as grant targets. */
  isActive: boolean;
  permissionCount: number;
  assignedUserCount: number;
}

export interface RbacRepository extends RoleDefinitionRepository {
  /** All permission codes from actual role_permissions rows carried by an
   * authorization-effective assignment. Unavailable scopes grant nothing.
   * Epic 1: this is the UNION across every assignment the user holds — the
   * informational set `/me` reports. Enforcement uses
   * `getEffectivePermissionCodesForAssignment`, which pins the session's
   * active assignment instead. */
  getEffectivePermissionCodes(userId: string): Promise<Set<string>>;
  /** Epic 1 (§4.1 C) — the enforcement read: permission codes of exactly one
   * assignment. A null `assignmentId` (session holds no effective
   * assignment) yields the empty set, so every permissioned route fails
   * closed. */
  getEffectivePermissionCodesForAssignment(
    tenantId: string,
    assignmentId: string | null,
  ): Promise<Set<string>>;
  /** Only authorization-effective assignments. Administrative reconciliation
   * uses listAdminUserAccess so retained unavailable rows remain visible. */
  getAssignments(userId: string): Promise<UserRoleAssignment[]>;
  /** Same rows as `getAssignments`, plus role/scope display names, for the
   * caller's own post-login context picker. */
  getMyAssignmentsWithScopeNames(userId: string): Promise<MyRoleAssignment[]>;
  findRoleByCode(tenantId: string, code: string): Promise<Role | null>;
  /** Provisioning read/write: activate every module for a fresh Tenant. */
  activateAllModulesForTenant(tenantId: string): Promise<void>;
  /** Included-role closure (AD_Role_Included parity). */
  resolveIncludedRoleIds(tenantId: string, roleId: string): Promise<string[]>;
  /** Window access union across a role and its included roles. */
  getWindowAccessForRole(tenantId: string, roleId: string): Promise<{ windowCode: string; isReadWrite: boolean; accessTypes: string[] }[]>;
  /** `tenantId` is required because this writer serializes on the tenant row:
   * `user_role_assignments.role_id` is ON DELETE CASCADE, so an assignment
   * inserted outside that lock can be silently cascaded away by a concurrent
   * Role delete. */
  assignRole(
    tenantId: string,
    input: AssignRoleInput,
    createdBy: string | null,
  ): Promise<UserRoleAssignment>;

  /**
   * Phase 11C — Business Admin Console. Every Role defined in `tenantId`
   * with its granted-permission and assigned-user counts. Tenant-scoped by
   * `roles.tenant_id`; `user_role_assignments` has no `tenant_id` of its own
   * and inherits tenancy through `roles` (the same ownership path the
   * platform boundary validator records for that table).
   */
  listRoleSummaries(tenantId: string): Promise<RoleSummary[]>;

  /**
   * Phase 11C — the global permission catalog. `permissions` is a global
   * catalog table with no `tenant_id` (it is migration-owned and identical
   * for every deployment), so this exposes only safe catalog metadata —
   * code and description — and never which tenant or user holds them.
   */
  listPermissionCatalog(): Promise<Permission[]>;

  /** True only when one authorization-effective assignment carries every
   * requested actual permission row. Capabilities from separate assignments
   * are never combined. */
  hasPermissionSetOnSameAssignment(
    userId: string,
    permissionCodes: readonly string[],
  ): Promise<boolean>;

  /** Epic 1 (§4.1 C) — enforcement variant: the same "all codes on one
   * assignment" question asked about the session's ACTIVE assignment. The
   * `userId` form above stays for callers asking about a user in the
   * abstract (queue routing, admin review). */
  hasPermissionSetForAssignment(
    tenantId: string,
    assignmentId: string | null,
    permissionCodes: readonly string[],
  ): Promise<boolean>;

  /** Canonical tenant-scope permission predicate. Permission and tenant Data
   * Scope must be carried by the same assignment; capabilities from separate
   * assignments are never combined. */
  hasTenantScopedPermission(
    tenantId: string,
    userId: string,
    permissionCode: string,
  ): Promise<boolean>;

  /** Epic 1 (§4.1 C) — enforcement variant, pinned to the active assignment. */
  hasTenantScopedPermissionForAssignment(
    tenantId: string,
    assignmentId: string | null,
    permissionCode: string,
  ): Promise<boolean>;

  /** Epic 4 step 11b — the Window lock read. `configured` is true when any
   * authorization-effective assignment carries a `role_window_access` row for
   * the Window; `writable` when any of those rows is both `is_read_write` and
   * `is_active` (union allow). Absence of rows means "not configured", never
   * "read-only" — the caller passes through on `configured = false`. */
  getWindowAccessState(
    tenantId: string,
    userId: string,
    windowCode: string,
  ): Promise<{ configured: boolean; writable: boolean }>;

  /** Epic 1 (§4.1 C) — enforcement variant of the Window lock, read against
   * the active assignment's Role only. A read-only Assignment must not be
   * written through merely because the user's OTHER Role is writable. */
  getWindowAccessStateForAssignment(
    tenantId: string,
    assignmentId: string | null,
    windowCode: string,
  ): Promise<{ configured: boolean; writable: boolean }>;

  /** Every authorization-effective assignment carrying `permissionCode`, with
   * that same assignment's Data Scope. Business modules use this when a read
   * or mutation must couple permission and Customer scope instead of combining
   * effective permission from one assignment with scope from another. */
  getAssignmentsWithPermission(
    userId: string,
    permissionCode: string,
  ): Promise<UserRoleAssignment[]>;

  /** Phase 11F governed access reads. Administrative assignment inventory is
   * anchored through the assigned User's tenant. Role/scope display metadata
   * resolves only through same-tenant targets; unresolved metadata is redacted
   * while the retained assignment ID and stored scope UUID remain removable.
   *
   * Epic 4 Wave 2 step 16 — `visibility` NARROWS the result to the target Users
   * the actor may administer. It is computed server-side from the actor's own
   * permission-bearing assignments and is never accepted from the browser; the
   * predicate lives in this SQL, not in the React filter (§4.4 risk row 1).
   * Only the TARGET list is narrowed: every retained assignment row of a
   * visible User is still projected, because hiding some of a User's
   * assignments would make an unremovable grant invisible. */
  listAdminUserAccess(
    tenantId: string,
    visibility: AdministrativeVisibility,
  ): Promise<AdminUserAccessSummary[]>;
  getRolePermissionDetail(
    tenantId: string,
    roleCode: string,
  ): Promise<RolePermissionDetail | null>;

  /** Phase 11F writes own their complete transaction, tenant lock, authority
   * revalidation, resource validation, mutation, and append-only audit row. */
  createGovernedRoleAssignment(
    actor: { tenantId: string; userId: string },
    targetUserId: string,
    input: GovernedRoleAssignmentInput,
  ): Promise<AdminRoleAssignmentSummary>;
  /** Epic 4 Wave 3 step 18 — soft revoke: the row and its history are RETAINED,
   * the grant becomes authorization-inert on the next check, and the audit
   * row carries before/after plus the operator's reason. */
  revokeGovernedRoleAssignment(
    actor: { tenantId: string; userId: string },
    targetUserId: string,
    assignmentId: string,
    reason: string,
  ): Promise<void>;

  /**
   * Epic 4 Wave 2 — the centralized Organization Unit scope helpers both
   * surfaces (User-centric and assignment-centric) call, so the hierarchy rule
   * exists in exactly one place (§4.4 E: "Pemeriksaan ancestor/descendant
   * harus memakai helper scope terpusat, bukan logika baru di frontend").
   */
  listOrganizationUnitSubtreeIds(
    tenantId: string,
    rootOrganizationUnitIds: readonly string[],
  ): Promise<string[]>;
  /** Epic 5 G3 — every Organization Unit inside one Legal Entity. This is the
   * downward half of the coverage chain tenant → Legal Entity → Organization
   * Unit (§4.5 principle 9): an assignment scoped to a Legal Entity covers
   * every unit in it, and this is the one place that set is computed, so the
   * administrative visibility, the assignment picker and the delegation check
   * cannot drift from the coverage predicate. */
  listOrganizationUnitIdsForLegalEntity(
    tenantId: string,
    legalEntityId: string,
  ): Promise<string[]>;
  /** The actor's own Organization Unit anchors, unexpanded — the assignable
   * universe for the scope picker (ancestors are context, not choices).
   * Epic 1 (§4.1 C): read from the ACTIVE assignment only. */
  listActorOrganizationUnitAnchors(
    actor: GovernedActor,
    permissionCode: string,
  ): Promise<string[]>;
  /** Resolve the caller's administrative visibility for one permission.
   * Epic 1 (§4.1 C): read from the ACTIVE assignment only. */
  resolveAdministrativeVisibility(
    actor: GovernedActor,
    permissionCode: string,
  ): Promise<AdministrativeVisibility>;

  /**
   * Epic 4 Wave 2 steps 12/14 — the preview and the single-confirmation batch
   * write shared by BOTH surfaces. The repository owns the whole transaction in
   * `updateRoleAssignments`, so a failure of any pair leaves no partial state
   * (§4.4 risk row 8).
   */
  previewRoleAssignments(
    actor: { tenantId: string; userId: string },
    targetUserId: string,
    input: PreviewRoleAssignmentsInput,
  ): Promise<AssignmentBatchPreview>;
  updateRoleAssignments(
    actor: { tenantId: string; userId: string },
    targetUserId: string,
    input: UpdateRoleAssignmentsInput,
  ): Promise<AssignmentBatchResult>;
  /** Create a User together with zero or more initial assignments in ONE
   * governed transaction (§4.4 C). A User with no assignment is valid and has
   * no effective access (§4.4 risk row 9). */
  createGovernedUserWithAssignments(
    actor: { tenantId: string; userId: string },
    input: CreateGovernedUserInput,
  ): Promise<{ user: GovernedUserSummary; assignments: AdminRoleAssignmentSummary[] }>;
  /** One visible User with the same access projection, or null when the User
   * is outside the actor's visibility — an out-of-scope target must be
   * indistinguishable from a missing one (§4.4 risk row 1). */
  getAdminUserAccess(
    tenantId: string,
    userId: string,
    visibility: AdministrativeVisibility,
  ): Promise<AdminUserAccessSummary | null>;

  /** Epic 4 Wave 2 step 13 — flattened assignment rows across Users, each with
   * the User it belongs to, narrowed by the same visibility predicate. */
  listAdminAssignments(
    tenantId: string,
    visibility: AdministrativeVisibility,
  ): Promise<AdminAssignmentRow[]>;
  /** Step 15 — the server-owned scope picker universe and the Role options,
   * both filtered by the actor's delegation limit. */
  listAssignmentOptions(
    actor: { tenantId: string; userId: string },
  ): Promise<AssignmentOptions>;

  /**
   * Every user who currently holds `roleCode` with a Data Scope covering
   * `organizationUnitId` (same exact-match + tenant-wide-covers-narrower
   * semantics as `RbacService.hasRoleCoveringScope`). `organizationUnitId
   * = null` means the target is tenant-wide, so only tenant-wide holders
   * of the role match. Added in Checkpoint 0E so the Notification Engine
   * can resolve "who is in this role+scope queue" without duplicating
   * ADR-0007's scope logic — used to fan out a Workflow role-Assignment
   * notification to every eligible reviewer, not just whoever acts first.
   */
  listUserIdsWithRoleInScope(
    tenantId: string,
    roleCode: string,
    organizationUnitId: string | null,
  ): Promise<string[]>;

  /**
   * Every INTERNAL user in the Tenant whose roles grant `permissionCode`.
   * Added in Checkpoint 1E.2 so management attention can be addressed by
   * CAPABILITY rather than by coupling to a role NAME (FD-1E §20).
   * Customer-scoped assignments are excluded: a Customer User must never
   * receive an internal management signal, even if their role happened to
   * carry the permission (FD-1E §42).
   */
  listUserIdsWithPermissionInTenant(
    tenantId: string,
    permissionCode: string,
  ): Promise<string[]>;
}
