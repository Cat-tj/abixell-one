import type {
  MyRoleAssignment,
  RbacRepository,
  UserRoleAssignment,
} from "../../domain/rbac/rbac.entity.js";
import type {
  OrganizationUnit,
  OrganizationUnitRepository,
} from "../../domain/organization-unit/organization-unit.entity.js";
import type {
  LegalEntityRepository,
  LifecycleStatus,
} from "../../domain/legal-entity/legal-entity.entity.js";
import { ForbiddenError } from "../../domain/shared-kernel/errors.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";

/**
 * Epic 5 §4.5 Putaran 6 — "an inactive entity may not be used for new work".
 * Applied to authorization: an entity that is not `status = 'active'`
 * (`inactive`, `tombstone`, `deleted`, or `draft`) confers no Data Scope and is
 * not a usable target. `status` is the authoritative lifecycle column — G1 pins
 * `is_active = (status = 'active')` with a CHECK and a sync trigger, and a
 * legacy row that still reads `is_active = true` while its status says
 * `deleted` is caught here and only here.
 */
function isUsableLifecycleEntity(status: LifecycleStatus | null | undefined): boolean {
  return status === "active";
}

/**
 * A RETIRED entity (tombstoned or deleted) is terminal: nothing is authorized
 * to reach into it, in either direction.
 *
 * `inactive` and `draft` deliberately stay coverable. The Organization Unit's
 * own lifecycle transitions (`inactive → active`, `inactive → tombstone`) run
 * their scope check against the very unit they are about to move, so refusing
 * an inactive TARGET here would make those transitions unsatisfiable — the same
 * trap G1 documented for the Legal Entity deactivation guard. Closing an
 * inactive entity to new work is that entity's own guard, plus the rule that a
 * SCOPE rooted in a non-active entity confers nothing (see
 * `isUsableLifecycleEntity` and the authorization-effective projection).
 */
function isRetiredLifecycleEntity(status: LifecycleStatus | null | undefined): boolean {
  return status === "deleted" || status === "tombstone";
}

/**
 * The lifecycle states a Legal Entity may be USED in for new work.
 *
 * `inactive`, `tombstone` and `deleted` are refused — §4.5 Putaran 6, and the
 * whole point of the enforcement batch. `draft` is allowed on purpose: a Legal
 * Entity is created as `draft` (`LegalEntityRepository.create` defaults it that
 * way) and its chart of accounts, employees and addresses are configured BEFORE
 * the entity goes live, so refusing a draft target would break setup rather
 * than protect anything. A `legal_entity`-scoped ASSIGNMENT on a draft Legal
 * Entity still confers nothing: the authorization-effective projection requires
 * `le.is_active`, which a draft row does not have.
 */
function isOpenForNewWork(status: LifecycleStatus | null | undefined): boolean {
  return status === "active" || status === "draft";
}

/**
 * Authorization = Role Permission (what) + Data Scope (which data),
 * per 02-Identity-Security-RBAC-Foundation.md. This service is the single
 * place both axes are evaluated — HTTP routes call it, they never
 * hand-roll their own permission checks.
 *
 * Epic 1 (§4.1 C) — separation of duties. Every method that answers "may the
 * actor do this" now reads the SESSION'S ACTIVE ASSIGNMENT, not the union of
 * everything the user holds. A user granted Creator and Approver must not be
 * able to approve in the Creator context merely because another Role they
 * hold would allow it.
 *
 * The methods that answer "what does this user hold" (getAssignments,
 * getMyAssignmentsWithScopeNames, getAssignmentsWithPermission, and the
 * repository's cross-user reads) deliberately keep the `userId` form: queue
 * routing, notification fan-out and admin review ask about a user in the
 * abstract, and pinning those to one session's choice would be wrong.
 */
/** Result of `RbacService.buildActiveOrganizationUnitCoverage`: a synchronous
 * "does the ACTIVE assignment cover this Organization Unit" predicate plus the
 * covered id set (for pushing the filter into SQL). `tenantWide` means every
 * unit is covered and `coveredUnitIds` is not populated. */
export interface ActiveOrganizationUnitCoverage {
  readonly tenantWide: boolean;
  covers(unitId: string): boolean;
  readonly coveredUnitIds: ReadonlySet<string>;
  /** The Legal Entity the active assignment is scoped to, only when it is
   * usable (lifecycle `active`, same Tenant); otherwise null. */
  readonly usableLegalEntityId: string | null;
}

export class RbacService {
  constructor(
    private readonly repo: RbacRepository,
    private readonly orgUnits: OrganizationUnitRepository,
    /**
     * Epic 5 G3 enforcement batch — the Legal Entity lifecycle read. The Data
     * Scope chain is tenant → Legal Entity → Organization Unit, so a coverage
     * answer that names a Legal Entity has to be able to say whether that Legal
     * Entity is still usable. Kept as a repository dependency (not a raw
     * `Pool`) for the same reason `orgUnits` is: the scope checks read the same
     * aggregate the rest of the platform writes.
     */
    private readonly legalEntities: LegalEntityRepository,
  ) {}

