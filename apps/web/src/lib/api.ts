const API_BASE = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      // Only advertise a JSON body when we actually send one — Fastify rejects
      // an empty body when Content-Type is application/json, which would break
      // bodyless POSTs (e.g. publish/submit).
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  }
  // A successful 204 deliberately has no representation. Returning `undefined`
  // keeps `request<void>` truthful instead of leaking the JSON fallback object.
  if (response.status === 204) return undefined as T;
  return data as T;
}

/** Multipart variant for the Document/File Service upload endpoint —
 * deliberately does NOT set Content-Type so the browser fills in the
 * multipart boundary itself. */
async function requestForm<T>(path: string, token: string, form: FormData): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

function queryString(query: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export type LoginSuccess = {
  status: "authenticated";
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  /** Epic 1 (§4.1 B): the server-side session this login created. The access
   * token names the session, and the session — not the token — carries the
   * active Role, so switching Roles never needs a new token. */
  sessionId: string;
};

/** Returned instead of tokens when the verified email exists in more than
 * one tenant — the user picks one, then re-submits with its `tenantId`. */
export type TenantSelectionRequired = {
  status: "tenant_selection_required";
  tenants: { tenantId: string; tenantCode: string; tenantName: string }[];
};

export type LoginResult = LoginSuccess | TenantSelectionRequired;

/** One node of the server-served navigation catalogue (§4.3). */
export type MenuNode = {
  code: string;
  name: string;
  description?: string;
  /** `true` = a folder (Grup, Modul); only a folder has children. */
  isSummary: boolean;
  moduleCode?: string;
  /** Route this menu opens; absent for a folder. */
  path?: string;
  isExternalAllowed: boolean;
  requiredPermissions: string[];
  seqNo: number;
  children: MenuNode[];
  /**
   * Wave 2: the caller's role cannot open this page while its module is
   * active, so the server sent it disabled with a reason instead of hiding
   * it. Read as-is — the browser never decides this.
   */
  locked?: boolean;
  lockedReason?: string;
};

/** The caller's OWN role+scope pairs, with display names — drives the
 * post-login "select role & site" screen. Mirrors the backend projection. */
export type MyRoleAssignment = {
  id: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  scopeType: "tenant" | "legal_entity" | "organization_unit" | "customer";
  scopeLegalEntityId: string | null;
  scopeLegalEntityName: string | null;
  scopeOrganizationUnitId: string | null;
  scopeOrganizationUnitName: string | null;
  scopeCustomerId: string | null;
  scopeCustomerName: string | null;
};

/* ---- Organization master types (Epic 5 Gelombang 1/2) ------------------- */

/** A Legal Entity's full representation — the create/update/list routes all
 *  return every column, so the client type mirrors the domain entity rather
 *  than the subset the old narrow type kept. */
export type LegalEntityRow = {
  id: string;
  name: string;
  registrationNo: string | null;
  displayName: string | null;
  country: string | null;
  timezone: string | null;
  baseCurrency: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  isActive: boolean;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
};

/** `Department` organises people; it is not an authorization scope. */
export type DepartmentRow = {
  id: string;
  parentDepartmentId: string | null;
  name: string;
  code: string | null;
  isActive: boolean;
};

/** Ladder level of a layered parameter value (ADR-0006). `S` is written only
 *  with platform authority, never from this client. */
export type ParameterLevel = "S" | "C" | "O";

export type AppParameter = {
  id: string;
  code: string;
  name: string;
  description: string;
  moduleCode: string;
  parameterType: "boolean" | "integer" | "decimal" | "string" | "json";
  schemaArea: string;
  schemaKey: string;
  defaultValue: unknown;
  allowedLevels: ParameterLevel[];
  orgOverrideAllowed: boolean;
  isGuardrail: boolean;
  isActive: boolean;
  /** false = declared in the catalogue but no code reads it yet (§4.15
   * Putaran 7). Absent on an older server build is read as "in use". */
  inUse?: boolean;
};

export type EffectiveParameterValue = {
  code: string;
  value: unknown;
  sourceLevel: ParameterLevel | "product_default";
};

export type OrganizationUnitChangeRequest = {
  id: string;
  organizationUnitId: string;
  requestedAction: "move" | "tombstone";
  proposedParentOrganizationUnitId: string | null;
  requestedReplacementOrganizationUnitId: string | null;
  requestedEffectiveFrom: string;
  reason: string;
  status: "draft" | "pending_review" | "published" | "rejected" | "cancelled";
  proposedByUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  publishedAt: string | null;
  createdAt: string;
};

export type HierarchyHistoryEntry = {
  id: string;
  organizationUnitId: string;
  parentOrganizationUnitId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  reason: string;
  changeRequestId: string | null;
};

export const api = {
  login: (payload: {
    email: string;
    password: string;
    tenantCode?: string;
    tenantId?: string;
  }) => request<LoginResult>("/auth/login", { method: "POST", body: payload }),

  me: (token: string) =>
    request<{
      userId: string;
      tenantId: string;
      /** Epic 1 (§4.1 B): the session id the access token carries. */
      sessionId: string;
      fullName: string;
      email: string;
      /** User's preferred UI language (en | id), persisted server-side so
       * it follows the user across devices rather than living only in
       * this browser's localStorage. */
      preferredLocale: "en" | "id";
      permissions: string[];
      scopeTypes: string[];
      activeModuleCodes: string[];
      /** The caller's navigation tree: the tenant catalogue filtered
       * server-side for THIS caller (§4.3 step 7). Internal menus never
       * reach an external caller, not even disabled. */
      menu: MenuNode[];
      assignments: MyRoleAssignment[];
      activeAssignmentId: string | null;
      /** Display name of the ACTIVE Role (Epic 1 §4.1: the session's
       * active assignment, not a client-side choice). */
      activeAssignmentName: string | null;
      /** Code of the ACTIVE Role — drives the role-aware dashboard. */
      activeRoleCode: string | null;
      /** Display name of the ACTIVE assignment's scope, for the user
       * menu. Null when the session has no active Role. */
      activeScopeName: string | null;
    }>("/me", {
      token,
    }),

  updateProfile: (
    token: string,
    payload: { fullName?: string; password?: string; currentPassword?: string },
  ) =>
    request<{ id: string; email: string; fullName: string; status: string }>("/me", {
      method: "PATCH",
      token,
      body: payload,
    }),

  // Frontend token/session persistence (Checkpoint 0F): `refresh` trades
  // the opaque refresh token for a new access token AND a rotated
  // refresh token (never reused — see refresh-token.ts); `logout`
  // revokes the refresh token server-side so a persisted-but-stale
  // token in localStorage can't be replayed after the user signs out.
  refresh: (refreshToken: string) =>
    request<{ accessToken: string; refreshToken: string }>("/auth/refresh", {
      method: "POST",
      body: { refreshToken },
    }),

  logout: (refreshToken: string) =>
    request<void>("/auth/logout", { method: "POST", body: { refreshToken } }),

  // Epic 1 (§4.1 B/C): change the session's ACTIVE Role. The assignment
  // must be one the caller holds and that is currently effective; the
  // server answers both. No new token is issued — the session row now
  // names a different Role, and the next `/me` reflects it.
  switchRole: (token: string, assignmentId: string) =>
    request<{
      sessionId: string;
      activeAssignmentId: string | null;
      roleId: string;
      roleCode: string;
      scopeType: "tenant" | "organization_unit" | "customer";
      scopeOrganizationUnitId: string | null;
      scopeCustomerId: string | null;
    }>("/auth/switch-role", { method: "POST", token, body: { assignmentId } }),

  // The profile columns are nullable and mean "not configured" — never an
  // invented default (Epic 5 Gelombang 1 §4.5).
  tenant: (token: string) =>
    request<{
      id: string;
      code: string;
      name: string;
      status: string;
      defaultTimezone: string | null;
      defaultLocale: string | null;
      defaultCurrency: string | null;
      contactAdminName: string | null;
      contactAdminEmail: string | null;
      contactAdminPhone: string | null;
    }>("/tenants/me", {
      token,
    }),

  updateTenantName: (
    token: string,
    payload: {
      name: string;
      defaultTimezone?: string | null;
      defaultLocale?: string | null;
      defaultCurrency?: string | null;
      contactAdminName?: string | null;
      contactAdminEmail?: string | null;
      contactAdminPhone?: string | null;
    },
  ) => request<{ name: string }>("/tenants/me", { method: "PATCH", token, body: payload }),

  myDashboard: (token: string) =>
    request<{ blocks: Record<string, Record<string, number | object>> }>("/my/dashboard", {
      token,
    }),

  organizationUnits: (token: string) =>
    request<
      Array<{
        id: string;
        parentId: string | null;
        name: string;
        unitType: string;
        legalEntityId: string;
        isActive: boolean;
        deactivatedAt: string | null;
        deactivatedBy: string | null;
      }>
    >("/organization-units", { token }),

  createOrganizationUnit: (
    token: string,
    payload: { legalEntityId: string; parentId?: string | null; name: string; unitType?: string },
  ) => request("/organization-units", { method: "POST", token, body: payload }),

  legalEntities: (token: string) =>
    request<LegalEntityRow[]>("/legal-entities", { token }),

  createLegalEntity: (
    token: string,
    payload: {
      name: string;
      registrationNo?: string | null;
      displayName?: string | null;
      country?: string | null;
      timezone?: string | null;
      baseCurrency?: string | null;
      email?: string | null;
      phone?: string | null;
    },
  ) => request<LegalEntityRow>("/legal-entities", { method: "POST", token, body: payload }),

  users: (token: string) =>
    request<
      Array<{
        id: string;
        email: string;
        fullName: string;
        status: string;
        deactivatedAt: string | null;
        deactivatedBy: string | null;
      }>
    >("/users", { token }),

  terminateUser: (token: string, id: string, reason: string | null) =>
    request<{ id: string; status: string }>(`/users/${id}/terminate`, {
      method: "POST",
      token,
      body: { reason },
    }),

  createCustomerUser: (
    token: string,
    payload: {
      email: string;
      fullName: string;
      password: string;
      roleCode: string;
      scopeType: "customer";
      scopeCustomerId: string;
    },
  ) => request("/users", { method: "POST", token, body: payload }),

  // --- Checkpoint 0C: Configuration & Metadata Engine -----------------------
  configModules: (token: string) =>
    request<
      Array<{
        moduleId: string;
        moduleCode: string;
        moduleName: string;
        isActive: boolean;
        updatedAt: string | null;
      }>
    >("/config/modules", { token }),

  setConfigModuleActivation: (token: string, code: string, isActive: boolean) =>
    request(`/config/modules/${code}`, { method: "PUT", token, body: { isActive } }),

  configFeatureFlags: (token: string) =>
    request<
      Array<{ code: string; name: string; isEnabled: boolean; source: string }>
    >("/config/feature-flags", { token }),

  configEffectiveFeatureFlags: (token: string, organizationUnitId: string) =>
    request<
      Array<{ code: string; name: string; isEnabled: boolean; source: string }>
    >(`/config/feature-flags/effective?organizationUnitId=${organizationUnitId}`, { token }),

  setConfigFeatureFlag: (
    token: string,
    code: string,
    payload: {
      isEnabled: boolean;
      scopeType: "tenant" | "organization_unit";
      scopeOrganizationUnitId?: string;
    },
  ) => request(`/config/feature-flags/${code}`, { method: "PUT", token, body: payload }),

  configTerminology: (token: string) =>
    request<
      Array<{ code: string; defaultLabel: string; value: string; isOverridden: boolean }>
    >("/config/terminology", { token }),

  setConfigTerminology: (token: string, code: string, value: string) =>
    request(`/config/terminology/${code}`, { method: "PUT", token, body: { value } }),

  configReferenceDataTypes: (token: string) =>
    request<Array<{ code: string; name: string }>>("/config/reference-data-types", { token }),

  configReferenceDataItems: (token: string, typeCode: string) =>
    request<
      Array<{ id: string; code: string; label: string; sortOrder: number; isActive: boolean }>
    >(`/config/reference-data/${typeCode}`, { token }),

  createConfigReferenceDataItem: (
    token: string,
    typeCode: string,
    payload: { code: string; label: string; sortOrder?: number },
  ) => request(`/config/reference-data/${typeCode}`, { method: "POST", token, body: payload }),

  setConfigReferenceDataItemActive: (token: string, typeCode: string, itemId: string, isActive: boolean) =>
    request(`/config/reference-data/${typeCode}/${itemId}`, {
      method: "PATCH",
      token,
      body: { isActive },
    }),

  // --- Organization Unit lifecycle ---
  // `name` is required, not optional: the backend update schema requires it,
  // and the repository writes `unit_type` unconditionally, so a partial
  // payload would silently reset the type. `unitType` stays a plain string
  // because the backend accepts any non-empty value and the entity's own
  // `unitType` is `string` — a union here would be a client-side fiction.
  updateOrganizationUnit: (
    token: string,
    id: string,
    payload: { name: string; unitType?: string },
  ) =>
    request<{
      id: string;
      parentId: string | null;
      name: string;
      unitType: string;
      legalEntityId: string;
      isActive: boolean;
      deactivatedAt: string | null;
      deactivatedBy: string | null;
    }>(`/organization-units/${id}`, { method: "PATCH", token, body: payload }),

  activateOrganizationUnit: (token: string, id: string) =>
    request(`/organization-units/${id}/activate`, { method: "POST", token }),

  deactivateOrganizationUnit: (token: string, id: string) =>
    request(`/organization-units/${id}/deactivate`, { method: "POST", token }),

  // --- Legal Entity lifecycle ---
  updateLegalEntity: (
    token: string,
    id: string,
    payload: {
      name: string;
      registrationNo?: string | null;
      displayName?: string | null;
      country?: string | null;
      timezone?: string | null;
      baseCurrency?: string | null;
      email?: string | null;
      phone?: string | null;
    },
  ) => request<LegalEntityRow>(`/legal-entities/${id}`, { method: "PATCH", token, body: payload }),

  activateLegalEntity: (token: string, id: string) =>
    request(`/legal-entities/${id}/activate`, { method: "POST", token }),

  deactivateLegalEntity: (token: string, id: string) =>
    request(`/legal-entities/${id}/deactivate`, { method: "POST", token }),

  // --- User lifecycle ---
  activateUser: (token: string, id: string) =>
    request(`/users/${id}/activate`, { method: "POST", token }),

  deactivateUser: (token: string, id: string) =>
    request(`/users/${id}/deactivate`, { method: "POST", token }),

  deleteUser: (token: string, id: string) =>
    request(`/users/${id}`, { method: "DELETE", token }),

  configNumberingSequence: (token: string, code: string) =>
    request<{ code: string; pattern: string; currentSequence: number }>(
      `/config/numbering/${code}`,
      { token },
    ),

  generateConfigNumber: (token: string, code: string) =>
    request<{ number: string; sequence: number }>(`/config/numbering/${code}/generate`, {
      method: "POST",
      token,
    }),

  // --- Layered parameters (ADR-0006) ---
  configParameters: (token: string) =>
    request<AppParameter[]>("/config/parameters", { token }),

  configParameterEffective: (token: string, code: string, organizationUnitId?: string) =>
    request<EffectiveParameterValue>(
      `/config/parameters/${encodeURIComponent(code)}/effective${queryString({ organizationUnitId })}`,
      { token },
    ),

  /** `level: "S"` is deliberately absent from the type: System values carry
   *  platform authority that this client never holds, so offering the write
   *  would only produce a 401. */
  setConfigParameterValue: (
    token: string,
    code: string,
    payload: { level: "C" | "O"; value: unknown; organizationUnitId?: string },
  ) =>
    request(`/config/parameters/${encodeURIComponent(code)}/values`, {
      method: "PUT",
      token,
      body: payload,
    }),

  // --- Departments ---
  departments: (token: string) => request<DepartmentRow[]>("/departments", { token }),

  createDepartment: (
    token: string,
    payload: { name: string; code?: string | null; parentDepartmentId?: string | null },
  ) => request<DepartmentRow>("/departments", { method: "POST", token, body: payload }),

  updateDepartment: (
    token: string,
    id: string,
    payload: { name?: string; code?: string | null; parentDepartmentId?: string | null },
  ) => request<DepartmentRow>(`/departments/${id}`, { method: "PATCH", token, body: payload }),

  setDepartmentActive: (token: string, id: string, isActive: boolean) =>
    request<DepartmentRow>(`/departments/${id}/${isActive ? "activate" : "deactivate"}`, {
      method: "POST",
      token,
    }),

  // --- Organization Unit change requests (Epic 5 Gelombang 2) ---
  organizationUnitChangeRequests: (
    token: string,
    filter: { organizationUnitId?: string; status?: string } = {},
  ) =>
    request<OrganizationUnitChangeRequest[]>(
      `/organization-unit-change-requests${queryString(filter)}`,
      { token },
    ),

  organizationUnitHierarchy: (token: string, id: string, at?: string) =>
    request<HierarchyHistoryEntry[]>(
      `/organization-units/${id}/hierarchy${queryString({ at })}`,
      { token },
    ),

  /** `requestedEffectiveFrom` must carry an offset — a bare date is refused,
   *  because a business date without a zone is ambiguous for this tenant. */
  createOrganizationUnitChangeRequest: (
    token: string,
    unitId: string,
    payload: {
      requestedAction: "move" | "tombstone";
      proposedParentOrganizationUnitId?: string | null;
      requestedReplacementOrganizationUnitId?: string | null;
      requestedEffectiveFrom: string;
      reason: string;
      submitForReview?: boolean;
    },
  ) =>
    request<OrganizationUnitChangeRequest>(`/organization-units/${unitId}/change-requests`, {
      method: "POST",
      token,
      body: payload,
    }),

  publishOrganizationUnitChangeRequest: (token: string, id: string) =>
    request<OrganizationUnitChangeRequest>(
      `/organization-unit-change-requests/${id}/publish`,
      { method: "POST", token },
    ),

  rejectOrganizationUnitChangeRequest: (token: string, id: string, reviewReason: string) =>
    request<OrganizationUnitChangeRequest>(
      `/organization-unit-change-requests/${id}/reject`,
      { method: "POST", token, body: { reviewReason } },
    ),

  cancelOrganizationUnitChangeRequest: (token: string, id: string) =>
    request<OrganizationUnitChangeRequest>(
      `/organization-unit-change-requests/${id}/cancel`,
      { method: "POST", token },
    ),

  recentAuditLog: (token: string) =>
    request<
      Array<{
        id: string;
        action: string;
        entityType: string;
        entityId: string | null;
        createdAt: string;
        metadata: Record<string, unknown>;
      }>
    >("/audit-log/recent", { token }),

  // --- Checkpoint 0D: Workflow & Approval Engine -----------------------------
  workflowDefinitions: (token: string) =>
    request<
      Array<{ id: string; code: string; name: string; entityType: string; description: string; isActive: boolean }>
    >("/workflow/definitions", { token }),

  createDemoTransaction: (token: string, title: string) =>
    request<{ id: string; title: string }>("/workflow/demo-transactions", {
      method: "POST",
      token,
      body: { title },
    }),

  startWorkflowInstance: (
    token: string,
    payload: { definitionCode: string; entityId: string; contextData?: Record<string, unknown> },
  ) =>
    request<{ instance: WorkflowInstance; assignment: WorkflowAssignment }>("/workflow/instances", {
      method: "POST",
      token,
      body: payload,
    }),

  workflowInstances: (token: string) => request<WorkflowInstance[]>("/workflow/instances", { token }),

  workflowInstanceHistory: (token: string, instanceId: string) =>
    request<
      Array<{
        id: string;
        fromStepId: string | null;
        toStepId: string | null;
        actionCode: string;
        actorUserId: string | null;
        comment: string | null;
        occurredAt: string;
      }>
    >(`/workflow/instances/${instanceId}/history`, { token }),

  myWorkflowAssignments: (token: string) =>
    request<WorkflowAssignment[]>("/workflow/my-assignments", { token }),

  actOnWorkflowAssignment: (
    token: string,
    assignmentId: string,
    payload: { actionCode: string; comment?: string | null },
  ) =>
    request<{ instance: WorkflowInstance; decidedAssignmentId: string; newAssignment: WorkflowAssignment | null }>(
      `/workflow/assignments/${assignmentId}/act`,
      { method: "POST", token, body: payload },
    ),

  triggerWorkflowEscalationSweep: (token: string) =>
    request<{ escalatedCount: number; escalated: WorkflowAssignment[] }>("/workflow/escalation-sweep", {
      method: "POST",
      token,
    }),

  claimWorkflowAssignment: (token: string, assignmentId: string) =>
    request<WorkflowAssignment>(`/workflow/assignments/${assignmentId}/claim`, { method: "POST", token }),

  releaseWorkflowAssignmentClaim: (token: string, assignmentId: string) =>
    request<WorkflowAssignment>(`/workflow/assignments/${assignmentId}/release-claim`, { method: "POST", token }),

  // --- Checkpoint 0E: Enterprise Shared Services -----------------------------
  notificationTemplates: (token: string) => request<NotificationTemplate[]>("/notifications/templates", { token }),

  createNotificationTemplate: (
    token: string,
    payload: { eventType: string; channel: string; subjectTemplate?: string | null; bodyTemplate: string },
  ) => request<NotificationTemplate>("/notifications/templates", { method: "POST", token, body: payload }),

  myNotifications: (token: string) => request<Notification[]>("/notifications/my", { token }),

  markNotificationRead: (token: string, id: string) =>
    request<Notification>(`/notifications/${id}/read`, { method: "POST", token }),

  documentsForEntity: (token: string, entityType: string, entityId: string) =>
    request<DocumentRecord[]>(`/documents?entityType=${entityType}&entityId=${entityId}`, { token }),

  uploadDocument: (token: string, entityType: string, entityId: string, file: File) => {
    const form = new FormData();
    form.append("entityType", entityType);
    form.append("entityId", entityId);
    form.append("file", file);
    return requestForm<DocumentRecord>("/documents", token, form);
  },

  documentDownloadUrl: (id: string) => `${API_BASE}/documents/${id}/download`,

  /** Authenticated download — the download route requires a Bearer token,
   * which a plain <a href> can't send, so fetch the bytes and hand back a
   * Blob the caller can turn into a temporary object URL. */
  downloadDocument: async (token: string, id: string): Promise<Blob> => {
    const response = await fetch(`${API_BASE}/documents/${id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new ApiError(response.status, `Download failed (${response.status})`);
    return response.blob();
  },

  deleteDocument: (token: string, id: string) => request<DocumentRecord>(`/documents/${id}`, { method: "DELETE", token }),

  scheduledJobs: (token: string) => request<ScheduledJob[]>("/scheduler/jobs", { token }),

  scheduledJobRuns: (token: string, jobCode: string) =>
    request<ScheduledJobRun[]>(`/scheduler/jobs/${jobCode}/runs`, { token }),

  triggerScheduledJob: (token: string, jobCode: string) =>
    request<ScheduledJobRun>(`/scheduler/jobs/${jobCode}/trigger`, { method: "POST", token }),

  integrationEndpoints: (token: string) => request<IntegrationEndpoint[]>("/integration/endpoints", { token }),

  createIntegrationEndpoint: (
    token: string,
    payload: { code: string; name: string; direction: "outbound" | "inbound"; baseUrl?: string | null; webhookSecret?: string | null },
  ) => request<IntegrationEndpoint>("/integration/endpoints", { method: "POST", token, body: payload }),

  setIntegrationEndpointActive: (token: string, code: string, isActive: boolean) =>
    request<IntegrationEndpoint>(`/integration/endpoints/${code}/active`, { method: "POST", token, body: { isActive } }),

  integrationLog: (token: string) => request<IntegrationLogEntry[]>("/integration/log", { token }),

  observabilityEvents: (token: string) => request<DomainEvent[]>("/observability/events", { token }),

  // --- Checkpoint 1A: Customer Experience Foundation -------------------------
  // Backend-scoped: `/customers` returns only the customers within the
  // caller's Data Scope (Customer/Organization/Tenant), never the raw table.
  customers: (token: string) => request<Customer[]>("/customers", { token }),

  createCustomer: (
    token: string,
    payload: {
      code: string;
      name: string;
      status?: string;
      ownerOrganizationUnitId?: string | null;
      notes?: string | null;
    },
  ) => request<Customer>("/customers", { method: "POST", token, body: payload }),

  updateCustomer: (
    token: string,
    id: string,
    payload: {
      code?: string;
      name?: string;
      status?: string;
      ownerOrganizationUnitId?: string | null;
      notes?: string | null;
    },
  ) => request<Customer>(`/customers/${id}`, { method: "PATCH", token, body: payload }),

  customerContacts: (token: string, customerId: string) =>
    request<CustomerContact[]>(`/customer-contacts?customerId=${customerId}`, { token }),

  createCustomerContact: (
    token: string,
    payload: {
      customerId: string;
      name: string;
      email?: string | null;
      phone?: string | null;
      isPrimary?: boolean;
    },
  ) => request<CustomerContact>("/customer-contacts", { method: "POST", token, body: payload }),

  updateCustomerContact: (
    token: string,
    id: string,
    payload: { name?: string; email?: string | null; phone?: string | null; isPrimary?: boolean },
  ) => request<CustomerContact>(`/customer-contacts/${id}`, { method: "PATCH", token, body: payload }),

  contracts: (token: string, customerId: string) =>
    request<ContractRecord[]>(`/contracts?customerId=${customerId}`, { token }),

  createContract: (
    token: string,
    payload: {
      customerId: string;
      code: string;
      name: string;
      startDate?: string | null;
      endDate?: string | null;
      status?: string;
    },
  ) => request<ContractRecord>("/contracts", { method: "POST", token, body: payload }),

  updateContract: (
    token: string,
    id: string,
    payload: { code?: string; name?: string; startDate?: string | null; endDate?: string | null; status?: string },
  ) => request<ContractRecord>(`/contracts/${id}`, { method: "PATCH", token, body: payload }),

  createProject: (
    token: string,
    payload: { customerId: string; contractId?: string | null; code: string; name: string; status?: string },
  ) => request<ProjectRecord>("/projects", { method: "POST", token, body: payload }),

  updateProject: (
    token: string,
    id: string,
    payload: { code?: string; name?: string; status?: string },
  ) => request<ProjectRecord>(`/projects/${id}`, { method: "PATCH", token, body: payload }),

  createSite: (
    token: string,
    payload: {
      customerId: string;
      projectId?: string | null;
      code: string;
      name: string;
      address?: string | null;
      status?: string;
    },
  ) => request<SiteRecord>("/sites", { method: "POST", token, body: payload }),

  updateSite: (
    token: string,
    id: string,
    payload: { code?: string; name?: string; address?: string | null; status?: string },
  ) => request<SiteRecord>(`/sites/${id}`, { method: "PATCH", token, body: payload }),

  commercialServices: (token: string) => request<CommercialService[]>("/services", { token }),

  createCommercialService: (token: string, payload: { code: string; name: string; description?: string | null }) =>
    request<CommercialService>("/services", { method: "POST", token, body: payload }),

  updateCommercialService: (
    token: string,
    id: string,
    payload: { code?: string; name?: string; description?: string | null; isActive?: boolean },
  ) => request<CommercialService>(`/services/${id}`, { method: "PATCH", token, body: payload }),

  customerServiceLinks: (token: string, customerId: string) =>
    request<CustomerServiceLink[]>(`/customer-service-links?customerId=${customerId}`, { token }),

  createCustomerServiceLink: (
    token: string,
    payload: {
      customerId: string;
      serviceId: string;
      contractId?: string | null;
      projectId?: string | null;
      siteId?: string | null;
      internalPicUserId?: string | null;
    },
  ) => request<CustomerServiceLink>("/customer-service-links", { method: "POST", token, body: payload }),

  updateCustomerServiceLink: (token: string, id: string, payload: { status?: string }) =>
    request<CustomerServiceLink>(`/customer-service-links/${id}`, { method: "PATCH", token, body: payload }),

  // --- Checkpoint 1B: Generic Customer Complaint Engine ---------------------
  // Lifecycle/SLA/assignment all live in the Workflow Engine; these methods
  // are the Complaint-specific surface. `actOnComplaint` forwards a
  // Tenant-configured Workflow Transition actionCode verbatim — the set of
  // valid actions is never hardcoded on the client.
  complaintsByCustomer: (token: string, customerId: string) =>
    request<Complaint[]>(`/complaints?customerId=${customerId}`, { token }),

  complaint: (token: string, id: string) =>
    request<{ complaint: Complaint; status: ComplaintStatus | null }>(`/complaints/${id}`, {
      token,
    }),

  // Checkpoint 1C.2 — customer list (status + SLA per row) + composite detail
  // + create-form option catalogs. All read from the real backend.
  complaintsByCustomerSummary: (token: string, customerId: string) =>
    request<ComplaintSummaryItem[]>(`/complaints?customerId=${customerId}&view=summary`, { token }),

  complaintDetail: (token: string, id: string) =>
    request<ComplaintDetailView>(`/complaints/${id}/detail`, { token }),

  complaintReferenceData: (token: string) =>
    request<ComplaintCreateOptions>("/complaints/reference-data", { token }),

  // Checkpoint 1C.3 — operational (internal) queue + detail. Backend restricts
  // both to internal actors; the frontend only reflects the authorized result.
  operationalQueue: (token: string, filters: OperationalQueueFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.assignedToMe) params.set("assignedToMe", "true");
    if (filters.overdue) params.set("overdue", "true");
    if (filters.severity) params.set("severity", filters.severity);
    if (filters.stepCode) params.set("stepCode", filters.stepCode);
    if (filters.customerId) params.set("customerId", filters.customerId);
    if (filters.limit != null) params.set("limit", String(filters.limit));
    if (filters.offset != null) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<OperationalQueueResult>(`/complaints/queue${qs ? `?${qs}` : ""}`, { token });
  },

  operationalDetail: (token: string, id: string) =>
    request<OperationalComplaintDetail>(`/complaints/${id}/operational-detail`, { token }),

  // Checkpoint 1C.5 — Management Dashboard (gated on complaint.dashboard.read
  // + Data Scope in the backend; aggregate read-only).
  complaintDashboard: (token: string, filters: DashboardFilters = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return request<DashboardResult>(`/complaints/dashboard${qs ? `?${qs}` : ""}`, { token });
  },

  // Wave 1 dynamic dashboard — complaint drill-down list (gated on
  // complaint.dashboard.read + Data Scope in the backend).
  complaintDashboardList: (token: string, filters: { status?: "open" | "closed"; severity?: string; category?: string; customerId?: string; limit?: number; offset?: number } = {}) =>
    request<ComplaintDashboardListResult>(`/complaints/dashboard-list${queryString(filters)}`, { token }),

  // Checkpoint 1C.6 — Complaint Administration (gated on complaint.configure).
  complaintConfig: (token: string) => request<ComplaintConfigView>("/complaints/config", { token }),

  createComplaintRefItem: (
    token: string,
    typeCode: string,
    item: { code: string; label: string; sortOrder?: number },
  ) =>
    request<ReferenceItemView>(`/complaints/config/reference-data/${typeCode}`, {
      method: "POST",
      token,
      body: item,
    }),

  setComplaintRefItemActive: (token: string, typeCode: string, itemId: string, isActive: boolean) =>
    request<ReferenceItemView>(`/complaints/config/reference-data/${typeCode}/${itemId}`, {
      method: "PATCH",
      token,
      body: { isActive },
    }),

  createComplaint: (token: string, payload: CreateComplaintPayload) =>
    request<Complaint>("/complaints", { method: "POST", token, body: payload }),

  submitComplaint: (token: string, id: string, comment?: string | null) =>
    request(`/complaints/${id}/submit`, { method: "POST", token, body: { comment: comment ?? null } }),

  actOnComplaint: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request(`/complaints/${id}/actions/${actionCode}`, {
      method: "POST",
      token,
      body: { comment: comment ?? null },
    }),

  updateComplaintInvestigation: (
    token: string,
    id: string,
    payload: {
      rootCause?: string | null;
      correctiveAction?: string | null;
      preventiveAction?: string | null;
      correctiveActionOwnerUserId?: string | null;
      correctiveActionTargetDate?: string | null;
    },
  ) => request<Complaint>(`/complaints/${id}/investigation`, { method: "POST", token, body: payload }),

  verifyComplaint: (token: string, id: string, note?: string | null) =>
    request<Complaint>(`/complaints/${id}/verification`, {
      method: "POST",
      token,
      body: { note: note ?? null },
    }),

  confirmComplaintByCustomer: (token: string, id: string, note?: string | null) =>
    request<Complaint>(`/complaints/${id}/customer-confirmation`, {
      method: "POST",
      token,
      body: { note: note ?? null },
    }),

  reopenComplaint: (token: string, id: string, toStepCode: string, comment?: string | null) =>
    request(`/complaints/${id}/reopen`, {
      method: "POST",
      token,
      body: { toStepCode, comment: comment ?? null },
    }),

  // --- Checkpoint 1D: Generic Survey & Assessment Engine --------------------
  // Admin (survey.manage)
  surveys: (token: string) => request<SurveyDefinition[]>("/surveys", { token }),
  survey: (token: string, code: string) => request<SurveyDetail>(`/surveys/${code}`, { token }),
  createSurvey: (token: string, payload: { code: string; name: string; description?: string | null }) =>
    request<{ definition: SurveyDefinition; version: SurveyVersion }>("/surveys", {
      method: "POST",
      token,
      body: payload,
    }),
  createSurveyVersion: (token: string, code: string) =>
    request<SurveyVersion>(`/surveys/${code}/versions`, { method: "POST", token }),
  surveyVersionDetail: (token: string, versionId: string) =>
    request<SurveyVersionDetail>(`/survey-versions/${versionId}`, { token }),
  addSurveySection: (
    token: string,
    versionId: string,
    payload: {
      code: string;
      title: string;
      description?: string | null;
      sortOrder?: number;
      scoringModel?: SurveyScoringModel | null;
      weight?: number;
    },
  ) => request<SurveySection>(`/survey-versions/${versionId}/sections`, { method: "POST", token, body: payload }),
  addSurveyQuestion: (
    token: string,
    versionId: string,
    payload: {
      sectionId?: string | null;
      code: string;
      text: string;
      questionType: string;
      isRequired?: boolean;
      config?: Record<string, unknown>;
      sortOrder?: number;
      weight?: number;
    },
  ) => request<SurveyQuestion>(`/survey-versions/${versionId}/questions`, { method: "POST", token, body: payload }),
  addSurveyOption: (
    token: string,
    questionId: string,
    payload: { code: string; label: string; score?: number | null; sortOrder?: number },
  ) => request<SurveyQuestionOption>(`/survey-questions/${questionId}/options`, { method: "POST", token, body: payload }),
  publishSurveyVersion: (token: string, code: string, versionNumber: number) =>
    request<SurveyVersion>(`/surveys/${code}/versions/${versionNumber}/publish`, { method: "POST", token }),
  retireSurveyVersion: (token: string, code: string, versionNumber: number) =>
    request<SurveyVersion>(`/surveys/${code}/versions/${versionNumber}/retire`, { method: "POST", token }),
  createSurveyAssignment: (
    token: string,
    payload: {
      surveyDefinitionCode?: string;
      surveyVersionId?: string;
      respondentUserId: string;
      dueAt?: string | null;
    },
  ) => request<SurveyAssignment>("/survey-assignments", { method: "POST", token, body: payload }),
  surveyResult: (token: string, assignmentId: string) =>
    request<SurveyResultView>(`/survey-assignments/${assignmentId}/result`, { token }),

  // Dashboard drill-down: all assignments (manage OR analytics.read).
  surveyAssignments: (token: string) => request<SurveyAssignment[]>("/survey-assignments", { token }),

  // Respondent (survey.respond)
  mySurveyAssignments: (token: string) => request<MySurveyItem[]>("/survey-assignments/my", { token }),
  surveyAssignment: (token: string, id: string) =>
    request<SurveyRespondentView>(`/survey-assignments/${id}`, { token }),
  saveSurveyAnswers: (
    token: string,
    id: string,
    answers: SurveyAnswerInput[],
    matrixAnswers: SurveyMatrixAnswerInput[] = [],
  ) =>
    request<{ ok: boolean }>(`/survey-assignments/${id}/answers`, {
      method: "POST",
      token,
      body: { answers, matrixAnswers },
    }),
  submitSurvey: (token: string, id: string) =>
    request<SurveyAssignment>(`/survey-assignments/${id}/submit`, { method: "POST", token }),

  // --- Wave A2: Survey & Assessment Advanced (SUR-ADV-003…007) ---------
  surveyBranchingRules: (token: string, versionId: string) =>
    request<SurveyBranchingRule[]>(`/survey-versions/${versionId}/branching-rules`, { token }),
  addSurveyBranchingRule: (token: string, versionId: string, body: CreateSurveyBranchingRuleBody) =>
    request<SurveyBranchingRule>(`/survey-versions/${versionId}/branching-rules`, {
      method: "POST",
      token,
      body,
    }),
  deleteSurveyBranchingRule: (token: string, versionId: string, ruleId: string) =>
    request<void>(`/survey-versions/${versionId}/branching-rules/${ruleId}`, {
      method: "DELETE",
      token,
    }),
  surveyMatrixRows: (token: string, questionId: string) =>
    request<SurveyMatrixRow[]>(`/survey-questions/${questionId}/matrix-rows`, { token }),
  addSurveyMatrixRow: (
    token: string,
    questionId: string,
    body: { code: string; label: string; sortOrder?: number },
  ) =>
    request<SurveyMatrixRow>(`/survey-questions/${questionId}/matrix-rows`, {
      method: "POST",
      token,
      body,
    }),
  surveyDistributionTokens: (token: string, versionId: string) =>
    request<SurveyDistributionToken[]>(`/survey-versions/${versionId}/distribution-tokens`, { token }),
  createSurveyDistributionToken: (
    token: string,
    versionId: string,
    body: CreateSurveyDistributionTokenBody,
  ) =>
    request<CreatedSurveyDistributionToken>(`/survey-versions/${versionId}/distribution-tokens`, {
      method: "POST",
      token,
      body,
    }),
  revokeSurveyDistributionToken: (token: string, tokenId: string) =>
    request<{ ok: boolean }>(`/survey-distribution-tokens/${tokenId}/revoke`, {
      method: "POST",
      token,
    }),
  surveyTranslations: (token: string, versionId: string, locale?: string) => {
    const query = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    return request<SurveyTranslation[]>(`/survey-versions/${versionId}/translations${query}`, { token });
  },
  upsertSurveyTranslation: (
    token: string,
    versionId: string,
    body: UpsertSurveyTranslationBody,
  ) =>
    request<SurveyTranslation>(`/survey-versions/${versionId}/translations`, {
      method: "PUT",
      token,
      body,
    }),
  deleteSurveyTranslation: (token: string, versionId: string, translationId: string) =>
    request<void>(`/survey-versions/${versionId}/translations/${translationId}`, {
      method: "DELETE",
      token,
    }),
  surveyAnalytics: (token: string, code: string) =>
    request<SurveyAnalyticsOverview>(`/surveys/${encodeURIComponent(code)}/analytics`, { token }),
  surveyBenchmark: (token: string, code: string) =>
    request<SurveyBenchmarkResult>(`/surveys/${encodeURIComponent(code)}/benchmark`, { token }),
  publicSurvey: (publicToken: string, locale?: string) => {
    const query = locale ? `?locale=${encodeURIComponent(locale)}` : "";
    return request<PublicSurveyView>(`/public/surveys/${encodeURIComponent(publicToken)}${query}`);
  },
  submitPublicSurvey: (
    publicToken: string,
    body: { answers: SurveyAnswerInput[]; matrixAnswers?: SurveyMatrixAnswerInput[] },
  ) =>
    request<PublicSurveySubmissionResult>(`/public/surveys/${encodeURIComponent(publicToken)}/submit`, {
      method: "POST",
      body,
    }),

  // --- Service Operations & Work Management (Phase 2) -----------------
  serviceDefinitions: (token: string) => request<ServiceDefinition[]>("/service-definitions", { token }),
  serviceDefinition: (token: string, code: string) =>
    request<{ definition: ServiceDefinition; checklist: ServiceChecklistTemplateItem[] }>(
      `/service-definitions/${code}`,
      { token },
    ),
  createServiceDefinition: (
    token: string,
    body: { code: string; name: string; description?: string | null; category?: string | null },
  ) => request<ServiceDefinition>("/service-definitions", { method: "POST", token, body }),
  addServiceChecklistItem: (
    token: string,
    code: string,
    body: { code: string; label: string; isRequired?: boolean; sortOrder?: number },
  ) =>
    request<ServiceChecklistTemplateItem>(`/service-definitions/${code}/checklist-items`, {
      method: "POST",
      token,
      body,
    }),
  setServiceDefinitionActive: (token: string, code: string, isActive: boolean) =>
    request<ServiceDefinition>(`/service-definitions/${code}/active`, {
      method: "PATCH",
      token,
      body: { isActive },
    }),

  workRequests: (token: string) => request<WorkRequestRow[]>("/work-requests", { token }),
  createWorkRequest: (
    token: string,
    body: {
      customerId: string;
      siteId?: string | null;
      serviceDefinitionCode: string;
      description: string;
      priority?: string | null;
    },
  ) => request<WorkRequest>("/work-requests", { method: "POST", token, body }),
  cancelWorkRequest: (token: string, id: string, reason: string | null) =>
    request<WorkRequest>(`/work-requests/${id}/cancel`, { method: "POST", token, body: { reason } }),
  convertWorkRequest: (token: string, id: string, body: { title?: string; dueAt?: string | null }) =>
    request<WorkOrder>(`/work-requests/${id}/convert`, { method: "POST", token, body }),

  workOrders: (token: string, query: { status?: "open" | "completed" } = {}) =>
    request<WorkOrderRow[]>(`/work-orders${queryString(query)}`, { token }),
  myWorkOrders: (token: string) => request<WorkOrderRow[]>("/work-orders/my", { token }),
  workOrder: (token: string, id: string) => request<WorkOrderDetail>(`/work-orders/${id}`, { token }),
  createWorkOrder: (
    token: string,
    body: {
      customerId: string;
      siteId?: string | null;
      serviceDefinitionCode: string;
      title: string;
      description?: string | null;
      priority?: string | null;
      dueAt?: string | null;
    },
  ) => request<WorkOrder>("/work-orders", { method: "POST", token, body }),
  assignWorkOrder: (token: string, id: string, assigneeUserId: string) =>
    request<WorkOrder>(`/work-orders/${id}/assign`, { method: "POST", token, body: { assigneeUserId } }),
  scheduleWorkOrder: (
    token: string,
    id: string,
    body: { plannedStartAt?: string | null; plannedEndAt?: string | null; dueAt?: string | null },
  ) => request<WorkOrder>(`/work-orders/${id}/schedule`, { method: "POST", token, body }),
  actOnWorkOrder: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ workOrder: WorkOrder }>(`/work-orders/${id}/actions/${actionCode}`, {
      method: "POST",
      token,
      body: { comment: comment ?? null },
    }),
  startWorkOrder: (token: string, id: string) =>
    request<WorkOrder>(`/work-orders/${id}/start`, { method: "POST", token }),
  setWorkOrderChecklistItem: (
    token: string,
    id: string,
    itemId: string,
    body: { isCompleted: boolean; note?: string | null },
  ) => request<WorkOrderChecklistItem>(`/work-orders/${id}/checklist/${itemId}`, { method: "POST", token, body }),
  completeWorkOrder: (token: string, id: string, notes: string | null) =>
    request<WorkOrder>(`/work-orders/${id}/complete`, { method: "POST", token, body: { notes } }),
  verifyWorkOrder: (token: string, id: string, notes: string | null) =>
    request<WorkOrder>(`/work-orders/${id}/verify`, { method: "POST", token, body: { notes } }),
  recordServingLog: (token: string, workOrderId: string, body: CreateServingLogInput) =>
    request<{ servingLog: WorkOrderServingLog }>(`/work-orders/${workOrderId}/serving`, {
      method: "POST",
      token,
      body,
    }),
  getServingLog: (token: string, workOrderId: string) =>
    request<{ servingLog: WorkOrderServingLog | null }>(`/work-orders/${workOrderId}/serving`, { token }),
  updateServingLog: (token: string, workOrderId: string, body: UpdateServingLogInput) =>
    request<{ servingLog: WorkOrderServingLog }>(`/work-orders/${workOrderId}/serving`, {
      method: "PATCH",
      token,
      body,
    }),
  getMgmtDashboard: (token: string, period: string) =>
    request<DashboardL2>(`/dashboard/management?period=${encodeURIComponent(period)}`, { token }),

  // --- Wave A3: Service Operations Advanced (PACK-001…004 / SO-ADV-002…005)
  servicePacks: (token: string) =>
    request<ServicePackView[]>("/service-operations/packs", { token }),
  servicePack: (token: string, packCode: ServicePackCode) =>
    request<ServicePackDetail>(`/service-operations/packs/${encodeURIComponent(packCode)}`, { token }),
  activateServicePack: (token: string, packCode: ServicePackCode, seedPresets: boolean) =>
    request<ServicePackActivation>(
      `/service-operations/packs/${encodeURIComponent(packCode)}/activate`,
      { method: "POST", token, body: { seedPresets } },
    ),
  deactivateServicePack: (token: string, packCode: ServicePackCode) =>
    request<ServicePackActivation>(
      `/service-operations/packs/${encodeURIComponent(packCode)}/deactivate`,
      { method: "POST", token },
    ),
  optimizationRuns: (token: string, limit = 50) =>
    request<OptimizationRun[]>(`/service-operations/optimization/runs?limit=${limit}`, { token }),
  optimizationRun: (token: string, id: string) =>
    request<OptimizationRun>(`/service-operations/optimization/runs/${id}`, { token }),
  generateOptimizationRun: (token: string, body: GenerateOptimizationRunBody) =>
    request<OptimizationRun>("/service-operations/optimization/runs", {
      method: "POST",
      token,
      body,
    }),
  applyOptimizationRun: (token: string, id: string) =>
    request<ApplyOptimizationResponse>(`/service-operations/optimization/runs/${id}/apply`, {
      method: "POST",
      token,
    }),
  dismissOptimizationRun: (token: string, id: string) =>
    request<OptimizationRun>(`/service-operations/optimization/runs/${id}/dismiss`, {
      method: "POST",
      token,
    }),

  // --- Wave A4: Workforce Advanced (HR-ADV-001…009) ------------------
  workforceShifts: (token: string, includeInactive = false) =>
    request<WorkforceShift[]>(`/workforce/advanced/shifts${includeInactive ? "?includeInactive=true" : ""}`, { token }),
  createWorkforceShift: (token: string, body: CreateWorkforceShiftBody) =>
    request<WorkforceShift>("/workforce/advanced/shifts", { method: "POST", token, body }),
  setWorkforceShiftActive: (token: string, id: string, isActive: boolean) =>
    request<WorkforceShift>(`/workforce/advanced/shifts/${id}/active`, { method: "PATCH", token, body: { isActive } }),
  workforceRosters: (token: string, query: WorkforceRosterQuery = {}) =>
    request<WorkforceRoster[]>(`/workforce/advanced/rosters${queryString(query)}`, { token }),
  upsertWorkforceRoster: (token: string, body: UpsertWorkforceRosterBody) =>
    request<WorkforceRoster>("/workforce/advanced/rosters", { method: "PUT", token, body }),
  workforceAttendance: (token: string, query: WorkforceAttendanceQuery = {}) =>
    request<WorkforceAttendanceRecord[]>(`/workforce/advanced/attendance${queryString(query)}`, { token }),
  recordWorkforceAttendance: (token: string, body: RecordWorkforceAttendanceBody) =>
    request<WorkforceAttendanceRecord>("/workforce/advanced/attendance", { method: "POST", token, body }),

  workforceLeaveTypes: (token: string, includeInactive = false) =>
    request<WorkforceLeaveType[]>(`/workforce/advanced/leave-types${includeInactive ? "?includeInactive=true" : ""}`, { token }),
  createWorkforceLeaveType: (token: string, body: CreateWorkforceLeaveTypeBody) =>
    request<WorkforceLeaveType>("/workforce/advanced/leave-types", { method: "POST", token, body }),
  workforceLeaveBalances: (token: string, employeeId: string, balanceYear?: number) =>
    request<WorkforceLeaveBalance[]>(`/workforce/advanced/leave-balances${queryString({ employeeId, balanceYear })}`, { token }),
  setWorkforceLeaveAllocation: (token: string, body: SetWorkforceLeaveAllocationBody) =>
    request<WorkforceLeaveBalance>("/workforce/advanced/leave-balances", { method: "PUT", token, body }),
  workforceLeaveRequests: (token: string, query: WorkforceLeaveRequestQuery = {}) =>
    request<WorkforceLeaveRequestRow[]>(`/workforce/advanced/leave-requests${queryString(query)}`, { token }),
  createWorkforceLeaveRequest: (token: string, body: CreateWorkforceLeaveRequestBody) =>
    request<WorkforceLeaveRequest>("/workforce/advanced/leave-requests", { method: "POST", token, body }),
  actOnWorkforceLeaveRequest: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ leaveRequest: WorkforceLeaveRequest; workflowResult: unknown }>(`/workforce/advanced/leave-requests/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),
  workforceOvertimeRequests: (token: string, query: WorkforceOvertimeRequestQuery = {}) =>
    request<WorkforceOvertimeRequestRow[]>(`/workforce/advanced/overtime-requests${queryString(query)}`, { token }),
  createWorkforceOvertimeRequest: (token: string, body: CreateWorkforceOvertimeRequestBody) =>
    request<WorkforceOvertimeRequest>("/workforce/advanced/overtime-requests", { method: "POST", token, body }),
  recordWorkforceActualOvertime: (token: string, id: string, actualHours: number) =>
    request<WorkforceOvertimeRequest>(`/workforce/advanced/overtime-requests/${id}/actual`, { method: "POST", token, body: { actualHours } }),
  actOnWorkforceOvertimeRequest: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ overtimeRequest: WorkforceOvertimeRequest; workflowResult: unknown }>(`/workforce/advanced/overtime-requests/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),

  workforceStatutoryPolicies: (token: string) =>
    request<WorkforceStatutoryPolicy[]>("/workforce/advanced/statutory-policies", { token }),
  createWorkforceStatutoryPolicy: (token: string, body: CreateWorkforceStatutoryPolicyBody) =>
    request<WorkforceStatutoryPolicy>("/workforce/advanced/statutory-policies", { method: "POST", token, body }),
  setWorkforceSalaryProfile: (token: string, body: SetWorkforceSalaryProfileBody) =>
    request<WorkforceEmployeeSalaryProfile>("/workforce/advanced/salary-profiles", { method: "PUT", token, body }),
  workforcePayrollRuns: (token: string, query: WorkforcePayrollRunQuery = {}) =>
    request<WorkforcePayrollRunRow[]>(`/workforce/advanced/payroll-runs${queryString(query)}`, { token }),
  workforcePayrollRun: (token: string, id: string) =>
    request<WorkforcePayrollRunDetail>(`/workforce/advanced/payroll-runs/${id}`, { token }),
  createWorkforcePayrollRun: (token: string, body: CreateWorkforcePayrollRunBody) =>
    request<WorkforcePayrollRun>("/workforce/advanced/payroll-runs", { method: "POST", token, body }),
  calculateWorkforcePayrollRun: (token: string, id: string) =>
    request<WorkforcePayrollCalculation>(`/workforce/advanced/payroll-runs/${id}/calculate`, { method: "POST", token }),
  actOnWorkforcePayrollRun: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ payrollRun: WorkforcePayrollRun; workflowResult: unknown }>(`/workforce/advanced/payroll-runs/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),
  workforcePayslips: (token: string, payrollRunId: string) =>
    request<WorkforcePayslip[]>(`/workforce/advanced/payroll-runs/${payrollRunId}/payslips`, { token }),

  workforceJobPostings: (token: string, query: WorkforceJobPostingQuery = {}) =>
    request<WorkforceJobPostingRow[]>(`/workforce/advanced/job-postings${queryString(query)}`, { token }),
  createWorkforceJobPosting: (token: string, body: CreateWorkforceJobPostingBody) =>
    request<WorkforceJobPosting>("/workforce/advanced/job-postings", { method: "POST", token, body }),
  actOnWorkforceJobPosting: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ jobPosting: WorkforceJobPosting; workflowResult: unknown }>(`/workforce/advanced/job-postings/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),
  workforceJobApplications: (token: string, query: WorkforceJobApplicationQuery = {}) =>
    request<WorkforceJobApplication[]>(`/workforce/advanced/job-applications${queryString(query)}`, { token }),
  createWorkforceJobApplication: (token: string, body: CreateWorkforceJobApplicationBody) =>
    request<WorkforceJobApplication>("/workforce/advanced/job-applications", { method: "POST", token, body }),
  advanceWorkforceJobApplication: (token: string, id: string, body: AdvanceWorkforceJobApplicationBody) =>
    request<WorkforceJobApplication>(`/workforce/advanced/job-applications/${id}/stage`, { method: "POST", token, body }),

  workforceCompetencies: (token: string, includeInactive = false) =>
    request<WorkforceCompetency[]>(`/workforce/advanced/competencies${includeInactive ? "?includeInactive=true" : ""}`, { token }),
  createWorkforceCompetency: (token: string, body: CreateWorkforceCompetencyBody) =>
    request<WorkforceCompetency>("/workforce/advanced/competencies", { method: "POST", token, body }),
  assessWorkforceEmployeeCompetency: (token: string, body: AssessWorkforceEmployeeCompetencyBody) =>
    request<WorkforceEmployeeCompetency>("/workforce/advanced/employee-competencies", { method: "PUT", token, body }),
  workforceEmployeeCompetencies: (token: string, employeeId: string) =>
    request<WorkforceEmployeeCompetency[]>(`/workforce/advanced/employees/${employeeId}/competencies`, { token }),
  workforceTrainingCourses: (token: string, includeInactive = false) =>
    request<WorkforceTrainingCourse[]>(`/workforce/advanced/training-courses${includeInactive ? "?includeInactive=true" : ""}`, { token }),
  createWorkforceTrainingCourse: (token: string, body: CreateWorkforceTrainingCourseBody) =>
    request<WorkforceTrainingCourse>("/workforce/advanced/training-courses", { method: "POST", token, body }),
  workforceTrainingEnrollments: (token: string, employeeId: string) =>
    request<WorkforceTrainingEnrollment[]>(`/workforce/advanced/training-enrollments${queryString({ employeeId })}`, { token }),
  enrollWorkforceTraining: (token: string, body: EnrollWorkforceTrainingBody) =>
    request<WorkforceTrainingEnrollment>("/workforce/advanced/training-enrollments", { method: "POST", token, body }),
  completeWorkforceTraining: (token: string, id: string, body: CompleteWorkforceTrainingBody) =>
    request<WorkforceTrainingEnrollment>(`/workforce/advanced/training-enrollments/${id}/complete`, { method: "POST", token, body }),
  workforcePerformanceReviews: (token: string, query: WorkforcePerformanceReviewQuery = {}) =>
    request<WorkforcePerformanceReviewRow[]>(`/workforce/advanced/performance-reviews${queryString(query)}`, { token }),
  createWorkforcePerformanceReview: (token: string, body: CreateWorkforcePerformanceReviewBody) =>
    request<WorkforcePerformanceReview>("/workforce/advanced/performance-reviews", { method: "POST", token, body }),
  actOnWorkforcePerformanceReview: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ review: WorkforcePerformanceReview; workflowResult: unknown }>(`/workforce/advanced/performance-reviews/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),
  workforceCareerPaths: (token: string, fromPositionId?: string) =>
    request<WorkforceCareerPath[]>(`/workforce/advanced/career-paths${queryString({ fromPositionId })}`, { token }),
  createWorkforceCareerPath: (token: string, body: CreateWorkforceCareerPathBody) =>
    request<WorkforceCareerPath>("/workforce/advanced/career-paths", { method: "POST", token, body }),

  workforceManpowerPlans: (token: string, query: WorkforceManpowerPlanQuery = {}) =>
    request<WorkforceManpowerPlan[]>(`/workforce/advanced/manpower-plans${queryString(query)}`, { token }),
  createWorkforceManpowerPlan: (token: string, body: CreateWorkforceManpowerPlanBody) =>
    request<WorkforceManpowerPlan>("/workforce/advanced/manpower-plans", { method: "POST", token, body }),
  computeWorkforceManpowerPlan: (token: string, id: string, targetHeadcountByPosition: Record<string, number>) =>
    request<WorkforceManpowerPlan>(`/workforce/advanced/manpower-plans/${id}/compute`, {
      method: "POST", token, body: { targetHeadcountByPosition },
    }),
  applyWorkforceManpowerPlan: (token: string, id: string) =>
    request<WorkforceManpowerPlan>(`/workforce/advanced/manpower-plans/${id}/apply`, { method: "POST", token }),
  dismissWorkforceManpowerPlan: (token: string, id: string) =>
    request<WorkforceManpowerPlan>(`/workforce/advanced/manpower-plans/${id}/dismiss`, { method: "POST", token }),

  // --- Workforce / HR (Phase 3) ---------------------------------------
  positions: (token: string) => request<PositionRecord[]>("/positions", { token }),
  createPosition: (token: string, body: { code: string; name: string; description?: string | null }) =>
    request<PositionRecord>("/positions", { method: "POST", token, body }),
  setPositionActive: (token: string, code: string, isActive: boolean) =>
    request<PositionRecord>(`/positions/${code}/active`, { method: "PATCH", token, body: { isActive } }),

  employees: (token: string, query: { search?: string; employmentStatus?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set("search", query.search);
    if (query.employmentStatus) params.set("employmentStatus", query.employmentStatus);
    const qs = params.toString();
    return request<Employee[]>(`/employees${qs ? `?${qs}` : ""}`, { token });
  },
  employee: (token: string, id: string) => request<EmployeeDetail>(`/employees/${id}`, { token }),
  myEmployeeRecord: (token: string) => request<EmployeeDetail>("/employees/me", { token }),
  createEmployee: (
    token: string,
    body: {
      employeeNumber?: string;
      fullName: string;
      email?: string | null;
      phone?: string | null;
      employmentType?: string | null;
      joinedAt?: string | null;
      legalEntityId?: string | null;
      organizationUnitId?: string | null;
      positionCode?: string | null;
    },
  ) => request<Employee>("/employees", { method: "POST", token, body }),
  updateEmployeeProfile: (
    token: string,
    id: string,
    body: { fullName?: string; email?: string | null; phone?: string | null; employmentType?: string | null },
  ) => request<Employee>(`/employees/${id}`, { method: "PATCH", token, body }),
  changeEmployeePlacement: (
    token: string,
    id: string,
    body: {
      legalEntityId?: string | null;
      organizationUnitId?: string | null;
      positionCode?: string | null;
      employmentStatus?: string;
      effectiveFrom?: string;
      note?: string | null;
    },
  ) => request<EmployeeDetail>(`/employees/${id}/placement`, { method: "POST", token, body }),
  setEmployeeUserLink: (token: string, id: string, userId: string | null) =>
    request<Employee>(`/employees/${id}/user-link`, { method: "POST", token, body: { userId } }),

  // --- Supply Chain (Phase 4) -----------------------------------------
  scmItems: (token: string, query: { search?: string } = {}) => {
    const qs = query.search ? `?search=${encodeURIComponent(query.search)}` : "";
    return request<ScmItem[]>(`/items${qs}`, { token });
  },
  scmItem: (token: string, code: string) =>
    request<{ item: ScmItem; balances: StockBalanceRecord[] }>(`/items/${code}`, { token }),
  createScmItem: (
    token: string,
    body: { code: string; name: string; description?: string | null; category?: string | null; unitOfMeasure: string },
  ) => request<ScmItem>("/items", { method: "POST", token, body }),
  updateScmItem: (token: string, code: string, body: { name?: string; isActive?: boolean }) =>
    request<ScmItem>(`/items/${code}`, { method: "PATCH", token, body }),

  suppliers: (token: string, query: { search?: string } = {}) => {
    const qs = query.search ? `?search=${encodeURIComponent(query.search)}` : "";
    return request<SupplierRecord[]>(`/suppliers${qs}`, { token });
  },
  createSupplier: (
    token: string,
    body: { code: string; name: string; contactName?: string | null; email?: string | null; phone?: string | null },
  ) => request<SupplierRecord>("/suppliers", { method: "POST", token, body }),

  stockBalances: (token: string, query: { itemCode?: string } = {}) => {
    const qs = query.itemCode ? `?itemCode=${encodeURIComponent(query.itemCode)}` : "";
    return request<StockBalanceRecord[]>(`/stock/balances${qs}`, { token });
  },
  stockMovements: (token: string, query: { itemCode?: string } = {}) => {
    const qs = query.itemCode ? `?itemCode=${encodeURIComponent(query.itemCode)}` : "";
    return request<StockMovementRecord[]>(`/stock/movements${qs}`, { token });
  },
  recordGoodsIn: (
    token: string,
    body: { itemCode: string; quantity: number; siteId?: string | null; reference?: string | null },
  ) => request<StockMovementResult>("/stock/goods-in", { method: "POST", token, body }),
  recordGoodsOut: (
    token: string,
    body: { itemCode: string; quantity: number; siteId?: string | null; reference?: string | null },
  ) => request<StockMovementResult>("/stock/goods-out", { method: "POST", token, body }),

  purchaseRequests: (token: string) => request<PurchaseRequestRecord[]>("/purchase-requests", { token }),
  purchaseRequest: (token: string, id: string) =>
    request<PurchaseRequestDetail>(`/purchase-requests/${id}`, { token }),
  createPurchaseRequest: (
    token: string,
    body: {
      justification: string;
      organizationUnitId?: string | null;
      requiredDate?: string | null;
      lines: { itemCode: string; quantity: number; note?: string | null }[];
    },
  ) => request<PurchaseRequestDetail>("/purchase-requests", { method: "POST", token, body }),
  actOnPurchaseRequest: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ request: PurchaseRequestRecord }>(`/purchase-requests/${id}/actions/${actionCode}`, {
      method: "POST",
      token,
      body: { comment: comment ?? null },
    }),

  purchaseOrders: (token: string) => request<PurchaseOrderRecord[]>("/purchase-orders", { token }),
  purchaseOrder: (token: string, id: string) => request<PurchaseOrderDetail>(`/purchase-orders/${id}`, { token }),
  createPurchaseOrder: (
    token: string,
    body: {
      supplierCode: string;
      purchaseRequestId?: string | null;
      currency?: string | null;
      expectedDate?: string | null;
      lines?: { itemCode: string; quantity: number; unitPrice?: number | null }[];
    },
  ) => request<PurchaseOrderDetail>("/purchase-orders", { method: "POST", token, body }),
  issuePurchaseOrder: (token: string, id: string) =>
    request<PurchaseOrderDetail>(`/purchase-orders/${id}/issue`, { method: "POST", token }),
  receiveAgainstOrder: (
    token: string,
    id: string,
    body: { lineId: string; quantity: number; note?: string | null },
  ) => request<StockMovementResult>(`/purchase-orders/${id}/receipts`, { method: "POST", token, body }),

  // --- Wave A5: Supply Chain Advanced (SCM-ADV-001…008) ------------------
  // 1. Warehouses & Storage Locations
  scmWarehouses: (token: string, query: { siteId?: string; organizationUnitId?: string; activeOnly?: boolean } = {}) => {
    const qs = queryString(query);
    return request<ScmWarehouse[]>(`/wms/warehouses${qs}`, { token });
  },
  scmWarehouse: (token: string, id: string) =>
    request<ScmWarehouse>(`/wms/warehouses/${id}`, { token }),
  createScmWarehouse: (token: string, body: CreateScmWarehouseBody) =>
    request<ScmWarehouse>("/wms/warehouses", { method: "POST", token, body }),
  updateScmWarehouse: (token: string, id: string, body: UpdateScmWarehouseBody) =>
    request<ScmWarehouse>(`/wms/warehouses/${id}`, { method: "PATCH", token, body }),

  scmWarehouseLocations: (token: string, query: { warehouseId?: string; activeOnly?: boolean } = {}) => {
    const qs = queryString(query);
    return request<ScmWarehouseLocation[]>(`/wms/warehouse-locations${qs}`, { token });
  },
  scmWarehouseLocation: (token: string, id: string) =>
    request<ScmWarehouseLocation>(`/wms/warehouse-locations/${id}`, { token }),
  createScmWarehouseLocation: (token: string, body: CreateScmWarehouseLocationBody) =>
    request<ScmWarehouseLocation>("/wms/warehouse-locations", { method: "POST", token, body }),
  updateScmWarehouseLocation: (token: string, id: string, body: UpdateScmWarehouseLocationBody) =>
    request<ScmWarehouseLocation>(`/wms/warehouse-locations/${id}`, { method: "PATCH", token, body }),

  // 2. Batches & Serials
  scmBatches: (token: string, query: { itemId?: string; includeExpired?: boolean } = {}) => {
    const qs = queryString(query);
    return request<ScmItemBatch[]>(`/wms/batches${qs}`, { token });
  },
  scmBatch: (token: string, id: string) =>
    request<ScmItemBatch>(`/wms/batches/${id}`, { token }),
  createScmBatch: (token: string, body: CreateScmItemBatchBody) =>
    request<ScmItemBatch>("/wms/batches", { method: "POST", token, body }),

  scmSerials: (token: string, query: { itemId?: string; warehouseId?: string; locationId?: string; batchId?: string; status?: ScmSerialStatus } = {}) => {
    const qs = queryString(query);
    return request<ScmItemSerial[]>(`/wms/serials${qs}`, { token });
  },
  scmSerial: (token: string, id: string) =>
    request<ScmItemSerial>(`/wms/serials/${id}`, { token }),
  createScmSerial: (token: string, body: CreateScmItemSerialBody) =>
    request<ScmItemSerial>("/wms/serials", { method: "POST", token, body }),
  updateScmSerial: (token: string, id: string, body: UpdateScmItemSerialBody) =>
    request<ScmItemSerial>(`/wms/serials/${id}`, { method: "PATCH", token, body }),

  // 3. Stock Balances & Immutable Ledger Movements
  scmAdvancedStockBalances: (token: string, query: { itemId?: string; warehouseId?: string; locationId?: string; batchId?: string } = {}) => {
    const qs = queryString(query);
    return request<ScmAdvancedStockBalance[]>(`/wms/balances${qs}`, { token });
  },
  recordScmAdvancedStockMovement: (token: string, body: RecordScmAdvancedStockMovementBody) =>
    request<ScmAdvancedStockMovement>("/wms/movements", { method: "POST", token, body }),
  scmAdvancedStockMovements: (token: string, query: { itemId?: string; warehouseId?: string; movementType?: ScmAdvancedStockMovementType; limit?: number } = {}) => {
    const qs = queryString(query);
    return request<ScmAdvancedStockMovement[]>(`/wms/movements${qs}`, { token });
  },

  // 4. Reorder Policies & Reservations
  scmReorderPolicies: (token: string, query: { itemId?: string; warehouseId?: string; activeOnly?: boolean } = {}) => {
    const qs = queryString(query);
    return request<ScmReorderPolicy[]>(`/wms/reorder-policies${qs}`, { token });
  },
  upsertScmReorderPolicy: (token: string, body: UpsertScmReorderPolicyBody) =>
    request<ScmReorderPolicy>("/wms/reorder-policies", { method: "PUT", token, body }),
  scmReorderAlerts: (token: string, warehouseId?: string) => {
    const qs = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : "";
    return request<ScmReorderAlert[]>(`/wms/reorder-alerts${qs}`, { token });
  },
  scmStockReservations: (token: string, query: { itemId?: string; warehouseId?: string; status?: ScmReservationStatus; reservedForType?: string } = {}) => {
    const qs = queryString(query);
    return request<ScmStockReservation[]>(`/wms/reservations${qs}`, { token });
  },
  createScmStockReservation: (token: string, body: CreateScmStockReservationBody) =>
    request<ScmStockReservation>("/wms/reservations", { method: "POST", token, body }),
  fulfillScmStockReservation: (token: string, id: string) =>
    request<ScmStockReservation>(`/wms/reservations/${id}/fulfill`, { method: "POST", token }),
  cancelScmStockReservation: (token: string, id: string) =>
    request<ScmStockReservation>(`/wms/reservations/${id}/cancel`, { method: "POST", token }),

  // 5. Stock Transfers & Opnames
  scmStockTransfers: async (token: string, query: { fromWarehouseId?: string; toWarehouseId?: string; status?: ScmTransferStatus } = {}) => {
    const qs = queryString(query);
    const res = await request<Array<{ transfer?: ScmStockTransfer } & ScmStockTransfer>>(`/wms/transfers${qs}`, { token });
    return res.map((t) => (t && typeof t === "object" && "transfer" in t ? t.transfer! : t));
  },
  scmStockTransfer: (token: string, id: string) =>
    request<ScmStockTransferDetail>(`/wms/transfers/${id}`, { token }),
  createScmStockTransfer: async (token: string, body: CreateScmStockTransferBody) => {
    const res = await request<{ transfer?: ScmStockTransfer } & ScmStockTransfer>("/wms/transfers", { method: "POST", token, body });
    return res?.transfer ?? res;
  },
  actOnScmStockTransfer: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ transfer: ScmStockTransfer; workflowResult: unknown }>(`/wms/transfers/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),
  recordScmStockTransferShipment: (token: string, body: RecordScmStockTransferShipmentBody) =>
    request<ScmStockTransferDetail>("/wms/transfers/shipments", { method: "POST", token, body }),
  recordScmStockTransferReceipt: (token: string, body: RecordScmStockTransferReceiptBody) =>
    request<ScmStockTransferDetail>("/wms/transfers/receipts", { method: "POST", token, body }),

  scmStockOpnames: async (token: string, query: { warehouseId?: string; status?: ScmOpnameStatus } = {}) => {
    const qs = queryString(query);
    const res = await request<Array<{ opname?: ScmStockOpname } & ScmStockOpname>>(`/wms/opnames${qs}`, { token });
    return res.map((o) => (o && typeof o === "object" && "opname" in o ? o.opname! : o));
  },
  scmStockOpname: (token: string, id: string) =>
    request<ScmStockOpnameDetail>(`/wms/opnames/${id}`, { token }),
  createScmStockOpname: async (token: string, body: CreateScmStockOpnameBody) => {
    const res = await request<{ opname?: ScmStockOpname } & ScmStockOpname>("/wms/opnames", { method: "POST", token, body });
    return res?.opname ?? res;
  },
  recordScmStockOpnameCount: (token: string, body: RecordScmStockOpnameCountBody) =>
    request<ScmStockOpnameLine>("/wms/opnames/counts", { method: "POST", token, body }),
  actOnScmStockOpname: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ opname: ScmStockOpname; workflowResult: unknown }>(`/wms/opnames/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),

  // 6. Valuation & Landed Cost
  scmValuationLayers: (token: string, query: { itemId?: string; warehouseId?: string } = {}) => {
    const qs = queryString(query);
    return request<ScmValuationLayer[]>(`/wms/valuation-layers${qs}`, { token });
  },
  createScmValuationLayer: (token: string, body: CreateScmValuationLayerBody) =>
    request<ScmValuationLayer>("/wms/valuation-layers", { method: "POST", token, body }),
  consumeScmValuationLayer: (token: string, body: { layerId: string; remainingQuantity: number }) =>
    request<ScmValuationLayer>("/wms/valuation-layers/consume", { method: "POST", token, body }),
  scmLandedCosts: (token: string, query: { purchaseOrderId?: string; status?: ScmLandedCostStatus } = {}) => {
    const qs = queryString(query);
    return request<ScmLandedCost[]>(`/wms/landed-costs${qs}`, { token });
  },
  scmLandedCost: (token: string, id: string) =>
    request<ScmLandedCostDetail>(`/wms/landed-costs/${id}`, { token }),
  createScmLandedCost: (token: string, body: CreateScmLandedCostBody) =>
    request<ScmLandedCost>("/wms/landed-costs", { method: "POST", token, body }),
  applyScmLandedCost: (token: string, id: string) =>
    request<ScmLandedCostDetail>(`/wms/landed-costs/${id}/apply`, { method: "POST", token }),

  // 7. RFQs, Tenders & Bid Comparisons
  scmRfqs: async (token: string, query: { procurementType?: ScmProcurementType; status?: ScmRfqStatus; organizationUnitId?: string } = {}) => {
    const qs = queryString(query);
    const res = await request<Array<{ rfq?: ScmRfq } & ScmRfq>>(`/procurement/rfqs${qs}`, { token });
    return res.map((r) => (r && typeof r === "object" && "rfq" in r ? r.rfq! : r));
  },
  scmRfq: (token: string, id: string) =>
    request<ScmRfqDetail>(`/procurement/rfqs/${id}`, { token }),
  createScmRfq: async (token: string, body: CreateScmRfqBody) => {
    const res = await request<{ rfq?: ScmRfq } & ScmRfq>("/procurement/rfqs", { method: "POST", token, body });
    return res?.rfq ?? res;
  },
  actOnScmRfq: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ rfq: ScmRfq; workflowResult: unknown }>(`/procurement/rfqs/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),
  submitScmSupplierBid: (token: string, body: SubmitScmSupplierBidBody) =>
    request<ScmSupplierBid>("/procurement/bids", { method: "POST", token, body }),
  scmSupplierBid: (token: string, id: string) =>
    request<ScmSupplierBidDetail>(`/procurement/bids/${id}`, { token }),
  scoreScmSupplierBid: (token: string, id: string, body: ScoreScmSupplierBidBody) =>
    request<ScmSupplierBid>(`/procurement/bids/${id}/score`, { method: "PATCH", token, body }),
  awardScmSupplierBid: (token: string, body: { bidId: string; resultingPurchaseOrderId?: string | null }) =>
    request<ScmSupplierBid>("/procurement/bids/award", { method: "POST", token, body }),

  // 8. Supplier Evaluations & Contracts
  scmSupplierEvaluations: async (token: string, query: { supplierId?: string; status?: ScmSupplierEvaluationStatus; ratingGrade?: ScmSupplierRatingGrade } = {}) => {
    const qs = queryString(query);
    const res = await request<Array<{ evaluation?: ScmSupplierEvaluation } & ScmSupplierEvaluation>>(`/procurement/evaluations${qs}`, { token });
    return res.map((e) => (e && typeof e === "object" && "evaluation" in e ? e.evaluation! : e));
  },
  scmSupplierEvaluation: (token: string, id: string) =>
    request<ScmSupplierEvaluationDetail>(`/procurement/evaluations/${id}`, { token }),
  createScmSupplierEvaluation: async (token: string, body: CreateScmSupplierEvaluationBody) => {
    const res = await request<{ evaluation?: ScmSupplierEvaluation } & ScmSupplierEvaluation>("/procurement/evaluations", { method: "POST", token, body });
    return res?.evaluation ?? res;
  },
  actOnScmSupplierEvaluation: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ evaluation: ScmSupplierEvaluation; workflowResult: unknown }>(`/procurement/evaluations/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),
  scmSupplierContracts: async (token: string, query: { supplierId?: string; contractType?: ScmSupplierContractType; status?: ScmSupplierContractStatus } = {}) => {
    const qs = queryString(query);
    const res = await request<Array<{ contract?: ScmSupplierContract } & ScmSupplierContract>>(`/procurement/contracts${qs}`, { token });
    return res.map((c) => (c && typeof c === "object" && "contract" in c ? c.contract! : c));
  },
  scmSupplierContract: (token: string, id: string) =>
    request<ScmSupplierContractDetail>(`/procurement/contracts/${id}`, { token }),
  createScmSupplierContract: async (token: string, body: CreateScmSupplierContractBody) => {
    const res = await request<{ contract?: ScmSupplierContract } & ScmSupplierContract>("/procurement/contracts", { method: "POST", token, body });
    return res?.contract ?? res;
  },
  recordScmSupplierContractSpend: (token: string, id: string, additionalSpentAmount: number) =>
    request<ScmSupplierContract>(`/procurement/contracts/${id}/spend`, {
      method: "POST", token, body: { additionalSpentAmount },
    }),
  actOnScmSupplierContract: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ contract: ScmSupplierContract; workflowResult: unknown }>(`/procurement/contracts/${id}/act`, {
      method: "POST", token, body: { actionCode, comment: comment ?? null },
    }),

  // 9. Receiving, Inspection & Returns
  scmReceivingRecords: (token: string, query: { purchaseOrderId?: string; supplierId?: string; warehouseId?: string; status?: ScmReceivingStatus } = {}) => {
    const qs = queryString(query);
    return request<ScmReceivingRecord[]>(`/wms/receiving-records${qs}`, { token });
  },
  scmReceivingRecord: (token: string, id: string) =>
    request<ScmReceivingRecordDetail>(`/wms/receiving-records/${id}`, { token }),
  createScmReceivingRecord: (token: string, body: CreateScmReceivingRecordBody) =>
    request<ScmReceivingRecordDetail>("/wms/receiving-records", { method: "POST", token, body }),
  createScmInspection: (token: string, body: CreateScmInspectionBody) =>
    request<ScmInspection>("/wms/inspections", { method: "POST", token, body }),
  scmInspectionByReceivingLine: (token: string, receivingLineId: string) =>
    request<ScmInspection>(`/wms/inspections/by-receiving-line/${receivingLineId}`, { token }),
  scmDiscrepancies: (token: string, query: { receivingLineId?: string; discrepancyType?: ScmDiscrepancyType; status?: ScmDiscrepancyStatus } = {}) => {
    const qs = queryString(query);
    return request<ScmDiscrepancyRecord[]>(`/wms/discrepancies${qs}`, { token });
  },
  createScmDiscrepancy: (token: string, body: CreateScmDiscrepancyBody) =>
    request<ScmDiscrepancyRecord>("/wms/discrepancies", { method: "POST", token, body }),
  resolveScmDiscrepancy: (token: string, id: string, body: { status: "resolved" | "cancelled"; resolutionNotes?: string | null }) =>
    request<ScmDiscrepancyRecord>(`/wms/discrepancies/${id}/resolve`, { method: "PATCH", token, body }),
  scmReturnsToVendor: (token: string, query: { supplierId?: string; purchaseOrderId?: string; warehouseId?: string; status?: ScmReturnToVendorStatus } = {}) => {
    const qs = queryString(query);
    return request<ScmReturnToVendor[]>(`/wms/returns-to-vendor${qs}`, { token });
  },
  scmReturnToVendor: (token: string, id: string) =>
    request<ScmReturnToVendorDetail>(`/wms/returns-to-vendor/${id}`, { token }),
  createScmReturnToVendor: (token: string, body: CreateScmReturnToVendorBody) =>
    request<ScmReturnToVendorDetail>("/wms/returns-to-vendor", { method: "POST", token, body }),

  // 10. Spend Analytics
  computeScmSpendSnapshot: (token: string, body: ComputeScmSpendSnapshotBody) =>
    request<ScmSpendAnalyticsSnapshot[]>("/procurement/spend-analytics/compute", { method: "POST", token, body }),
  scmSpendSnapshots: (token: string, query: { periodType?: ScmSpendAnalyticsPeriodType; organizationUnitId?: string } = {}) => {
    const qs = queryString(query);
    return request<ScmSpendAnalyticsSnapshot[]>(`/procurement/spend-analytics${qs}`, { token });
  },

  // --- Asset (Phase 5) --------------------------------------------------
  assets: (token: string, query: AssetQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "" && value !== false) qs.set(key, String(value));
    }
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<AssetListResult>(`/assets${suffix}`, { token });
  },
  asset: (token: string, id: string) => request<AssetDetail>(`/assets/${id}`, { token }),
  createAsset: (token: string, body: CreateAssetBody) =>
    request<AssetDetail>("/assets", { method: "POST", token, body }),
  updateAsset: (token: string, id: string, body: UpdateAssetBody) =>
    request<AssetDetail>(`/assets/${id}`, { method: "PATCH", token, body }),
  moveAsset: (token: string, id: string, body: MoveAssetBody) =>
    request<AssetDetail>(`/assets/${id}/movements`, { method: "POST", token, body }),
  changeAssetStatus: (
    token: string,
    id: string,
    body: { status: AssetStatusValue; reason?: string | null; effectiveDate?: string | null },
  ) => request<AssetDetail>(`/assets/${id}/status`, { method: "POST", token, body }),
  retireAsset: (
    token: string,
    id: string,
    body: { status?: "retired" | "disposed"; reason?: string | null; effectiveDate?: string | null },
  ) => request<AssetDetail>(`/assets/${id}/retirement`, { method: "POST", token, body }),
  actOnAssetMovement: (token: string, movementId: string, actionCode: string, comment?: string | null) =>
    request<AssetDetail>(`/asset-movements/${movementId}/actions/${actionCode}`, {
      method: "POST",
      token,
      body: { comment: comment ?? null },
    }),

  // --- Wave A3: Asset Advanced (AST-ADV-001…007) -----------------------
  assetMaintenanceSchedules: (token: string, assetId?: string) => {
    const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : "";
    return request<AssetMaintenanceSchedule[]>(`/assets/schedules${query}`, { token });
  },
  dueAssetMaintenanceSchedules: (token: string, asOfDate?: string) => {
    const query = asOfDate ? `?asOfDate=${encodeURIComponent(asOfDate)}` : "";
    return request<AssetMaintenanceSchedule[]>(`/assets/schedules/due${query}`, { token });
  },
  assetMaintenanceSchedule: (token: string, id: string) =>
    request<AssetMaintenanceSchedule>(`/assets/schedules/${id}`, { token }),
  createAssetMaintenanceSchedule: (token: string, body: CreateAssetMaintenanceScheduleBody) =>
    request<AssetMaintenanceSchedule>("/assets/schedules", { method: "POST", token, body }),

  assetMaintenanceWorkOrders: (token: string, query: AssetMaintenanceWorkOrderQuery = {}) => {
    const params = new URLSearchParams();
    if (query.assetId) params.set("assetId", query.assetId);
    if (query.maintenanceType) params.set("maintenanceType", query.maintenanceType);
    if (query.assignedToUserId) params.set("assignedToUserId", query.assignedToUserId);
    const suffix = params.toString() ? `?${params}` : "";
    return request<AssetMaintenanceWorkOrderRow[]>(`/assets/work-orders${suffix}`, { token });
  },
  assetMaintenanceWorkOrder: (token: string, id: string) =>
    request<AssetMaintenanceWorkOrderDetail>(`/assets/work-orders/${id}`, { token }),
  createAssetMaintenanceWorkOrder: (token: string, body: CreateAssetMaintenanceWorkOrderBody) =>
    request<AssetMaintenanceWorkOrder>("/assets/work-orders", { method: "POST", token, body }),
  assignAssetMaintenanceWorkOrder: (token: string, id: string, assignedToUserId: string) =>
    request<AssetMaintenanceWorkOrder>(`/assets/work-orders/${id}/assign`, {
      method: "POST",
      token,
      body: { assignedToUserId },
    }),
  startAssetMaintenanceWorkOrder: (token: string, id: string) =>
    request<AssetMaintenanceWorkOrder>(`/assets/work-orders/${id}/start`, { method: "POST", token }),
  completeAssetMaintenanceWorkOrder: (
    token: string,
    id: string,
    body: CompleteAssetMaintenanceWorkOrderBody,
  ) => request<AssetMaintenanceWorkOrder>(`/assets/work-orders/${id}/complete`, { method: "POST", token, body }),
  verifyAssetMaintenanceWorkOrder: (token: string, id: string, verificationNotes?: string | null) =>
    request<AssetMaintenanceWorkOrder>(`/assets/work-orders/${id}/verify`, {
      method: "POST",
      token,
      body: { verificationNotes: verificationNotes ?? null },
    }),
  actOnAssetMaintenanceWorkOrder: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<{ workOrder: AssetMaintenanceWorkOrder; workflowResult: unknown }>(`/assets/work-orders/${id}/act`, {
      method: "POST",
      token,
      body: { actionCode, comment: comment ?? null },
    }),
  recordAssetMaintenancePart: (token: string, id: string, body: RecordAssetMaintenancePartBody) =>
    request<AssetMaintenancePart>(`/assets/work-orders/${id}/parts`, { method: "POST", token, body }),
  assetMaintenanceParts: (token: string, id: string) =>
    request<AssetMaintenancePart[]>(`/assets/work-orders/${id}/parts`, { token }),

  assetMeterReadings: (token: string, assetId: string, readingType?: MeterReadingType) => {
    const query = readingType ? `?readingType=${encodeURIComponent(readingType)}` : "";
    return request<AssetMeterReading[]>(`/assets/${assetId}/meter-readings${query}`, { token });
  },
  recordAssetMeterReading: (token: string, assetId: string, body: RecordAssetMeterReadingBody) =>
    request<AssetMeterReading>(`/assets/${assetId}/meter-readings`, { method: "POST", token, body }),
  assetDowntime: (token: string, assetId: string) =>
    request<AssetDowntimeRecord[]>(`/assets/${assetId}/downtime`, { token }),
  recordAssetDowntime: (token: string, assetId: string, body: RecordAssetDowntimeBody) =>
    request<AssetDowntimeRecord>(`/assets/${assetId}/downtime`, { method: "POST", token, body }),
  closeAssetDowntime: (token: string, id: string, endTime?: string | null) =>
    request<AssetDowntimeRecord>(`/assets/downtime/${id}/close`, {
      method: "POST",
      token,
      body: { endTime: endTime ?? null },
    }),
  assetReliability: (token: string, assetId: string, periodStart: string, periodEnd: string) =>
    request<ReliabilityMetrics>(
      `/assets/${assetId}/reliability?periodStart=${encodeURIComponent(periodStart)}&periodEnd=${encodeURIComponent(periodEnd)}`,
      { token },
    ),
  assetPredictiveSnapshots: (token: string, assetId: string, limit = 20) =>
    request<AssetPredictiveSnapshot[]>(`/assets/${assetId}/predictive-snapshots?limit=${limit}`, { token }),
  latestAssetPredictiveSnapshot: (token: string, assetId: string) =>
    request<AssetPredictiveSnapshot | null>(`/assets/${assetId}/predictive-snapshots/latest`, { token }),
  generateAssetPredictiveSnapshot: (token: string, assetId: string) =>
    request<AssetPredictiveSnapshot>(`/assets/${assetId}/predictive-snapshots`, { method: "POST", token }),

  // Location pickers reuse the existing Customer & Commercial hierarchy —
  // Asset never owns its own site or project master.
  sitesForCustomer: (token: string, customerId: string) =>
    request<SiteRecord[]>(`/sites?customerId=${customerId}`, { token }),
  projectsForCustomer: (token: string, customerId: string) =>
    request<ProjectRecord[]>(`/projects?customerId=${customerId}`, { token }),

  // --- Finance (Phase 6) ------------------------------------------------
  // Every amount below is a STRING, deliberately: money must never pass
  // through a JavaScript number on its way to or from the API.
  financeAccounts: (token: string, query: { activeOnly?: boolean } = {}) =>
    request<FinanceAccount[]>(`/finance/accounts${query.activeOnly ? "?activeOnly=true" : ""}`, { token }),
  financeAccount: (token: string, code: string) =>
    request<FinanceAccount>(`/finance/accounts/${encodeURIComponent(code)}`, { token }),
  createFinanceAccount: (token: string, body: CreateFinanceAccountBody) =>
    request<FinanceAccount>("/finance/accounts", { method: "POST", token, body }),
  updateFinanceAccount: (
    token: string,
    code: string,
    body: { name?: string; description?: string | null; isActive?: boolean },
  ) => request<FinanceAccount>(`/finance/accounts/${encodeURIComponent(code)}`, { method: "PATCH", token, body }),

  financeCategories: (token: string) =>
    request<{ code: string; label: string }[]>("/finance/categories", { token }),

  financeTransactions: (token: string, query: FinanceTransactionQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    return request<FinanceTransactionRecord[]>(`/finance/transactions${qs.toString() ? `?${qs}` : ""}`, { token });
  },
  financeTransaction: (token: string, id: string) =>
    request<FinanceTransactionDetail>(`/finance/transactions/${id}`, { token }),
  recordFinanceTransaction: (token: string, body: RecordFinanceTransactionBody) =>
    request<FinanceTransactionDetail>("/finance/transactions", { method: "POST", token, body }),
  actOnFinanceTransaction: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<FinanceTransactionDetail>(`/finance/transactions/${id}/actions/${actionCode}`, {
      method: "POST",
      token,
      body: { comment: comment ?? null },
    }),
  reverseFinanceTransaction: (
    token: string,
    id: string,
    body: { reason?: string | null; transactionDate?: string | null } = {},
  ) => request<FinanceTransactionDetail>(`/finance/transactions/${id}/reversal`, { method: "POST", token, body }),

  financeCashflow: (token: string, query: { from: string; to: string; accountCode?: string }) => {
    const qs = new URLSearchParams({ from: query.from, to: query.to });
    if (query.accountCode) qs.set("accountCode", query.accountCode);
    return request<CashflowResult>(`/finance/cashflow?${qs}`, { token });
  },

  // --- Accounting Kernel reads (Wave A6) --------------------------------
  // Read-only views only. Every mutation stays behind the dedicated
  // accounting screens; this surface exists so the Accounting and Financial
  // Statements pages can show what the kernel already holds.
  accountingPeriods: (token: string, query: { legalEntityId?: string; status?: string } = {}) =>
    request<AccountingPeriodRecord[]>(`/accounting/periods${queryString(query)}`, { token }),
  accountingLedgers: (token: string, legalEntityId: string) =>
    request<AccountingLedgerRecord[]>(`/accounting/ledgers${queryString({ legalEntityId })}`, { token }),
  accountingCharts: (token: string, query: { legalEntityId?: string } = {}) =>
    request<AccountingChartRecord[]>(`/accounting/charts${queryString(query)}`, { token }),
  accountingAccounts: (token: string, query: { legalEntityId?: string; activeOnly?: boolean } = {}) =>
    request<AccountingAccountRecord[]>(`/accounting/accounts${queryString(query)}`, { token }),
  accountingFiscalClosings: (token: string, query: { legalEntityId?: string; periodId?: string } = {}) =>
    request<AccountingFiscalClosingRecord[]>(`/accounting/fiscal-closings${queryString(query)}`, { token }),
  accountingAging: (token: string, query: { side: "AR" | "AP"; asOfDate: string; currency: string }) =>
    request<AccountingAgingResult>(`/accounting/aging${queryString(query)}`, { token }),
  accountingGlEntries: (token: string, query: { accountId?: string; periodId?: string } = {}) =>
    request<AccountingGlEntryRecord[]>(`/accounting/gl-entries${queryString(query)}`, { token }),
  accountingJournals: (token: string, query: { periodId?: string; status?: string } = {}) =>
    request<AccountingJournalRecord[]>(`/accounting/journals${queryString(query)}`, { token }),
  accountingConsolidationGroups: (token: string) =>
    request<AccountingConsolidationGroupRecord[]>("/accounting/consolidation-groups", { token }),
  accountingTranslationRuns: (token: string, query: { groupId?: string; periodId?: string } = {}) =>
    request<AccountingTranslationRunRecord[]>(`/accounting/translation-runs${queryString(query)}`, { token }),
  accountingEliminations: (token: string, query: { groupId?: string; periodId?: string } = {}) =>
    request<AccountingEliminationRecord[]>(`/accounting/eliminations${queryString(query)}`, { token }),
  accountingFsvVersions: (token: string, query: { fsvCode?: string } = {}) =>
    request<AccountingFsvVersionRecord[]>(`/accounting/fsv-versions${queryString(query)}`, { token }),

  // --- Accounting Kernel mutations (Wave A6.2) --------------------------
  // Every call below has an existing route and an existing permission check;
  // the client adds no rule of its own. Money is sent as text, verbatim.
  accountingCreateJournal: (token: string, body: AccountingJournalInput) =>
    request<AccountingJournalRecord>("/accounting/journals", { method: "POST", token, body }),
  accountingValidateJournal: (token: string, id: string) =>
    request<{ balanced: boolean; debitTotal: string; creditTotal: string }>(
      `/accounting/journals/${id}/validate`,
      { method: "POST", token },
    ),
  accountingPostJournal: (token: string, id: string) =>
    request<AccountingJournalRecord>(`/accounting/journals/${id}/post`, { method: "POST", token }),
  accountingReverseJournal: (token: string, id: string, body: { type: "reverse_correct" | "reverse_accrual"; reason: string }) =>
    request<AccountingJournalRecord>(`/accounting/journals/${id}/reverse`, { method: "POST", token, body }),
  accountingLockPeriod: (token: string, id: string, body: { reason: string }) =>
    request<void>(`/accounting/periods/${id}/lock`, { method: "POST", token, body }),
  accountingRequestReopen: (token: string, id: string, body: { reason: string; impactEvidence: string }) =>
    request<void>(`/accounting/periods/${id}/reopen`, { method: "POST", token, body }),
  accountingCloseMonthEnd: (token: string, id: string, body: AccountingCloseAttestation) =>
    request<AccountingFiscalClosingRecord>(`/accounting/periods/${id}/close-month-end`, { method: "POST", token, body }),
  accountingCloseYearEnd: (token: string, id: string, body: AccountingCloseAttestation) =>
    request<AccountingFiscalClosingRecord>(`/accounting/periods/${id}/close-year-end`, { method: "POST", token, body }),
  accountingCreateLedger: (token: string, body: { legalEntityId: string; ledgerCode: string; ledgerName: string; currency: string }) =>
    request<AccountingLedgerRecord>("/accounting/ledgers", { method: "POST", token, body }),
  accountingApproveChart: (token: string, id: string) =>
    request<AccountingChartRecord>(`/accounting/charts/${id}/approve`, { method: "POST", token }),

  // --- Open items (WP-FIN-A6-02) ---------------------------------------
  accountingOpenItems: (token: string, query: { side?: "AR" | "AP"; legalEntityId?: string } = {}) =>
    request<AccountingOpenItemRecord[]>(`/accounting/open-items${queryString(query)}`, { token }),
  accountingCreateOpenItem: (token: string, body: AccountingOpenItemInput) =>
    request<AccountingOpenItemRecord>("/accounting/open-items", { method: "POST", token, body }),
  accountingAllocate: (token: string, body: AccountingAllocationInput) =>
    request<AccountingOpenItemAllocationRecord>("/accounting/open-items/allocate", { method: "POST", token, body }),

  // --- Budget control (WP-FIN-A6-03) -----------------------------------
  accountingBudgets: (token: string, query: { legalEntityId?: string; fiscalYearCode?: string } = {}) =>
    request<AccountingBudgetRecord[]>(`/accounting/budgets${queryString(query)}`, { token }),
  accountingCreateBudget: (token: string, body: AccountingBudgetInput) =>
    request<AccountingBudgetRecord>("/accounting/budgets", { method: "POST", token, body }),
  accountingBudgetVersions: (token: string, budgetId: string) =>
    request<AccountingBudgetVersionRecord[]>(`/accounting/budgets/${budgetId}/versions`, { token }),
  accountingCreateBudgetVersion: (
    token: string,
    budgetId: string,
    body: { totalAmount: string; weights: { periodCode: string; weight: string }[]; note: string | null },
  ) => request<AccountingBudgetVersionRecord>(`/accounting/budgets/${budgetId}/versions`, { method: "POST", token, body }),
  accountingBudgetAction: (token: string, versionId: string, body: { actionCode: string; comment: string | null }) =>
    request<AccountingBudgetVersionRecord>(`/accounting/budget-versions/${versionId}/actions`, { method: "POST", token, body }),
  accountingBudgetUtilization: (token: string, budgetId: string) =>
    request<AccountingBudgetUtilization>(`/accounting/budgets/${budgetId}/utilization`, { token }),
  accountingConsumeBudget: (token: string, body: AccountingBudgetConsumptionInput) =>
    request<AccountingBudgetConsumptionRecord>("/accounting/budget-consumptions", { method: "POST", token, body }),

  // --- Bank reconciliation (WP-FIN-A6-04) ------------------------------
  accountingBankAccounts: (token: string, query: { legalEntityId?: string } = {}) =>
    request<AccountingBankAccountRecord[]>(`/accounting/bank-accounts${queryString(query)}`, { token }),
  accountingCreateBankAccount: (token: string, body: AccountingBankAccountInput) =>
    request<AccountingBankAccountRecord>("/accounting/bank-accounts", { method: "POST", token, body }),
  accountingImportStatement: (
    token: string,
    body: { bankAccountId: string; formatProfile: string; sourceFileName: string; content: string },
  ) => request<AccountingBankStatementImportRecord>("/accounting/bank-statements/import", { method: "POST", token, body }),
  accountingStatementLines: (token: string, query: { bankAccountId?: string; includeDuplicates?: boolean } = {}) =>
    request<AccountingBankStatementLineRecord[]>(`/accounting/bank-statement-lines${queryString(query)}`, { token }),
  accountingBankReconciliations: (token: string, query: { bankAccountId?: string } = {}) =>
    request<AccountingBankReconciliationRecord[]>(`/accounting/bank-reconciliations${queryString(query)}`, { token }),
  accountingOpenReconciliation: (token: string, body: { bankAccountId: string; periodId: string }) =>
    request<AccountingBankReconciliationRecord>("/accounting/bank-reconciliations", { method: "POST", token, body }),
  accountingBankMatches: (token: string, reconciliationId: string) =>
    request<AccountingBankMatchRecord[]>(`/accounting/bank-reconciliations/${reconciliationId}/matches`, { token }),
  accountingCreateBankMatch: (token: string, body: AccountingBankMatchInput) =>
    request<AccountingBankMatchRecord>("/accounting/bank-matches", { method: "POST", token, body }),
  accountingCloseReconciliation: (token: string, id: string, body: { statementBalance: string | null }) =>
    request<AccountingBankReconciliationRecord>(`/accounting/bank-reconciliations/${id}/close`, { method: "POST", token, body }),
  accountingBankPeriodMovement: (token: string, query: { bankAccountId: string; periodId: string }) =>
    request<AccountingBankPeriodMovement>(`/accounting/bank-period-movement${queryString(query)}`, { token }),
  accountingStatementLineCandidates: (
    token: string,
    lineId: string,
    query: { dateToleranceDays?: number } = {},
  ) =>
    request<AccountingMatchCandidate[]>(
      `/accounting/bank-statement-lines/${lineId}/candidates${queryString(query)}`,
      { token },
    ),
  accountingReverseBankMatch: (token: string, id: string, body: { idempotencyKey: string; note: string | null }) =>
    request<AccountingBankMatchRecord>(`/accounting/bank-matches/${id}/reverse`, { method: "POST", token, body }),

  // --- Fixed assets + depreciation (WP-FIN-A6-05) ----------------------
  accountingAssetBooks: (token: string, query: { legalEntityId?: string; bookCode?: string } = {}) =>
    request<AccountingAssetBookRecord[]>(`/accounting/asset-books${queryString(query)}`, { token }),
  accountingCreateAssetBook: (token: string, body: AccountingAssetBookInput) =>
    request<AccountingAssetBookRecord>("/accounting/asset-books", { method: "POST", token, body }),
  accountingActivateAssetBook: (token: string, id: string) =>
    request<AccountingAssetBookRecord>(`/accounting/asset-books/${id}/activate`, { method: "POST", token }),
  accountingDepreciationRuns: (token: string, query: { legalEntityId?: string; periodId?: string } = {}) =>
    request<AccountingDepreciationRunRecord[]>(`/accounting/depreciation-runs${queryString(query)}`, { token }),
  accountingRunDepreciation: (
    token: string,
    body: { legalEntityId: string; bookCode: string; periodId: string; idempotencyKey: string; description: string | null },
  ) => request<AccountingDepreciationRunRecord>("/accounting/depreciation-runs", { method: "POST", token, body }),
  accountingReverseDepreciationRun: (token: string, id: string, body: { idempotencyKey: string; reason: string }) =>
    request<AccountingDepreciationRunRecord>(`/accounting/depreciation-runs/${id}/reverse`, { method: "POST", token, body }),
  accountingDisposeAssetBook: (
    token: string,
    id: string,
    body: { disposalDate: string; evidenceDocumentId: string; proceeds: string | null; note: string | null; idempotencyKey: string },
  ) => request<AccountingAssetBookRecord>(`/accounting/asset-books/${id}/dispose`, { method: "POST", token, body }),

  // --- Tax baseline (WP-FIN-A6-06a) ------------------------------------
  accountingTaxRegistrations: (token: string, legalEntityId: string) =>
    request<AccountingTaxRegistrationRecord[]>(`/accounting/tax-registrations${queryString({ legalEntityId })}`, { token }),
  accountingRegisterTaxpayer: (
    token: string,
    body: { legalEntityId: string; taxpayerStatus: "pkp" | "non_pkp"; effectiveFrom: string; registrationNumber: string | null },
  ) => request<AccountingTaxRegistrationRecord>("/accounting/tax-registrations", { method: "POST", token, body }),
  accountingTaxRules: (token: string, query: { legalEntityId?: string } = {}) =>
    request<AccountingTaxRuleRecord[]>(`/accounting/tax-rules${queryString(query)}`, { token }),
  accountingCreateTaxRule: (
    token: string,
    body: { legalEntityId: string; ruleCode: string; taxType: "ppn" | "pph22" | "pph23" | "pph26"; description: string | null },
  ) => request<AccountingTaxRuleRecord>("/accounting/tax-rules", { method: "POST", token, body }),
  accountingTaxRuleVersions: (token: string, ruleId: string) =>
    request<AccountingTaxRuleVersionRecord[]>(`/accounting/tax-rules/${ruleId}/versions`, { token }),
  accountingTaxRuleVersionAction: (
    token: string,
    versionId: string,
    body: { actionCode: string; comment: string | null },
  ) =>
    request<AccountingTaxRuleVersionRecord>(`/accounting/tax-rule-versions/${versionId}/actions`, {
      method: "POST",
      token,
      body,
    }),
  accountingCreateTaxRuleVersion: (
    token: string,
    ruleId: string,
    body: {
      rate: string;
      basis: "gross" | "net" | "dpp";
      roundingMode?: "half_up" | "half_even" | "truncate";
      requiresPkp?: boolean;
      accountId: string;
      effectiveFrom: string;
      effectiveTo: string | null;
    },
  ) => request<AccountingTaxRuleVersionRecord>(`/accounting/tax-rules/${ruleId}/versions`, { method: "POST", token, body }),
  accountingTaxCalculations: (token: string, query: { legalEntityId?: string } = {}) =>
    request<AccountingTaxCalculationRecord[]>(`/accounting/tax-calculations${queryString(query)}`, { token }),
  accountingCalculateTax: (
    token: string,
    body: {
      legalEntityId: string;
      ruleCode: string;
      basisAmount: string;
      calculationDate: string;
      currency?: string;
      idempotencyKey: string;
    },
  ) => request<AccountingTaxCalculationRecord>("/accounting/tax-calculations", { method: "POST", token, body }),

  // --- Reporting & Operational Insight (Phase 9) ------------------------
  reportingReports: (token: string) => request<ReportDefinition[]>("/reporting/reports", { token }),
  reportingReport: (token: string, code: string) =>
    request<StandardReportResult>(`/reporting/reports/${encodeURIComponent(code)}`, { token }),
  reportingDashboard: (token: string) => request<ExecutiveDashboard>("/reporting/dashboard", { token }),
  exportReportingReport: async (token: string, code: string): Promise<{ filename: string; content: string }> => {
    const response = await fetch(`${API_BASE}/reporting/reports/${encodeURIComponent(code)}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const content = await response.text();
    if (!response.ok) throw new ApiError(response.status, content || `Export failed (${response.status})`);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `${code}.csv`;
    return { filename, content };
  },

  // --- Wave A2: Governed BI & Predictive Analytics ---------------------
  biDatasets: (token: string) => request<BiDataset[]>("/reporting/bi/datasets", { token }),
  biDataset: (token: string, code: string) =>
    request<BiDatasetDetail>(`/reporting/bi/datasets/${encodeURIComponent(code)}`, { token }),
  biQuery: (token: string, config: BiQueryConfig) =>
    request<BiQueryResult>("/reporting/bi/query", { method: "POST", token, body: config }),
  exportBiQuery: async (
    token: string,
    config: BiQueryConfig,
  ): Promise<{ filename: string; content: string }> => {
    const response = await fetch(`${API_BASE}/reporting/bi/export`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    });
    const content = await response.text();
    if (!response.ok) throw new ApiError(response.status, content || `Export failed (${response.status})`);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `${config.datasetCode}.csv`;
    return { filename, content };
  },
  biSavedReports: (token: string, datasetCode?: string) => {
    const query = datasetCode ? `?datasetCode=${encodeURIComponent(datasetCode)}` : "";
    return request<BiSavedReport[]>(`/reporting/bi/saved-reports${query}`, { token });
  },
  biSavedReport: (token: string, id: string) =>
    request<BiSavedReport>(`/reporting/bi/saved-reports/${id}`, { token }),
  createBiSavedReport: (token: string, body: CreateBiSavedReportBody) =>
    request<BiSavedReport>("/reporting/bi/saved-reports", { method: "POST", token, body }),
  deleteBiSavedReport: (token: string, id: string) =>
    request<void>(`/reporting/bi/saved-reports/${id}`, { method: "DELETE", token }),
  generatePredictiveForecast: (token: string, body: GenerateForecastBody) =>
    request<GenerateForecastResponse>("/reporting/predictive/forecast", {
      method: "POST",
      token,
      body,
    }),
  predictiveSnapshots: (token: string, modelCode?: ForecastModelCode) => {
    const query = modelCode ? `?modelCode=${encodeURIComponent(modelCode)}` : "";
    return request<PredictiveForecastSnapshot[]>(`/reporting/predictive/snapshots${query}`, { token });
  },
  latestPredictiveSnapshot: (token: string, modelCode: ForecastModelCode) =>
    request<PredictiveForecastSnapshot | null>(
      `/reporting/predictive/snapshots/latest/${encodeURIComponent(modelCode)}`,
      { token },
    ),

  // --- Project Delivery (Phase 8) --------------------------------------
  projectDeliveryProjects: (token: string) =>
    request<ProjectDeliveryProjectSummary[]>("/project-delivery/projects", { token }),
  projectDeliveryDetail: (token: string, projectId: string) =>
    request<ProjectDeliveryDetail>(`/project-delivery/projects/${projectId}`, { token }),
  createProjectDeliveryActivity: (token: string, projectId: string, body: CreateProjectDeliveryActivityBody) =>
    request<ProjectDeliveryActivity>(`/project-delivery/projects/${projectId}/activities`, { method: "POST", token, body }),
  updateProjectDeliveryActivity: (token: string, id: string, body: UpdateProjectDeliveryActivityBody) =>
    request<ProjectDeliveryActivity>(`/project-delivery/activities/${id}`, { method: "PATCH", token, body }),
  createProjectDeliveryMilestone: (token: string, projectId: string, body: CreateProjectDeliveryMilestoneBody) =>
    request<ProjectDeliveryMilestone>(`/project-delivery/projects/${projectId}/milestones`, { method: "POST", token, body }),
  updateProjectDeliveryMilestone: (token: string, id: string, body: UpdateProjectDeliveryMilestoneBody) =>
    request<ProjectDeliveryMilestone>(`/project-delivery/milestones/${id}`, { method: "PATCH", token, body }),

  // --- Project Delivery Advanced (Wave A7) ------------------------------
  projectDeliveryWbs: (token: string, projectId: string) =>
    request<ProjectWbsNodeView[]>(`/project-delivery/advanced/${projectId}/wbs`, { token }),
  createProjectDeliveryWbs: (
    token: string,
    projectId: string,
    body: { parentId?: string | null; code: string; name: string; description?: string | null; sortOrder?: number },
  ) => request<ProjectWbsNode>(`/project-delivery/advanced/${projectId}/wbs`, { method: "POST", token, body }),
  updateProjectDeliveryWbs: (
    token: string,
    wbsNodeId: string,
    body: Partial<{ code: string; name: string; description: string | null; sortOrder: number }>,
  ) => request<ProjectWbsNode>(`/project-delivery/advanced/wbs/${wbsNodeId}`, { method: "PATCH", token, body }),
  projectDeliverySchedule: (token: string, projectId: string) =>
    request<ProjectSchedule>(`/project-delivery/advanced/${projectId}/schedule`, { token }),
  projectDeliveryGantt: (token: string, projectId: string) =>
    request<GanttRow[]>(`/project-delivery/advanced/${projectId}/gantt`, { token }),
  projectDeliveryDependencies: (token: string, projectId: string) =>
    request<ProjectActivityDependency[]>(`/project-delivery/advanced/${projectId}/dependencies`, { token }),
  createProjectDeliveryDependency: (
    token: string,
    body: { projectId: string; fromActivityId: string; toActivityId: string; type: string; lagDays?: number },
  ) => request<ProjectActivityDependency>("/project-delivery/advanced/dependencies", { method: "POST", token, body }),
  deleteProjectDeliveryDependency: (token: string, dependencyId: string) =>
    request<void>(`/project-delivery/advanced/dependencies/${dependencyId}`, { method: "DELETE", token }),
  projectDeliveryResources: (token: string, activeOnly?: boolean) => {
    const qs = activeOnly ? "?activeOnly=true" : "";
    return request<ProjectResource[]>(`/project-delivery/advanced/resources${qs}`, { token });
  },
  createProjectDeliveryResource: (
    token: string,
    body: { code: string; name: string; type: string; baseAvailability: string; unitOfMeasure: string },
  ) => request<ProjectResource>("/project-delivery/advanced/resources", { method: "POST", token, body }),
  createProjectDeliveryResourceAssignment: (
    token: string,
    projectId: string,
    body: { resourceId: string; activityId: string; allocatedQuantity: string; startDate: string; endDate: string },
  ) =>
    request<ProjectResourceAssignment>(`/project-delivery/advanced/${projectId}/resource-assignments`, {
      method: "POST",
      token,
      body,
    }),
  projectDeliveryResourceLoading: (token: string, projectId: string, from: string, to: string) =>
    request<ResourceLoadingResult>(
      `/project-delivery/advanced/${projectId}/resource-loading?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { token },
    ),
  projectDeliveryBaselines: (token: string, projectId: string) =>
    request<ProjectBaseline[]>(`/project-delivery/advanced/${projectId}/baselines`, { token }),
  createProjectDeliveryBaseline: (token: string, projectId: string, body: { code: string; description?: string | null }) =>
    request<ProjectBaseline>(`/project-delivery/advanced/${projectId}/baselines`, { method: "POST", token, body }),
  approveProjectDeliveryBaseline: (token: string, baselineId: string) =>
    request<ProjectBaseline>(`/project-delivery/advanced/baselines/${baselineId}/approve`, { method: "POST", token }),
  projectDeliveryBaselineVariance: (token: string, projectId: string, asOfDate: string) =>
    request<BaselineVarianceResult>(
      `/project-delivery/advanced/${projectId}/baseline-variance?asOfDate=${encodeURIComponent(asOfDate)}`,
      { token },
    ),
  projectDeliveryCostEntries: (token: string, projectId: string, asOfDate?: string) => {
    const qs = asOfDate ? `?asOfDate=${encodeURIComponent(asOfDate)}` : "";
    return request<ProjectCostEntry[]>(`/project-delivery/advanced/${projectId}/cost-entries${qs}`, { token });
  },
  createProjectDeliveryCostEntry: (
    token: string,
    projectId: string,
    body: { activityId: string; entryType: string; amount: string; idempotencyKey: string; entryDate: string; note?: string | null },
  ) => request<ProjectCostEntry>(`/project-delivery/advanced/${projectId}/cost-entries`, { method: "POST", token, body }),
  reverseProjectDeliveryCostEntry: (token: string, entryId: string, body?: { note?: string | null }) =>
    request<ProjectCostEntry>(`/project-delivery/advanced/cost-entries/${entryId}/reverse`, {
      method: "POST",
      token,
      body: body ?? {},
    }),
  postProjectDeliveryCostEntry: (token: string, entryId: string) =>
    request<ProjectCostEntry>(`/project-delivery/advanced/cost-entries/${entryId}/post`, { method: "POST", token }),
  projectDeliveryCostPosition: (token: string, projectId: string, asOfDate: string) =>
    request<ProjectCostPosition>(
      `/project-delivery/advanced/${projectId}/cost-position?asOfDate=${encodeURIComponent(asOfDate)}`,
      { token },
    ),
  projectDeliveryEarnedValue: (token: string, projectId: string, asOfDate: string) =>
    request<EarnedValueResult>(
      `/project-delivery/advanced/${projectId}/earned-value?asOfDate=${encodeURIComponent(asOfDate)}`,
      { token },
    ),
  projectDeliveryEarnedValueSnapshots: (token: string, projectId: string) =>
    request<ProjectEarnedValueSnapshot[]>(`/project-delivery/advanced/${projectId}/earned-value-snapshots`, { token }),
  createProjectDeliveryEarnedValueSnapshot: (token: string, projectId: string, body: { snapshotDate: string }) =>
    request<ProjectEarnedValueSnapshot>(`/project-delivery/advanced/${projectId}/earned-value-snapshots`, {
      method: "POST",
      token,
      body,
    }),

  // --- HSE (Phase 7) ---------------------------------------------------
  hseRecords: (token: string, query: HseRecordQuery = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    return request<HseRecord[]>(`/hse/records${qs.toString() ? `?${qs}` : ""}`, { token });
  },
  hseRecord: (token: string, id: string) =>
    request<HseRecordDetail>(`/hse/records/${id}`, { token }),
  reportHseRecord: (token: string, body: ReportHseRecordBody) =>
    request<HseRecord>("/hse/records", { method: "POST", token, body }),
  updateHseRecord: (token: string, id: string, body: UpdateHseRecordBody) =>
    request<HseRecord>(`/hse/records/${id}`, { method: "PATCH", token, body }),
  startHseRecordLifecycle: (token: string, id: string) =>
    request<HseRecord>(`/hse/records/${id}/lifecycle`, { method: "POST", token }),
  actOnHseRecord: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<HseRecord>(`/hse/records/${id}/actions/${actionCode}`, {
      method: "POST",
      token,
      body: { comment: comment ?? null },
    }),
  addHsePersonInvolved: (token: string, recordId: string, body: AddHsePersonBody) =>
    request<HsePersonInvolved>(`/hse/records/${recordId}/persons`, { method: "POST", token, body }),
  createHseFollowUp: (token: string, recordId: string, body: CreateHseFollowUpBody) =>
    request<HseFollowUp>(`/hse/records/${recordId}/follow-ups`, { method: "POST", token, body }),
  completeHseFollowUp: (token: string, recordId: string, followUpId: string, body: CompleteHseFollowUpBody) =>
    request<HseFollowUp>(`/hse/records/${recordId}/follow-ups/${followUpId}/complete`, { method: "POST", token, body }),

  // --- HSE Advanced (Wave A7) ------------------------------------------
  hseAdvFrameworks: (token: string) =>
    request<HseInvestigationFramework[]>("/hse/advanced/frameworks", { token }),
  createHseAdvFramework: (token: string, body: CreateHseFrameworkBody) =>
    request<HseInvestigationFramework>("/hse/advanced/frameworks", { method: "POST", token, body }),

  hseAdvInvestigations: (token: string) =>
    request<HseInvestigation[]>("/hse/advanced/investigations", { token }),
  createHseAdvInvestigation: (token: string, recordId: string, body: CreateHseInvestigationBody) =>
    request<HseInvestigation>(`/hse/advanced/records/${recordId}/investigations`, {
      method: "POST",
      token,
      body,
    }),
  hseAdvInvestigation: (token: string, id: string) =>
    request<HseInvestigation>(`/hse/advanced/investigations/${id}`, { token }),
  updateHseAdvInvestigation: (token: string, id: string, body: UpdateHseInvestigationBody) =>
    request<HseInvestigation>(`/hse/advanced/investigations/${id}`, { method: "PATCH", token, body }),

  hseAdvRiskMatrix: (token: string) =>
    request<HseRiskMatrix | null>("/hse/advanced/risk-matrix", { token }),
  createHseAdvRiskMatrix: (token: string, body: CreateHseRiskMatrixBody) =>
    request<HseRiskMatrix>("/hse/advanced/risk-matrices", { method: "POST", token, body }),
  hseAdvRiskAssessments: (token: string, query: { hseRecordId?: string; projectId?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    return request<HseRiskAssessment[]>(
      `/hse/advanced/risk-assessments${qs.toString() ? `?${qs}` : ""}`,
      { token },
    );
  },
  createHseAdvRiskAssessment: (token: string, body: CreateHseRiskAssessmentBody) =>
    request<HseRiskAssessment>("/hse/advanced/risk-assessments", { method: "POST", token, body }),
  hseAdvRiskAssessment: (token: string, id: string) =>
    request<HseRiskAssessment>(`/hse/advanced/risk-assessments/${id}`, { token }),

  hseAdvPermits: (token: string) => request<HsePermit[]>("/hse/advanced/permits", { token }),
  createHseAdvPermit: (token: string, body: CreateHsePermitBody) =>
    request<HsePermit>("/hse/advanced/permits", { method: "POST", token, body }),
  hseAdvPermit: (token: string, id: string) =>
    request<HsePermitDetail>(`/hse/advanced/permits/${id}`, { token }),
  updateHseAdvPermit: (token: string, id: string, body: Partial<CreateHsePermitBody>) =>
    request<HsePermit>(`/hse/advanced/permits/${id}`, { method: "PATCH", token, body }),
  actOnHseAdvPermit: (token: string, id: string, actionCode: string, comment?: string | null) =>
    request<HsePermitDetail>(`/hse/advanced/permits/${id}/act`, {
      method: "POST",
      token,
      body: { actionCode, comment: comment ?? null },
    }),
  startHseAdvPermitLifecycle: (token: string, id: string) =>
    request<HsePermit>(`/hse/advanced/permits/${id}/start-lifecycle`, { method: "POST", token }),

  hseAdvProgrammes: (token: string) =>
    request<HseAuditProgramme[]>("/hse/advanced/programmes", { token }),
  createHseAdvProgramme: (token: string, body: CreateHseProgrammeBody) =>
    request<HseAuditProgramme>("/hse/advanced/programmes", { method: "POST", token, body }),
  hseAdvOccurrences: (token: string, programmeId: string) =>
    request<HseAuditOccurrence[]>(`/hse/advanced/programmes/${programmeId}/occurrences`, { token }),
  scheduleHseAdvOccurrence: (token: string, programmeId: string, scheduledFor: string) =>
    request<HseAuditOccurrence>(`/hse/advanced/programmes/${programmeId}/occurrences`, {
      method: "POST",
      token,
      body: { scheduledFor },
    }),
  completeHseAdvOccurrence: (
    token: string,
    occurrenceId: string,
    body: { results: AuditResult[]; notes?: string | null },
  ) =>
    request<HseAuditOccurrence>(`/hse/advanced/occurrences/${occurrenceId}/complete`, {
      method: "POST",
      token,
      body,
    }),
  hseAdvFindings: (token: string, occurrenceId: string) =>
    request<HseAuditFinding[]>(`/hse/advanced/occurrences/${occurrenceId}/findings`, { token }),
  createHseAdvFinding: (
    token: string,
    occurrenceId: string,
    body: { findingType?: AuditFindingType; checklistItemCode?: string | null; description: string },
  ) =>
    request<HseAuditFinding>(`/hse/advanced/occurrences/${occurrenceId}/findings`, {
      method: "POST",
      token,
      body,
    }),

  hseAdvMonitoringPoints: (token: string) =>
    request<HseMonitoringPoint[]>("/hse/advanced/monitoring-points", { token }),
  createHseAdvMonitoringPoint: (token: string, body: CreateHseMonitoringPointBody) =>
    request<HseMonitoringPoint>("/hse/advanced/monitoring-points", { method: "POST", token, body }),
  hseAdvReadings: (token: string, pointId: string, limit = 50) =>
    request<HseMonitoringReading[]>(
      `/hse/advanced/monitoring-points/${pointId}/readings?limit=${limit}`,
      { token },
    ),
  recordHseAdvReading: (
    token: string,
    pointId: string,
    body: { measuredAt: string; value: string; note?: string | null },
  ) =>
    request<HseMonitoringReading>(`/hse/advanced/monitoring-points/${pointId}/readings`, {
      method: "POST",
      token,
      body,
    }),

  hseAdvCapas: (token: string) => request<HseCapa[]>("/hse/advanced/capas", { token }),
  createHseAdvCapa: (token: string, body: CreateHseCapaBody) =>
    request<HseCapa>("/hse/advanced/capas", { method: "POST", token, body }),
  hseAdvCapa: (token: string, id: string) => request<HseCapaDetail>(`/hse/advanced/capas/${id}`, { token }),
  changeHseAdvCapaStatus: (
    token: string,
    id: string,
    body: { status: CapaStatus; verificationNotes?: string | null },
  ) =>
    request<HseCapa>(`/hse/advanced/capas/${id}/status`, { method: "PATCH", token, body }),
  addHseAdvCapaAction: (
    token: string,
    id: string,
    body: { description: string; ownerUserId?: string | null; dueDate?: string | null },
  ) =>
    request<HseCapaAction>(`/hse/advanced/capas/${id}/actions`, { method: "POST", token, body }),
  completeHseAdvCapaAction: (
    token: string,
    id: string,
    actionId: string,
    body: { completionNotes?: string | null },
  ) =>
    request<HseCapaAction>(`/hse/advanced/capas/${id}/actions/${actionId}/complete`, {
      method: "POST",
      token,
      body,
    }),

  hseAdvIndicators: (token: string) =>
    request<HseIndicatorSnapshot[]>("/hse/advanced/indicators", { token }),
  computeHseAdvIndicator: (token: string, body: ComputeHseIndicatorBody) =>
    request<HseIndicatorSnapshot>("/hse/advanced/indicators", { method: "POST", token, body }),

  // --- Business Admin Console (Phase 11C/11F) ---------------------------
  adminOverview: (token: string) => request<AdminOverview>("/admin/overview", { token }),
  adminUsers: (token: string) => request<AdminUserAccessSummary[]>("/admin/users", { token }),
  adminUserAccess: (token: string, userId: string) =>
    request<AdminUserAccessSummary>(`/admin/users/${encodeURIComponent(userId)}/access`, { token }),
  adminAssignments: (token: string) => request<AdminAssignmentRow[]>("/admin/assignments", { token }),
  adminAssignmentOptions: (token: string) =>
    request<AdminAssignmentOptions>("/admin/assignment-options", { token }),
  previewAdminUserAssignments: (token: string, userId: string, body: AdminAssignmentPreviewInput) =>
    request<AdminAssignmentBatchPreview>(`/admin/users/${encodeURIComponent(userId)}/assignment-previews`, {
      method: "POST",
      token,
      body,
    }),
  confirmAdminUserAssignments: (token: string, userId: string, body: AdminAssignmentConfirmInput) =>
    request<AdminAssignmentBatchResult>(`/admin/users/${encodeURIComponent(userId)}/assignment-batches`, {
      method: "POST",
      token,
      body,
    }),
  createAdminUser: (token: string, body: CreateAdminUserInput) =>
    request<CreateAdminUserResult>("/admin/users", { method: "POST", token, body }),
  adminRoles: (token: string) => request<AdminRoleSummary[]>("/admin/roles", { token }),
  adminRolePermissions: (token: string, roleCode: string) =>
    request<AdminRolePermissions>(`/admin/roles/${encodeURIComponent(roleCode)}/permissions`, { token }),

  // --- Role definition (Epic 4 Wave 1) ----------------------------------
  // Read paths accept `config.read`; write paths require `role.manage`. Both
  // additionally require the edge ticket `admin.console.read` plus one
  // tenant-scoped assignment holding the pair. No client-side gate replaces
  // the server check.
  roleDefinition: (token: string, roleCode: string) =>
    request<RoleDefinition>(`/admin/roles/${encodeURIComponent(roleCode)}/definition`, { token }),
  roleDefinitionOptions: (token: string) =>
    request<RoleDefinitionOptions>("/admin/role-definition-options", { token }),
  createRoleDefinition: (token: string, body: CreateRoleDefinitionInput) =>
    request<RoleDefinition>("/admin/roles", { method: "POST", token, body }),
  copyRoleDefinition: (token: string, roleCode: string, body: CopyRoleDefinitionInput) =>
    request<RoleDefinition>(`/admin/roles/${encodeURIComponent(roleCode)}/copy`, {
      method: "POST",
      token,
      body,
    }),
  /** Dry run. Returns the hash and the affected-user count without writing. */
  previewRoleDefinition: (token: string, roleCode: string, body: RoleDefinitionFields) =>
    request<RoleDefinitionPreview>(`/admin/roles/${encodeURIComponent(roleCode)}/preview`, {
      method: "POST",
      token,
      body,
    }),
  /** The hash binds the definition the preview described. If the role changed
   * in between, the server refuses rather than applying a stale intent. */
  updateRoleDefinition: (token: string, roleCode: string, body: UpdateRoleDefinitionInput) =>
    request<RoleDefinition>(`/admin/roles/${encodeURIComponent(roleCode)}/definition`, {
      method: "PUT",
      token,
      body,
    }),
  deleteRoleDefinition: (token: string, roleCode: string) =>
    request<void>(`/admin/roles/${encodeURIComponent(roleCode)}/definition`, {
      method: "DELETE",
      token,
    }),
  /** Deactivate or reactivate a Role (Epic 4 open item 2). Deactivation is
   * refused (409) while any live assignment still references the Role. */
  setRoleDefinitionActive: (token: string, roleCode: string, isActive: boolean) =>
    request<RoleDefinition>(`/admin/roles/${encodeURIComponent(roleCode)}/active-state`, {
      method: "POST",
      token,
      body: { isActive },
    }),
  addAdminUserRoleAssignment: (
    token: string,
    userId: string,
    body: AdminRoleAssignmentInput,
  ) =>
    request<AdminRoleAssignmentSummary>(`/admin/users/${encodeURIComponent(userId)}/role-assignments`, {
      method: "POST",
      token,
      body,
    }),
  // Epic 4 Wave 3 — revoke retains the row; a reason is mandatory.
  revokeAdminUserRoleAssignment: (
    token: string,
    userId: string,
    assignmentId: string,
    reason: string,
  ) =>
    request<void>(
      `/admin/users/${encodeURIComponent(userId)}/role-assignments/${encodeURIComponent(assignmentId)}/revoke`,
      {
        method: "POST",
        token,
        body: { reason },
      },
    ),
  adminPermissions: (token: string) => request<AdminPermission[]>("/admin/permissions", { token }),
  adminModules: (token: string) => request<AdminModuleSummary[]>("/admin/modules", { token }),
  adminWorkflows: (token: string) => request<AdminWorkflowSummary[]>("/admin/workflows", { token }),
  adminRecentAudit: (token: string) => request<AdminAuditEntry[]>("/admin/audit/recent", { token }),

  // --- Wave A1: Sales & Pipeline (CUS-ADV-001) ------------------------------
  salesReferenceOptions: (token: string) =>
    request<{ stages: { code: string; label: string }[]; sources: { code: string; label: string }[]; units: { code: string; label: string }[] }>("/sales/reference-data", { token }),
  priceBooks: (token: string) => request<PriceBookRecord[]>("/sales/price-books", { token }),
  createPriceBook: (token: string, body: CreatePriceBookBody) =>
    request<PriceBookRecord>("/sales/price-books", { method: "POST", token, body }),
  priceBookEntries: (token: string, priceBookId: string) =>
    request<PriceBookEntryRecord[]>(`/sales/price-books/${priceBookId}/entries`, { token }),
  addPriceBookEntry: (token: string, priceBookId: string, body: AddPriceBookEntryBody) =>
    request<PriceBookEntryRecord>(`/sales/price-books/${priceBookId}/entries`, { method: "POST", token, body }),
  opportunities: (token: string, query?: { outcome?: string; stageCode?: string; customerId?: string }) => {
    const qs = new URLSearchParams();
    if (query?.outcome) qs.set("outcome", query.outcome);
    if (query?.stageCode) qs.set("stageCode", query.stageCode);
    if (query?.customerId) qs.set("customerId", query.customerId);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<OpportunityRecord[]>(`/sales/opportunities${suffix}`, { token });
  },
  opportunityPipeline: (token: string) =>
    request<OpportunityPipelineSummary[]>("/sales/opportunities/pipeline", { token }),
  opportunity: (token: string, id: string) =>
    request<OpportunityDetailRecord>(`/sales/opportunities/${id}`, { token }),
  createOpportunity: (token: string, body: CreateOpportunityBody) =>
    request<OpportunityRecord>("/sales/opportunities", { method: "POST", token, body }),
  changeOpportunityStage: (token: string, id: string, body: { stageCode: string; outcome?: string; outcomeReason?: string | null; note?: string | null }) =>
    request<OpportunityRecord>(`/sales/opportunities/${id}/stage`, { method: "POST", token, body }),
  quotations: (token: string) => request<QuotationRecord[]>("/sales/quotations", { token }),
  quotation: (token: string, id: string) =>
    request<QuotationDetailRecord>(`/sales/quotations/${id}`, { token }),
  createQuotation: (token: string, body: CreateQuotationBody) =>
    request<QuotationDetailRecord>("/sales/quotations", { method: "POST", token, body }),
  submitQuotationForApproval: (token: string, id: string) =>
    request<QuotationRecord>(`/sales/quotations/${id}/submit`, { method: "POST", token }),
  recordQuotationApproval: (token: string, id: string, decision: "issued" | "withdrawn") =>
    request<QuotationRecord>(`/sales/quotations/${id}/approval`, { method: "POST", token, body: { decision } }),
  recordQuotationCustomerDecision: (token: string, id: string, body: { decision: "accepted" | "declined"; note?: string | null }) =>
    request<QuotationRecord>(`/sales/quotations/${id}/customer-decision`, { method: "POST", token, body }),

  // --- Wave A1: Service Quality Advanced (SQ-ADV-001…004) ------------------
  sqCalendars: (token: string) =>
    request<{ calendar: SqCalendarRecord; windows: SqCalendarWindow[]; holidays: SqHolidayRecord[] }[]>("/service-quality/calendars", { token }),
  createSqCalendar: (token: string, body: CreateSqCalendarBody) =>
    request<{ calendar: SqCalendarRecord; windows: SqCalendarWindow[] }>("/service-quality/calendars", { method: "POST", token, body }),
  addSqHoliday: (token: string, calendarId: string, body: { holidayDate: string; name: string }) =>
    request<SqHolidayRecord>(`/service-quality/calendars/${calendarId}/holidays`, { method: "POST", token, body }),
  sqSlaPolicies: (token: string) =>
    request<{ policy: SqSlaPolicyRecord; calendar: SqCalendarRecord | null; rules: SqSlaRuleRecord[] }[]>("/service-quality/sla-policies", { token }),
  createSqSlaPolicy: (token: string, body: CreateSqSlaPolicyBody) =>
    request<SqSlaPolicyRecord>("/service-quality/sla-policies", { method: "POST", token, body }),
  createSqSlaRule: (token: string, body: CreateSqSlaRuleBody) =>
    request<SqSlaRuleRecord>("/service-quality/sla-rules", { method: "POST", token, body }),
  sqSlaPerformance: (token: string) =>
    request<SqSlaPerformanceSummary[]>("/service-quality/sla-performance", { token }),
  sqComplaintSla: (token: string, complaintId: string) =>
    request<{ target: SqSlaTargetRecord | null; state: SqSlaTargetState | null }>(`/service-quality/complaints/${complaintId}/sla`, { token }),
  sqRcaCategories: (token: string) =>
    request<SqRcaCategoryRecord[]>("/service-quality/rca/categories", { token }),
  createSqRcaCategory: (token: string, body: CreateSqRcaCategoryBody) =>
    request<SqRcaCategoryRecord>("/service-quality/rca/categories", { method: "POST", token, body }),
  sqComplaintRcaFindings: (token: string, complaintId: string) =>
    request<SqRcaFindingRecord[]>(`/service-quality/complaints/${complaintId}/rca/findings`, { token }),
  recordSqRcaFinding: (token: string, complaintId: string, body: CreateSqRcaFindingBody) =>
    request<SqRcaFindingRecord>(`/service-quality/complaints/${complaintId}/rca/findings`, { method: "POST", token, body }),
  clearSqPrimaryRcaFinding: (token: string, complaintId: string) =>
    request<void>(`/service-quality/complaints/${complaintId}/rca/primary`, { method: "DELETE", token }),
  sqCapaActions: (token: string) =>
    request<SqCapaActionRecord[]>("/service-quality/capa/actions", { token }),
  sqComplaintCapaActions: (token: string, complaintId: string) =>
    request<SqCapaActionRecord[]>(`/service-quality/complaints/${complaintId}/capa/actions`, { token }),
  createSqCapaAction: (token: string, body: CreateSqCapaActionBody) =>
    request<SqCapaActionRecord>("/service-quality/capa/actions", { method: "POST", token, body }),
  updateSqCapaStatus: (token: string, id: string, body: { status: string; completionNote?: string }) =>
    request<SqCapaActionRecord>(`/service-quality/capa/actions/${id}/status`, { method: "PATCH", token, body }),
  verifySqCapaEffectiveness: (token: string, id: string, body: { verdict: "effective" | "ineffective"; note?: string | null }) =>
    request<SqCapaActionRecord>(`/service-quality/capa/actions/${id}/verify`, { method: "POST", token, body }),
  sqCapaEffectivenessSummary: (token: string) =>
    request<SqCapaEffectivenessSummary[]>("/service-quality/capa/effectiveness-summary", { token }),
  sqRecurrenceRules: (token: string) =>
    request<SqRecurrenceRuleRecord[]>("/service-quality/recurrence/rules", { token }),
  createSqRecurrenceRule: (token: string, body: CreateSqRecurrenceRuleBody) =>
    request<SqRecurrenceRuleRecord>("/service-quality/recurrence/rules", { method: "POST", token, body }),
  detectSqRecurrence: (token: string, ruleId: string) =>
    request<SqRecurrenceDetectionRecord>(`/service-quality/recurrence/rules/${ruleId}/detection`, { token }),
  sqAutomationRules: (token: string) =>
    request<SqAutomationRuleRecord[]>("/service-quality/automation/rules", { token }),
  createSqAutomationRule: (token: string, body: CreateSqAutomationRuleBody) =>
    request<SqAutomationRuleRecord>("/service-quality/automation/rules", { method: "POST", token, body }),
  setSqAutomationRuleActive: (token: string, id: string, isActive: boolean) =>
    request<SqAutomationRuleRecord>(`/service-quality/automation/rules/${id}/active`, { method: "PATCH", token, body: { isActive } }),
  sqAutomationProposals: (token: string, status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return request<SqAutomationProposalRecord[]>(`/service-quality/automation/proposals${qs}`, { token });
  },
  sqAutomationProposal: (token: string, id: string) =>
    request<SqAutomationProposalRecord>(`/service-quality/automation/proposals/${id}`, { token }),
  approveSqAutomationProposal: (token: string, id: string, note?: string | null) =>
    request<SqAutomationProposalRecord>(`/service-quality/automation/proposals/${id}/approve`, { method: "POST", token, body: { note } }),
  rejectSqAutomationProposal: (token: string, id: string, note: string) =>
    request<SqAutomationProposalRecord>(`/service-quality/automation/proposals/${id}/reject`, { method: "POST", token, body: { note } }),
};

// --- Business Admin Console types (Phase 11C) ---------------------------

export type AdminSectionAccess = {
  visible: boolean;
  /** Surfaced so the UI can name the permission a denied section needs. */
  requiredPermission: string;
};

/** `count` is null — not zero — when the section is not visible, so the UI
 * never renders a misleading "0". */
export type AdminCountSection = AdminSectionAccess & { count: number | null };

export type AdminOverview = {
  tenantId: string;
  sections: {
    users: AdminCountSection;
    roles: AdminCountSection;
    permissions: AdminCountSection;
    modules: AdminCountSection & { activeCount: number | null };
    workflows: AdminCountSection;
    audit: AdminCountSection;
  };
  capabilities: {
    userRoleManage: boolean;
    userAccessRead: boolean;
    rolePermissionRead: boolean;
    readOnly: boolean;
    userManage: false;
    roleManage: boolean;
    permissionManage: false;
    moduleActivationManage: false;
    workflowManage: false;
  };
};

export type AdminRoleAssignmentScopeType =
  | "tenant"
  | "legal_entity"
  | "organization_unit"
  | "customer";

export type AdminRoleAssignmentSummary = {
  id: string;
  roleState: "available" | "unavailable";
  roleCode: string | null;
  roleName: string | null;
  scopeType: AdminRoleAssignmentScopeType;
  scopeState: "available" | "unavailable";
  /** Epic 5 G3 — the Legal Entity scope target, named only when it resolves in
   * the assigned User's tenant. */
  scopeLegalEntityId?: string | null;
  scopeLegalEntityName?: string | null;
  scopeOrganizationUnitId: string | null;
  scopeOrganizationUnitName: string | null;
  scopeCustomerId: string | null;
  scopeCustomerName: string | null;
  // Epic 4 Wave 3 — lifecycle kept separate from role/scope availability: an
  // operator revocation and a system invalidation are different events.
  assignmentState: "active" | "revoked" | "invalidated" | "unavailable";
  assignedAt: string | null;
  assignedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
};

export type AdminUserAccessSummary = {
  id: string;
  fullName: string;
  email: string;
  status: string;
  roleAssignments: AdminRoleAssignmentSummary[];
};

export type AdminRoleAssignmentInput =
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

// --- Epic 4 Wave 2: user and assignment surfaces (§4.4 C/D/E) -------------

/** One assignment flattened with its user (step 13, assignment-centric list).
 * The tenant and organization-unit scopes are the only ones the governed
 * surface writes; customer pairs are refused by the API until the Service
 * Operation session closes, so the browser never offers them. */
export type AdminAssignmentRow = AdminRoleAssignmentSummary & {
  userId: string;
  userName: string;
  userEmail: string;
  userStatus: string;
};

/** Step 15 — the picker universe, already filtered server-side by the actor's
 * delegation ceiling and closed-descendant subtree. Non-selectable entries are
 * context (an ancestor above the actor's own subtree), not choices. */
export type AdminAssignmentOptions = {
  canAssignTenantScope: boolean;
  legalEntities: AdminAssignmentLegalEntityOption[];
  organizationUnits: AdminAssignmentUnitOption[];
  roles: AdminAssignmentRoleOption[];
};

export type AdminAssignmentLegalEntityOption = {
  id: string;
  name: string;
  selectable: boolean;
};

export type AdminAssignmentUnitOption = {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  selectable: boolean;
};

export type AdminAssignmentRoleOption = {
  code: string;
  name: string;
  permissionCount: number;
  selectable: boolean;
};

export type AdminAssignmentPreviewInput = {
  pairs: AdminRoleAssignmentInput[];
};

/** Server-computed pairs of the previewed batch. One row per pair, resolved
 * against the same policy a confirmation would run. */
export type AdminAssignmentPairSummary = {
  roleCode: string;
  roleName: string;
  scopeType: AdminRoleAssignmentScopeType;
  scopeLegalEntityId: string | null;
  scopeLegalEntityName: string | null;
  scopeOrganizationUnitId: string | null;
  scopeOrganizationUnitName: string | null;
  scopeCustomerId: string | null;
  scopeCustomerName: string | null;
};

export type AdminAssignmentBatchPreview = {
  previewHash: string;
  targetUserId: string;
  pairs: AdminAssignmentPairSummary[];
};

export type AdminAssignmentConfirmInput = {
  pairs: AdminRoleAssignmentInput[];
  previewHash: string;
  confirm: true;
};

export type AdminAssignmentBatchResult = {
  targetUserId: string;
  created: AdminRoleAssignmentSummary[];
};

export type CreateAdminUserInput = {
  email: string;
  fullName: string;
  password: string;
  pairs: AdminRoleAssignmentInput[];
};

export type CreateAdminUserResult = {
  user: {
    id: string;
    fullName: string;
    email: string;
    status: string;
  };
  assignments: AdminRoleAssignmentSummary[];
};

export type AdminRoleSummary = {
  code: string;
  name: string;
  /** `null` means the Role never had a description — a different fact from an
   * empty one, and the list shows it as such. */
  description: string | null;
  isFullAccess: boolean;
  /** False for a deactivated Role: still listed, because it owns history, but
   * not offerable as a grant target. */
  isActive: boolean;
  permissionCount: number;
  assignedUserCount: number;
};

export type AdminRolePermissions = {
  roleCode: string;
  roleName: string;
  isFullAccess: boolean;
  permissions: AdminPermission[];
};

export type AdminPermission = { code: string; description: string };

export type AdminModuleSummary = {
  moduleCode: string;
  moduleName: string;
  isActive: boolean;
};

export type AdminWorkflowSummary = {
  code: string;
  name: string;
  entityType: string;
  isActive: boolean;
};

/** Privacy-safe: carries no audit `metadata` and no `entityId`. */
export type AdminAuditEntry = {
  id: string;
  action: string;
  entityType: string;
  actorUserId: string | null;
  createdAt: string;
};

// --- Role definition types (Epic 4 Wave 1) ------------------------------
// Mirrors `domain/rbac/rbac.entity.ts`. The server rejects any body that
// carries a field not listed here, so these shapes are also the contract for
// what the UI may send back.

export type WindowAccessInput = {
  windowCode: string;
  isReadWrite: boolean;
  isActive: boolean;
};

export type RoleDefinition = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  /** Operator-authored metadata (Epic 4 open item 1). Never read by
   * authorization. */
  description: string | null;
  isFullAccess: boolean;
  /** Lifecycle switch (Epic 4 open item 2): false means the Role may not be
   * granted again and live grants referencing it stop authorizing. */
  isActive: boolean;
  version: number;
  permissionCodes: string[];
  windows: WindowAccessInput[];
  /** iDempiere AD_Role_Included parity — Roles whose grants this Role
   * effectively inherits, ordered by code. Excludes the Role itself. */
  includedRoleCodes: string[];
  /** Read server-side from the census of routes the server actually serves
   * (Epic 4 step 11b). `"partial"` means at least one mutating route resolves
   * to no Window and carries no exemption, so it sits outside the read-only
   * lock with nothing on record saying why; `"enforced"` means every one of
   * them is mapped or exempted. Never a literal the server can hard-code. */
  enforcementStatus: "enforced" | "partial";
};

