export interface Site {
  id: string;
  tenantId: string;
  customerId: string;
  projectId: string | null;
  code: string;
  name: string;
  address: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSiteInput {
  tenantId: string;
  customerId: string;
  projectId?: string | null;
  code: string;
  name: string;
  address?: string | null;
  status?: string;
}

export interface UpdateSiteInput {
  projectId?: string | null;
  code?: string;
  name?: string;
  address?: string | null;
  status?: string;
}

export interface SiteRepository {
  create(input: CreateSiteInput, createdBy: string | null): Promise<Site>;
  update(id: string, input: UpdateSiteInput, updatedBy: string | null): Promise<Site | null>;
  findById(id: string): Promise<Site | null>;
  listByCustomer(customerId: string): Promise<Site[]>;
  /** All sites of a tenant — complaint queue display (owner request). */
  listForTenant(tenantId: string): Promise<Site[]>;
}