  /** The union across every assignment the user holds. Informational only —
   * `/me` reports it so a user can see their full capability set before
   * switching context. Never an enforcement input. */
  async getEffectivePermissions(userId: string): Promise<Set<string>> {
    return this.repo.getEffectivePermissionCodes(userId);
  }

  /** The ACTIVE assignment's permission codes. This is the enforcement read:
   * a session with no effective assignment yields the empty set. */
  async getActivePermissions(actor: ActorContext): Promise<Set<string>> {
    return this.repo.getEffectivePermissionCodesForAssignment(
      actor.tenantId,
      actor.assignmentId,
    );
  }

  /**
   * Throws ForbiddenError unless the actor's ACTIVE Role carries
   * `permissionCode`.
   *
   * Three distinguishable failures collapse into one refusal, deliberately:
   * the session holds no effective assignment, the active Role lacks the
   * code, or the code belongs only to another Role the user holds. All three
   * mean "not in this context", and telling them apart would leak role
   * structure to a caller who is only entitled to a yes/no.
   */
  async requirePermission(actor: ActorContext, permissionCode: string): Promise<void> {
    if (actor.assignmentId === null) {
      throw new ForbiddenError(
        `No active Role in this session; switch to a Role that grants permission '${permissionCode}'`,
      );
    }
    const permissions = await this.getActivePermissions(actor);
    if (!permissions.has(permissionCode)) {
      throw new ForbiddenError(
        `Missing permission '${permissionCode}' in the active Role`,
      );
    }
  }

  /** Same refusal rule as `requirePermission`, but ANY ONE of the listed codes
   * suffices. Used where a legacy code and its granular successor both grant
   * the same action (Epic 15 Decision #7). */
  async requireAnyPermission(
    actor: ActorContext,
    permissionCodes: readonly string[],
  ): Promise<void> {
    if (actor.assignmentId === null) {
      throw new ForbiddenError(
        `No active Role in this session; switch to a Role that grants permission '${permissionCodes[0]}'`,
      );
    }
    const permissions = await this.getActivePermissions(actor);
    if (!permissionCodes.some((code) => permissions.has(code))) {
      throw new ForbiddenError(
        `Missing permission '${permissionCodes.join("' or '")}' in the active Role`,
      );
    }
  }

  /** Requires one authorization-effective assignment to carry every listed
   * actual permission grant. Permissions from separate roles are not combined. */
  async requirePermissionsOnSameAssignment(
    userId: string,
    permissionCodes: readonly string[],
  ): Promise<void> {
    const allowed = await this.repo.hasPermissionSetOnSameAssignment(
      userId,
      permissionCodes,
    );
    if (!allowed) {
      throw new ForbiddenError(
        `Missing same-assignment permissions '${permissionCodes.join("', '")}'`,
      );
    }
  }

  /** Epic 1 — same "all codes on one assignment" rule, pinned to the session's
   * active assignment. */
  async requirePermissionsOnActiveAssignment(
    actor: ActorContext,
    permissionCodes: readonly string[],
  ): Promise<void> {
    const allowed = await this.repo.hasPermissionSetForAssignment(
      actor.tenantId,
      actor.assignmentId,
      permissionCodes,
    );
    if (!allowed) {
      throw new ForbiddenError(
        `Missing same-assignment permissions '${permissionCodes.join("', '")}' in the active Role`,
      );
    }
  }

  /**
   * Canonical tenant-scoped authorization check for tenant-wide resources.
   * The requested permission and tenant Data Scope must come from the SAME
   * assignment; checking effective permissions and scope independently would
   * incorrectly combine authority from unrelated assignments.
   */
  async requireTenantScopedPermission(
    tenantId: string,
    userId: string,
    permissionCode: string,
  ): Promise<void> {
    const allowed = await this.repo.hasTenantScopedPermission(tenantId, userId, permissionCode);
    if (!allowed) {
      throw new ForbiddenError(
        `Missing tenant-scoped permission '${permissionCode}'`,
      );
    }
  }

  /** Epic 1 — the enforcement form: the ACTIVE assignment must be tenant-scoped
   * AND carry the permission. A tenant-scoped Role the user holds but has not
   * switched into does not authorize the action. */
  async requireTenantScopedPermissionForActor(
    actor: ActorContext,
    permissionCode: string,
  ): Promise<void> {
    const allowed = await this.repo.hasTenantScopedPermissionForAssignment(
      actor.tenantId,
      actor.assignmentId,
      permissionCode,
    );
    if (!allowed) {
      throw new ForbiddenError(
        `Missing tenant-scoped permission '${permissionCode}' in the active Role`,
      );
    }
  }

  /** Epic 4 step 11b — Window read-only state for one actor and one Window.
   * Passthrough so the enforcement plugin asks the same service every other
   * authorization question asks, and so the repository read has exactly one
   * consumer-shaped entry point. See `RbacRepository.getWindowAccessState`
   * for the semantics of `configured` and `writable`. */
  async getWindowAccessState(
    tenantId: string,
    userId: string,
    windowCode: string,
  ): Promise<{ configured: boolean; writable: boolean }> {
    return this.repo.getWindowAccessState(tenantId, userId, windowCode);
  }

