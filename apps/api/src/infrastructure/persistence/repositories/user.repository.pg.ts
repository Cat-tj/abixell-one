import type { Pool } from "pg";
import type {
  CreateUserInput,
  UpdateUserProfileInput,
  User,
  UserRepository,
  UserTenantCandidate,
  UserWithPasswordHash,
} from "../../../domain/identity/user.entity.js";
import type { ActorContext } from "../../../domain/shared-kernel/audit-context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../../domain/shared-kernel/errors.js";
import { verifyPassword } from "../../security/password.js";
import {
  inGovernedTransaction,
  requireTransactionActorPermission,
  recordGovernedAudit,
} from "./governed-transaction.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at) : null,
    deactivatedBy: row.deactivated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preferredLocale: (row.preferred_locale ?? "id") as "en" | "id",
  };
}

const USER_ROLE_MANAGE = "user.role.manage";

export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateUserInput, createdBy: string | null): Promise<User> {
    const result = await this.pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [input.tenantId, input.email.toLowerCase(), input.passwordHash, input.fullName, createdBy],
    );
    return mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query(
      `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByEmailInTenant(
    tenantId: string,
    email: string,
  ): Promise<UserWithPasswordHash | null> {
    const result = await this.pool.query(
      `SELECT * FROM users WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL`,
      [tenantId, email.toLowerCase()],
    );
    if (!result.rows[0]) return null;
    return { ...mapRow(result.rows[0]), passwordHash: result.rows[0].password_hash };
  }

  async findCandidatesByEmailAcrossTenants(
    email: string,
  ): Promise<UserTenantCandidate[]> {
    const result = await this.pool.query(
      `SELECT u.*, t.code AS tenant_code, t.name AS tenant_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id AND t.deleted_at IS NULL
        WHERE u.email = $1 AND u.deleted_at IS NULL`,
      [email.toLowerCase()],
    );
    return result.rows.map((row) => ({
      user: { ...mapRow(row), passwordHash: row.password_hash },
      tenant: { id: row.tenant_id, code: row.tenant_code, name: row.tenant_name },
    }));
  }

  async listByTenant(tenantId: string): Promise<User[]> {
    const result = await this.pool.query(
      `SELECT * FROM users WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  async updateProfile(
    id: string,
    input: UpdateUserProfileInput,
    actor: ActorContext,
  ): Promise<User> {
    if (input.fullName === undefined && input.email === undefined && input.passwordHash === undefined) {
      throw new ConflictError("No profile fields supplied");
    }
    return inGovernedTransaction(this.pool, actor.tenantId, async (client) => {
      for (const [field, permission] of [
        [input.fullName, "user.update"],
        [input.email, "user.email.update"],
        [input.passwordHash, "user.password.reset"],
      ] as const) {
        if (field !== undefined) {
          await requireTransactionActorPermission(client, actor, permission);
        }
      }

      const target = await client.query(
        `SELECT id, email, full_name
           FROM users
          WHERE id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
          FOR UPDATE`,
        [id, actor.tenantId],
      );
      if (!target.rows[0]) throw new NotFoundError("User", id);

      const email = input.email?.toLowerCase() ?? target.rows[0].email;
      if (input.email && email !== target.rows[0].email) {
        const duplicate = await client.query(
          `SELECT 1
             FROM users
            WHERE tenant_id = $1
              AND email = $2
              AND id <> $3
              AND deleted_at IS NULL
            FOR UPDATE`,
          [actor.tenantId, email, id],
        );
        if (duplicate.rows[0]) {
          throw new ConflictError(`Email '${input.email}' already exists in this Tenant`);
        }
      }

      const updated = await client.query(
        `UPDATE users
            SET full_name = $1,
                email = $2,
                password_hash = COALESCE($3, password_hash),
                updated_by = $4,
                updated_at = now()
          WHERE id = $5
            AND tenant_id = $6
            AND deleted_at IS NULL
        RETURNING *`,
        [
          input.fullName ?? target.rows[0].full_name,
          email,
          input.passwordHash ?? null,
          actor.userId,
          id,
          actor.tenantId,
        ],
      );
      if (!updated.rows[0]) throw new NotFoundError("User", id);

      // Credential updates invalidate all old refresh sessions. Hashes and
      // replacement credentials are deliberately excluded from audit data.
      if (input.email || input.passwordHash) {
        await client.query(
          `UPDATE refresh_tokens
              SET revoked_at = now()
            WHERE user_id = $1
              AND revoked_at IS NULL`,
          [id],
        );
      }

      await recordGovernedAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "user.updated",
        entityType: "user",
        entityId: id,
        metadata: {
          changedFields: [
            ...(input.fullName !== undefined ? ["fullName"] : []),
            ...(input.email !== undefined ? ["email"] : []),
            ...(input.passwordHash !== undefined ? ["password"] : []),
          ],
        },
      });

      return mapRow(updated.rows[0]);
    });
  }

  // Self-service (PATCH /me) — the target is always the caller, never an
  // id off the wire, so this has no permission gate (unlike updateProfile)
  // and no email field (email stays admin-only via updateProfile above).
  // Current-password verification happens HERE, under the FOR UPDATE row
  // lock, so verification and write are atomic: a concurrent password
  // change either completes first (and the stale currentPassword fails)
  // or this one wins, but a verified-then-overwritten hash is impossible.
  async updateOwnProfile(
    input: UpdateUserProfileInput,
    actor: ActorContext,
    currentPassword?: string,
  ): Promise<User> {
    if (
      input.fullName === undefined &&
      input.passwordHash === undefined &&
      input.preferredLocale === undefined
    ) {
      throw new ConflictError("No profile fields supplied");
    }
    if (input.email !== undefined) {
      throw new ForbiddenError("Email cannot be changed via self-service profile update");
    }
    return inGovernedTransaction(this.pool, actor.tenantId, async (client) => {
      const target = await client.query(
        `SELECT id, full_name, password_hash, preferred_locale
           FROM users
          WHERE id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
            AND status = 'active'
          FOR UPDATE`,
        [actor.userId, actor.tenantId],
      );
      if (!target.rows[0]) throw new NotFoundError("User", actor.userId);
      if (
        input.passwordHash &&
        (currentPassword === undefined ||
          !(await verifyPassword(currentPassword, target.rows[0].password_hash)))
      ) {
        throw new UnauthorizedError("Current password is not valid");
      }

      const updated = await client.query(
        `UPDATE users
            SET full_name = $1,
                password_hash = COALESCE($2, password_hash),
                preferred_locale = COALESCE($3, preferred_locale),
                updated_by = $4,
                updated_at = now()
          WHERE id = $4
            AND tenant_id = $5
            AND deleted_at IS NULL
            AND status = 'active'
        RETURNING *`,
        [
          input.fullName ?? target.rows[0].full_name,
          input.passwordHash ?? null,
          input.preferredLocale ?? null,
          actor.userId,
          actor.tenantId,
        ],
      );
      if (!updated.rows[0]) throw new NotFoundError("User", actor.userId);

      // Credential update invalidates all old refresh sessions.
      if (input.passwordHash) {
        await client.query(
          `UPDATE refresh_tokens
              SET revoked_at = now()
            WHERE user_id = $1
              AND revoked_at IS NULL`,
          [actor.userId],
        );
      }

      await recordGovernedAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "user.updated",
        entityType: "user",
        entityId: actor.userId,
        metadata: {
          changedFields: [
            ...(input.fullName !== undefined ? ["fullName"] : []),
            ...(input.passwordHash !== undefined ? ["password"] : []),
            ...(input.preferredLocale !== undefined ? ["preferredLocale"] : []),
          ],
        },
      });

      return mapRow(updated.rows[0]);
    });
  }

  async setActive(
    id: string,
    isActive: boolean,
    actor: ActorContext,
  ): Promise<User> {
    return inGovernedTransaction(this.pool, actor.tenantId, async (client) => {
      await requireTransactionActorPermission(
        client,
        actor,
        isActive ? "user.activate" : "user.deactivate",
      );

      const target = await client.query(
        `SELECT id, status
           FROM users
          WHERE id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
          FOR UPDATE`,
        [id, actor.tenantId],
      );
      if (!target.rows[0]) throw new NotFoundError("User", id);
      if (!isActive && id === actor.userId) {
        throw new ConflictError("You cannot deactivate your own account");
      }

      if (!isActive) {
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
          [actor.tenantId, USER_ROLE_MANAGE, id],
        );
        if (remainingManagers.rows[0]?.count === 0) {
          throw new ConflictError("Cannot deactivate the final active tenant manager");
        }

        const pendingSpecificAssignment = await client.query(
          `SELECT 1
             FROM workflow_instance_assignments wia
             JOIN workflow_instances wi ON wi.id = wia.workflow_instance_id
            WHERE wi.tenant_id = $1
              AND wia.assigned_user_id = $2
              AND wia.assignment_type = 'specific_user'
              AND wia.status = 'pending'
            LIMIT 1
            FOR UPDATE OF wia`,
          [actor.tenantId, id],
        );
        if (pendingSpecificAssignment.rows[0]) {
          throw new ConflictError(
            "User has pending workflow assignments. Reassign or complete them first.",
          );
        }
      }

      const updated = await client.query(
        `UPDATE users
            SET status = CASE WHEN $1 THEN 'active' ELSE 'inactive' END,
                deactivated_at = CASE WHEN $1 THEN NULL ELSE now() END,
                deactivated_by = CASE WHEN $1 THEN NULL ELSE $2::uuid END,
                updated_by = $2,
                updated_at = now()
          WHERE id = $3
            AND tenant_id = $4
            AND deleted_at IS NULL
        RETURNING *`,
        [isActive, actor.userId, id, actor.tenantId],
      );
      if (!updated.rows[0]) throw new NotFoundError("User", id);

      if (!isActive) {
        await client.query(
          `UPDATE refresh_tokens
              SET revoked_at = now()
            WHERE user_id = $1
              AND revoked_at IS NULL`,
          [id],
        );
      }

      await recordGovernedAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: isActive ? "user.activated" : "user.deactivated",
        entityType: "user",
        entityId: id,
        metadata: {
          previousStatus: target.rows[0].status,
          status: isActive ? "active" : "inactive",
        },
      });

      return mapRow(updated.rows[0]);
    });
  }

  /**
   * Terminate (owner request): the employee left, the record stays. Sets
   * status='terminated' (login denied at auth), revokes every live session
   * and refresh token, and leaves all historical rows untouched — the UI
   * renders the name struck through with a Terminated badge.
   */
  async terminate(
    id: string,
    actor: ActorContext,
    reason: string | null,
  ): Promise<User> {
    return inGovernedTransaction(this.pool, actor.tenantId, async (client) => {
      await requireTransactionActorPermission(client, actor, 'user.deactivate');

      const target = await client.query(
        `SELECT id, status FROM users
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [id, actor.tenantId],
      );
      if (!target.rows[0]) throw new NotFoundError('User', id);
      if (id === actor.userId) {
        throw new ConflictError('You cannot terminate your own account');
      }

      await client.query(
        `UPDATE users SET status='terminated', deactivated_at=now(), deactivated_by=$2, updated_by=$2, updated_at=now()
          WHERE id=$1`,
        [id, actor.userId],
      );
      await client.query(
        `UPDATE sessions SET revoked_at=now(), revoked_reason=$2
          WHERE user_id=$1 AND revoked_at IS NULL`,
        [id, reason ?? 'user terminated'],
      );
      await client.query(
        `UPDATE refresh_tokens SET revoked_at=now()
          WHERE user_id=$1 AND revoked_at IS NULL`,
        [id],
      );

      await recordGovernedAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'user.terminated',
        entityType: 'user',
        entityId: id,
        metadata: { reason: reason ?? null, priorStatus: target.rows[0].status },
      });

      const updated = await client.query(`SELECT * FROM users WHERE id=$1`, [id]);
      return mapRow(updated.rows[0]);
    });
  }
  async softDelete(id: string, actor: ActorContext): Promise<User> {
    return inGovernedTransaction(this.pool, actor.tenantId, async (client) => {
      await requireTransactionActorPermission(client, actor, "user.delete");

      const target = await client.query(
        `SELECT id, status
           FROM users
          WHERE id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
          FOR UPDATE`,
        [id, actor.tenantId],
      );
      if (!target.rows[0]) throw new NotFoundError("User", id);
      if (id === actor.userId) throw new ConflictError("You cannot delete your own account");

      // A soft delete removes this user from the effective-role view just as
      // deactivation does, so it must not remove the final tenant manager.
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
        [actor.tenantId, USER_ROLE_MANAGE, id],
      );
      if (remainingManagers.rows[0]?.count === 0) {
        throw new ConflictError("Cannot delete the final active tenant manager");
      }

      const updated = await client.query(
        `UPDATE users
            SET status = 'inactive',
                deleted_at = now(),
                deleted_by = $1,
                deactivated_at = COALESCE(deactivated_at, now()),
                deactivated_by = COALESCE(deactivated_by, $1),
                updated_by = $1,
                updated_at = now()
          WHERE id = $2
            AND tenant_id = $3
            AND deleted_at IS NULL
        RETURNING *`,
        [actor.userId, id, actor.tenantId],
      );
      if (!updated.rows[0]) throw new NotFoundError("User", id);

      await client.query(
        `UPDATE refresh_tokens
            SET revoked_at = now()
          WHERE user_id = $1
            AND revoked_at IS NULL`,
        [id],
      );

      await recordGovernedAudit(client, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: "user.deleted",
        entityType: "user",
        entityId: id,
      });

      return mapRow(updated.rows[0]);
    });
  }
}
