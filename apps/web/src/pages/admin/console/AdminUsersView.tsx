/**
 * Epic 4 Wave 2 §4.4 steps 11–16 — user-centric access surface.
 *
 * The list and the detail view both come from server-side visibility. A user
 * outside the actor's administrative scope never enters the payload, and a
 * handcrafted detail request for an out-of-scope user is answered like a
 * missing one by the API. The browser never performs the security filtering.
 *
 * Creation and assignment use the governed Wave 2 routes: create user may carry
 * zero or more initial pairs, and add access uses one preview plus one
 * confirmation hash. Customer scope is deliberately absent until the separate
 * Service Operation decision closes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UserX } from "lucide-react";
import { useAuth } from "../../../auth/AuthContext";
import { useT } from "../../../i18n/LocaleProvider";
import {
  api,
  ApiError,
  type AdminRoleAssignmentSummary,
  type AdminUserAccessSummary,
} from "../../../lib/api";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Spinner,
  StatusPill,
} from "../../../shell/components/ui";
import { OverlayDialog } from "../../../shell/components/OverlayDialog";
import { AdminPanel, AdminSectionState } from "./AdminSection";
import { useAdminResource } from "./useAdminResource";
import { AssignAccessDialog } from "./AdminAssignAccessDialog";
import { AdminCreateUserDialog } from "./AdminCreateUserDialog";
import { errorMessage } from "./AdminAssignmentControls";

/** Mirrors the API's `revokeAssignmentSchema` ceiling (§4.4 Wave 3 step 18). */
const MAX_REVOKE_REASON_LENGTH = 500;

type Translate = ReturnType<typeof useT>;

function assignmentScopeName(t: Translate, assignment: AdminRoleAssignmentSummary): string {
  if (assignment.scopeType === "tenant") return t("adminAssignments.scopeTenantWide");
  if (assignment.scopeType === "legal_entity") {
    return assignment.scopeState === "available"
      ? assignment.scopeLegalEntityName ?? t("adminAssignments.legalEntityUnavailable")
      : t("adminAssignments.legalEntityUnavailable");
  }
  if (assignment.scopeType === "organization_unit") {
    return assignment.scopeState === "available"
      ? assignment.scopeOrganizationUnitName ?? t("adminAssignments.orgUnitUnavailable")
      : t("adminAssignments.orgUnitUnavailable");
  }
  return assignment.scopeState === "available"
    ? assignment.scopeCustomerName ?? t("adminAssignments.customerUnavailable")
    : t("adminAssignments.customerUnavailable");
}

function assignmentRoleLabel(t: Translate, assignment: AdminRoleAssignmentSummary): string {
  return assignment.roleState === "available"
    ? assignment.roleName ?? assignment.roleCode ?? t("adminAssignments.roleUnavailable")
    : t("adminAssignments.roleUnavailable");
}

function roleSearchText(t: Translate, user: AdminUserAccessSummary): string {
  return user.roleAssignments
    .map((assignment) => `${assignmentRoleLabel(t, assignment)} ${assignment.roleCode ?? ""}`)
    .join(" ");
}

function assignmentStateTone(assignment: AdminRoleAssignmentSummary): "success" | "warning" {
  return assignment.assignmentState === "active" ? "success" : "warning";
}

/** Wave 3 — one label per lifecycle state, so an operator reads WHY the grant
 * is inert: revoked by hand, invalidated by the system, or unavailable because
 * its role/scope no longer resolves. */
function assignmentStateLabel(t: Translate, assignment: AdminRoleAssignmentSummary): string {
  switch (assignment.assignmentState) {
    case "active":
      return t("adminAssignments.stateActive");
    case "revoked":
      return t("adminAssignments.stateRevoked");
    case "invalidated":
      return t("adminAssignments.stateInvalidated");
    default:
      return t("adminAssignments.stateUnavailable");
  }
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString();
}