  /** Epic 1 — the Window lock read against the ACTIVE Role only. Without this
   * a read-only Assignment could write through because another Role the user
   * holds happens to be writable. */
  async getWindowAccessStateForActor(
    actor: ActorContext,
    windowCode: string,
  ): Promise<{ configured: boolean; writable: boolean }> {
    return this.repo.getWindowAccessStateForAssignment(
      actor.tenantId,
      actor.assignmentId,
      windowCode,
    );
  }

  /**
   * Epic 1 — the enforcement form: throws unless the actor's ACTIVE
   * assignment's Data Scope covers `targetOrganizationUnitId` — a tenant-wide
   * active assignment, a legal_entity active assignment naming the Legal
   * Entity the unit belongs to (Epic 5 G3), or an active organization_unit
   * assignment on the unit or one of its ANCESTORS. An ancestor assignment the
   * user holds but has not switched into grants nothing here.
   */
  async requireOrganizationUnitScopeForActor(
    actor: ActorContext,
    targetOrganizationUnitId: string,
  ): Promise<void> {
    const covered = await this.isActiveOrganizationUnitScopeCovered(
      actor,
      targetOrganizationUnitId,
    );
    if (!covered) {
      throw new ForbiddenError(
        "The active Role's Data Scope does not cover this Organization Unit",
      );
    }
  }

  async isActiveOrganizationUnitScopeCovered(
    actor: ActorContext,
    targetOrganizationUnitId: string,
  ): Promise<boolean> {
    if (actor.assignmentId === null) return false;
    if (actor.scopeType === "tenant") return true;
    // Epic 5 G3 enforcement batch — the coverage chain tenant → Legal Entity →
    // Organization Unit. A Legal Entity-scoped assignment covers EVERY unit
    // inside that Legal Entity, which is not the same set as the ancestor walk:
    // a unit in the Legal Entity is covered even when no assignment names one
    // of its ancestors. §4.5 Putaran 4: the scope "mencakup semua Organization
    // Unit di Legal Entity tersebut, tetapi tidak mencakup Legal Entity lain".
    //
    // Fail-closed guards, in the order they are cheapest to reason about:
    // 1. the TARGET unit must exist in the actor's Tenant and must not be
    //    RETIRED (tombstoned or deleted) — a terminal unit is closed to
    //    everything, while `inactive` stays coverable so the unit's own
    //    lifecycle transitions remain reachable (see
    //    `isRetiredLifecycleEntity`);
    // 2. the SCOPE entity (the Legal Entity or the Organization Unit the active
    //    assignment names) must itself be usable — an authority rooted in a
    //    closed entity is void even if a stale ActorContext still carries it;
    // 3. the actor's Organization Unit scope must actually cover the target by
    //    the ancestor walk (ADR-0009).
    const unit = await this.orgUnits.findById(targetOrganizationUnitId);
    if (unit === null || unit.tenantId !== actor.tenantId) return false;
    if (isRetiredLifecycleEntity(unit.status)) return false;

    if (actor.scopeType === "legal_entity") {
      if (actor.scopeLegalEntityId === null) return false;
      if (unit.legalEntityId !== actor.scopeLegalEntityId) return false;
      const legalEntity = await this.legalEntities.findById(actor.scopeLegalEntityId);
      return (
        legalEntity !== null &&
        legalEntity.tenantId === actor.tenantId &&
        isUsableLifecycleEntity(legalEntity.status)
      );
    }
    if (
      actor.scopeType !== "organization_unit" ||
      actor.scopeOrganizationUnitId === null
    ) {
      // A customer-scoped assignment never reaches into the internal structure.
      return false;
    }
    const scopeUnit = await this.orgUnits.findById(actor.scopeOrganizationUnitId);
    if (
      scopeUnit === null ||
      scopeUnit.tenantId !== actor.tenantId ||
      !isUsableLifecycleEntity(scopeUnit.status)
    ) {
      return false;
    }
    const ancestorIds = await this.orgUnits.listAncestorIds(targetOrganizationUnitId);
    return new Set(ancestorIds).has(actor.scopeOrganizationUnitId);
  }

