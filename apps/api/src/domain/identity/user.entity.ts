export type Locale = "en" | "id";

export interface User {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  status: string;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  preferredLocale: Locale;
}

export interface UserWithPasswordHash extends User {
  passwordHash: string;
}

export interface CreateUserInput {
  tenantId: string;
  email: string;
  fullName: string;
  passwordHash: string;
}

export interface UpdateUserProfileInput {
  fullName?: string;
  email?: string;
  passwordHash?: string;
  preferredLocale?: Locale;
}

export interface LifecycleActor {
  userId: string;
  tenantId: string;
}

/** Email-only login candidate: a (non-deleted) user in a (non-deleted)
 * tenant. Email is unique per-tenant only (`users_tenant_email_unique`),
 * so one address can resolve to several of these across tenants. */
export interface UserTenantCandidate {
  user: UserWithPasswordHash;
  tenant: { id: string; code: string; name: string };
}

export interface UserRepository {
  create(input: CreateUserInput, createdBy: string | null): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmailInTenant(tenantId: string, email: string): Promise<UserWithPasswordHash | null>;
  findCandidatesByEmailAcrossTenants(email: string): Promise<UserTenantCandidate[]>;
  listByTenant(tenantId: string): Promise<User[]>;
  updateProfile(id: string, input: UpdateUserProfileInput, actor: LifecycleActor): Promise<User>;
  updateOwnProfile(
    input: UpdateUserProfileInput,
    actor: LifecycleActor,
    currentPassword?: string,
  ): Promise<User>;
  setActive(id: string, isActive: boolean, actor: LifecycleActor): Promise<User>;
  /** Hard stop: status='terminated', sessions+refresh tokens revoked. */
  terminate(id: string, actor: LifecycleActor, reason: string | null): Promise<User>;
  softDelete(id: string, actor: LifecycleActor): Promise<User>;
}
