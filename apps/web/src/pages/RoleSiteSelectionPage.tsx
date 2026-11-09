import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError, type MyRoleAssignment } from "../lib/api";
import { Alert, Button, Field, Select, Spinner } from "../shell/components/ui";
import { useT } from "../i18n/LocaleProvider";
import { LanguageSwitcher } from "../shell/components/LanguageSwitcher";
import type { MessageKey } from "../i18n/dictionaries/en";

/** Human label for one assignment's Data Scope. `organization_unit` names the
 * site; a tenant-wide grant has no single site, and a customer grant is scoped
 * to the customer rather than to any internal site — each is stated plainly
 * instead of leaving the control empty. */
function scopeLabel(assignment: MyRoleAssignment, t: (key: MessageKey) => string): string {
  switch (assignment.scopeType) {
    case "tenant":
      return t("selectRole.scopeTenant");
    case "legal_entity":
      return assignment.scopeLegalEntityName ?? t("selectRole.scopeLegalEntity");
    case "customer":
      return assignment.scopeCustomerName ?? t("selectRole.scopeCustomer");
    default:
      return assignment.scopeOrganizationUnitName ?? t("selectRole.scopeOrgUnit");
  }
}

/**
 * Post-login work-context picker. Shows only role+scope pairs the signed-in
 * user already holds, so choosing one narrows what the workspace displays and
 * can never widen authority.
 *
 * Epic 1 (§4.1 C) changed what "choosing" means: the active Role is
 * server-side session state, so Continue calls POST /auth/switch-role and
 * the sessions row is rewritten. Nothing here can grant a Role the server
 * does not already recognise — the endpoint answers "is this mine and
 * currently effective" in the same statement that performs the write.
 */
export function RoleSiteSelectionPage() {
  const { session, updateSession } = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const token = session?.accessToken;
  const currentAssignmentId = session?.assignmentId;

  const [assignments, setAssignments] = useState<MyRoleAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleCode, setRoleCode] = useState("");
  const [assignmentId, setAssignmentId] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .me(token)
      .then((me) => {
        if (cancelled) return;
        setAssignments(me.assignments);
        const preferred =
          me.assignments.find((a) => a.id === (currentAssignmentId ?? me.activeAssignmentId)) ??
          me.assignments[0];
        if (preferred) {
          setRoleCode(preferred.roleCode);
          setAssignmentId(preferred.id);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("selectRole.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
    // Runs once per session token — the assignment list is stable for a login.
    // `t` is intentionally omitted: the message is captured at failure time and
    // a language switch must not refetch the access list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, currentAssignmentId]);

  // One entry per Role; a Role may carry several scopes, which the second
  // control narrows.
  const roles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of assignments ?? []) seen.set(a.roleCode, a.roleName);
    return Array.from(seen, ([code, name]) => ({ code, name }));
  }, [assignments]);

  const scopes = useMemo(
    () => (assignments ?? []).filter((a) => a.roleCode === roleCode),
    [assignments, roleCode],
  );

  function chooseRole(nextRole: string) {
    setRoleCode(nextRole);
    const first = (assignments ?? []).find((a) => a.roleCode === nextRole);
    setAssignmentId(first?.id ?? "");
  }

  async function handleContinue() {
    if (!token) return;
    if (!assignmentId) {
      setError(
        t("common.form.missing", { fields: `${t("selectRole.role")}, ${t("selectRole.site")}` }),
      );
      return;
    }
    setError(null);
    // Epic 1 (§4.1 C): the choice is written to the session server-side.
    // Skipping the call when the server already has this assignment active
    // (single-Role users) is a round-trip saved, not an authority decision.
    if (assignmentId !== currentAssignmentId) {
      setPending(true);
      try {
        await api.switchRole(token, assignmentId);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("selectRole.switchFailed"));
        setPending(false);
        return;
      }
      setPending(false);
    }
    updateSession({ assignmentId });
    navigate("/", { replace: true });
  }

  if (!session) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-md space-y-4 rounded border border-line bg-panel p-6 shadow-xs">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t("selectRole.title")}</h1>
          <p className="text-sm text-ink-faint">{t("selectRole.subtitle")}</p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        {!assignments && !error && <Spinner label={t("selectRole.loading")} />}

        {assignments && assignments.length === 0 && (
          <Alert tone="warning">{t("selectRole.noRoles")}</Alert>
        )}

        {assignments && assignments.length > 0 && (
          <>
            {/* Placed above the role control, as asked: the language is a
                choice about the whole screen, so it comes before the choice
                that screen is asking for. */}
            <div className="flex justify-end">
              <LanguageSwitcher />
            </div>
            <Field label={t("selectRole.role")} required>
              <Select value={roleCode} onChange={(e) => chooseRole(e.target.value)}>
                {roles.map((role) => (
                  <option key={role.code} value={role.code}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t("selectRole.site")} required>
              <Select value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)}>
                {scopes.map((scope) => (
                  <option key={scope.id} value={scope.id}>
                    {scopeLabel(scope, t)}
                  </option>
                ))}
              </Select>
            </Field>

            <Button
              className="min-h-[44px] w-full"
              disabled={pending}
              onClick={() => void handleContinue()}
            >
              {pending ? t("selectRole.pending") : t("selectRole.continue")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
