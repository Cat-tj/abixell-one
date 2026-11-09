import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../../infrastructure/persistence/db.js";
import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../domain/shared-kernel/errors.js";
import type { RbacService } from "../rbac/rbac.service.js";
import type { AuditService } from "../audit/audit.service.js";

/**
 * Wave A8 / WP-PLT-A8-01 — Partner credential lifecycle (ADR-0028 §2).
 *
 * Credentials are issued, rotated, and revoked by a tenant admin through
 * the internal (session-authenticated) surface. The plaintext secret is
 * returned exactly once per issue/rotate and stored only as a SHA-256
 * digest. A partner credential is never a user: it has no Role assignment,
 * no session, and cannot reach internal routes.
 */

export interface PartnerCredentialRow {
  id: string;
  tenantId: string;
  name: string;
  clientId: string;
  permissions: string[];
  status: "active" | "revoked";
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface CredentialDao {
  id: string;
  tenant_id: string;
  name: string;
  client_id: string;
  permissions: string[];
  status: "active" | "revoked";
  last_used_at: Date | null;
  created_at: Date;
}

function toRow(d: CredentialDao): PartnerCredentialRow {
  return {
    id: d.id,
    tenantId: d.tenant_id,
    name: d.name,
    clientId: d.client_id,
    permissions: d.permissions ?? [],
    status: d.status,
    lastUsedAt: d.last_used_at,
    createdAt: d.created_at,
  };
}

function hashSecret(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

/** Digest of a fixed dummy secret: unknown client_ids still pay one digest
 * compare so response time does not reveal whether a client_id exists. */
const DUMMY_HASH = hashSecret("partner-credential-dummy-secret");

function digestEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class PartnerCredentialService {
  constructor(
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  /** Issue a new credential (human admin, session-authenticated). Every
   * granted permission must be held by the ISSUER's ACTIVE assignment — a
   * credential can never carry more authority than the person issuing it
   * (ADR-0028 §2 subset rule), fail-closed. */
  async issue(
    actor: ActorContext,
    input: { name: string; permissions: string[] },
  ): Promise<{ credential: PartnerCredentialRow; clientId: string; secret: string }> {
    await this.rbac.requirePermission(actor, "integration.partner_credential.manage");
    const requested = [...new Set(input.permissions)];
    if (requested.length === 0) {
      throw new ValidationError("A partner credential requires at least one permission");
    }
    const held = await this.rbac.getActivePermissions(actor);
    const missing = requested.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw new ForbiddenError(
        `Cannot grant permissions the issuing Role does not hold: ${missing.join(", ")}`,
      );
    }

    const clientId = `pc_${randomBytes(12).toString("hex")}`;
    const secret = randomBytes(32).toString("base64url");
    const inserted = await pool.query<CredentialDao>(
      `INSERT INTO partner_credentials (tenant_id, name, client_id, secret_hash, permissions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, name, client_id, permissions, status, last_used_at, created_at`,
      [actor.tenantId, input.name, clientId, hashSecret(secret), requested, actor.userId],
    );
    const credential = toRow(inserted.rows[0]);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "integration.partner_credential.issued",
      entityType: "partner_credential",
      entityId: credential.id,
      metadata: { name: input.name, clientId, permissions: requested },
    });
    return { credential, clientId, secret };
  }

  async list(actor: ActorContext): Promise<PartnerCredentialRow[]> {
    await this.rbac.requirePermission(actor, "integration.partner_credential.read");
    const rows = await pool.query<CredentialDao>(
      `SELECT id, tenant_id, name, client_id, permissions, status, last_used_at, created_at
         FROM partner_credentials WHERE tenant_id = $1 ORDER BY created_at`,
      [actor.tenantId],
    );
    return rows.rows.map(toRow);
  }

  /** Rotate: replace the secret, keep identity and permissions. The old
   * secret stops working immediately. Only active credentials rotate. */
  async rotate(
    actor: ActorContext,
    credentialId: string,
  ): Promise<{ credentialId: string; clientId: string; secret: string }> {
    await this.rbac.requirePermission(actor, "integration.partner_credential.manage");
    const secret = randomBytes(32).toString("base64url");
    const updated = await pool.query(
      `UPDATE partner_credentials
          SET secret_hash = $3, rotated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'active'
        RETURNING client_id`,
      [credentialId, actor.tenantId, hashSecret(secret)],
    );
    if (updated.rowCount === 0) throw new NotFoundError("PartnerCredential", credentialId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "integration.partner_credential.rotated",
      entityType: "partner_credential",
      entityId: credentialId,
      metadata: { clientId: updated.rows[0].client_id },
    });
    return { credentialId, clientId: updated.rows[0].client_id, secret };
  }

  async revoke(actor: ActorContext, credentialId: string): Promise<void> {
    await this.rbac.requirePermission(actor, "integration.partner_credential.manage");
    const updated = await pool.query(
      `UPDATE partner_credentials
          SET status = 'revoked', revoked_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'active'
        RETURNING client_id`,
      [credentialId, actor.tenantId],
    );
    if (updated.rowCount === 0) throw new NotFoundError("PartnerCredential", credentialId);
    await this.audit.record({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: "integration.partner_credential.revoked",
      entityType: "partner_credential",
      entityId: credentialId,
      metadata: { clientId: updated.rows[0].client_id },
    });
  }

  /** Machine authentication path: verify Basic credentials, return the
   * active credential row. Revoked/unknown credentials are indistinguishable
   * (single generic failure) so callers cannot probe credential state. */
  async authenticate(clientId: string, secret: string): Promise<PartnerCredentialRow> {
    const rows = await pool.query<CredentialDao & { secret_hash: string }>(
      `SELECT id, tenant_id, name, client_id, secret_hash, permissions, status, last_used_at, created_at
         FROM partner_credentials WHERE client_id = $1`,
      [clientId],
    );
    const row = rows.rows[0];
    // Always perform exactly one constant-time digest compare (against a
    // dummy for unknown client_ids) so timing does not reveal existence.
    const hashMatches = digestEquals(row?.secret_hash ?? DUMMY_HASH, hashSecret(secret));
    if (!row || row.status !== "active" || !hashMatches) {
      throw Object.assign(new Error("Invalid partner credentials"), { statusCode: 401 });
    }
    void pool
      .query(`UPDATE partner_credentials SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch(() => {});
    return toRow(row);
  }
}