  /**
   * Batch form of `isActiveOrganizationUnitScopeCovered` (same rules, same
   * fail-closed guards) for callers that filter a whole LIST: the tenant's
   * units are read ONCE and the ADR-0009 ancestor walk runs in memory, so a
   * list read costs a constant number of queries instead of several per row.
   * Per-call result for any unit id equals `isActiveOrganizationUnitScopeCovered`.
   */
  async buildActiveOrganizationUnitCoverage(
    actor: ActorContext,
  ): Promise<ActiveOrganizationUnitCoverage> {
    const none: ActiveOrganizationUnitCoverage = {
      tenantWide: false,
      covers: () => false,
      coveredUnitIds: new Set<string>(),
      usableLegalEntityId: null,
    };
    if (actor.assignmentId === null) return none;
    if (actor.scopeType === "tenant") {
      return {
        tenantWide: true,
        covers: () => true,
        coveredUnitIds: new Set<string>(),
        usableLegalEntityId: null,
      };
    }
    if (actor.scopeType !== "legal_entity" && actor.scopeType !== "organization_unit") {
      return none; // a customer-scoped assignment never reaches into the internal structure
    }
    const units = await this.orgUnits.listByTenant(actor.tenantId);
    const byId = new Map(units.map((u) => [u.id, u]));
    const covered = new Set<string>();
    let usableLegalEntityId: string | null = null;

    if (actor.scopeType === "legal_entity") {
      if (actor.scopeLegalEntityId === null) return none;
      const legalEntity = await this.legalEntities.findById(actor.scopeLegalEntityId);
      if (
        legalEntity === null ||
        legalEntity.tenantId !== actor.tenantId ||
        !isUsableLifecycleEntity(legalEntity.status)
      ) {
        return none;
      }
      usableLegalEntityId = actor.scopeLegalEntityId;
      for (const unit of units) {
        if (isRetiredLifecycleEntity(unit.status)) continue;
        if (unit.legalEntityId === actor.scopeLegalEntityId) covered.add(unit.id);
      }
    } else {
      if (actor.scopeOrganizationUnitId === null) return none;
      const scopeUnit = byId.get(actor.scopeOrganizationUnitId);
      if (
        !scopeUnit ||
        scopeUnit.tenantId !== actor.tenantId ||
        !isUsableLifecycleEntity(scopeUnit.status)
      ) {
        return none;
      }
      for (const unit of units) {
        if (isRetiredLifecycleEntity(unit.status)) continue;
        // Ancestor walk (target itself included), identical to listAncestorIds.
        const seen = new Set<string>();
        let cursor: typeof unit | undefined = unit;
        while (cursor && !seen.has(cursor.id)) {
          if (cursor.id === actor.scopeOrganizationUnitId) {
            covered.add(unit.id);
            break;
          }
          seen.add(cursor.id);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
      }
    }
    return {
      tenantWide: false,
      covers: (unitId) => covered.has(unitId),
      coveredUnitIds: covered,
      usableLegalEntityId,
    };
  }

  /**
   * Batch form of `isCustomerContextScopeCoveredByAssignments`: one read of the
   * tenant's units, then a synchronous matcher, instead of up to two queries
   * per Customer. Same decisions as the per-row method.
   */
  async buildCustomerContextScopeMatcher(
    tenantId: string,
    assignments: readonly UserRoleAssignment[],
  ): Promise<(target: { customerId: string; ownerOrganizationUnitId: string | null }) => boolean> {
    if (assignments.some((a) => a.scopeType === "tenant")) return () => true;
    const customerIds = new Set(
      assignments
        .filter((a) => a.scopeType === "customer" && a.scopeCustomerId)
        .map((a) => a.scopeCustomerId as string),
    );
    const legalEntityIds = new Set(
      assignments
        .filter((a) => a.scopeType === "legal_entity")
        .map((a) => a.scopeLegalEntityId ?? null),
    );
    const orgUnitScopeIds = new Set(
      assignments
        .filter((a) => a.scopeType === "organization_unit" && a.scopeOrganizationUnitId)
        .map((a) => a.scopeOrganizationUnitId as string),
    );
    const byId =
      legalEntityIds.size > 0 || orgUnitScopeIds.size > 0
        ? new Map((await this.orgUnits.listByTenant(tenantId)).map((u) => [u.id, u]))
        : new Map<string, OrganizationUnit>();
    return (target) => {
      if (customerIds.has(target.customerId)) return true;
      if (!target.ownerOrganizationUnitId) return false;
      const owner = byId.get(target.ownerOrganizationUnitId);
      if (!owner) return false;
      if (legalEntityIds.has(owner.legalEntityId)) return true;
      if (orgUnitScopeIds.size === 0) return false;
      const seen = new Set<string>();
      let cursor: OrganizationUnit | undefined = owner;
      while (cursor && !seen.has(cursor.id)) {
        if (orgUnitScopeIds.has(cursor.id)) return true;
        seen.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      return false;
    };
  }

  /**
   * The lifecycle-safe coverage question: does the ACTIVE assignment's Data
   * Scope cover `targetLegalEntityId`, regardless of the target's lifecycle
   * state? Covered exactly by a tenant-wide assignment or by a `legal_entity`
   * assignment naming that Legal Entity. A sibling Legal Entity of the same
   * Tenant is never covered, and an Organization Unit assignment never widens
   * to the whole Legal Entity that contains it (§4.5 principle 9).
   *
   * This is the form the Legal Entity's OWN aggregate uses (profile, addresses,
   * lifecycle): an inactive Legal Entity must stay readable and reactivatable,
   * so the target's lifecycle state deliberately does not enter here. A
   * resource that ASSIGNS a Legal Entity to something new uses
   * `isActiveLegalEntityScopeCovered` instead.
   */
  async isLegalEntityScopeCovered(
    actor: ActorContext,
    targetLegalEntityId: string,
  ): Promise<boolean> {
    if (actor.assignmentId === null) return false;
    const target = await this.legalEntities.findById(targetLegalEntityId);
    if (target === null || target.tenantId !== actor.tenantId) return false;
    if (actor.scopeType === "tenant") return true;
    if (actor.scopeType === "legal_entity") {
      return (
        actor.scopeLegalEntityId !== null &&
        actor.scopeLegalEntityId === targetLegalEntityId
      );
    }
    // An Organization-Unit-scoped assignment covers the ONE Legal Entity its
    // scope unit belongs to — a unit has exactly one owning Legal Entity, so
    // this is not a widening, just the missing link in the tenant → Legal
    // Entity → Organization Unit chain. Without this branch an OU-scoped
    // actor fails every Legal-Entity-scope check unconditionally, which is
    // the bug this branch fixes (Epic 6 G2 placement reads surfaced it).
    //
    // Crucially, the scope UNIT must be inside the TARGET LE, not just any
    // LE. An OU-scoped actor restricted to unit A (in LE-1) may not see
    // placements in LE-1 if they sit in unit B (also in LE-1 but outside A's
    // scope). This is enforced by isActiveOrganizationUnitScopeCovered, which
    // walks the OU hierarchy; here, we answer only the LE question.
    if (
      actor.scopeType === "organization_unit" &&
      actor.scopeOrganizationUnitId !== null
    ) {
      const scopeUnit = await this.orgUnits.findById(actor.scopeOrganizationUnitId);
      return (
        scopeUnit !== null &&
        scopeUnit.tenantId === actor.tenantId &&
        scopeUnit.legalEntityId === targetLegalEntityId
      );
    }
    return false;
  }

  /**
   * Epic 5 G3 (§4.5 step 15) — is `targetLegalEntityId` covered by the actor's
   * ACTIVE Data Scope AND open for new work? Same rules as
   * `isLegalEntityScopeCovered`, plus the target Legal Entity must not be
   * `inactive`, `tombstone` or `deleted`.
   *
   * This is the form every resource uses when it WRITES a Legal Entity id onto
   * something: §4.5 Putaran 6 — an inactive or deleted Legal Entity may not be
   * used for new work. The Legal Entity's own lifecycle transitions do not pass
   * through here (see `isLegalEntityScopeCovered`), so reactivating an inactive
   * Legal Entity stays possible.
   */
  async isActiveLegalEntityScopeCovered(
    actor: ActorContext,
    targetLegalEntityId: string,
  ): Promise<boolean> {
    if (actor.assignmentId === null) return false;
    const target = await this.legalEntities.findById(targetLegalEntityId);
    if (target === null || target.tenantId !== actor.tenantId) return false;
    if (!isOpenForNewWork(target.status)) return false;
    if (actor.scopeType === "tenant") return true;
    return (
      actor.scopeType === "legal_entity" &&
      actor.scopeLegalEntityId !== null &&
      actor.scopeLegalEntityId === targetLegalEntityId
    );
  }

  /** Epic 5 G3 enforcement batch — the enforcement form of the pure scope
   * question (lifecycle-safe; see `isLegalEntityScopeCovered`). The permission
   * is the caller's to state, because the same scope question is asked by reads
   * and writes that carry different capability codes. */
  async requireLegalEntityScopeForActor(
    actor: ActorContext,
    targetLegalEntityId: string,
  ): Promise<void> {
    if (!(await this.isLegalEntityScopeCovered(actor, targetLegalEntityId))) {
      throw new ForbiddenError(
        "The active Role's Data Scope does not cover this Legal Entity",
      );
    }
  }

  /** Epic 5 G3 enforcement batch — the enforcement form used whenever a Legal
   * Entity is ASSIGNED to new work: coverage plus "the target is active". */
  async requireActiveLegalEntityScopeForActor(
    actor: ActorContext,
    targetLegalEntityId: string,
  ): Promise<void> {
    if (!(await this.isActiveLegalEntityScopeCovered(actor, targetLegalEntityId))) {
      throw new ForbiddenError(
        "The active Role's Data Scope does not cover this Legal Entity, or the Legal Entity is not active",
      );
    }
  }

  /**
   * The Organization Unit ids the ACTIVE assignment's Data Scope covers, for a
   * caller narrowing a LIST read — the Legal Entity-aware successor of the
   * ad-hoc `getAssignments(userId)` walks some modules used to do.
   *
   * - `null` means "every unit in the Tenant" (a tenant-wide active
   *   assignment): a caller passes it straight through as "no narrowing".
   * - an empty array means "no unit at all" — the fail-closed answer for a
   *   customer-scoped, scope-less or unusable-scope session.
   * - a `legal_entity` scope yields every ACTIVE unit inside that Legal Entity
   *   (§4.5 Putaran 4), which is the whole point of the branch: before this,
   *   an Organization-Unit-only walk answered empty for a Legal Entity-scoped
   *   supervisor and silently showed them nothing.
   * - an `organization_unit` scope yields that unit and its ACTIVE descendants
   *   (ADR-0009). Units that are inactive, tombstoned or deleted are excluded:
   *   they authorize nothing, so no list should widen back onto them.
   */
  async listScopedOrganizationUnitIds(actor: ActorContext): Promise<string[] | null> {
    if (actor.assignmentId === null) return [];
    if (actor.scopeType === "tenant") return null;

    const units = (await this.orgUnits.listByTenant(actor.tenantId)).filter((u) =>
      isUsableLifecycleEntity(u.status),
    );

    if (actor.scopeType === "legal_entity") {
      if (actor.scopeLegalEntityId === null) return [];
      const legalEntity = await this.legalEntities.findById(actor.scopeLegalEntityId);
      if (
        legalEntity === null ||
        legalEntity.tenantId !== actor.tenantId ||
        !isUsableLifecycleEntity(legalEntity.status)
      ) {
        return [];
      }
      return units
        .filter((u) => u.legalEntityId === actor.scopeLegalEntityId)
        .map((u) => u.id);
    }

    if (actor.scopeType === "organization_unit") {
      if (actor.scopeOrganizationUnitId === null) return [];
      const root = units.find((u) => u.id === actor.scopeOrganizationUnitId);
      if (!root) return [];
      const childrenByParent = new Map<string, string[]>();
      for (const unit of units) {
        if (unit.parentId === null) continue;
        const siblings = childrenByParent.get(unit.parentId) ?? [];
        siblings.push(unit.id);
        childrenByParent.set(unit.parentId, siblings);
      }
      const covered: string[] = [];
      const queue = [root.id];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        covered.push(current);
        queue.push(...(childrenByParent.get(current) ?? []));
      }
      return covered;
    }

    return [];
  }

  /**
   * The Legal Entity ids the ACTIVE assignment's Data Scope lets the actor SEE,
   * for narrowing a Legal Entity list read — `null` for "every Legal Entity in
   * the Tenant".
   *
   * An Organization Unit scope yields the Legal Entity its covered units belong
   * to: the unit sits INSIDE that Legal Entity, so the structure the user is
   * scoped to cannot be rendered without naming it. That is a read of the
   * parent, not authority over the whole Legal Entity — mutations still go
   * through `isActiveLegalEntityScopeCovered`, which refuses an Organization
   * Unit scope (§4.5 principle 9: a unit authority never widens upward).
   */
  async listScopedLegalEntityIds(actor: ActorContext): Promise<string[] | null> {
    if (actor.assignmentId === null) return [];
    if (actor.scopeType === "tenant") return null;
    if (actor.scopeType === "legal_entity") {
      if (actor.scopeLegalEntityId === null) return [];
      const covered = await this.isActiveLegalEntityScopeCovered(
        actor,
        actor.scopeLegalEntityId,
      );
      return covered ? [actor.scopeLegalEntityId] : [];
    }
    if (actor.scopeType === "organization_unit") {
      const unitIds = await this.listScopedOrganizationUnitIds(actor);
      if (unitIds === null || unitIds.length === 0) return unitIds === null ? null : [];
      const wanted = new Set(unitIds);
      const units = await this.orgUnits.listByTenant(actor.tenantId);
      return [
        ...new Set(
          units.filter((u) => wanted.has(u.id)).map((u) => u.legalEntityId),
        ),
      ];
    }
    return [];
  }

  /** Epic 5 G3 — the enforcement form, and the single entry point a Legal
   * Entity-scoped resource should call. Same-assignment rule: the permission
   * comes from the ACTIVE assignment (requirePermission) and the scope comes
   * from that same context, so a permission held at one scope can never be
   * combined with the scope of another. */
  async requireLegalEntityScopedPermissionForActor(
    actor: ActorContext,
    permissionCode: string,
    targetLegalEntityId: string,
  ): Promise<void> {
    await this.requirePermission(actor, permissionCode);
    if (!(await this.isActiveLegalEntityScopeCovered(actor, targetLegalEntityId))) {
      throw new ForbiddenError(
        "The active Role's Data Scope does not cover this Legal Entity",
      );
    }
  }

  /** Epic 5 G3 — the same combined form for an Organization Unit target: the
   * ACTIVE assignment must carry the permission AND cover the unit, through
   * the tenant → Legal Entity → Organization Unit chain. */
  async requireOrganizationUnitScopedPermissionForActor(
    actor: ActorContext,
    permissionCode: string,
    targetOrganizationUnitId: string,
  ): Promise<void> {
    await this.requirePermission(actor, permissionCode);
    await this.requireOrganizationUnitScopeForActor(actor, targetOrganizationUnitId);
  }

  /** True if the user's ACTIVE assignment is tenant-wide. The userId form is
   * gone: every caller asked "may the actor act tenant-wide", and answering
   * from an inactive Role the user merely holds was the exact bug §4.1
   * closes. */
  async hasTenantScope(actor: ActorContext): Promise<boolean> {
    return actor.assignmentId !== null && actor.scopeType === "tenant";
  }

  /**
   * Used by the Workflow Engine (Checkpoint 0D) to decide whether an actor
   * may act on a Workflow Assignment routed to a Role + Organization Unit
   * "queue" (per 04-Workflow-Approval-Engine-Foundation.md's Assignment
   * concept — a task is routed to whoever holds a role in a scope, not to
   * one pre-picked user).
   *
   * Epic 1 (§4.1 C): the question is now asked about the ACTIVE Role only.
   * Holding Approver in another context must not let the actor decide a task
   * routed to Approver while they are working as Creator — that is precisely
   * the separation-of-duties hole this epic closes.
   *
   * - `targetOrganizationUnitId = null` (a tenant-wide task): the active
   *   assignment must be tenant-wide and carry `roleCode`.
   * - otherwise: the active assignment must be tenant-wide, or scoped to the
   *   target unit itself or one of its ANCESTORS (Checkpoint 0F / ADR-0009).
   */
  async hasActiveRoleCoveringScope(
    actor: ActorContext,
    roleCode: string,
    targetOrganizationUnitId: string | null,
  ): Promise<boolean> {
    if (actor.assignmentId === null || actor.roleCode !== roleCode) return false;
    if (actor.scopeType === "tenant") return true;
    if (targetOrganizationUnitId === null) return false;
    return this.isActiveOrganizationUnitScopeCovered(actor, targetOrganizationUnitId);
  }

  /**
   * Epic 5 G3 — the same coverage question asked about a SET of assignment
   * rows a caller already holds, so a list read does not need one query per
   * row (the shape `isCustomerContextScopeCoveredByAssignments` established).
   *
   * - a tenant-wide assignment covers every Legal Entity;
   * - a `legal_entity` assignment covers exactly its own Legal Entity and
   *   never a sibling of the same Tenant;
   * - an `organization_unit` assignment covers nothing at this level: a unit
   *   is narrower than the Legal Entity that contains it (§4.5 principle 9),
   *   and widening it here would let a unit authority govern the whole Legal
   *   Entity.
   */
  isLegalEntityCoveredByAssignments(
    assignments: readonly UserRoleAssignment[],
    targetLegalEntityId: string,
  ): boolean {
    if (assignments.some((a) => a.scopeType === "tenant")) return true;
    return assignments.some(
      (a) =>
        a.scopeType === "legal_entity" &&
        (a.scopeLegalEntityId ?? null) === targetLegalEntityId,
    );
  }

  /**
   * Checkpoint 1A / ADR-0011 — Customer Data Scope. Every Customer-context
   * entity (Customer, Contract, Project, Site, Service Assignment, and —
   * per the Checkpoint 1A binding decision — Document/Attachment) resolves
   * authorization through this single method, so it can never drift
   * between call sites (the same design goal as ADR-0009's
   * `listAncestorIds`).
   *
   * Epic 1 (§4.1 C): the enforcement form reads the ACTIVE assignment.
   * Covered if it is ANY of:
   * - tenant-wide (internal Administrator/broad role), OR
   * - an organization_unit assignment covering `ownerOrganizationUnitId`
   *   (internal Supervisor/GM/Regional Manager — hierarchical, ADR-0009),
   *   when the target Customer has an owner Organization Unit, OR
   * - a customer assignment matching `customerId` exactly (a Customer User —
   *   no hierarchy, a Customer has no descendants).
   */
  async requireCustomerContextScopeForActor(
    actor: ActorContext,
    target: { customerId: string; ownerOrganizationUnitId: string | null },
  ): Promise<void> {
    const covered = await this.isActiveCustomerContextScopeCovered(actor, target);
    if (!covered) {
      throw new ForbiddenError("The active Role's Data Scope does not cover this Customer");
    }
  }

  async isActiveCustomerContextScopeCovered(
    actor: ActorContext,
    target: { customerId: string; ownerOrganizationUnitId: string | null },
  ): Promise<boolean> {
    if (actor.assignmentId === null) return false;
    if (actor.scopeType === "tenant") return true;
    if (
      actor.scopeType === "customer" &&
      actor.scopeCustomerId === target.customerId
    ) {
      return true;
    }
    // Epic 5 G3 — a Customer owned by an Organization Unit inside the actor's
    // Legal Entity is covered by the Legal Entity scope, exactly the way the
    // unit-scope branch below covers it: the ownership unit is the join
    // between the Customer axis and the internal structure.
    if (
      actor.scopeType === "legal_entity" &&
      actor.scopeLegalEntityId !== null &&
      target.ownerOrganizationUnitId !== null
    ) {
      const ownerUnit = await this.orgUnits.findById(target.ownerOrganizationUnitId);
      return (
        ownerUnit !== null &&
        ownerUnit.tenantId === actor.tenantId &&
        ownerUnit.legalEntityId === actor.scopeLegalEntityId
      );
    }
    if (
      actor.scopeType === "organization_unit" &&
      target.ownerOrganizationUnitId !== null &&
      actor.scopeOrganizationUnitId !== null
    ) {
      const ancestorIds = await this.orgUnits.listAncestorIds(target.ownerOrganizationUnitId);
      return new Set(ancestorIds).has(actor.scopeOrganizationUnitId);
    }
    return false;
  }

  /** Checkpoint 1B hardening — same rule as `isCustomerContextScopeCovered`,
   * taking a pre-fetched assignment list so a caller filtering a WHOLE
   * LIST of Customers (e.g. `CustomerService.listForTenant`) fetches the
   * actor's assignments exactly once instead of once per row. */
  async isCustomerContextScopeCoveredByAssignments(
    assignments: UserRoleAssignment[],
    target: { customerId: string; ownerOrganizationUnitId: string | null },
  ): Promise<boolean> {
    if (assignments.some((a) => a.scopeType === "tenant")) return true;
    if (
      assignments.some(
        (a) => a.scopeType === "customer" && a.scopeCustomerId === target.customerId,
      )
    ) {
      return true;
    }
    if (target.ownerOrganizationUnitId) {
      // Epic 5 G3 — one lookup for the ownership unit answers both internal
      // branches: the unit gives the actor's Legal Entity (legal_entity scope)
      // and the ancestors the unit-scope branch walks.
      const legalEntityAssignments = assignments.filter(
        (a) => a.scopeType === "legal_entity",
      );
      const orgUnitAssignments = assignments.filter((a) => a.scopeType === "organization_unit");
      if (legalEntityAssignments.length === 0 && orgUnitAssignments.length === 0) {
        return false;
      }
      const ownerUnit = await this.orgUnits.findById(target.ownerOrganizationUnitId);
      if (!ownerUnit) return false;
      if (
        legalEntityAssignments.some(
          (a) => (a.scopeLegalEntityId ?? null) === ownerUnit.legalEntityId,
        )
      ) {
        return true;
      }
      if (orgUnitAssignments.length === 0) return false;
      const ancestorIds = await this.orgUnits.listAncestorIds(target.ownerOrganizationUnitId);
      const ancestorSet = new Set(ancestorIds);
      return orgUnitAssignments.some(
        (a) => a.scopeOrganizationUnitId !== null && ancestorSet.has(a.scopeOrganizationUnitId),
      );
    }
    return false;
  }

  /** Epic 1 — the ACTIVE assignment as a zero-or-one element list, in the
   * shape `isCustomerContextScopeCoveredByAssignments` and friends already
   * accept. Callers that filter a whole LIST by Data Scope (a Customer list,
   * a Project list) swap their source from `getAssignments(userId)` to this
   * and inherit active-Role enforcement without changing their predicate. */
  getActiveAssignment(actor: ActorContext): UserRoleAssignment[] {
    if (
      actor.assignmentId === null ||
      actor.roleId === null ||
      actor.roleCode === null ||
      actor.scopeType === null
    ) {
      return [];
    }
    return [
      {
        id: actor.assignmentId,
        userId: actor.userId,
        roleId: actor.roleId,
        roleCode: actor.roleCode,
        scopeType: actor.scopeType,
        scopeLegalEntityId: actor.scopeLegalEntityId,
        scopeOrganizationUnitId: actor.scopeOrganizationUnitId,
        scopeCustomerId: actor.scopeCustomerId,
      },
    ];
  }

  /** Passthrough — see `RbacRepository.getAssignments`. Kept for callers
   * asking what a user holds in the abstract; enforcement callers use
   * `getActiveAssignment`. */
  async getAssignments(userId: string): Promise<UserRoleAssignment[]> {
    return this.repo.getAssignments(userId);
  }

  /** The caller's own assignments with role/scope display names, for the
   * post-login context picker. Passthrough — see
   * `RbacRepository.getMyAssignmentsWithScopeNames`. */
  async getMyAssignmentsWithScopeNames(userId: string): Promise<MyRoleAssignment[]> {
    return this.repo.getMyAssignmentsWithScopeNames(userId);
  }

  /** The permission codes a single Role grants, used to narrow the caller's
   * own effective set when they pick one context on the selection screen.
   * Read-only metadata about a role the caller already holds — no admin
   * permission required, and it cannot widen authority (the picked role is
   * by definition already among the caller's assignments). */
  async getPermissionsForRole(
    tenantId: string,
    roleCode: string,
  ): Promise<Set<string>> {
    const detail = await this.repo.getRolePermissionDetail(tenantId, roleCode);
    return new Set(detail?.permissions.map((p) => p.code) ?? []);
  }

  /** Returns only assignments where the SAME role grants `permissionCode`.
   * This is the authorization input for Customer-context modules that must not
   * combine a permission carried by one assignment with Data Scope from an
   * unrelated assignment. */
  async getAssignmentsWithPermission(
    userId: string,
    permissionCode: string,
  ): Promise<UserRoleAssignment[]> {
    return this.repo.getAssignmentsWithPermission(userId, permissionCode);
  }
}