export function AdminUsersView({
  canManageAccess,
}: {
  canManageAccess: boolean;
}) {
  const t = useT();
  const { session } = useAuth();
  const { data, loading, error, denied, sessionExpired, reload } =
    useAdminResource<AdminUserAccessSummary[]>(
      (token) => api.adminUsers(token),
      t("adminUsers.loadFailed"),
    );
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [detailUser, setDetailUser] = useState<AdminUserAccessSummary | null>(null);
  const [assignTarget, setAssignTarget] = useState<AdminUserAccessSummary | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [terminatingId, setTerminatingId] = useState<string | null>(null);

  const terminateUser = useCallback(
    async (user: AdminUserAccessSummary) => {
      if (!window.confirm(t("adminUsers.terminateConfirm", { name: user.fullName }))) return;
      setTerminatingId(user.id);
      try {
        await api.terminateUser(session!.accessToken, user.id, null);
        setFeedback(t("adminUsers.terminated", { name: user.fullName }));
        reload();
      } catch {
        setFeedback(t("adminUsers.terminateFailed"));
      } finally {
        setTerminatingId(null);
      }
    },
    [reload, t, session],
  );
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const assignTriggerRef = useRef<HTMLButtonElement | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const PAGE_SIZE = 25;

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return data ?? [];
    return (data ?? []).filter((user) =>
      `${user.fullName} ${user.email} ${user.status} ${roleSearchText(t, user)}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [data, query, t]);

  const totalPages = Math.ceil(filteredUsers.length / PAGE_SIZE);
  const clampedPage = Math.max(1, Math.min(page, totalPages || 1));
  const paginatedUsers = useMemo(() => {
    const start = (clampedPage - 1) * PAGE_SIZE;
    return filteredUsers.slice(start, start + PAGE_SIZE);
  }, [filteredUsers, clampedPage]);

  function openDetail(user: AdminUserAccessSummary, trigger: HTMLButtonElement) {
    detailTriggerRef.current = trigger;
    setDetailUser(user);
  }

  function openAssign(user: AdminUserAccessSummary, trigger?: HTMLButtonElement) {
    if (trigger) assignTriggerRef.current = trigger;
    setAssignTarget(user);
  }

  // A stacked dialog takes over: the detail dialog below must not keep
  // claiming to be the sole modal while the assign/remove dialog is open.
  const dialogStacked = Boolean(assignTarget) || Boolean(createOpen);

  async function refreshWithFeedback(message: string) {
    await reload();
    setFeedback(message);
  }

  return (
    <>
      <AdminSectionState
        loading={loading}
        loadingLabel={t("adminUsers.loading")}
        denied={denied}
        sessionExpired={sessionExpired}
        error={error}
        requiredPermission="user.read"
        onRetry={reload}
      >
        <div aria-live="polite">
          {feedback && (
            <Alert tone="success">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{feedback}</span>
                <Button variant="ghost" onClick={() => setFeedback(null)}>
                  {t("adminUsers.dismiss")}
                </Button>
              </div>
            </Alert>
          )}
        </div>
        <AdminPanel
          title={t("adminUsers.title")}
          description={
            canManageAccess
              ? t("adminUsers.descriptionManage")
              : t("adminUsers.descriptionRead")
          }
          actions={
            canManageAccess ? (
              <Button
                onClick={(event) => {
                  createTriggerRef.current = event.currentTarget;
                  setCreateOpen(true);
                }}
              >
                {t("adminUsers.createUser")}
              </Button>
            ) : undefined
          }
        >
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <Field label={t("adminUsers.searchLabel")}>
              <Input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder={t("adminUsers.searchPlaceholder")}
                autoComplete="off"
                aria-label={t("adminUsers.searchAria")}
                className="sm:w-80"
              />
            </Field>
            <p className="text-sm tabular-nums text-ink-dim" role="status" aria-live="polite">
              {t("adminUsers.showing", {
                shown: filteredUsers.length,
                total: (data ?? []).length,
              })}
            </p>
          </div>

          <DataTable
            rows={paginatedUsers}
            keyOf={(user) => user.id}
            mobileBreakpoint="md"
            empty={
              <EmptyState
                title={query ? t("adminUsers.emptySearchTitle") : t("adminUsers.emptyTitle")}
                description={
                  query ? t("adminUsers.emptySearchBody") : t("adminUsers.emptyBody")
                }
                action={
                  query ? (
                    <Button variant="secondary" onClick={() => setQuery("")}>
                      {t("adminUsers.clearSearch")}
                    </Button>
                  ) : undefined
                }
              />
            }
            columns={[
              {
                header: t("adminUsers.columnUser"),
                mobileRole: "title",
                cell: (user) => (
                  <div>
                    <div
                      className={
                        user.status === "terminated"
                          ? "font-medium text-ink-dim line-through decoration-danger decoration-2"
                          : "font-medium text-ink"
                      }
                    >
                      {user.fullName}
                    </div>
                    <div className="break-all text-xs text-ink-dim">{user.email}</div>
                  </div>
                ),
              },
              {
                header: t("adminUsers.columnStatus"),
                mobileRole: "status",
                cell: (user) => (
                  <StatusPill
                    tone={
                      user.status === "active"
                        ? "success"
                        : user.status === "terminated"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {user.status}
                  </StatusPill>
                ),
              },
              {
                header: t("adminUsers.columnAssignments"),
                cell: (user) => (
                  <span className="tabular-nums text-ink-dim">
                    {user.roleAssignments.length}
                  </span>
                ),
              },
              {
                header: t("adminUsers.columnRoles"),
                cell: (user) => (
                  <div className="flex max-w-xl flex-wrap gap-1.5">
                    {user.roleAssignments.length === 0 ? (
                      <span className="text-ink-dim">{t("adminUsers.noRoleAssignments")}</span>
                    ) : (
                      user.roleAssignments.slice(0, 3).map((assignment) => (
                        <Badge key={assignment.id}>
                          {assignmentRoleLabel(t, assignment)} ·{" "}
                          {assignmentScopeName(t, assignment)}
                        </Badge>
                      ))
                    )}
                    {user.roleAssignments.length > 3 && (
                      <Badge>
                        {t("adminUsers.moreCount", {
                          count: user.roleAssignments.length - 3,
                        })}
                      </Badge>
                    )}
                  </div>
                ),
              },
              {
                header: t("adminUsers.columnAccess"),
                className: "text-right",
                cell: (user) => (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="secondary"
                      className="min-h-[44px]"
                      onClick={(event) => openDetail(user, event.currentTarget)}
                    >
                      {t("adminUsers.viewAccess")}
                    </Button>
                    {canManageAccess && (
                      <Button
                        className="min-h-[44px]"
                        onClick={(event) => openAssign(user, event.currentTarget)}
                      >
                        {t("adminUsers.assignAccess")}
                      </Button>
                    )}
                    {canManageAccess && user.status === "active" && (
                      <Button
                        variant="ghost"
                        className="min-h-[44px] text-status-danger"
                        aria-label={t("adminUsers.terminate")}
                        title={t("adminUsers.terminate")}
                        disabled={terminatingId === user.id}
                        onClick={() => void terminateUser(user)}
                      >
                        <UserX size={16} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />

          {filteredUsers.length > 0 && (
            <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm tabular-nums text-ink-dim" role="status" aria-live="polite">
                {t("adminUsers.page", {
                  page: clampedPage,
                  total: totalPages || 1,
                })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={clampedPage <= 1}
                  onClick={() => setPage(Math.max(1, clampedPage - 1))}
                >
                  {t("adminUsers.previous")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={clampedPage >= totalPages}
                  onClick={() => setPage(Math.min(totalPages, clampedPage + 1))}
                >
                  {t("adminUsers.next")}
                </Button>
              </div>
            </div>
          )}
        </AdminPanel>
      </AdminSectionState>

      {detailUser && (
        <UserAccessDialog
          user={detailUser}
          canManageAccess={canManageAccess}
          stacked={dialogStacked}
          onClose={() => setDetailUser(null)}
          onAssign={(user, trigger) => openAssign(user, trigger)}
          onRemoved={(message) => void refreshWithFeedback(message)}
          restoreFocusRef={detailTriggerRef}
        />
      )}

      {assignTarget && (
        <AssignAccessDialog
          targetUserId={assignTarget.id}
          targetName={assignTarget.fullName}
          targetEmail={assignTarget.email}
          onClose={() => setAssignTarget(null)}
          restoreFocusRef={assignTriggerRef}
          onApplied={(message) => {
            setAssignTarget(null);
            setDetailUser(null);
            void refreshWithFeedback(message);
          }}
        />
      )}

      {createOpen && (
        <AdminCreateUserDialog
          restoreFocusRef={createTriggerRef}
          onClose={() => setCreateOpen(false)}
          onCreated={(message) => {
            setCreateOpen(false);
            void refreshWithFeedback(message);
          }}
        />
      )}
    </>
  );
}

function UserAccessDialog({
  user,
  canManageAccess,
  stacked,
  onClose,
  onAssign,
  onRemoved,
  restoreFocusRef,
}: {
  user: AdminUserAccessSummary;
  canManageAccess: boolean;
  /** True while another dialog is open above this one: this dialog then stops
   *  claiming to be the sole modal and stops competing for focus. */
  stacked: boolean;
  onClose: () => void;
  onAssign: (user: AdminUserAccessSummary, trigger?: HTMLButtonElement) => void;
  onRemoved: (message: string) => void;
  restoreFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const { session } = useAuth();
  const t = useT();
  const token = session!.accessToken;
  const [detail, setDetail] = useState<AdminUserAccessSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AdminRoleAssignmentSummary | null>(null);
  // A stale response must not overwrite a newer reload, and no response may
  // land after this dialog is gone.
  const generation = useRef(0);

  const loadDetail = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.adminUserAccess(token, user.id);
      if (requestGeneration !== generation.current) return;
      setDetail(result);
    } catch (err) {
      if (requestGeneration !== generation.current) return;
      setLoadError(
        err instanceof ApiError ? err.message : t("adminUsers.loadAccessFailed"),
      );
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [token, user.id, t]);

  useEffect(() => {
    void loadDetail();
    return () => {
      generation.current += 1;
    };
  }, [loadDetail]);

  // While a dialog is stacked above this one (assignment or removal), this
  // dialog stops claiming to be the sole modal and its content goes inert.
  const bodyStacked = stacked || removing !== null;

  return (
    <>
      <OverlayDialog
        open
        title={t("adminUsers.detailAccess", { name: user.fullName })}
        description={<span className="break-all">{user.email}</span>}
        stacked={bodyStacked}
        onClose={onClose}
        restoreFocusRef={restoreFocusRef}
        size="lg"
        footer={
          <>
            <Button variant="secondary" className="min-h-[44px]" onClick={onClose}>
              {t("common.close")}
            </Button>
            {canManageAccess && detail && (
              <Button
                className="min-h-[44px]"
                onClick={(event) => onAssign(detail, event.currentTarget)}
              >
                {t("adminUsers.assignAccess")}
              </Button>
            )}
          </>
        }
      >
        <div aria-hidden={bodyStacked || undefined} {...(bodyStacked ? { inert: true } : {})}>
        {loading ? (
          <Spinner label={t("adminUsers.loadingAccess")} />
        ) : loadError ? (
          <Alert tone="error">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{loadError}</span>
              <Button variant="secondary" onClick={() => void loadDetail()}>
                {t("adminUsers.retry")}
              </Button>
            </div>
          </Alert>
        ) : detail ? (
          <div className="space-y-5">
            <section aria-labelledby="user-access-summary-title">
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <SummaryItem label={t("adminUsers.statusLabel")}>
                  <StatusPill tone={detail.status === "active" ? "success" : "neutral"}>
                    {detail.status}
                  </StatusPill>
                </SummaryItem>
                <SummaryItem label={t("adminUsers.userIdLabel")}>
                  <code className="break-all font-mono text-[11.5px]">{detail.id}</code>
                </SummaryItem>
                <SummaryItem label={t("adminUsers.assignmentsLabel")}>
                  <span className="tabular-nums">{detail.roleAssignments.length}</span>
                </SummaryItem>
              </div>
            </section>
            <section aria-labelledby="current-access-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="current-access-title" className="text-sm font-semibold text-ink">
                  {t("adminUsers.currentAccess")}
                </h3>
                {!canManageAccess && <Badge>{t("adminUsers.readOnly")}</Badge>}
              </div>
              {detail.roleAssignments.length === 0 ? (
                <EmptyState
                  title={t("adminUsers.noAssignmentsTitle")}
                  description={t("adminUsers.noAssignmentsBody")}
                />
              ) : (
                <ul className="mt-3 divide-y divide-line rounded border border-line">
                  {detail.roleAssignments.map((assignment) => (
                    <li
                      key={assignment.id}
                      className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <AssignmentBlock assignment={assignment} t={t} />
                      {canManageAccess && assignment.assignmentState === "active" && (
                        <Button
                          variant="secondary"
                          className="min-h-[44px] shrink-0"
                          onClick={() => setRemoving(assignment)}
                        >
                          {t("adminUsers.reviewRevocation")}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
        </div>
      </OverlayDialog>
      {removing && detail && (
        <RevokeAssignmentDialog
          user={detail}
          assignment={removing}
          onClose={() => setRemoving(null)}
          onRevoked={(message) => {
            setRemoving(null);
            onRemoved(message);
            void loadDetail();
          }}
        />
      )}
    </>
  );
}

function AssignmentBlock({
  assignment,
  t,
}: {
  assignment: AdminRoleAssignmentSummary;
  t: Translate;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium text-ink">
          {assignmentRoleLabel(t, assignment)}
        </span>
        {assignment.roleCode && (
          <code className="break-all font-mono text-[11.5px] text-ink-dim">
            {assignment.roleCode}
          </code>
        )}
        <StatusPill tone={assignmentStateTone(assignment)}>
          {assignmentStateLabel(t, assignment)}
        </StatusPill>
      </div>
      <div className="text-sm text-ink-dim">{assignmentScopeName(t, assignment)}</div>
      <code className="break-all font-mono text-[11.5px] text-ink-faint">
        {assignment.id}
      </code>
      {assignment.assignmentState === "revoked" && (
        <p className="text-xs text-status-warn">
          {t("adminUsers.revokedNote", {
            timestamp: formatTimestamp(assignment.revokedAt),
          })}
        </p>
      )}
      {assignment.assignmentState === "invalidated" && (
        <p className="text-xs text-status-warn">
          {t("adminUsers.invalidatedNote")}
        </p>
      )}
      {assignment.assignmentState === "unavailable" && (
        <p className="text-xs text-status-warn">
          {t("adminUsers.unavailableNote")}
        </p>
      )}
      {assignment.revokeReason && (
        <p className="text-xs text-ink-dim">
          {t("adminUsers.reasonLine", { reason: assignment.revokeReason })}
        </p>
      )}
    </div>
  );
}

function RevokeAssignmentDialog({
  user,
  assignment,
  onClose,
  onRevoked,
}: {
  user: AdminUserAccessSummary;
  assignment: AdminRoleAssignmentSummary;
  onClose: () => void;
  onRevoked: (message: string) => void;
}) {
  const { session } = useAuth();
  const t = useT();
  const token = session!.accessToken;
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: two rapid activations must not both pass the guard
  // before a re-render delivers the updated `pending`.
  const inFlight = useRef(false);

  const trimmedReason = reason.trim();
  const reasonInvalid =
    trimmedReason.length === 0 || trimmedReason.length > MAX_REVOKE_REASON_LENGTH;

  async function confirmRevocation() {
    if (inFlight.current || reasonInvalid) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await api.revokeAdminUserRoleAssignment(token, user.id, assignment.id, trimmedReason);
      // Revocation retains the row, so the proof is the state transition, not
      // the row's absence.
      const authoritative = await api.adminUserAccess(token, user.id);
      const reloaded = authoritative.roleAssignments.find(
        (candidate) => candidate.id === assignment.id,
      );
      if (!reloaded || reloaded.assignmentState !== "revoked" || !reloaded.revokedAt) {
        throw new Error(t("adminUsers.reloadMismatch"));
      }
      onRevoked(
        t("adminUsers.revokedMessage", {
          role: assignmentRoleLabel(t, assignment),
          name: user.fullName,
        }),
      );
    } catch (err) {
      setError(errorMessage(t, err, t("adminUsers.revokeFailed")));
      setPending(false);
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <OverlayDialog
      open
      title={t("adminUsers.revokeTitle")}
      description={t("adminUsers.revokeDescription")}
      pending={pending}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" className="min-h-[44px]" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            className="min-h-[44px]"
            disabled={pending || reasonInvalid}
            onClick={() => void confirmRevocation()}
          >
            {pending ? t("adminUsers.revoking") : t("adminUsers.confirmRevoke")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <section className="rounded border border-line-strong bg-panel-2 p-4">
          <h3 className="text-sm font-semibold text-ink">
            {t("adminUsers.whatWillChange")}
          </h3>
          <dl className="mt-3 grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
            <SummaryItem label={t("adminUsers.userLabel")}>
              {user.fullName} · {user.email}
            </SummaryItem>
            <SummaryItem label={t("adminUsers.roleLabel")}>
              {assignmentRoleLabel(t, assignment)}
            </SummaryItem>
            <SummaryItem label={t("adminUsers.scopeLabel")}>
              {assignmentScopeName(t, assignment)}
            </SummaryItem>
            <SummaryItem label={t("adminUsers.assignmentIdLabel")}>
              <code className="break-all font-mono text-[11.5px]">{assignment.id}</code>
            </SummaryItem>
          </dl>
          <p className="mt-3 text-sm text-ink-dim">{t("adminUsers.revokeEffect")}</p>
        </section>
        <div>
          <label
            htmlFor="revoke-reason"
            className="block text-xs font-semibold uppercase tracking-wide text-ink-dim"
          >
            {t("adminUsers.reasonField")}
          </label>
          <textarea
            id="revoke-reason"
            className="mt-1 min-h-[88px] w-full rounded border border-line-strong bg-panel-2 px-3 py-2 text-sm text-ink"
            maxLength={MAX_REVOKE_REASON_LENGTH}
            value={reason}
            disabled={pending}
            aria-describedby="revoke-reason-help"
            onChange={(event) => setReason(event.target.value)}
          />
          <p id="revoke-reason-help" className="mt-1 text-xs text-ink-dim">
            {t("adminUsers.reasonHelp", {
              count: trimmedReason.length,
              max: MAX_REVOKE_REASON_LENGTH,
            })}
          </p>
        </div>
        {pending && (
          <Alert tone="info">
            {t("adminUsers.revokePending")}
          </Alert>
        )}
      </div>
    </OverlayDialog>
  );
}

function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-dim">{label}</dt>
      <dd className="mt-1 wrap-break-word text-ink">{children}</dd>
    </div>
  );
}