export type RoleDefinitionPermissionOption = AdminPermission & {
  moduleCode: string | null;
  isActive: boolean;
  /** False when the actor's delegation limit or a disabled module forbids the
   * grant. The server rejects it even if the UI sends it anyway. */
  selectable: boolean;
};

export type RoleDefinitionWindowOption = {
  code: string;
  name: string;
  moduleCode: string;
  registrationStatus: string;
  requiredPermissions: string[];
  parentPath: string | null;
  isDetail: boolean;
  selectable: boolean;
};

export type RoleDefinitionOptions = {
  permissions: RoleDefinitionPermissionOption[];
  windows: RoleDefinitionWindowOption[];
};

export type RoleDefinitionPreview = {
  role: RoleDefinition;
  previewHash: string;
  affectedUserCount: number;
};

/** What a definition IS, apart from its code: shared by preview and update so
 * the two can never drift. */
export type RoleDefinitionFields = {
  version: number;
  name: string;
  /** Required and nullable, not optional: preview and update state the whole
   * definition, so an omitted field would silently clear the description. */
  description: string | null;
  permissionCodes: string[];
  windows: WindowAccessInput[];
  includedRoleCodes: string[];
};

/** Create omits `version` deliberately: the server's create schema is strict
 * and a new role has no version to check against. Keeping the token out of
 * this type is what stops one being sent by accident. */
