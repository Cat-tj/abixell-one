import type { Pool } from "pg";
import type { CreateSiteInput, Site, SiteRepository, UpdateSiteInput } from "../../../domain/customer/site.entity.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): Site {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    customerId: row.customer_id,
    projectId: row.project_id,
    code: row.code,
    name: row.name,
    address: row.address,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgSiteRepository implements SiteRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateSiteInput, createdBy: string | null): Promise<Site> {
    const result = await this.pool.query(
      `INSERT INTO sites
         (tenant_id, customer_id, project_id, code, name, address, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [
        input.tenantId,
        input.customerId,
        input.projectId ?? null,
        input.code,
        input.name,
        input.address ?? null,
        input.status ?? "active",
        createdBy,
      ],
    );
    return mapRow(result.rows[0]);
  }

  async update(id: string, input: UpdateSiteInput, updatedBy: string | null): Promise<Site | null> {
    const result = await this.pool.query(
      `UPDATE sites
          SET project_id = CASE WHEN $2::boolean THEN $3 ELSE project_id END,
              code = COALESCE($4, code),
              name = COALESCE($5, name),
              address = CASE WHEN $6::boolean THEN $7 ELSE address END,
              status = COALESCE($8, status),
              updated_by = $9,
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [
        id,
        Object.prototype.hasOwnProperty.call(input, "projectId"),
        input.projectId ?? null,
        input.code ?? null,
        input.name ?? null,
        Object.prototype.hasOwnProperty.call(input, "address"),
        input.address ?? null,
        input.status ?? null,
        updatedBy,
      ],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findById(id: string): Promise<Site | null> {
    const result = await this.pool.query(`SELECT * FROM sites WHERE id = $1 AND deleted_at IS NULL`, [
      id,
    ]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async listForTenant(tenantId: string): Promise<Site[]> {
    const result = await this.pool.query(
      `SELECT * FROM sites WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  }
  async listByCustomer(customerId: string): Promise<Site[]> {
    const result = await this.pool.query(
      `SELECT * FROM sites WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC`,
      [customerId],
    );
    return result.rows.map(mapRow);
  }
}