export type CreateRoleDefinitionInput = Omit<RoleDefinitionFields, "version"> & {
  code: string;
  /** Omitted or `null` both mean "no description". */
  description?: string | null;
};

export type CopyRoleDefinitionInput = {
  code: string;
  name: string;
  /** Omitted means "carry the source Role's description". */
  description?: string | null;
};

export type UpdateRoleDefinitionInput = RoleDefinitionFields & {
  previewHash: string;
  confirm: true;
};

// --- Reporting & Operational Insight types (Phase 9) --------------------

export type ReportModuleCode =
  | "customer_commercial"
  | "customer_complaint"
  | "survey_assessment"
  | "service_operations"
  | "workforce"
  | "supply_chain"
  | "asset"
  | "finance"
  | "hse"
  | "project_delivery";

export type ReportColumnType = "text" | "number" | "money" | "percent";

export type ReportDefinition = {
  code: string;
  title: string;
  description: string;
  moduleCode: ReportModuleCode;
  requiredPermission: string;
};

export type ReportColumn = {
  key: string;
  label: string;
  type: ReportColumnType;
};

export type ReportRow = {
  label: string;
  [key: string]: string | number | null;
};

export type StandardReportResult = {
  code: string;
  title: string;
  moduleCode: ReportModuleCode;
  moduleName: string;
  generatedAt: string;
  columns: ReportColumn[];
  summary: Record<string, string | number>;
  rows: ReportRow[];
};

export type DrillTarget =
  | { kind: "route"; path: string }
  | { kind: "list"; path: string; params: Record<string, string> };

export type DashboardCard = {
  label: string;
  value: string | number;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  drillTarget?: DrillTarget;
};

export type DashboardModule = {
  moduleCode: ReportModuleCode;
  moduleName: string;
  cards: DashboardCard[];
  chart?: {
    columns: ReportColumn[];
    rows: ReportRow[];
  };
};

export type ExecutiveDashboard = {
  generatedAt: string;
  modules: DashboardModule[];
};

// --- Wave A2 Reporting Advanced types ----------------------------------

export type BiFieldType = "text" | "number" | "money" | "date" | "boolean";
export type BiAggregation = "sum" | "avg" | "count" | "min" | "max";
export type BiFilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";

export type BiDataset = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  moduleCode: string;
  requiredPermissions: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BiDatasetField = {
  id: string;
  tenantId: string;
  datasetId: string;
  code: string;
  name: string;
  fieldType: BiFieldType;
  isDimension: boolean;
  isMeasure: boolean;
  isFilterable: boolean;
  aggregation: BiAggregation | null;
  sortOrder: number;
};

export type BiDatasetDetail = {
  dataset: BiDataset;
  fields: BiDatasetField[];
};

export type BiFilter = {
  field: string;
  operator: BiFilterOperator;
  value: string | number | boolean | Array<string | number>;
};

export type BiQueryConfig = {
  datasetCode: string;
  dimensions: string[];
  measures: string[];
  filters: BiFilter[];
};

export type BiQueryResult = {
  datasetCode: string;
  columns: Array<{ key: string; label: string; type: BiFieldType }>;
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
  generatedAt: string;
};

export type BiSavedReport = {
  id: string;
  tenantId: string;
  datasetId: string;
  code: string;
  title: string;
  description: string | null;
  config: BiQueryConfig;
  isShared: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateBiSavedReportBody = {
  code: string;
  title: string;
  description?: string | null;
  config: BiQueryConfig;
  isShared?: boolean;
};

export type ForecastModelCode =
  | "complaint_volume_forecast"
  | "sla_breach_risk_forecast"
  | "survey_satisfaction_trend";
export type ForecastStatus = "completed" | "insufficient_data";
export type ForecastDataPoint = { period: string; value: number };
export type ForecastMetrics = {
  historicalAverage: number;
  trendSlopePerDay: number;
  projectedNextPeriodValue: number;
};
export type ForecastConfidenceInterval = { period: string; lower: number; upper: number };

export type ForecastResult = {
  modelCode: ForecastModelCode;
  status: ForecastStatus;
  forecastPeriodStart: string;
  forecastPeriodEnd: string;
  historicalDataPoints: ForecastDataPoint[];
  projectedDataPoints: ForecastDataPoint[];
  metrics: ForecastMetrics | null;
  confidenceIntervals: ForecastConfidenceInterval[];
  insufficientDataReason: string | null;
};

export type PredictiveForecastSnapshot = {
  id: string;
  tenantId: string;
  modelCode: ForecastModelCode;
  forecastPeriodStart: string;
  forecastPeriodEnd: string;
  inputParams: Record<string, unknown>;
  dataPoints: ForecastDataPoint[];
  metrics: ForecastMetrics | Record<string, never>;
  confidenceIntervals: ForecastConfidenceInterval[];
  status: ForecastStatus;
  generatedAt: string;
  generatedBy: string | null;
  createdAt: string;
};

export type GenerateForecastBody = {
  modelCode: ForecastModelCode;
  lookbackDays?: number;
  forecastDays?: number;
};

export type GenerateForecastResponse = {
  forecast: ForecastResult;
  snapshot: PredictiveForecastSnapshot;
};

// --- Finance types (Phase 6) -------------------------------------------

/** Money is a string end to end — see the module PRD and finance.entity.ts. */
export type Money = string;

export type FinanceAccountType = "cash" | "bank" | "petty_cash";
export type TransactionDirection = "income" | "expense";

export type FinanceAccount = {
  id: string;
  code: string;
  name: string;
  accountType: FinanceAccountType;
  currency: string;
  description: string | null;
  legalEntityId: string | null;
  organizationUnitId: string | null;
  balance: Money;
  isActive: boolean;
};

export type FinanceTransactionRecord = {
  id: string;
  transactionNumber: string;
  direction: TransactionDirection;
  amount: Money;
  currency: string;
  transactionDate: string;
  accountId: string;
  categoryCode: string;
  description: string | null;
  reference: string | null;
  organizationUnitId: string | null;
  projectId: string | null;
  siteId: string | null;
  customerId: string | null;
  workflowInstanceId: string | null;
  appliedAt: string | null;
  reversesTransactionId: string | null;
  reversedByTransactionId: string | null;
};

export type FinanceTransactionDetail = {
  transaction: FinanceTransactionRecord;
  account: FinanceAccount | null;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
  isApplied: boolean;
};

export type CashflowResult = {
  from: string;
  to: string;
  opening: Money;
  totals: { income: Money; expense: Money; net: Money };
  closing: Money;
  byCategory: { categoryCode: string; direction: TransactionDirection; amount: Money }[];
  accounts: FinanceAccount[];
};

export type FinanceTransactionQuery = {
  direction?: string;
  accountCode?: string;
  categoryCode?: string;
  customerId?: string;
  projectId?: string;
  organizationUnitId?: string;
  dateFrom?: string;
  dateTo?: string;
  state?: string;
  search?: string;
};

export type CreateFinanceAccountBody = {
  code: string;
  name: string;
  accountType: FinanceAccountType;
  currency: string;
  description?: string | null;
  legalEntityId?: string | null;
  organizationUnitId?: string | null;
};

export type RecordFinanceTransactionBody = {
  direction: TransactionDirection;
  /** A string, always. */
  amount: Money;
  transactionDate: string;
  accountCode: string;
  categoryCode: string;
  description?: string | null;
  reference?: string | null;
  organizationUnitId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  customerId?: string | null;
};

// --- Accounting Kernel types (Wave A6) ---------------------------------
// Shapes mirror the API entities. Amounts are strings; dates are
// `YYYY-MM-DD` strings unless the kernel returns a real Date.

export type AccountingPeriodRecord = {
  id: string;
  legalEntityId: string;
  fiscalYearCode: string;
  periodCode: string;
  periodName: string;
  periodType: "monthly" | "quarterly" | "annual";
  dateFrom: string;
  dateTo: string;
  status: "draft" | "open" | "closed" | "reopenable" | "tombstone";
  lockedDate: string | null;
  lockedBy: string | null;
  reopenRequestedDate: string | null;
  reopenReason: string | null;
};

export type AccountingLedgerRecord = {
  id: string;
  legalEntityId: string;
  ledgerCode: string;
  ledgerName: string;
  ledgerRole: "primary";
  isPrimary: boolean;
  isActive: boolean;
  currency: string;
};

export type AccountingChartRecord = {
  id: string;
  legalEntityId: string;
  coaVersionCode: string;
  coaVersionDate: string;
  templateType: "SAK_UMUM" | "SAK_EMKM" | null;
  coaStatus: "draft" | "approved";
  isActive: boolean;
  approvedBy: string | null;
  approvedDate: string | null;
};

export type AccountingAccountRecord = {
  id: string;
  legalEntityId: string;
  coaId: string;
  accountCode: string;
  accountName: string;
  accountClass: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  normalBalance: "debit" | "credit";
  accountType: string | null;
  parentAccountId: string | null;
  isActive: boolean;
};

export type AccountingFiscalClosingRecord = {
  id: string;
  legalEntityId: string;
  periodId: string;
  fiscalYearCode: string;
  closeKind: "month_end" | "year_end";
  incomeTotal: Money | null;
  expenseTotal: Money | null;
  retainedEarningsDelta: Money | null;
  closingJournalId: string | null;
  closedBy: string | null;
  closedAt: string;
};

export type AccountingAgingBucket = {
  label: string;
  fromDays: number;
  toDays: number | null;
  amount: Money;
  itemCount: number;
};

export type AccountingAgingResult = {
  asOfDate: string;
  side: "AR" | "AP";
  currency: string;
  totalOpen: Money;
  buckets: AccountingAgingBucket[];
};

export type AccountingGlEntryRecord = {
  id: string;
  accountId: string;
  periodId: string;
  journalLineId: string;
  postingDate: string;
  debit: Money;
  credit: Money;
  documentType: string | null;
  documentId: string | null;
};

export type AccountingJournalRecord = {
  id: string;
  legalEntityId: string;
  journalNumber: string;
  journalDate: string;
  accountingDate: string;
  periodId: string;
  description: string | null;
  currency: string;
  status: "pending" | "posted" | "failed" | "reversed";
  isBalanced: boolean;
  reversalOfId: string | null;
};

export type AccountingConsolidationGroupRecord = {
  id: string;
  groupCode: string;
  name: string;
  reportingCurrency: string;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
};

export type AccountingTranslationRunRecord = {
  id: string;
  groupId: string;
  periodId: string;
  reportingCurrency: string;
  translatedTotal: Money;
  residualAmount: Money;
  status: string;
  journalId: string | null;
};

export type AccountingEliminationRecord = {
  id: string;
  groupId: string;
  periodId: string;
  description: string;
  amount: Money;
  currency: string;
  status: string;
  journalId: string | null;
};

export type AccountingFsvVersionRecord = {
  id: string;
  fsvCode: string;
  versionNumber: number;
  description: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

// --- Accounting mutations (Wave A6.2) ---------------------------------
// Inputs mirror the zod schemas on the API routes. Every amount stays a
// string at the precision the route accepts: 4 decimals for open items and
// budgets, 2 for bank reconciliation, assets, tax and consolidation.

export type AccountingJournalLineInput = {
  accountId: string;
  lineNumber: number;
  debit: string;
  credit: string;
  lineDescription: string | null;
  projectId: string | null;
  siteId: string | null;
};

export type AccountingJournalInput = {
  legalEntityId: string;
  journalNumber: string;
  journalDate: string;
  accountingDate: string;
  periodId: string;
  description: string | null;
  currency: string;
  lines: AccountingJournalLineInput[];
};

export type AccountingCloseAttestation = {
  bankReconConfirmed: boolean;
  apArConfirmed: boolean;
  depreciationConfirmed: boolean;
  accrualsConfirmed: boolean;
};

export type AccountingOpenItemRecord = {
  id: string;
  legalEntityId: string;
  side: "AR" | "AP";
  direction: "debit" | "credit";
  sourceKind: string;
  partyType: "customer" | "supplier";
  partyId: string;
  documentNo: string;
  documentDate: string;
  dueDate: string | null;
  currency: string;
  originalAmount: Money;
};

export type AccountingOpenItemInput = {
  legalEntityId: string;
  side: "AR" | "AP";
  direction: "debit" | "credit";
  sourceKind: "invoice" | "payment" | "credit_note" | "debit_note" | "down_payment" | "withholding" | "unapplied";
  sourceRefTable: string;
  sourceRefId: string;
  partyType: "customer" | "supplier";
  partyId: string;
  documentNo: string;
  documentDate: string;
  dueDate: string | null;
  currency: string;
  originalAmount: string;
};

export type AccountingOpenItemAllocationRecord = {
  id: string;
  sourceOpenItemId: string;
  targetOpenItemId: string;
  amount: Money;
  currency: string;
  allocationDate: string;
  idempotencyKey: string;
};

export type AccountingAllocationInput = {
  legalEntityId: string;
  sourceOpenItemId: string;
  targetOpenItemId: string;
  amount: string;
  allocationDate: string;
  idempotencyKey: string;
};

export type AccountingBudgetRecord = {
  id: string;
  legalEntityId: string;
  fiscalYearCode: string;
  scenario: "original" | "revision" | "forecast";
  currency: string;
  name: string;
  activeVersionId: string | null;
};

export type AccountingBudgetInput = {
  legalEntityId: string;
  fiscalYearCode: string;
  scenario: "original" | "revision" | "forecast";
  currency: string;
  name: string;
};

export type AccountingBudgetVersionRecord = {
  id: string;
  budgetId: string;
  versionNumber: number;
  status: string;
  note: string | null;
  approvedAt: string | null;
};

export type AccountingBudgetUtilization = {
  budgetId: string;
  versionId: string | null;
  currency: string;
  periods: {
    periodCode: string;
    baseline: Money;
    actual: Money;
    committed: Money;
    released: Money;
    adjustments: Money;
    available: Money;
    variance: Money;
  }[];
  total: {
    baseline: Money;
    actual: Money;
    committed: Money;
    released: Money;
    adjustments: Money;
    available: Money;
    variance: Money;
  };
};

export type AccountingBudgetConsumptionRecord = {
  id: string;
  budgetVersionId: string;
  periodCode: string;
  kind: "actual" | "commitment" | "adjustment" | "release";
  amount: Money;
  note: string | null;
};

export type AccountingBudgetConsumptionInput = {
  budgetId: string;
  periodCode: string;
  amount: string;
  kind: "actual" | "commitment" | "adjustment" | "release";
  idempotencyKey: string;
  note: string | null;
};

export type AccountingBankAccountRecord = {
  id: string;
  legalEntityId: string;
  bankName: string;
  houseBankCode: string;
  accountNumberMasked: string;
  name: string;
  currency: string;
  ledgerAccountId: string;
  reconciliationPolicy: "manual" | "suggested";
  effectiveFrom: string;
  isActive: boolean;
};

export type AccountingBankAccountInput = {
  legalEntityId: string;
  bankName: string;
  houseBankCode: string;
  bankAccountId: string;
  accountNumberMasked: string;
  name: string;
  currency: string;
  ledgerAccountId: string;
  reconciliationPolicy: "manual" | "suggested";
  effectiveFrom: string;
};

export type AccountingBankStatementImportRecord = {
  id: string;
  bankAccountId: string;
  formatProfile: string;
  sourceFileName: string;
  lineCount: number;
  duplicateLineCount: number;
  createdAt: string;
};

export type AccountingBankStatementLineRecord = {
  id: string;
  bankAccountId: string;
  valueDate: string;
  amount: Money;
  direction: "debit" | "credit";
  currency: string;
  reference: string | null;
  counterparty: string | null;
  duplicateStatus: "accepted" | "review_queue";
};

export type AccountingBankReconciliationRecord = {
  id: string;
  bankAccountId: string;
  periodId: string;
  status: "open" | "closed";
  statementBalance: Money | null;
  closedBookBalance: Money | null;
  closedStatementBalance: Money | null;
  closedAt: string | null;
};

export type AccountingBankMatchRecord = {
  id: string;
  reconciliationId: string;
  statementLineId: string;
  glEntryId: string;
  amount: Money;
  matchKind: "manual" | "confirmed";
  reversesId: string | null;
};

export type AccountingBankMatchInput = {
  reconciliationId: string;
  statementLineId: string;
  glEntryId: string;
  amount: string;
  matchKind: "manual" | "confirmed";
  matchReason: string | null;
  idempotencyKey: string;
  note: string | null;
};

export type AccountingBankPeriodMovement = {
  periodId: string;
  bookMovement: Money;
  statementMovement: Money;
  difference: Money;
  currency: string;
};

/** A ledger entry the service proposes as the other half of a statement line.
 * `score` and `reasons` come from the service — the page does not rank them. */
export type AccountingMatchCandidate = {
  glEntryId: string;
  postingDate: string;
  amount: Money;
  documentType: string | null;
  ledgerReference: string;
  score: number;
  reasons: string[];
};

export type AccountingAssetBookRecord = {
  id: string;
  legalEntityId: string;
  assetId: string;
  bookCode: string;
  assetClass: string;
  capitalizationDate: string;
  inServiceDate: string;
  acquisitionCost: Money;
  residualValue: Money;
  usefulLifeMonths: number;
  methodCode: string;
  methodVersion: number;
  status: "draft" | "active" | "disposed";
  accumulatedDepreciation: Money;
  disposedAt: string | null;
};

export type AccountingAssetBookInput = {
  legalEntityId: string;
  ledgerId: string;
  assetId: string;
  bookCode: string;
  assetClass: string;
  capitalizationDate: string;
  inServiceDate: string;
  acquisitionCost: string;
  residualValue: string;
  usefulLifeMonths: number;
  depreciationExpenseAccountId: string;
  accumulatedDepreciationAccountId: string;
};

export type AccountingDepreciationRunRecord = {
  id: string;
  legalEntityId: string;
  bookCode: string;
  periodId: string;
  status: "posted" | "reversed";
  totalAmount: Money;
  currency: string;
  journalId: string | null;
  reversesRunId: string | null;
};

export type AccountingTaxRegistrationRecord = {
  id: string;
  legalEntityId: string;
  taxpayerStatus: "pkp" | "non_pkp";
  registrationNumber: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "superseded";
};

export type AccountingTaxRuleRecord = {
  id: string;
  legalEntityId: string;
  ruleCode: string;
  taxType: "ppn" | "pph22" | "pph23" | "pph26";
  description: string | null;
};

export type AccountingTaxRuleVersionRecord = {
  id: string;
  taxRuleId: string;
  versionNumber: number;
  rate: string;
  basis: "gross" | "net" | "dpp";
  roundingMode: "half_up" | "half_even" | "truncate";
  requiresPkp: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "draft" | "approved" | "superseded";
};

export type AccountingTaxCalculationRecord = {
  id: string;
  legalEntityId: string;
  ruleVersionId: string;
  taxpayerStatus: "pkp" | "non_pkp";
  basisAmount: Money;
  rate: string;
  taxAmount: Money;
  currency: string;
  calculationDate: string;
};

// --- Project Delivery types (Phase 8) -----------------------------------

export type ProjectDeliveryActivityStatus = "planned" | "in_progress" | "completed" | "on_hold" | "cancelled";
export type ProjectDeliveryMilestoneStatus = "pending" | "achieved" | "missed" | "cancelled";

export type ProjectDeliveryProject = {
  id: string;
  tenantId: string;
  customerId: string;
  code: string;
  name: string;
  status: string;
  ownerOrganizationUnitId: string | null;
};

export type ProjectDeliveryProgress = {
  projectId: string;
  activityCount: number;
  completedActivityCount: number;
  progressPercent: number;
  milestoneCount: number;
  achievedMilestoneCount: number;
};

export type ProjectDeliveryActivity = {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  description: string | null;
  activityTypeCode: string | null;
  picUserId: string | null;
  picEmployeeId: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  status: ProjectDeliveryActivityStatus;
  progressPercent: number;
};

export type ProjectDeliveryMilestone = {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  description: string | null;
  milestoneTypeCode: string | null;
  plannedDate: string | null;
  status: ProjectDeliveryMilestoneStatus;
  achievedAt: string | null;
  achievedByUserId: string | null;
  achievementNote: string | null;
};

export type ProjectDeliveryProjectSummary = {
  project: ProjectDeliveryProject;
  progress: ProjectDeliveryProgress;
};

export type ProjectDeliveryDetail = ProjectDeliveryProjectSummary & {
  activities: ProjectDeliveryActivity[];
  milestones: ProjectDeliveryMilestone[];
};

export type CreateProjectDeliveryActivityBody = {
  title: string;
  description?: string | null;
  activityTypeCode?: string | null;
  picUserId?: string | null;
  picEmployeeId?: string | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  actualStartDate?: string | null;
  actualEndDate?: string | null;
  status?: ProjectDeliveryActivityStatus;
  progressPercent?: number;
};

export type UpdateProjectDeliveryActivityBody = Partial<CreateProjectDeliveryActivityBody>;

export type CreateProjectDeliveryMilestoneBody = {
  title: string;
  description?: string | null;
  milestoneTypeCode?: string | null;
  plannedDate?: string | null;
  status?: ProjectDeliveryMilestoneStatus;
};

export type UpdateProjectDeliveryMilestoneBody = Partial<CreateProjectDeliveryMilestoneBody> & {
  achievementNote?: string | null;
};

// --- Project Delivery Advanced types (Phase 3) --------------------------

// WBS (Work Breakdown Structure)
export type ProjectWbsNode = {
  id: string;
  projectId: string;
  parentId: string | null;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: string;
};

export type ProjectWbsNodeView = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  depth: number;
  rolledUpCost: string; // money 2dp
  activityCount: number;
  children: ProjectWbsNodeView[];
};

// Dependencies and scheduling
export type ProjectActivityDependency = {
  id: string;
  projectId: string;
  fromActivityId: string;
  toActivityId: string;
  type: "FS" | "SS" | "FF" | "SF"; // Finish-Start, Start-Start, Finish-Finish, Start-Finish
  lagDays: number;
  createdAt: string;
};

export type ScheduleActivityResult = {
  activityId: string;
  code: string;
  name: string;
  plannedStart: string | null; // YYYY-MM-DD
  plannedFinish: string | null; // YYYY-MM-DD
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalSlack: number; // days
  isCritical: boolean;
};

export type ProjectSchedule = {
  projectId: string;
  activities: ScheduleActivityResult[];
  projectFinish: string | null;
  criticalPath: string[]; // activity IDs
};

export type GanttRow = {
  activityId: string;
  code: string;
  name: string;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  percentComplete: number;
  wbsNodeId: string | null;
};

// Resources and loading
export type ProjectResource = {
  id: string;
  code: string;
  name: string;
  type: "labor" | "equipment" | "material";
  baseAvailability: string; // units per period, 4dp
  unitOfMeasure: string;
  createdAt: string;
};

export type ProjectResourceAssignment = {
  id: string;
  projectId: string;
  resourceId: string;
  activityId: string;
  allocatedQuantity: string; // 4dp
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  createdAt: string;
};

export type ResourceOverallocation = {
  resourceId: string;
  resourceCode: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  allocatedQuantity: string; // 4dp
  availableQuantity: string; // 4dp
};

export type ResourceLoadingResult = {
  projectId: string;
  overallocations: ResourceOverallocation[];
  isLevellable: boolean;
};

// Baselines and variance
export type ProjectBaseline = {
  id: string;
  projectId: string;
  code: string;
  description: string | null;
  status: "draft" | "approved" | "superseded";
  approvedAt: string | null;
  approvedByUserId: string | null;
  createdAt: string;
};

export type ProjectBaselineLine = {
  id: string;
  baselineId: string;
  activityId: string;
  plannedCost: string; // money 2dp
  plannedQuantity: string; // 4dp
};

export type BaselineVarianceResult = {
  projectId: string;
  baselineId: string;
  asOfDate: string; // YYYY-MM-DD
  activities: Array<{
    activityId: string;
    code: string;
    name: string;
    plannedCost: string;
    actualCost: string;
    variance: string; // actualCost - plannedCost
    percentVariance: number;
  }>;
};

// Cost entries and position
export type ProjectCostEntry = {
  id: string;
  projectId: string;
  activityId: string;
  entryType: "actual" | "commitment" | "adjustment" | "reversal";
  amount: string; // money 2dp
  idempotencyKey: string;
  entryDate: string; // YYYY-MM-DD
  recordedByUserId: string;
  recordedAt: string; // ISO timestamp
  note: string | null;
  postingStatus: "emitted" | "skipped_duplicate" | null;
};

export type ProjectCostPosition = {
  projectId: string;
  asOfDate: string; // YYYY-MM-DD
  actualCost: string; // money 2dp
  commitmentCost: string; // money 2dp
  estimateToComplete: string; // money 2dp
  estimateAtCompletion: string; // money 2dp
  budgetAtCompletion: string; // money 2dp
  costVariance: string; // money 2dp: estimateAtCompletion - budgetAtCompletion
  costPerformanceIndex: number;
};

// Earned value
export type ProjectEarnedValueSnapshot = {
  id: string;
  projectId: string;
  snapshotDate: string; // YYYY-MM-DD
  plannedValue: string; // money 2dp
  earnedValue: string; // money 2dp
  actualCost: string; // money 2dp
  schedulePerformanceIndex: number;
  costPerformanceIndex: number;
};

export type EarnedValueResult = {
  projectId: string;
  asOfDate: string; // YYYY-MM-DD
  plannedValue: string; // money 2dp
  earnedValue: string; // money 2dp
  actualCost: string; // money 2dp
  scheduleVariance: string; // money 2dp
  costVariance: string; // money 2dp
  schedulePerformanceIndex: number;
  costPerformanceIndex: number;
  budgetAtCompletion: string; // money 2dp
  estimateAtCompletion: string; // money 2dp
  estimateToComplete: string; // money 2dp
  varianceAtCompletion: string; // money 2dp
  activities: Array<{
    activityId: string;
    code: string;
    name: string;
    percentComplete: number;
    plannedValue: string;
    earnedValue: string;
    actualCost: string;
  }>;
};

// --- HSE types (Phase 7) -----------------------------------------------

export type HseRecordType = "incident" | "observation";

export type HseRecord = {
  id: string;
  recordNumber: string;
  recordType: HseRecordType;
  categoryCode: string | null;
  severityCode: string | null;
  occurredAt: string;
  reportedAt: string;
  title: string;
  summary: string | null;
  description: string | null;
  immediateAction: string | null;
  organizationUnitId: string | null;
  projectId: string | null;
  siteId: string | null;
  locationDetail: string | null;
  reportedByUserId: string;
  responsibleUserId: string | null;
  responsibleOrgUnitId: string | null;
  workflowInstanceId: string | null;
};

export type HsePersonInvolved = {
  id: string;
  hseRecordId: string;
  employeeId: string | null;
  personName: string | null;
  personRole: string | null;
  createdAt: string;
};

export type HseFollowUp = {
  id: string;
  hseRecordId: string;
  title: string;
  description: string | null;
  assignedToUserId: string | null;
  assignedToOrgUnitId: string | null;
  dueDate: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  createdAt: string;
};

export type HseRecordDetail = {
  record: HseRecord;
  personsInvolved: HsePersonInvolved[];
  followUps: HseFollowUp[];
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type HseRecordQuery = {
  recordType?: string;
  categoryCode?: string;
  severityCode?: string;
  organizationUnitId?: string;
  projectId?: string;
  siteId?: string;
  reportedByUserId?: string;
  responsibleUserId?: string;
  occurredFrom?: string;
  occurredTo?: string;
  search?: string;
};

export type ReportHseRecordBody = {
  recordType: HseRecordType;
  categoryCode?: string | null;
  severityCode?: string | null;
  occurredAt: string;
  title: string;
  summary?: string | null;
  description?: string | null;
  immediateAction?: string | null;
  organizationUnitId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  locationDetail?: string | null;
  responsibleUserId?: string | null;
  responsibleOrgUnitId?: string | null;
};

export type UpdateHseRecordBody = {
  categoryCode?: string | null;
  severityCode?: string | null;
  occurredAt?: string;
  title?: string;
  summary?: string | null;
  description?: string | null;
  immediateAction?: string | null;
  organizationUnitId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  locationDetail?: string | null;
  responsibleUserId?: string | null;
  responsibleOrgUnitId?: string | null;
};

export type AddHsePersonBody = {
  employeeId?: string | null;
  personName?: string | null;
  personRole?: string | null;
};

export type CreateHseFollowUpBody = {
  title: string;
  description?: string | null;
  assignedToUserId?: string | null;
  assignedToOrgUnitId?: string | null;
  dueDate?: string | null;
};

export type CompleteHseFollowUpBody = {
  completionNotes?: string | null;
};

// --- HSE Advanced types (Wave A7) ---------------------------------------

export type RiskAssessmentType = "jsa" | "hira";
export type AuditProgrammeType = "inspection" | "audit";
export type AuditFindingType = "observation" | "nonconformity" | "major_nonconformity";
export type CapaActionType = "corrective" | "preventive";
export type CapaStatus = "open" | "in_progress" | "verification" | "closed" | "cancelled";

export type ContributingFactor = {
  category: string;
  description: string;
  isRootCause: boolean;
};

export type RiskControl = {
  description: string;
  controlType: string | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
};

export type PermitIsolationCondition = {
  conditionType: string;
  description: string;
  verifiedAt: string | null;
};

export type AuditChecklistItem = {
  code: string;
  question: string;
  isMandatory: boolean;
};

export type AuditResult = {
  itemCode: string;
  result: string;
  note: string | null;
};

export type RiskScalePoint = {
  value: number;
  label: string;
};

export type HseInvestigationFramework = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  causeCategories: string[];
  version: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HseInvestigation = {
  id: string;
  hseRecordId: string;
  frameworkId: string;
  frameworkCode: string;
  frameworkVersion: number;
  leadInvestigatorUserId: string | null;
  startedAt: string;
  concludedAt: string | null;
  findings: string | null;
  rootCause: string | null;
  contributingFactors: ContributingFactor[];
  createdAt: string;
  updatedAt: string;
};

export type HseRiskMatrix = {
  id: string;
  code: string;
  name: string;
  likelihoodScale: RiskScalePoint[];
  severityScale: RiskScalePoint[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HseRiskMatrixCell = {
  id: string;
  matrixId: string;
  likelihood: number;
  severity: number;
  bandCode: string;
  score: string;
};

export type HseRiskAssessment = {
  id: string;
  hseRecordId: string | null;
  projectId: string | null;
  assessmentType: RiskAssessmentType;
  title: string;
  taskDescription: string | null;
  matrixId: string;
  likelihood: number;
  severity: number;
  bandCode: string;
  score: string;
  controls: RiskControl[];
  residualLikelihood: number | null;
  residualSeverity: number | null;
  residualBandCode: string | null;
  residualScore: string | null;
  assessedByUserId: string | null;
  assessedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type HsePermit = {
  id: string;
  permitNumber: string;
  permitTypeCode: string;
  title: string;
  description: string | null;
  organizationUnitId: string | null;
  projectId: string | null;
  siteId: string | null;
  locationDetail: string | null;
  validFrom: string;
  validTo: string;
  isolationConditions: PermitIsolationCondition[];
  riskAssessmentId: string | null;
  workflowInstanceId: string | null;
  requestedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Lifecycle state lives in the Workflow Engine, never on the permit row (ADR-0027 §4). */
export type HsePermitDetail = {
  permit: HsePermit;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type HseAuditProgramme = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  programmeType: AuditProgrammeType;
  frequencyDays: number;
  checklist: AuditChecklistItem[];
  organizationUnitId: string | null;
  siteId: string | null;
  ownerUserId: string | null;
  isActive: boolean;
  lastScheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HseAuditOccurrence = {
  id: string;
  programmeId: string;
  scheduledFor: string;
  performedAt: string | null;
  performedByUserId: string | null;
  results: AuditResult[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HseAuditFinding = {
  id: string;
  occurrenceId: string;
  findingType: AuditFindingType;
  checklistItemCode: string | null;
  description: string;
  createdAt: string;
};

export type HseMonitoringPoint = {
  id: string;
  code: string;
  name: string;
  parameterCode: string;
  unit: string;
  /** NUMERIC as text; null means that side is unbounded. */
  thresholdMin: string | null;
  thresholdMax: string | null;
  organizationUnitId: string | null;
  siteId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HseMonitoringReading = {
  id: string;
  pointId: string;
  measuredAt: string;
  /** NUMERIC as text. */
  value: string;
  isBreach: boolean;
  recordedByUserId: string | null;
  note: string | null;
  createdAt: string;
};

export type HseCapa = {
  id: string;
  capaNumber: string;
  title: string;
  description: string | null;
  hseRecordId: string | null;
  investigationId: string | null;
  auditFindingId: string | null;
  monitoringReadingId: string | null;
  coreFollowUpId: string | null;
  rootCause: string | null;
  actionType: CapaActionType;
  status: CapaStatus;
  ownerUserId: string | null;
  dueDate: string | null;
  verificationNotes: string | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HseCapaAction = {
  id: string;
  capaId: string;
  description: string;
  ownerUserId: string | null;
  dueDate: string | null;
  completedAt: string | null;
  completionNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HseCapaDetail = {
  capa: HseCapa;
  actions: HseCapaAction[];
};

export type HseIndicatorSnapshot = {
  id: string;
  organizationUnitId: string | null;
  windowStart: string;
  windowEnd: string;
  exposureHours: string | null;
  nearMissCount: number;
  observationCount: number;
  inspectionCount: number;
  capaOpenedCount: number;
  capaClosedCount: number;
  capaClosureRate: string | null;
  permitCount: number;
  incidentCount: number;
  lostTimeIncidentCount: number;
  lostDays: number;
  incidentFrequencyRate: string | null;
  severityRate: string | null;
  createdAt: string;
};

export type CreateHseFrameworkBody = {
  code: string;
  name: string;
  description?: string | null;
  causeCategories?: string[];
};

export type CreateHseInvestigationBody = {
  frameworkId: string;
  leadInvestigatorUserId?: string | null;
};

export type UpdateHseInvestigationBody = {
  leadInvestigatorUserId?: string | null;
  findings?: string | null;
  rootCause?: string | null;
  contributingFactors?: ContributingFactor[];
  concluded?: boolean;
};

export type CreateHseRiskMatrixBody = {
  code: string;
  name: string;
  likelihoodScale: RiskScalePoint[];
  severityScale: RiskScalePoint[];
  cells: { likelihood: number; severity: number; bandCode: string; score: string }[];
};

export type CreateHseRiskAssessmentBody = {
  hseRecordId?: string | null;
  projectId?: string | null;
  assessmentType: RiskAssessmentType;
  title: string;
  taskDescription?: string | null;
  matrixId?: string;
  likelihood: number;
  severity: number;
  controls?: RiskControl[];
  residualLikelihood?: number | null;
  residualSeverity?: number | null;
};

export type CreateHsePermitBody = {
  permitTypeCode: string;
  title: string;
  description?: string | null;
  organizationUnitId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  locationDetail?: string | null;
  validFrom: string;
  validTo: string;
  isolationConditions?: PermitIsolationCondition[];
  riskAssessmentId?: string | null;
};

export type CreateHseProgrammeBody = {
  code: string;
  name: string;
  description?: string | null;
  programmeType?: AuditProgrammeType;
  frequencyDays: number;
  checklist?: AuditChecklistItem[];
  organizationUnitId?: string | null;
  siteId?: string | null;
  ownerUserId?: string | null;
};

export type CreateHseMonitoringPointBody = {
  code: string;
  name: string;
  parameterCode: string;
  unit: string;
  thresholdMin?: string | null;
  thresholdMax?: string | null;
  organizationUnitId?: string | null;
  siteId?: string | null;
};

export type CreateHseCapaBody = {
  title: string;
  description?: string | null;
  hseRecordId?: string | null;
  investigationId?: string | null;
  auditFindingId?: string | null;
  monitoringReadingId?: string | null;
  coreFollowUpId?: string | null;
  rootCause?: string | null;
  actionType?: CapaActionType;
  ownerUserId?: string | null;
  dueDate?: string | null;
};

export type ComputeHseIndicatorBody = {
  windowStart: string;
  windowEnd: string;
  organizationUnitId?: string | null;
  exposureHours?: string | null;
  lostDays?: number;
  nearMissCategoryCode?: string | null;
  lostTimeSeverityCode?: string | null;
};

// --- Asset types (Phase 5) ---------------------------------------------

export type AssetStatusValue = "in_use" | "idle" | "retired" | "disposed";

export type AssetRecord = {
  id: string;
  assetNumber: string;
  assetTag: string | null;
  name: string;
  description: string | null;
  category: string | null;
  status: AssetStatusValue;
  organizationUnitId: string | null;
  custodianEmployeeId: string | null;
  projectId: string | null;
  siteId: string | null;
  locationDetail: string | null;
  acquisitionReference: string | null;
  acquiredAt: string | null;
  version: number;
  retiredAt: string | null;
};

export type CustodianReference = {
  id: string;
  employeeNumber: string;
  fullName: string;
};

export type AssetMovementRecord = {
  id: string;
  assetId: string;
  sequence: number | null;
  movementType: "transfer" | "status_change";
  reason: string | null;
  effectiveDate: string | null;
  fromOrganizationUnitId: string | null;
  fromCustodianEmployeeId: string | null;
  fromProjectId: string | null;
  fromSiteId: string | null;
  fromLocationDetail: string | null;
  fromStatus: AssetStatusValue | null;
  toOrganizationUnitId: string | null;
  toCustodianEmployeeId: string | null;
  toProjectId: string | null;
  toSiteId: string | null;
  toLocationDetail: string | null;
  toStatus: AssetStatusValue | null;
  workflowInstanceId: string | null;
  appliedAt: string | null;
  createdAt: string;
};

export type AssetMovementView = {
  movement: AssetMovementRecord;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type AssetDetail = {
  asset: AssetRecord;
  custodian: CustodianReference | null;
  movements: AssetMovementRecord[];
  pendingMovement: AssetMovementView | null;
};

export type AssetListResult = {
  assets: AssetRecord[];
  custodians: CustodianReference[];
};

export type AssetQuery = {
  search?: string;
  category?: string;
  status?: string;
  organizationUnitId?: string;
  siteId?: string;
  custodianEmployeeId?: string;
  includeTerminal?: boolean;
};

// --- Wave A3 Asset Advanced types ---------------------------------------

export type MaintenanceFrequencyType = "calendar" | "meter";
export type MeterReadingType = "hours" | "km" | "cycles";
export type MaintenanceType = "preventive" | "corrective" | "emergency";
export type MaintenancePriority = "low" | "medium" | "high" | "critical";
export type DowntimeReasonCategory =
  | "breakdown"
  | "scheduled_maintenance"
  | "power_failure"
  | "operator_error"
  | "other";

export type AssetMaintenanceSchedule = {
  id: string;
  tenantId: string;
  assetId: string;
  scheduleCode: string;
  title: string;
  description: string | null;
  frequencyType: MaintenanceFrequencyType;
  intervalDays: number | null;
  meterInterval: number | null;
  meterType: MeterReadingType | null;
  lastPerformedAt: string | null;
  lastMeterReading: number | null;
  nextDueDate: string | null;
  nextDueMeter: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
};

export type CreateAssetMaintenanceScheduleBody = {
  assetId: string;
  scheduleCode: string;
  title: string;
  description?: string | null;
  frequencyType: MaintenanceFrequencyType;
  intervalDays?: number | null;
  meterInterval?: number | null;
  meterType?: MeterReadingType | null;
  nextDueDate?: string | null;
  nextDueMeter?: number | null;
};

export type AssetMaintenanceWorkOrder = {
  id: string;
  tenantId: string;
  orderNumber: string;
  assetId: string;
  scheduleId: string | null;
  maintenanceType: MaintenanceType;
  priority: MaintenancePriority;
  title: string;
  description: string | null;
  assignedToUserId: string | null;
  assignedAt: string | null;
  assignedByUserId: string | null;
  startedAt: string | null;
  startedByUserId: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  verificationNotes: string | null;
  downtimeHours: number;
  costEstimate: number | null;
  actualCost: number | null;
  workflowInstanceId: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  deletedAt: string | null;
};

export type AssetMaintenanceWorkOrderRow = {
  workOrder: AssetMaintenanceWorkOrder;
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
};

export type AssetMaintenanceWorkOrderQuery = {
  assetId?: string;
  maintenanceType?: MaintenanceType;
  assignedToUserId?: string;
};

export type CreateAssetMaintenanceWorkOrderBody = {
  assetId: string;
  scheduleId?: string | null;
  maintenanceType: MaintenanceType;
  priority?: MaintenancePriority;
  title: string;
  description?: string | null;
  costEstimate?: number | null;
};

export type AssetMaintenancePart = {
  id: string;
  tenantId: string;
  maintenanceWorkOrderId: string;
  itemId: string;
  quantity: number;
  unitCost: number | null;
  notes: string | null;
  recordedAt: string;
  recordedByUserId: string | null;
};

export type AssetMaintenanceWorkOrderDetail = {
  workOrder: AssetMaintenanceWorkOrder;
  schedule: AssetMaintenanceSchedule | null;
  parts: AssetMaintenancePart[];
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type CompleteAssetMaintenanceWorkOrderBody = {
  completionNotes?: string | null;
  actualCost?: number | null;
  downtimeHours?: number | null;
  currentMeterReading?: number | null;
};

export type RecordAssetMaintenancePartBody = {
  itemId: string;
  quantity: number;
  unitCost?: number | null;
  notes?: string | null;
};

export type AssetMeterReading = {
  id: string;
  tenantId: string;
  assetId: string;
  readingType: MeterReadingType;
  readingValue: number;
  readingDate: string;
  recordedByUserId: string | null;
  notes: string | null;
  createdAt: string;
};

export type RecordAssetMeterReadingBody = {
  readingType: MeterReadingType;
  readingValue: number;
  readingDate?: string | null;
  notes?: string | null;
};

export type AssetDowntimeRecord = {
  id: string;
  tenantId: string;
  assetId: string;
  maintenanceWorkOrderId: string | null;
  startTime: string;
  endTime: string | null;
  durationMinutes: number | null;
  reasonCategory: DowntimeReasonCategory;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type RecordAssetDowntimeBody = {
  maintenanceWorkOrderId?: string | null;
  startTime: string;
  endTime?: string | null;
  reasonCategory: DowntimeReasonCategory;
  notes?: string | null;
};

export type ReliabilityMetrics = {
  periodStart: string;
  periodEnd: string;
  elapsedHours: number;
  downtimeHours: number;
  operationalHours: number;
  correctiveFailureCount: number;
  mtbfHours: number;
  mttrHours: number;
  availabilityPct: number;
};

export type AssetPredictiveSnapshot = {
  id: string;
  tenantId: string;
  assetId: string;
  analysisDate: string;
  mtbfHours: number | null;
  mttrHours: number | null;
  availabilityPct: number | null;
  healthScore: number;
  predictedFailureDate: string | null;
  confidencePct: number | null;
  recommendation: string | null;
  algorithmVersion: string;
  createdAt: string;
  createdBy: string | null;
};

export type CreateAssetBody = {
  name: string;
  assetTag?: string | null;
  description?: string | null;
  category?: string | null;
  status?: AssetStatusValue;
  organizationUnitId?: string | null;
  custodianEmployeeId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  locationDetail?: string | null;
  acquisitionReference?: string | null;
  acquiredAt?: string | null;
};

export type UpdateAssetBody = {
  assetTag?: string | null;
  name?: string;
  description?: string | null;
  category?: string | null;
  acquisitionReference?: string | null;
  acquiredAt?: string | null;
};

export type MoveAssetBody = {
  organizationUnitId?: string | null;
  custodianEmployeeId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  locationDetail?: string | null;
  reason?: string | null;
  effectiveDate?: string | null;
};

export type SiteRecord = {
  id: string;
  customerId: string;
  projectId: string | null;
  code: string;
  name: string;
  address: string | null;
  status: string;
};

export type ProjectRecord = {
  id: string;
  customerId: string;
  contractId: string | null;
  code: string;
  name: string;
  status: string;
};

// --- Supply Chain types (Phase 4) --------------------------------------

export type ScmItem = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  unitOfMeasure: string;
  isActive: boolean;
};

export type SupplierRecord = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
};

export type StockBalanceRecord = {
  id: string;
  itemId: string;
  siteId: string | null;
  quantity: number;
  updatedAt: string;
};

export type StockMovementRecord = {
  id: string;
  itemId: string;
  siteId: string | null;
  movementType: "in" | "out";
  quantity: number;
  reference: string | null;
  note: string | null;
  purchaseOrderId: string | null;
  occurredAt: string;
};

export type StockMovementResult = {
  movement: StockMovementRecord;
  balance: StockBalanceRecord;
  line?: PurchaseOrderLineRecord;
};

export type PurchaseRequestRecord = {
  id: string;
  requestNumber: string;
  organizationUnitId: string | null;
  justification: string;
  requiredDate: string | null;
  workflowInstanceId: string | null;
  convertedPurchaseOrderId: string | null;
};

export type PurchaseRequestLineRecord = {
  id: string;
  itemId: string;
  quantity: number;
  note: string | null;
};

export type PurchaseRequestDetail = {
  request: PurchaseRequestRecord;
  lines: PurchaseRequestLineRecord[];
  status: { stepCode: string | null; stepName: string | null; instanceStatus: string } | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type PurchaseOrderRecord = {
  id: string;
  orderNumber: string;
  supplierId: string;
  purchaseRequestId: string | null;
  currency: string | null;
  expectedDate: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
};

export type PurchaseOrderLineRecord = {
  id: string;
  itemId: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitPrice: number | null;
};

export type PurchaseOrderDetail = {
  order: PurchaseOrderRecord;
  lines: PurchaseOrderLineRecord[];
  supplier: SupplierRecord | null;
  state: string;
};

// --- Wave A5 Supply Chain Advanced types (SCM-ADV-001…008) -------------

export type ScmSerialStatus =
  | "in_stock"
  | "reserved"
  | "issued"
  | "in_transit"
  | "disposed"
  | "maintenance";

export type ScmAdvancedStockMovementType =
  | "in"
  | "out"
  | "transfer_in"
  | "transfer_out"
  | "adjustment_in"
  | "adjustment_out"
  | "opname_in"
  | "opname_out";

export type ScmReservationStatus = "active" | "fulfilled" | "cancelled" | "expired";
export type ScmTransferStatus = "draft" | "approved" | "in_transit" | "received" | "cancelled";
export type ScmOpnameStatus = "draft" | "in_progress" | "completed" | "approved" | "adjusted" | "cancelled";
export type ScmProcurementType = "rfq" | "tender" | "direct_sourcing";
export type ScmRfqStatus = "draft" | "published" | "in_evaluation" | "awarded" | "cancelled" | "closed";
export type ScmSupplierBidStatus = "submitted" | "evaluated" | "shortlisted" | "awarded" | "rejected";
export type ScmSupplierEvaluationStatus = "draft" | "submitted" | "approved" | "rejected";
export type ScmSupplierRatingGrade = "A" | "B" | "C" | "D" | "E";
export type ScmSupplierContractType = "blanket_po" | "fixed_price" | "service_rate" | "consignment";
export type ScmSupplierContractStatus = "draft" | "pending_approval" | "active" | "expired" | "terminated" | "closed";
export type ScmLandedCostStatus = "draft" | "applied" | "cancelled";
export type ScmLandedCostAllocationMethod = "by_value" | "by_quantity" | "by_weight" | "equal";
export type ScmSpendAnalyticsPeriodType = "monthly" | "quarterly" | "yearly";

export type ScmWorkflowStatus = {
  stepCode: string | null;
  stepName: string | null;
  instanceStatus: "in_progress" | "approved" | "rejected" | "cancelled";
  sla: { dueAt: string | null; slaHours: number | null } | null;
  assignment: { roleCode: string | null; userId: string | null; isMine: boolean } | null;
};

export type ScmWarehouse = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  siteId: string | null;
  organizationUnitId: string | null;
  address: string | null;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type CreateScmWarehouseBody = {
  code: string;
  name: string;
  siteId?: string | null;
  organizationUnitId?: string | null;
  address?: string | null;
  isActive?: boolean;
};

export type UpdateScmWarehouseBody = {
  name?: string;
  siteId?: string | null;
  organizationUnitId?: string | null;
  address?: string | null;
  isActive?: boolean;
};

export type ScmWarehouseLocation = {
  id: string;
  tenantId: string;
  warehouseId: string;
  code: string;
  zone: string | null;
  aisle: string | null;
  rack: string | null;
  shelf: string | null;
  bin: string | null;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type CreateScmWarehouseLocationBody = {
  warehouseId: string;
  code: string;
  zone?: string | null;
  aisle?: string | null;
  rack?: string | null;
  shelf?: string | null;
  bin?: string | null;
  isActive?: boolean;
};

export type UpdateScmWarehouseLocationBody = {
  zone?: string | null;
  aisle?: string | null;
  rack?: string | null;
  shelf?: string | null;
  bin?: string | null;
  isActive?: boolean;
};

export type ScmItemBatch = {
  id: string;
  tenantId: string;
  itemId: string;
  batchNumber: string;
  manufacturedDate: string | null;
  expiryDate: string | null;
  supplierId: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type CreateScmItemBatchBody = {
  itemId: string;
  batchNumber?: string;
  manufacturedDate?: string | null;
  expiryDate?: string | null;
  supplierId?: string | null;
  notes?: string | null;
  isActive?: boolean;
};

export type ScmItemSerial = {
  id: string;
  tenantId: string;
  itemId: string;
  serialNumber: string;
  batchId: string | null;
  warehouseId: string | null;
  locationId: string | null;
  status: ScmSerialStatus;
  warrantyExpiryDate: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type CreateScmItemSerialBody = {
  itemId: string;
  serialNumber: string;
  batchId?: string | null;
  warehouseId?: string | null;
  locationId?: string | null;
  status?: ScmSerialStatus;
  warrantyExpiryDate?: string | null;
  notes?: string | null;
};

export type UpdateScmItemSerialBody = {
  batchId?: string | null;
  warehouseId?: string | null;
  locationId?: string | null;
  status?: ScmSerialStatus;
  warrantyExpiryDate?: string | null;
  notes?: string | null;
};

export type ScmAdvancedStockBalance = {
  id: string;
  tenantId: string;
  itemId: string;
  warehouseId: string;
  locationId: string | null;
  batchId: string | null;
  quantity: number;
  reservedQty: number;
  availableQuantity: number;
  updatedAt: string;
};

export type ScmAdvancedStockMovement = {
  id: string;
  tenantId: string;
  itemId: string;
  warehouseId: string;
  locationId: string | null;
  batchId: string | null;
  serialId: string | null;
  movementType: ScmAdvancedStockMovementType;
  quantity: number;
  unitCost: number | null;
  totalCost: number | null;
  referenceType: string | null;
  referenceId: string | null;
  referenceNumber: string | null;
  notes: string | null;
  occurredAt: string;
  createdBy: string | null;
  createdAt: string;
};

export type RecordScmAdvancedStockMovementBody = {
  itemId: string;
  warehouseId: string;
  locationId?: string | null;
  batchId?: string | null;
  serialId?: string | null;
  movementType: ScmAdvancedStockMovementType;
  quantity: number;
  unitCost?: number;
  totalCost?: number;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  occurredAt?: string;
};

export type ScmReorderPolicy = {
  id: string;
  tenantId: string;
  itemId: string;
  warehouseId: string | null;
  minQuantity: number;
  reorderPoint: number;
  reorderQuantity: number;
  safetyStock: number;
  leadTimeDays: number;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type UpsertScmReorderPolicyBody = {
  itemId: string;
  warehouseId?: string | null;
  minQuantity: number;
  reorderPoint: number;
  reorderQuantity: number;
  safetyStock?: number;
  leadTimeDays?: number;
  isActive?: boolean;
};

export type ScmReorderAlert = {
  itemId: string;
  warehouseId: string | null;
  currentBalance: number;
  reorderPoint: number;
  reorderQuantity: number;
  minQuantity: number;
  suggestedReorderQuantity: number;
};

export type ScmStockReservation = {
  id: string;
  tenantId: string;
  reservationNumber: string;
  itemId: string;
  warehouseId: string;
  locationId: string | null;
  batchId: string | null;
  quantity: number;
  reservedForType: string;
  reservedForId: string | null;
  reservedForNumber: string | null;
  status: ScmReservationStatus;
  validUntil: string | null;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type CreateScmStockReservationBody = {
  reservationNumber: string;
  itemId: string;
  warehouseId: string;
  locationId?: string | null;
  batchId?: string | null;
  quantity: number;
  reservedForType: string;
  reservedForId?: string | null;
  reservedForNumber?: string | null;
  validUntil?: string | null;
  notes?: string | null;
};

export type ScmStockTransferLine = {
  id: string;
  tenantId: string;
  transferId: string;
  itemId: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  batchId: string | null;
  quantityRequested: number;
  quantityShipped: number;
  quantityReceived: number;
  notes: string | null;
  sortOrder: number;
};

export type ScmStockTransfer = {
  id: string;
  tenantId: string;
  transferNumber: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: ScmTransferStatus;
  shippedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  workflowInstanceId: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ScmStockTransferDetail = {
  transfer: ScmStockTransfer;
  lines: ScmStockTransferLine[];
  status: ScmWorkflowStatus | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type CreateScmStockTransferBody = {
  transferNumber?: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  notes?: string | null;
  lines: {
    itemId: string;
    quantityRequested: number;
    batchId?: string | null;
    fromLocationId?: string | null;
    toLocationId?: string | null;
    notes?: string | null;
    sortOrder?: number;
  }[];
};

export type RecordScmStockTransferShipmentBody = {
  transferId: string;
  lineShipments: { lineId: string; quantityShipped: number }[];
};

export type RecordScmStockTransferReceiptBody = {
  transferId: string;
  lineReceipts: { lineId: string; quantityReceived: number }[];
};

export type ScmStockOpnameLine = {
  id: string;
  tenantId: string;
  opnameId: string;
  itemId: string;
  locationId: string | null;
  batchId: string | null;
  systemQuantity: number;
  physicalQuantity: number | null;
  varianceQuantity: number | null;
  adjustmentMovementId: string | null;
  notes: string | null;
  sortOrder: number;
};

export type ScmStockOpname = {
  id: string;
  tenantId: string;
  opnameNumber: string;
  warehouseId: string;
  opnameDate: string;
  status: ScmOpnameStatus;
  workflowInstanceId: string | null;
  completedAt: string | null;
  completedBy: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ScmStockOpnameDetail = {
  opname: ScmStockOpname;
  lines: ScmStockOpnameLine[];
  status: ScmWorkflowStatus | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type CreateScmStockOpnameBody = {
  warehouseId: string;
  opnameDate: string;
  opnameNumber?: string;
  notes?: string | null;
  lines: {
    itemId: string;
    locationId?: string | null;
    batchId?: string | null;
    systemQuantity: number;
    physicalQuantity?: number | null;
    notes?: string | null;
    sortOrder?: number;
  }[];
};

export type RecordScmStockOpnameCountBody = {
  lineId: string;
  physicalQuantity: number;
};

// --- Receiving, Inspection & Returns (Wave A6 GAP #9) -------------------
//
// The receiving chain is one document series: a receipt books the goods, an
// inspection releases them out of quality hold, a discrepancy records a
// complaint, and a return ships goods back. `paymentEligible` is not a stored
// column — it is `quantityAccepted - quantityReturned - quantityReversed`,
// the same expression the payment batch re-checks at transaction time.

export type ScmStockCondition =
  | "unrestricted"
  | "quality_hold"
  | "rejected"
  | "quarantined"
  | "blocked"
  | "in_transit"
  | "in_repair";

export type ScmStockOwnerType = "own" | "supplier" | "customer";

export type ScmReceivingStatus =
  | "received"
  | "partially_inspected"
  | "accepted"
  | "rejected"
  | "reversed";

export type ScmInspectionResult = "accepted" | "rejected" | "mixed" | "quarantined";

export type ScmDiscrepancyType = "shortage" | "overage" | "damage" | "quality" | "document";
export type ScmDiscrepancyStatus = "open" | "resolved" | "cancelled";
export type ScmReturnToVendorStatus = "executed" | "cancelled";

export type ScmAccountAssignmentType =
  | "stock"
  | "expense"
  | "asset"
  | "project"
  | "work_order"
  | "service";

export type ScmReceivingRecord = {
  id: string;
  tenantId: string;
  receiptNumber: string;
  idempotencyKey: string;
  purchaseOrderId: string;
  supplierId: string;
  warehouseId: string;
  locationId: string | null;
  receivedAt: string;
  receivedBy: string | null;
  status: ScmReceivingStatus;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type ScmReceivingLine = {
  id: string;
  tenantId: string;
  receivingRecordId: string;
  purchaseOrderLineId: string;
  itemId: string;
  warehouseId: string;
  locationId: string | null;
  batchId: string | null;
  stockCondition: ScmStockCondition;
  ownerType: ScmStockOwnerType;
  ownerPartyId: string | null;
  quantityReceived: number;
  quantityAccepted: number;
  quantityRejected: number;
  quantityQuarantined: number;
  quantityReturned: number;
  quantityReversed: number;
  unitCost: number | null;
  currency: string;
  accountAssignmentType: ScmAccountAssignmentType;
  inspectionRequired: boolean;
  notes: string | null;
  sortOrder: number;
};

export type ScmReceivingRecordDetail = {
  receiving: ScmReceivingRecord;
  lines: ScmReceivingLine[];
};

export type CreateScmReceivingRecordBody = {
  idempotencyKey: string;
  purchaseOrderId: string;
  supplierId: string;
  warehouseId: string;
  locationId?: string | null;
  receiptNumber?: string;
  notes?: string | null;
  lines: {
    purchaseOrderLineId: string;
    itemId: string;
    warehouseId?: string | null;
    locationId?: string | null;
    quantityReceived: number;
    unitCost?: number | null;
    currency?: string;
    accountAssignmentType: ScmAccountAssignmentType;
    inspectionRequired?: boolean;
    notes?: string | null;
    sortOrder?: number;
  }[];
};

export type ScmInspection = {
  id: string;
  tenantId: string;
  receivingLineId: string;
  inspectionNumber: string;
  idempotencyKey: string;
  inspectedAt: string;
  inspectedBy: string | null;
  quantityAccepted: number;
  quantityRejected: number;
  quantityQuarantined: number;
  result: ScmInspectionResult;
  reason: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type CreateScmInspectionBody = {
  receivingLineId: string;
  idempotencyKey: string;
  inspectionNumber?: string;
  quantityAccepted?: number;
  quantityRejected?: number;
  quantityQuarantined?: number;
  result: ScmInspectionResult;
  reason?: string | null;
};

export type ScmDiscrepancyRecord = {
  id: string;
  tenantId: string;
  receivingLineId: string;
  discrepancyType: ScmDiscrepancyType;
  quantity: number | null;
  description: string;
  status: ScmDiscrepancyStatus;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type CreateScmDiscrepancyBody = {
  receivingLineId: string;
  discrepancyType: ScmDiscrepancyType;
  quantity?: number | null;
  description: string;
};

export type ScmReturnToVendor = {
  id: string;
  tenantId: string;
  returnNumber: string;
  idempotencyKey: string;
  supplierId: string;
  purchaseOrderId: string | null;
  warehouseId: string;
  returnedAt: string;
  returnedBy: string | null;
  reason: string;
  status: ScmReturnToVendorStatus;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type ScmReturnToVendorLine = {
  id: string;
  tenantId: string;
  returnToVendorId: string;
  receivingLineId: string | null;
  itemId: string;
  warehouseId: string;
  locationId: string | null;
  batchId: string | null;
  stockCondition: ScmStockCondition;
  ownerType: ScmStockOwnerType;
  ownerPartyId: string | null;
  quantity: number;
  movementId: string | null;
  notes: string | null;
  sortOrder: number;
};

export type ScmReturnToVendorDetail = {
  returnToVendor: ScmReturnToVendor;
  lines: ScmReturnToVendorLine[];
};

export type CreateScmReturnToVendorBody = {
  idempotencyKey: string;
  supplierId: string;
  purchaseOrderId?: string | null;
  warehouseId: string;
  reason: string;
  notes?: string | null;
  lines: {
    receivingLineId?: string | null;
    itemId: string;
    warehouseId: string;
    locationId?: string | null;
    batchId?: string | null;
    stockCondition: ScmStockCondition;
    ownerType: ScmStockOwnerType;
    quantity: number;
    notes?: string | null;
    sortOrder?: number;
  }[];
};

export type ScmValuationLayer = {
  id: string;
  tenantId: string;
  itemId: string;
  warehouseId: string | null;
  receiptMovementId: string | null;
  receivedDate: string;
  originalQuantity: number;
  remainingQuantity: number;
  unitCost: number;
  landedCostAdded: number;
  effectiveUnitCost: number;
  totalValue: number;
  createdAt: string;
};

export type CreateScmValuationLayerBody = {
  itemId: string;
  warehouseId?: string | null;
  receiptMovementId?: string | null;
  receivedDate: string;
  originalQuantity: number;
  remainingQuantity: number;
  unitCost: number;
  landedCostAdded?: number;
  effectiveUnitCost: number;
  totalValue: number;
};

export type ScmLandedCostAllocation = {
  id: string;
  tenantId: string;
  landedCostId: string;
  itemId: string;
  valuationLayerId: string | null;
  allocatedAmount: number;
  costPerUnitAdded: number;
};

export type ScmLandedCost = {
  id: string;
  tenantId: string;
  voucherNumber: string;
  purchaseOrderId: string;
  costType: string;
  currency: string;
  amount: number;
  allocationMethod: ScmLandedCostAllocationMethod;
  status: ScmLandedCostStatus;
  appliedAt: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ScmLandedCostDetail = {
  landedCost: ScmLandedCost;
  allocations: ScmLandedCostAllocation[];
};

export type CreateScmLandedCostBody = {
  purchaseOrderId: string;
  costType: string;
  currency?: string;
  amount: number;
  allocationMethod: ScmLandedCostAllocationMethod;
  voucherNumber?: string;
  notes?: string | null;
  allocations: {
    itemId: string;
    valuationLayerId?: string | null;
    allocatedAmount: number;
    costPerUnitAdded: number;
  }[];
};

export type ScmRfqItem = {
  id: string;
  tenantId: string;
  rfqId: string;
  itemId: string;
  targetQuantity: number;
  targetUnitPrice: number | null;
  specifications: string | null;
  sortOrder: number;
};

export type ScmRfqInvitedSupplier = {
  id: string;
  tenantId: string;
  rfqId: string;
  supplierId: string;
  invitedAt: string;
  respondedAt: string | null;
};

export type ScmSupplierBidLine = {
  id: string;
  tenantId: string;
  bidId: string;
  rfqItemId: string;
  offeredQuantity: number;
  offeredUnitPrice: number;
  offeredTotalPrice: number;
  remarks: string | null;
};

export type ScmSupplierBid = {
  id: string;
  tenantId: string;
  bidNumber: string;
  rfqId: string;
  supplierId: string;
  submittedAt: string;
  currency: string;
  totalAmount: number;
  leadTimeDays: number;
  validUntil: string | null;
  status: ScmSupplierBidStatus;
  technicalScore: number | null;
  commercialScore: number | null;
  finalScore: number | null;
  rank: number | null;
  isWinningBid: boolean;
  resultingPurchaseOrderId: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ScmSupplierBidDetail = {
  bid: ScmSupplierBid;
  lines: ScmSupplierBidLine[];
};

export type ScmRfq = {
  id: string;
  tenantId: string;
  rfqNumber: string;
  title: string;
  procurementType: ScmProcurementType;
  organizationUnitId: string | null;
  purchaseRequestId: string | null;
  submissionDeadline: string;
  status: ScmRfqStatus;
  workflowInstanceId: string | null;
  awardedAt: string | null;
  cancelledAt: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ScmRfqDetail = {
  rfq: ScmRfq;
  items: ScmRfqItem[];
  invitedSuppliers: ScmRfqInvitedSupplier[];
  bids: ScmSupplierBid[];
  status: ScmWorkflowStatus | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type CreateScmRfqBody = {
  title: string;
  procurementType: ScmProcurementType;
  organizationUnitId?: string | null;
  purchaseRequestId?: string | null;
  submissionDeadline: string;
  rfqNumber?: string;
  notes?: string | null;
  items: {
    itemId: string;
    targetQuantity: number;
    targetUnitPrice?: number | null;
    specifications?: string | null;
    sortOrder?: number;
  }[];
  invitedSuppliers?: {
    supplierId: string;
    respondedAt?: string | null;
  }[];
};

export type SubmitScmSupplierBidBody = {
  rfqId: string;
  supplierId: string;
  currency?: string;
  totalAmount?: number;
  bidNumber?: string;
  validUntil?: string | null;
  leadTimeDays?: number;
  notes?: string | null;
  lines: {
    rfqItemId: string;
    offeredQuantity: number;
    offeredUnitPrice: number;
    offeredTotalPrice: number;
    remarks?: string | null;
  }[];
};

export type ScoreScmSupplierBidBody = {
  commercialScore?: number | null;
  technicalScore?: number | null;
  rank?: number | null;
  status?: ScmSupplierBidStatus;
};

export type ScmSupplierEvaluation = {
  id: string;
  tenantId: string;
  evaluationNumber: string;
  supplierId: string;
  evaluationPeriod: string;
  periodStartDate: string;
  periodEndDate: string;
  qualityScore: number;
  deliveryScore: number;
  pricingScore: number;
  serviceScore: number;
  overallScore: number;
  ratingGrade: ScmSupplierRatingGrade;
  status: ScmSupplierEvaluationStatus;
  workflowInstanceId: string | null;
  notes: string | null;
  evaluatedBy: string | null;
  evaluatedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ScmSupplierEvaluationDetail = {
  evaluation: ScmSupplierEvaluation;
  status: ScmWorkflowStatus | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type CreateScmSupplierEvaluationBody = {
  supplierId: string;
  evaluationPeriod: string;
  periodStartDate: string;
  periodEndDate: string;
  qualityScore?: number;
  deliveryScore?: number;
  pricingScore?: number;
  serviceScore?: number;
  evaluationNumber?: string;
  notes?: string | null;
};

export type ScmSupplierContractItem = {
  id: string;
  tenantId: string;
  contractId: string;
  itemId: string;
  agreedUnitPrice: number;
  minOrderQuantity: number;
  maxOrderQuantity: number | null;
  leadTimeDays: number;
  notes: string | null;
};

export type ScmSupplierContract = {
  id: string;
  tenantId: string;
  contractNumber: string;
  supplierId: string;
  title: string;
  contractType: ScmSupplierContractType;
  startDate: string;
  endDate: string;
  currency: string;
  committedAmount: number;
  spentAmount: number;
  status: ScmSupplierContractStatus;
  workflowInstanceId: string | null;
  termsAndConditions: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

export type ScmSupplierContractDetail = {
  contract: ScmSupplierContract;
  items: ScmSupplierContractItem[];
  status: ScmWorkflowStatus | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type CreateScmSupplierContractBody = {
  supplierId: string;
  title: string;
  contractType: ScmSupplierContractType;
  startDate: string;
  endDate: string;
  currency?: string;
  committedAmount?: number;
  termsAndConditions?: string | null;
  contractNumber?: string;
  items: {
    itemId: string;
    agreedUnitPrice: number;
    minOrderQuantity?: number;
    maxOrderQuantity?: number | null;
    leadTimeDays?: number;
    notes?: string | null;
  }[];
};

export type ScmSpendAnalyticsSnapshot = {
  id: string;
  tenantId: string;
  snapshotDate: string;
  periodType: ScmSpendAnalyticsPeriodType;
  periodKey: string;
  organizationUnitId: string | null;
  supplierId: string | null;
  itemCategory: string | null;
  totalSpend: number;
  poCount: number;
  itemsPurchasedCount: number;
  avgPoValue: number;
  createdAt: string;
  createdBy: string | null;
};

export type ComputeScmSpendSnapshotBody = {
  periodType: ScmSpendAnalyticsPeriodType;
  periodStart: string;
  periodEnd: string;
  organizationUnitId?: string;
};

// --- Wave A4 Workforce Advanced types ----------------------------------

export type WorkforceWorkflowStatus = {
  stepCode: string | null;
  stepName: string | null;
  instanceStatus: "in_progress" | "approved" | "rejected" | "cancelled";
  sla: { dueAt: string | null; slaHours: number | null } | null;
  assignment: { roleCode: string | null; userId: string | null; isMine: boolean } | null;
};

export type WorkforceShift = {
  id: string; tenantId: string; shiftCode: string; name: string; startTime: string; endTime: string;
  breakMinutes: number; isOvernight: boolean; isActive: boolean; createdAt: string; createdBy: string | null;
  updatedAt: string; updatedBy: string | null;
};
export type CreateWorkforceShiftBody = {
  shiftCode: string; name: string; startTime: string; endTime: string; breakMinutes?: number; isOvernight?: boolean;
};
export type WorkforceRoster = {
  id: string; tenantId: string; employeeId: string; shiftId: string; rosterDate: string;
  organizationUnitId: string | null; notes: string | null; createdAt: string; createdBy: string | null;
  updatedAt: string; updatedBy: string | null;
};
export type WorkforceRosterQuery = { employeeId?: string; organizationUnitId?: string; fromDate?: string; toDate?: string };
export type UpsertWorkforceRosterBody = {
  employeeId: string; shiftId: string; rosterDate: string; organizationUnitId?: string | null; notes?: string | null;
};
export type WorkforceAttendanceStatus = "present" | "late" | "absent" | "leave" | "holiday" | "day_off";
export type WorkforceAttendanceSource = "manual" | "self_service" | "import" | "device";
export type WorkforceAttendanceRecord = {
  id: string; tenantId: string; employeeId: string; attendanceDate: string; shiftId: string | null;
  clockIn: string | null; clockOut: string | null; workedMinutes: number | null; lateMinutes: number;
  earlyOutMinutes: number; status: WorkforceAttendanceStatus; source: WorkforceAttendanceSource;
  notes: string | null; createdAt: string; updatedAt: string;
};
export type WorkforceAttendanceQuery = { employeeId?: string; fromDate?: string; toDate?: string; status?: WorkforceAttendanceStatus };
export type RecordWorkforceAttendanceBody = {
  employeeId: string; attendanceDate: string; shiftId?: string | null; clockIn?: string | null; clockOut?: string | null;
  status?: WorkforceAttendanceStatus; source?: WorkforceAttendanceSource; notes?: string | null;
};

export type WorkforceLeaveType = {
  id: string; tenantId: string; code: string; name: string; annualAllowanceDays: number; isPaid: boolean;
  requiresAttachment: boolean; isActive: boolean; createdAt: string; updatedAt: string;
};
export type CreateWorkforceLeaveTypeBody = { code: string; name: string; annualAllowanceDays?: number; isPaid?: boolean; requiresAttachment?: boolean };
export type WorkforceLeaveBalance = {
  id: string; tenantId: string; employeeId: string; leaveTypeId: string; balanceYear: number;
  allocatedDays: number; usedDays: number; pendingDays: number; createdAt: string; updatedAt: string;
};
export type SetWorkforceLeaveAllocationBody = { employeeId: string; leaveTypeId: string; balanceYear: number; allocatedDays: number };
export type WorkforceLeaveRequest = {
  id: string; tenantId: string; requestNumber: string; employeeId: string; leaveTypeId: string; startDate: string;
  endDate: string; totalDays: number; reason: string | null; attachmentDocumentId: string | null;
  workflowInstanceId: string | null; submittedAt: string; approvedAt: string | null; rejectedAt: string | null; cancelledAt: string | null;
};
export type WorkforceLeaveRequestRow = { leaveRequest: WorkforceLeaveRequest; status: WorkforceWorkflowStatus | null };
export type WorkforceLeaveRequestQuery = { employeeId?: string; leaveTypeId?: string; fromDate?: string; toDate?: string };
export type CreateWorkforceLeaveRequestBody = {
  employeeId: string; leaveTypeId: string; startDate: string; endDate: string; totalDays: number;
  reason?: string | null; attachmentDocumentId?: string | null;
};
export type WorkforceOvertimeRequest = {
  id: string; tenantId: string; requestNumber: string; employeeId: string; overtimeDate: string; startTime: string;
  endTime: string; estimatedHours: number; actualHours: number | null; reason: string | null; workflowInstanceId: string | null;
  submittedAt: string; approvedAt: string | null; rejectedAt: string | null; cancelledAt: string | null;
};
export type WorkforceOvertimeRequestRow = { overtimeRequest: WorkforceOvertimeRequest; status: WorkforceWorkflowStatus | null };
export type WorkforceOvertimeRequestQuery = { employeeId?: string; fromDate?: string; toDate?: string };
export type CreateWorkforceOvertimeRequestBody = {
  employeeId: string; overtimeDate: string; startTime: string; endTime: string; estimatedHours: number; reason?: string | null;
};

export type WorkforcePphBracket = { upTo: number | null; rate: number };
export type WorkforcePphTerBracket = { category: "A" | "B" | "C"; upTo: number | null; rate: number };
export type WorkforceStatutoryPolicy = {
  id: string; tenantId: string; policyCode: string; name: string; countryCode: string; effectiveFrom: string; effectiveTo: string | null;
  bpjsKesehatanRateEmployer: number; bpjsKesehatanRateEmployee: number; bpjsKesehatanCap: number | null;
  bpjsTkJhtRateEmployer: number; bpjsTkJhtRateEmployee: number; bpjsTkJkkRate: number; bpjsTkJkmRate: number;
  bpjsTkJpRateEmployer: number; bpjsTkJpRateEmployee: number; bpjsTkJpCap: number | null; occupationalCostRate: number;
  occupationalCostMonthlyCap: number | null; ptkpAnnualAmounts: Record<string, number>; pph21Brackets: WorkforcePphBracket[];
  pph21TerBrackets: WorkforcePphTerBracket[]; pph21Method: "annualized" | "ter"; nonNpwpSurchargeRate: number;
  roundingMode: "half_up" | "down" | "up"; isActive: boolean;
};
export type CreateWorkforceStatutoryPolicyBody = Omit<WorkforceStatutoryPolicy, "id" | "tenantId" | "isActive" | "countryCode" | "effectiveTo" | "bpjsKesehatanRateEmployer" | "bpjsKesehatanRateEmployee" | "bpjsKesehatanCap" | "bpjsTkJhtRateEmployer" | "bpjsTkJhtRateEmployee" | "bpjsTkJkkRate" | "bpjsTkJkmRate" | "bpjsTkJpRateEmployer" | "bpjsTkJpRateEmployee" | "bpjsTkJpCap" | "occupationalCostRate" | "occupationalCostMonthlyCap" | "ptkpAnnualAmounts" | "pph21Brackets" | "pph21TerBrackets" | "pph21Method" | "nonNpwpSurchargeRate" | "roundingMode"> & {
  countryCode?: string; effectiveTo?: string | null; bpjsKesehatanRateEmployer?: number; bpjsKesehatanRateEmployee?: number;
  bpjsKesehatanCap?: number | null; bpjsTkJhtRateEmployer?: number; bpjsTkJhtRateEmployee?: number; bpjsTkJkkRate?: number;
  bpjsTkJkmRate?: number; bpjsTkJpRateEmployer?: number; bpjsTkJpRateEmployee?: number; bpjsTkJpCap?: number | null;
  occupationalCostRate?: number; occupationalCostMonthlyCap?: number | null; ptkpAnnualAmounts?: Record<string, number>;
  pph21Brackets?: WorkforcePphBracket[]; pph21TerBrackets?: WorkforcePphTerBracket[]; pph21Method?: "annualized" | "ter";
  nonNpwpSurchargeRate?: number; roundingMode?: "half_up" | "down" | "up";
};
export type WorkforcePtkpStatus = "TK/0" | "TK/1" | "TK/2" | "TK/3" | "K/0" | "K/1" | "K/2" | "K/3";
export type WorkforceEmployeeSalaryProfile = {
  id: string; tenantId: string; employeeId: string; baseSalary: number; fixedAllowance: number; overtimeHourlyRate: number | null;
  ptkpStatus: WorkforcePtkpStatus; hasNpwp: boolean; bpjsKesehatanNumber: string | null; bpjsTkNumber: string | null;
  bankName: string | null; bankAccountNumber: string | null; effectiveFrom: string; effectiveTo: string | null;
};
export type SetWorkforceSalaryProfileBody = {
  employeeId: string; baseSalary: number; fixedAllowance?: number; overtimeHourlyRate?: number | null; ptkpStatus: WorkforcePtkpStatus;
  hasNpwp?: boolean; bpjsKesehatanNumber?: string | null; bpjsTkNumber?: string | null; bankName?: string | null;
  bankAccountNumber?: string | null; effectiveFrom: string;
};
export type WorkforcePayrollRun = {
  id: string; tenantId: string; runNumber: string; periodMonth: number; periodYear: number; organizationUnitId: string | null;
  statutoryPolicyId: string | null; workflowInstanceId: string | null; employeeCount: number; totalGross: number;
  totalDeductions: number; totalNet: number; totalEmployerContributions: number; calculatedAt: string | null;
  approvedAt: string | null; closedAt: string | null;
};
export type WorkforcePayrollRunRow = { payrollRun: WorkforcePayrollRun; status: WorkforceWorkflowStatus | null };
export type WorkforcePayslip = {
  id: string; tenantId: string; payrollRunId: string; employeeId: string; baseSalary: number; allowances: number;
  overtimeHours: number; overtimePay: number; grossSalary: number; bpjsKesehatanEmployee: number; bpjsKesehatanEmployer: number;
  bpjsTkJhtEmployee: number; bpjsTkJhtEmployer: number; bpjsTkJkkEmployer: number; bpjsTkJkmEmployer: number;
  bpjsTkJpEmployee: number; bpjsTkJpEmployer: number; pph21Withheld: number; otherDeductions: number; totalDeductions: number;
  employerContributions: number; netSalary: number; ptkpStatus: string | null; calculationBreakdown: Record<string, unknown>; createdAt: string;
};
export type WorkforcePayrollRunDetail = { payrollRun: WorkforcePayrollRun; payslips: WorkforcePayslip[]; status: WorkforceWorkflowStatus | null; availableActions: WorkforceWorkflowAction[] };
export type WorkforcePayrollCalculation = { payrollRun: WorkforcePayrollRun; payslipCount: number; totals: { totalGross: number; totalDeductions: number; totalNet: number; totalEmployerContributions: number } };
export type WorkforcePayrollRunQuery = { organizationUnitId?: string; periodYear?: number };
export type CreateWorkforcePayrollRunBody = { periodMonth: number; periodYear: number; organizationUnitId?: string | null };

export type WorkforceJobPostingStatus = "draft" | "published" | "closed" | "cancelled";
export type WorkforceJobPosting = {
  id: string; tenantId: string; postingCode: string; title: string; positionId: string | null; organizationUnitId: string | null;
  headcountTarget: number; employmentType: string | null; jobDescription: string | null; status: WorkforceJobPostingStatus;
  workflowInstanceId: string | null; publishedAt: string | null; closedAt: string | null;
};
export type WorkforceJobPostingRow = { jobPosting: WorkforceJobPosting; status: WorkforceWorkflowStatus | null };
export type WorkforceJobPostingQuery = { status?: WorkforceJobPostingStatus; organizationUnitId?: string };
export type CreateWorkforceJobPostingBody = { title: string; positionId?: string | null; organizationUnitId?: string | null; headcountTarget?: number; employmentType?: string | null; jobDescription?: string | null };
export type WorkforceJobApplicationStage = "applied" | "screening" | "interview" | "offer" | "hired" | "rejected" | "withdrawn";
export type WorkforceJobApplication = {
  id: string; tenantId: string; jobPostingId: string; candidateName: string; candidateEmail: string | null; candidatePhone: string | null;
  resumeDocumentId: string | null; stage: WorkforceJobApplicationStage; rating: number | null; interviewerNotes: string | null;
  hiredEmployeeId: string | null; appliedAt: string; decidedAt: string | null;
};
export type WorkforceJobApplicationQuery = { jobPostingId?: string; stage?: WorkforceJobApplicationStage };
export type CreateWorkforceJobApplicationBody = { jobPostingId: string; candidateName: string; candidateEmail?: string | null; candidatePhone?: string | null; resumeDocumentId?: string | null };
export type AdvanceWorkforceJobApplicationBody = { stage: WorkforceJobApplicationStage; rating?: number | null; interviewerNotes?: string | null; hiredEmployeeId?: string | null };

export type WorkforceCompetency = { id: string; tenantId: string; code: string; name: string; category: string | null; description: string | null; scaleMin: number; scaleMax: number; isActive: boolean };
export type CreateWorkforceCompetencyBody = { code: string; name: string; category?: string | null; description?: string | null; scaleMin?: number; scaleMax?: number };
export type WorkforceEmployeeCompetency = { id: string; tenantId: string; employeeId: string; competencyId: string; proficiencyLevel: number; lastAssessedDate: string | null; assessedByUserId: string | null; notes: string | null };
export type AssessWorkforceEmployeeCompetencyBody = { employeeId: string; competencyId: string; proficiencyLevel: number; notes?: string | null };
export type WorkforceTrainingCourse = { id: string; tenantId: string; courseCode: string; title: string; provider: string | null; durationHours: number; competencyId: string | null; description: string | null; isActive: boolean };
export type CreateWorkforceTrainingCourseBody = { courseCode: string; title: string; provider?: string | null; durationHours?: number; competencyId?: string | null; description?: string | null };
export type WorkforceTrainingEnrollmentStatus = "enrolled" | "in_progress" | "completed" | "failed" | "cancelled";
export type WorkforceTrainingEnrollment = { id: string; tenantId: string; trainingCourseId: string; employeeId: string; status: WorkforceTrainingEnrollmentStatus; enrolledAt: string; completionDate: string | null; score: number | null; certificateDocumentId: string | null; notes: string | null };
export type EnrollWorkforceTrainingBody = { trainingCourseId: string; employeeId: string };
export type CompleteWorkforceTrainingBody = { status: "completed" | "failed"; completionDate: string; score?: number | null; certificateDocumentId?: string | null };
export type WorkforcePerformanceReview = { id: string; tenantId: string; reviewCode: string; employeeId: string; periodStart: string; periodEnd: string; reviewerUserId: string | null; goalsScore: number | null; competencyScore: number | null; overallRating: number | null; reviewNotes: string | null; developmentPlan: string | null; workflowInstanceId: string | null; submittedAt: string | null; finalizedAt: string | null };
export type WorkforcePerformanceReviewRow = { review: WorkforcePerformanceReview; status: WorkforceWorkflowStatus | null };
export type WorkforcePerformanceReviewQuery = { employeeId?: string; periodYear?: number };
export type CreateWorkforcePerformanceReviewBody = { employeeId: string; periodStart: string; periodEnd: string; reviewerUserId?: string | null; goalsScore?: number | null; competencyScore?: number | null; overallRating?: number | null; reviewNotes?: string | null; developmentPlan?: string | null };
export type WorkforceCareerPath = { id: string; tenantId: string; fromPositionId: string; toPositionId: string; requiredTenureMonths: number; requiredCompetencyIds: string[]; guidelines: string | null; isActive: boolean };
export type CreateWorkforceCareerPathBody = { fromPositionId: string; toPositionId: string; requiredTenureMonths?: number; requiredCompetencyIds?: string[]; guidelines?: string | null };

export type WorkforceManpowerPlanStatus = "draft" | "computed" | "applied" | "dismissed";
export type WorkforceManpowerGapEntry = { organizationUnitId: string | null; positionId: string | null; currentHeadcount: number; plannedHeadcount: number; variance: number; costImpact: number };
export type WorkforceManpowerPlan = { id: string; tenantId: string; planNumber: string; planYear: number; organizationUnitId: string | null; title: string; status: WorkforceManpowerPlanStatus; parameters: Record<string, unknown>; currentHeadcount: number; plannedHeadcount: number; varianceHeadcount: number; currentCostProjection: number; plannedCostProjection: number; varianceCostProjection: number; gapAnalysis: WorkforceManpowerGapEntry[]; computedAt: string | null; appliedAt: string | null; appliedBy: string | null };
export type WorkforceManpowerPlanQuery = { organizationUnitId?: string; planYear?: number; status?: WorkforceManpowerPlanStatus };
export type CreateWorkforceManpowerPlanBody = { planYear: number; organizationUnitId?: string | null; title: string; parameters?: Record<string, unknown> };
export type WorkforceWorkflowAction = { actionCode: string; name: string; toStepCode: string };

// --- Workforce types (Phase 3) -----------------------------------------

export type PositionRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
};

export type Employee = {
  id: string;
  employeeNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  employmentType: string | null;
  employmentStatus: "active" | "inactive" | "ended";
  joinedAt: string | null;
  endedAt: string | null;
  legalEntityId: string | null;
  organizationUnitId: string | null;
  positionId: string | null;
  userId: string | null;
};

// --- Wave A3 Service Operations Advanced types --------------------------

export type ServicePackCode = "catering" | "housekeeping" | "camp" | "facility";

export type ServicePackChecklistPresetItem = {
  code: string;
  label: string;
  isRequired: boolean;
  sortOrder: number;
};

export type ServicePackDefinitionPreset = {
  code: string;
  name: string;
  description: string;
  category: string;
  checklistItems: ServicePackChecklistPresetItem[];
};

export type ServicePackPreset = {
  packCode: ServicePackCode;
  name: string;
  description: string;
  serviceDefinitions: ServicePackDefinitionPreset[];
};

export type ServicePackActivation = {
  id: string;
  tenantId: string;
  packCode: ServicePackCode;
  isActive: boolean;
  activatedAt: string;
  activatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ServicePackView = {
  packCode: ServicePackCode;
  name: string;
  description: string;
  isActive: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
  presetServiceCount: number;
};

export type ServicePackDetail = ServicePackView & {
  preset: ServicePackPreset;
};

export type OptimizationRunStatus = "proposed" | "applied" | "dismissed";

export type OptimizationParameters = {
  maxWorkOrdersPerWorker?: number;
  maxMinutesPerWorker?: number;
  prioritizeSla?: boolean;
  groupDistanceNear?: boolean;
};

export type OptimizationAssignmentProposal = {
  workOrderId: string;
  workOrderNumber: string;
  title: string;
  priority: string | null;
  customerId: string;
  siteId: string | null;
  organizationUnitId: string | null;
  recommendedUserId: string;
  recommendedUserName: string;
  estimatedMinutes: number;
  rationale: string;
};

export type OptimizationRun = {
  id: string;
  tenantId: string;
  runNumber: string;
  targetDate: string;
  organizationUnitId: string | null;
  parameters: OptimizationParameters;
  proposals: OptimizationAssignmentProposal[];
  status: OptimizationRunStatus;
  appliedAt: string | null;
  appliedBy: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type GenerateOptimizationRunBody = {
  targetDate: string;
  organizationUnitId?: string | null;
  parameters?: OptimizationParameters;
};

export type ApplyOptimizationResponse = {
  run: OptimizationRun;
  appliedCount: number;
  skippedCount: number;
};

export type EmployeeAssignmentRecord = {
  id: string;
  legalEntityId: string | null;
  organizationUnitId: string | null;
  positionId: string | null;
  employmentStatus: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
};

export type EmployeeDetail = {
  employee: Employee;
  position: PositionRecord | null;
  history: EmployeeAssignmentRecord[];
};

// --- Service Operations types (Phase 2) --------------------------------

export type ServiceDefinition = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  isActive: boolean;
};

export type ServiceChecklistTemplateItem = {
  id: string;
  code: string;
  label: string;
  isRequired: boolean;
  sortOrder: number;
};

export type WorkRequest = {
  id: string;
  requestNumber: string;
  customerId: string;
  siteId: string | null;
  serviceDefinitionId: string;
  description: string;
  priority: string | null;
  requestedAt: string;
  convertedWorkOrderId: string | null;
  cancelledAt: string | null;
};

export type WorkRequestRow = { request: WorkRequest; state: string };

export type WorkOrder = {
  id: string;
  workOrderNumber: string;
  workRequestId: string | null;
  customerId: string;
  siteId: string | null;
  serviceDefinitionId: string;
  title: string;
  description: string | null;
  priority: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  dueAt: string | null;
  assignedToUserId: string | null;
  startedAt: string | null;
  completionNotes: string | null;
  completedAt: string | null;
  verificationNotes: string | null;
  verifiedAt: string | null;
  workflowInstanceId: string | null;
};

export type WorkOrderChecklistItem = {
  id: string;
  code: string;
  label: string;
  isRequired: boolean;
  sortOrder: number;
  isCompleted: boolean;
  note: string | null;
  completedAt: string | null;
};

export type WorkOrderStatus = {
  stepCode: string | null;
  stepName: string | null;
  instanceStatus: string;
  sla: { dueAt: string | null; slaHours: number | null } | null;
  assignment: { roleCode: string | null; userId: string | null; isMine: boolean } | null;
};

export type WorkOrderRow = { workOrder: WorkOrder; status: WorkOrderStatus | null };

export type WorkOrderDetail = {
  workOrder: WorkOrder;
  serviceDefinition: ServiceDefinition | null;
  checklist: WorkOrderChecklistItem[];
  status: WorkOrderStatus | null;
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
};

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export type WorkOrderServingLog = {
  id: string;
  tenantId: string;
  workOrderId: string;
  servingNumber: string;
  servicePointId: string | null;
  mealDate: string;
  mealType: MealType;
  openingTime: string;
  closingTime: string | null;
  receivedQty: string;
  servedQty: string;
  returnedQty: string;
  wastedQty: string;
  remainingQty: string;
  servingSupervisorUserId: string | null;
  notes: string | null;
  recordedBy: string;
  recordedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateServingLogInput = {
  mealDate: string;
  mealType: MealType;
  openingTime: string;
  closingTime?: string | null;
  receivedQty: string;
  servedQty: string;
  returnedQty: string;
  wastedQty: string;
  servicePointId?: string | null;
  servingSupervisorUserId?: string | null;
  notes?: string | null;
};

export type UpdateServingLogInput = {
  closingTime?: string | null;
  servedQty?: string;
  returnedQty?: string;
  wastedQty?: string;
  servingSupervisorUserId?: string | null;
  notes?: string | null;
};

export type KPIValue = { metric: string; value: string; unit: string; dataPoints: number };

export type DashboardL2 = {
  period: string;
  productionAchievement: KPIValue;
  mealFulfillment: KPIValue;
  foodWaste: KPIValue;
  foodCostPerMeal: KPIValue;
};

export type WorkflowInstance = {
  id: string;
  workflowDefinitionId: string;
  workflowVersionId: string;
  entityType: string;
  entityId: string;
  currentStepId: string | null;
  status: "in_progress" | "approved" | "rejected" | "cancelled";
  contextData: Record<string, unknown>;
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
};

export type WorkflowAssignment = {
  id: string;
  workflowInstanceId: string;
  stepId: string;
  assignmentType: "role" | "specific_user";
  assignedRoleCode: string | null;
  assignedOrganizationUnitId: string | null;
  assignedUserId: string | null;
  assignedAt: string;
  dueAt: string | null;
  status: "pending" | "approved" | "rejected" | "returned" | "escalated" | "superseded";
  decidedBy: string | null;
  decidedAt: string | null;
  decisionActionCode: string | null;
  comment: string | null;
  claimedByUserId: string | null;
  claimedAt: string | null;
};

// --- Checkpoint 0E types ----------------------------------------------------

export type NotificationTemplate = {
  id: string;
  eventType: string;
  channel: "email" | "push" | "whatsapp" | "sms" | "in_app";
  subjectTemplate: string | null;
  bodyTemplate: string;
  isActive: boolean;
};

export type Notification = {
  id: string;
  eventType: string;
  /** Business object the event was about — drives the "open task" link. */
  entityType?: string | null;
  entityId?: string | null;
  channel: string;
  subject: string | null;
  body: string;
  status: "sent" | "failed" | "skipped";
  readAt: string | null;
  createdAt: string;
};

export type DocumentRecord = {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
  deletedAt: string | null;
};

export type ScheduledJob = {
  id: string;
  jobCode: string;
  name: string;
  description: string;
  intervalSeconds: number;
  isEnabled: boolean;
  lastRunAt: string | null;
  lastStatus: "running" | "success" | "failed" | null;
  lastDurationMs: number | null;
  lastError: string | null;
};

export type ScheduledJobRun = {
  id: string;
  trigger: "scheduler" | "manual";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed";
  resultSummary: Record<string, unknown> | null;
  errorMessage: string | null;
};

export type IntegrationEndpoint = {
  id: string;
  code: string;
  name: string;
  direction: "outbound" | "inbound";
  baseUrl: string | null;
  isActive: boolean;
};

export type IntegrationLogEntry = {
  id: string;
  direction: "outbound" | "inbound";
  eventType: string;
  status: "sent" | "failed" | "received" | "rejected";
  createdAt: string;
};

export type DomainEvent = {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
};

// --- Checkpoint 1A / 1B domain types (mirror the API contracts) -------------

export type Customer = {
  id: string;
  code: string;
  name: string;
  status: string;
  ownerOrganizationUnitId: string | null;
  notes: string | null;
};

export type CustomerContact = {
  id: string;
  customerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
};

export type ContractRecord = {
  id: string;
  customerId: string;
  code: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
};

export type CommercialService = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
};

export type CustomerServiceLink = {
  id: string;
  customerId: string;
  serviceId: string;
  contractId: string | null;
  projectId: string | null;
  siteId: string | null;
  internalPicUserId: string | null;
  status: string;
};

export type Complaint = {
  id: string;
  complaintNumber: string;
  customerId: string;
  customerContactId: string | null;
  contractId: string | null;
  projectId: string | null;
  siteId: string | null;
  serviceId: string | null;
  category: string;
  subcategory: string | null;
  description: string;
  priority: string;
  severity: string;
  source: string | null;
  channel: string | null;
  submittedByUserId: string;
  submittedAt: string | null;
  rootCause: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  correctiveActionOwnerUserId: string | null;
  correctiveActionTargetDate: string | null;
  verificationNote: string | null;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  customerConfirmationNote: string | null;
  customerConfirmedAt: string | null;
  closureDate: string | null;
  workflowInstanceId: string | null;
  createdAt: string;
  updatedAt: string;
};

// --- Wave 1 dynamic dashboard drill-down list ------------------------------
export type ComplaintDashboardListItem = {
  id: string;
  complaintNumber: string;
  customerName: string | null;
  category: string;
  severity: string;
  status: string;
  createdAt: string;
};
export type ComplaintDashboardListResult = {
  items: ComplaintDashboardListItem[];
  total: number;
};

/** Current lifecycle position, resolved from the Complaint's Workflow
 * Instance (never a column on the Complaint itself). */
export type ComplaintStatus = {
  stepCode: string | null;
  instanceStatus: string;
};

// --- Checkpoint 1C.2 composite/customer read types --------------------------

export type ComplaintDetailStatus = {
  stepCode: string | null;
  stepName: string | null;
  instanceStatus: string;
} | null;

export type ComplaintSla = { dueAt: string | null; slaHours: number | null } | null;

export type ComplaintTimelineEntry = {
  occurredAt: string;
  actionCode: string;
  stepCode: string | null;
  stepName: string | null;
};

export type ComplaintAvailableAction = { actionCode: string; name: string };

export type ComplaintDetailView = {
  complaint: Complaint;
  status: ComplaintDetailStatus;
  sla: ComplaintSla;
  timeline: ComplaintTimelineEntry[];
  availableActions: ComplaintAvailableAction[];
  reopen: { canReopen: boolean; targetSteps: { code: string; name: string }[] };
};

export type ComplaintSummaryItem = {
  complaint: Complaint;
  status: ComplaintDetailStatus;
  sla: ComplaintSla;
};

export type ComplaintRefItem = { code: string; label: string };

export type ComplaintCreateOptions = {
  categories: ComplaintRefItem[];
  severities: ComplaintRefItem[];
  priorities: ComplaintRefItem[];
};

// --- Checkpoint 1C.3 operational (internal) types ---------------------------

export type ComplaintAssignmentSummary = {
  roleCode: string | null;
  userId: string | null;
  isMine: boolean;
} | null;

export type OperationalQueueFilters = {
  assignedToMe?: boolean;
  overdue?: boolean;
  severity?: string;
  stepCode?: string;
  customerId?: string;
  limit?: number;
  offset?: number;
};

export type OperationalQueueItem = {
  complaint: Complaint;
  customerName: string | null;
  siteName: string | null;
  status: ComplaintDetailStatus;
  sla: ComplaintSla;
  assignment: ComplaintAssignmentSummary;
  overdue: boolean;
};

export type OperationalQueueResult = {
  items: OperationalQueueItem[];
  total: number;
};

export type OperationalTimelineEntry = {
  occurredAt: string;
  actionCode: string;
  fromStepName: string | null;
  toStepName: string | null;
  actorUserId: string | null;
  comment: string | null;
};

export type OperationalComplaintDetail = {
  complaint: Complaint;
  customerName: string | null;
  status: ComplaintDetailStatus;
  sla: ComplaintSla;
  assignment: ComplaintAssignmentSummary;
  timeline: OperationalTimelineEntry[];
  availableActions: { actionCode: string; name: string; toStepCode: string }[];
  reopen: { canReopen: boolean; targetSteps: { code: string; name: string }[] };
};

// --- Checkpoint 1C.5 management dashboard types -----------------------------

export type DashboardFilters = {
  from?: string;
  to?: string;
  customerId?: string;
  siteId?: string;
  serviceId?: string;
  category?: string;
  severity?: string;
};

export type DashboardSummary = {
  total: number;
  open: number;
  closed: number;
  submittedToday: number;
  critical: number;
  slaOverdue: number;
  resolutionRatePercent: number | null;
  avgResolutionHours: number | null;
};

export type BreakdownRow = { key: string; label: string; count: number };

export type DashboardBreakdowns = {
  byCustomer: BreakdownRow[];
  bySite: BreakdownRow[];
  byService: BreakdownRow[];
  byCategory: BreakdownRow[];
  bySeverity: BreakdownRow[];
  byStatus: BreakdownRow[];
};

export type EscalationSummary = { escalatedEvents: number; openEscalatedComplaints: number };

export type ActionCenterItem = {
  complaintId: string;
  complaintNumber: string;
  customerName: string | null;
  severity: string;
  stepCode: string | null;
  stepName: string | null;
  dueAt: string | null;
  overdue: boolean;
  critical: boolean;
};

export type DashboardResult = {
  summary: DashboardSummary;
  breakdowns: DashboardBreakdowns;
  escalation: EscalationSummary;
  actionCenter: ActionCenterItem[];
  period: { from: string; to: string };
  scope: { customerCount: number };
};

// --- Checkpoint 1C.6 admin configuration types ------------------------------

export type ReferenceItemView = {
  id: string;
  code: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
};

export type WorkflowCondition = { field: string; operator: string; value: unknown } | null;

export type WorkflowStepView = {
  code: string;
  name: string;
  stepType: string;
  isInitial: boolean;
  isTerminal: boolean;
  terminalStatus: string | null;
  slaHours: number | null;
  transitions: { actionCode: string; name: string; toStepCode: string | null; condition: WorkflowCondition }[];
  assignmentRules: {
    assignmentType: string;
    roleCode: string | null;
    organizationUnitStrategy: string | null;
    specificUserSource: string | null;
    condition: WorkflowCondition;
  }[];
};

export type WorkflowDefinitionView = {
  definition: { code: string; name: string; entityType: string; isActive: boolean };
  versionNumber: number | null;
  versionStatus: string | null;
  steps: WorkflowStepView[];
} | null;

export type ComplaintConfigView = {
  referenceData: {
    categories: ReferenceItemView[];
    severities: ReferenceItemView[];
    priorities: ReferenceItemView[];
  };
  numbering: { code: string; pattern: string; currentSequence: number } | null;
  notificationTemplates: {
    id: string;
    eventType: string;
    channel: string;
    subjectTemplate: string | null;
    isActive: boolean;
  }[];
  workflow: WorkflowDefinitionView;
  capabilities: {
    referenceDataCreate: boolean;
    referenceDataToggleActive: boolean;
    numberingEditable: boolean;
    notificationTemplateEditable: boolean;
    workflowEditable: boolean;
  };
};

export type CreateComplaintPayload = {
  customerId: string;
  customerContactId?: string | null;
  contractId?: string | null;
  projectId?: string | null;
  siteId?: string | null;
  serviceId?: string | null;
  category: string;
  subcategory?: string | null;
  description: string;
  priority: string;
  severity: string;
  source?: string | null;
  channel?: string | null;
};

// --- Checkpoint 1D survey types ---------------------------------------------

export type SurveyVersionStatus = "draft" | "published" | "retired";
export type SurveyQuestionType =
  | "rating"
  | "single_choice"
  | "long_text"
  | "short_text"
  | "multiple_choice"
  | "numeric"
  | "yes_no"
  | "date"
  | "matrix_single_choice"
  | "matrix_rating";
export type SurveyScoringModel = "sum" | "weighted_average" | "percentage" | "nps";
export type SurveyAssignmentStatus = "pending" | "in_progress" | "submitted" | "expired" | "cancelled";

export type SurveyDefinition = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SurveyVersion = {
  id: string;
  surveyDefinitionId: string;
  versionNumber: number;
  status: SurveyVersionStatus;
  isCurrent: boolean;
  publishedAt: string | null;
  createdAt: string;
  scoringModel: SurveyScoringModel;
  defaultLocale: string;
};

export type SurveySection = {
  id: string;
  surveyVersionId: string;
  code: string;
  title: string;
  description: string | null;
  sortOrder: number;
  scoringModel: SurveyScoringModel | null;
  weight: number;
};

export type SurveyQuestionOption = {
  id: string;
  surveyQuestionId: string;
  code: string;
  label: string;
  score: number | null;
  sortOrder: number;
};

export type SurveyQuestion = {
  id: string;
  surveyVersionId: string;
  sectionId: string | null;
  code: string;
  text: string;
  questionType: SurveyQuestionType;
  isRequired: boolean;
  config: Record<string, unknown>;
  sortOrder: number;
  weight: number;
  options?: SurveyQuestionOption[];
  matrixRows?: SurveyMatrixRow[];
};

export type SurveyAssignment = {
  id: string;
  tenantId: string;
  surveyVersionId: string;
  respondentType: string;
  respondentUserId: string | null;
  respondentCustomerContactId: string | null;
  contextEntityType: string | null;
  contextEntityId: string | null;
  status: SurveyAssignmentStatus;
  dueAt: string | null;
  totalScore: number | null;
  assignedBy: string | null;
  createdAt: string;
  submittedAt: string | null;
};

export type SurveyVersionDetail = {
  version: SurveyVersion;
  sections: SurveySection[];
  questions: (SurveyQuestion & { options: SurveyQuestionOption[]; matrixRows: SurveyMatrixRow[] })[];
};

export type SurveyDetail = {
  definition: SurveyDefinition;
  versions: SurveyVersion[];
  current: SurveyVersionDetail | null;
};

export type SurveyAnswerView = {
  questionId: string;
  valueText: string | null;
  valueNumeric: number | null;
  selectedOptionIds: string[];
};

export type SurveyRespondentView = {
  assignment: SurveyAssignment;
  sections: SurveySection[];
  questions: (SurveyQuestion & { options: SurveyQuestionOption[]; matrixRows: SurveyMatrixRow[] })[];
  answers: SurveyAnswerView[];
  matrixAnswers: SurveyMatrixAnswerView[];
  branchingRules: SurveyBranchingRule[];
};

export type SurveyResultView = {
  assignment: SurveyAssignment;
  version: SurveyVersionDetail | null;
  answers: SurveyAnswerView[];
};

export type SurveyAnswerInput = {
  questionId: string;
  valueText?: string | null;
  valueNumeric?: number | null;
  optionIds?: string[];
};

// --- Wave A2 Survey & Assessment Advanced types --------------------------

export type BranchConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "in"
  | "not_in"
  | "is_answered"
  | "is_unanswered";

export type BranchTargetAction = "jump_to_question" | "jump_to_section" | "end_survey";

export type TokenDistributionChannel = "link" | "email" | "sms" | "qr";

export type TranslationEntityType = "definition" | "section" | "question" | "option" | "matrix_row";

export type SurveyMatrixRow = {
  id: string;
  tenantId: string;
  surveyQuestionId: string;
  code: string;
  label: string;
  sortOrder: number;
  createdAt: string;
};

export type SurveyMatrixAnswerView = {
  questionId: string;
  matrixRowId: string;
  valueText: string | null;
  valueNumeric: number | null;
  selectedOptionId: string | null;
};

export type SurveyMatrixAnswerInput = {
  questionId: string;
  matrixRowId: string;
  valueText?: string | null;
  valueNumeric?: number | null;
  selectedOptionId?: string | null;
};

export type SurveyBranchingRule = {
  id: string;
  tenantId: string;
  surveyVersionId: string;
  sourceQuestionId: string;
  conditionOperator: BranchConditionOperator;
  conditionValue: unknown;
  targetAction: BranchTargetAction;
  targetQuestionId: string | null;
  targetSectionId: string | null;
  priority: number;
  createdAt: string;
};

export type CreateSurveyBranchingRuleBody = {
  sourceQuestionId: string;
  conditionOperator: BranchConditionOperator;
  conditionValue: unknown;
  targetAction: BranchTargetAction;
  targetQuestionId?: string | null;
  targetSectionId?: string | null;
  priority?: number;
};

export type SurveyDistributionToken = {
  id: string;
  tenantId: string;
  surveyVersionId: string;
  channel: TokenDistributionChannel;
  recipientLabel: string | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

// Mint returns the row plus the one-time secret; the secret is never stored,
// only the SHA-256 hash is, so it can be shown once and never again.
export type CreatedSurveyDistributionToken = {
  token: SurveyDistributionToken;
  rawToken: string;
};

export type CreateSurveyDistributionTokenBody = {
  channel?: TokenDistributionChannel;
  recipientLabel?: string | null;
  maxUses?: number | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type SurveyTranslation = {
  id: string;
  tenantId: string;
  surveyVersionId: string;
  locale: string;
  entityType: TranslationEntityType;
  entityId: string;
  fieldName: string;
  translatedText: string;
  createdAt: string;
  updatedAt: string;
};

export type UpsertSurveyTranslationBody = {
  locale: string;
  entityType: TranslationEntityType;
  entityId: string;
  fieldName: string;
  translatedText: string;
};

// Field names mirror the analytics service payload exactly. A mismatch here
// compiles fine and only fails at render (`.map` of undefined), so keep them
// in step with `SurveyAnalyticsOverview` in the API domain entity.
export type SurveyAnalyticsOverview = {
  surveyDefinitionId: string;
  surveyDefinitionCode: string;
  surveyDefinitionName: string;
  totalAssignments: number;
  submittedCount: number;
  inProgressCount: number;
  expiredCount: number;
  completionRatePercent: number;
  averageScore: number | null;
  nps: {
    totalNpsResponses: number;
    promoterCount: number;
    passiveCount: number;
    detractorCount: number;
    promoterPercent: number;
    passivePercent: number;
    detractorPercent: number;
    netPromoterScore: number | null;
  };
  sectionAverages: Array<{
    sectionId: string;
    sectionCode: string;
    sectionTitle: string;
    averagePercentageScore: number | null;
    averageWeightedScore: number | null;
  }>;
  questionDropOff: Array<{
    questionId: string;
    questionCode: string;
    questionText: string;
    viewCount: number;
    answerCount: number;
    dropOffRatePercent: number;
  }>;
  smallCellSuppressed: boolean;
};

export type SurveyBenchmarkResult = {
  surveyDefinitionId: string;
  benchmarkDimension: "category" | "organization_unit" | "time_period";
  items: Array<{
    contextEntityType: string;
    contextEntityId: string;
    contextLabel: string;
    responseCount: number;
    averageScore: number | null;
    npsScore: number | null;
    completionRatePercent: number;
  }>;
  generatedAt: string;
};

// Flat shape as the public route actually sends it: no `definition` or
// `version` objects, and no ids beyond the ones a public respondent needs.
export type PublicSurveyView = {
  definitionCode: string;
  definitionName: string;
  description: string | null;
  versionNumber: number;
  defaultLocale: string;
  locale: string;
  sections: SurveySection[];
  questions: (SurveyQuestion & { options: SurveyQuestionOption[]; matrixRows: SurveyMatrixRow[] })[];
  branchingRules: SurveyBranchingRule[];
};

export type PublicSurveySubmissionResult = {
  assignmentId: string;
  status: SurveyAssignmentStatus;
  totalScore: number | null;
};

export type MySurveyItem = {
  assignment: SurveyAssignment;
  surveyName: string | null;
  versionNumber: number | null;
};

// --- Wave A1: Sales & Commercial Types --------------------------------------

export type PriceBookRecord = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  currency: string;
  isStandard: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PriceBookEntryRecord = {
  id: string;
  tenantId: string;
  priceBookId: string;
  itemSku: string;
  unitPrice: number;
  minQuantity: number;
  maxQuantity: number | null;
  unitOfMeasure: string;
  createdAt: string;
  updatedAt: string;
};

export type OpportunityRecord = {
  id: string;
  tenantId: string;
  code: string;
  title: string;
  customerId: string;
  leadSource: string;
  stageCode: string;
  estimatedValue: number | null;
  currency: string;
  confidencePercent: number | null;
  targetCloseDate: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpportunityStageHistoryRecord = {
  id: string;
  opportunityId: string;
  fromStageCode: string | null;
  toStageCode: string;
  fromOutcome: string | null;
  toOutcome: string | null;
  outcomeReason: string | null;
  note: string | null;
  changedBy: string | null;
  changedAt: string;
};

export type OpportunityDetailRecord = {
  opportunity: OpportunityRecord;
  customer: Customer | null;
  stageHistory: OpportunityStageHistoryRecord[];
};

export type OpportunityPipelineSummary = {
  stageCode: string;
  count: number;
  totalEstimatedValue: number;
};

export type QuotationRecord = {
  id: string;
  tenantId: string;
  code: string;
  opportunityId: string | null;
  customerId: string;
  priceBookId: string | null;
  revisionNumber: number;
  status: string;
  totalAmount: number;
  currency: string;
  validUntil: string | null;
  issuedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  withdrawnAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type QuotationItemRecord = {
  id: string;
  quotationId: string;
  itemSku: string | null;
  description: string;
  unitPrice: number;
  quantity: number;
  discountPercent: number;
  lineTotal: number;
  sortOrder: number;
};

export type QuotationDetailRecord = {
  quotation: QuotationRecord;
  customer: Customer | null;
  opportunity: OpportunityRecord | null;
  items: QuotationItemRecord[];
};

export type CreatePriceBookBody = {
  code: string;
  name: string;
  currency: string;
  isStandard?: boolean;
};

export type AddPriceBookEntryBody = {
  itemSku: string;
  unitPrice: number;
  minQuantity?: number;
  maxQuantity?: number | null;
  unitOfMeasure?: string;
};

export type CreateOpportunityBody = {
  code: string;
  title: string;
  customerId: string;
  leadSource?: string;
  stageCode?: string;
  estimatedValue?: number | null;
  currency?: string;
  confidencePercent?: number | null;
  targetCloseDate?: string | null;
};

export type CreateQuotationBody = {
  code: string;
  opportunityId?: string | null;
  customerId: string;
  priceBookId?: string | null;
  currency?: string;
  validUntil?: string | null;
  notes?: string | null;
  items: {
    itemSku?: string | null;
    description: string;
    unitPrice: number;
    quantity: number;
    discountPercent?: number;
  }[];
};

// --- Wave A1: Service Quality Advanced Types --------------------------------

export type SqCalendarWindow = {
  id?: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
};

export type SqHolidayRecord = {
  id: string;
  tenantId: string;
  calendarId: string;
  holidayDate: string;
  name: string;
  createdAt: string;
};

export type SqCalendarRecord = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  timeZone: string;
  isContinuous: boolean;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SqSlaPolicyRecord = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  calendarId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SqSlaRuleRecord = {
  id: string;
  tenantId: string;
  policyId: string;
  code: string;
  customerId: string | null;
  contractId: string | null;
  severityCode: string | null;
  categoryCode: string | null;
  responseMinutes: number | null;
  resolutionMinutes: number | null;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SqSlaTargetRecord = {
  id: string;
  tenantId: string;
  complaintId: string;
  policyId: string;
  ruleId: string;
  calendarId: string;
  frozenAt: string;
  responseDueAt: string | null;
  resolutionDueAt: string | null;
  responseMetAt: string | null;
  resolutionMetAt: string | null;
  responseBreached: boolean;
  resolutionBreached: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type SqSlaTargetState = {
  status: string;
  responseMet: boolean;
  resolutionMet: boolean;
  responseBreached: boolean;
  resolutionBreached: boolean;
};

export type SqSlaPerformanceSummary = {
  status: string;
  count: number;
  metResponseCount: number;
  metResolutionCount: number;
  breachedCount: number;
};

export type SqRcaCategoryRecord = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SqRcaFindingRecord = {
  id: string;
  tenantId: string;
  complaintId: string;
  rootCauseCategoryId: string;
  analysisMethodCode: string | null;
  statement: string;
  evidenceSummary: string | null;
  isPrimary: boolean;
  identifiedBy: string | null;
  identifiedAt: string;
  createdAt: string;
};

export type SqCapaActionRecord = {
  id: string;
  tenantId: string;
  actionNumber: string;
  complaintId: string;
  rcaFindingId: string | null;
  actionType: "corrective" | "preventive";
  title: string;
  description: string | null;
  ownerUserId: string | null;
  dueDate: string | null;
  status: string;
  workflowInstanceId: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completionNote: string | null;
  effectivenessVerdict: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SqCapaEffectivenessSummary = {
  status: string;
  count: number;
  effectiveCount: number;
  ineffectiveCount: number;
};

export type SqRecurrenceRuleRecord = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  groupBy: string;
  windowDays: number;
  minimumOccurrences: number;
  customerId: string | null;
  severityCode: string | null;
  categoryCode: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SqRecurrenceCluster = {
  groupValue: string | null;
  occurrences: number;
  complaintIds: string[];
  firstOccurredAt: string;
  lastOccurredAt: string;
};

export type SqRecurrenceDetectionRecord = {
  rule: SqRecurrenceRuleRecord;
  windowDays: number;
  minimumOccurrences: number;
  clusters: SqRecurrenceCluster[];
};

export type SqAutomationRuleRecord = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description: string | null;
  triggerEvent: string;
  scoreThreshold: number | null;
  proposedAction: string;
  actionParameters: Record<string, unknown>;
  requiresApproval: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SqAutomationProposalRecord = {
  id: string;
  tenantId: string;
  ruleId: string;
  triggerEvent: string;
  sourceEntityId: string;
  proposedAction: string;
  actionParameters: Record<string, unknown>;
  status: string;
  requiresApproval: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedAt: string | null;
  failureReason: string | null;
  createdAt: string;
};

export type CreateSqCalendarBody = {
  code: string;
  name: string;
  timeZone: string;
  isContinuous?: boolean;
  isDefault?: boolean;
  windows: { dayOfWeek: number; startMinute: number; endMinute: number }[];
};

export type CreateSqSlaPolicyBody = {
  code: string;
  name: string;
  description?: string | null;
  calendarId: string;
};

export type CreateSqSlaRuleBody = {
  policyId: string;
  code: string;
  customerId?: string | null;
  contractId?: string | null;
  severityCode?: string | null;
  categoryCode?: string | null;
  responseMinutes?: number | null;
  resolutionMinutes?: number | null;
  priority?: number;
};

export type CreateSqRcaCategoryBody = {
  code: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  sortOrder?: number;
};

export type CreateSqRcaFindingBody = {
  rootCauseCategoryId: string;
  analysisMethodCode?: string | null;
  statement: string;
  evidenceSummary?: string | null;
  isPrimary?: boolean;
  identifiedBy?: string | null;
};

export type CreateSqCapaActionBody = {
  complaintId: string;
  rcaFindingId?: string | null;
  actionType: "corrective" | "preventive";
  title: string;
  description?: string | null;
  ownerUserId?: string | null;
  dueDate?: string | null;
};

export type CreateSqRecurrenceRuleBody = {
  code: string;
  name: string;
  description?: string | null;
  groupBy: string;
  windowDays: number;
  minimumOccurrences: number;
  customerId?: string | null;
  severityCode?: string | null;
  categoryCode?: string | null;
};

export type CreateSqAutomationRuleBody = {
  code: string;
  name: string;
  description?: string | null;
  triggerEvent: string;
  scoreThreshold?: number | null;
  proposedAction: string;
  actionParameters?: Record<string, unknown>;
};
