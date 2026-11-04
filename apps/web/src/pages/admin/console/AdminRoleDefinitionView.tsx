/**
 * Epic 4 Wave 1 (§4.4 Gelombang 1) — Role definition.
 *
 * Covers roadmap steps 5–11a plus the 11b status read: create, permission
 * picker, copy-as-detached, impact-preview edit with the optimistic version
 * check, delete guard, and the Window picker that writes `role_window_access`.
 *
 * Two things the screen must not pretend to be:
 *
 * 1. `enforcementStatus` is the server's own reading of its API Resource →
 *    Window mapping, never a literal here. `"partial"` means at least one
 *    mutating route the server serves resolves to no Window and carries no
 *    exemption, so it is outside the read-only lock with nothing on record
 *    saying why; `"enforced"` means every one of them is mapped or exempt. The
 *    screen repeats whichever the server reported, on the surface that records
 *    the setting rather than in a tooltip.
 * 2. Nothing here is a security boundary. `selectable=false` marks an option
 *    the server will refuse; the picker leaves those visible but unselectable
 *    so an administrator can see what exists instead of guessing why a code is
 *    missing.
 *
 * The Window identity sent back is always a dictionary code the actor picked
 * from this list. No free-text Window code can be submitted.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../../auth/AuthContext";
import { useT } from "../../../i18n/LocaleProvider";
import {
  api,
  ApiError,
  type AdminRoleSummary,
  type RoleDefinition,
  type RoleDefinitionOptions,
  type RoleDefinitionPermissionOption,
  type RoleDefinitionWindowOption,
  type WindowAccessInput,
} from "../../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  StatusPill,
} from "../../../shell/components/ui";
import { OverlayDialog } from "../../../shell/components/OverlayDialog";
import { AdminSectionState } from "./AdminSection";

/* ------------------------------------------------------------------ draft */

interface WindowDraft {
  isReadWrite: boolean;
  isActive: boolean;
}

/** The two per-Window flags the roadmap fixes in step 11a. Named so a caller
 *  cannot pass a string that is not one of them. */
type WindowFlag = keyof WindowDraft;

interface DefinitionDraft {
  name: string;
  /** Raw textarea value: `""` is what an emptied description looks like while
   *  editing, and `toDescription()` is what turns it back into the `null` the
   *  server stores. Keeping the two apart is why the draft holds a string. */
  description: string;
  permissionCodes: string[];
  /** Keyed by Window code, so membership is one lookup and a removal cannot
   *  leave a stale per-Window flag behind. */
  windows: Record<string, WindowDraft>;
  includedRoleCodes: string[];
}

/** `null` (never had a description) and `""` (someone typed nothing) both
 *  render as an empty textarea, because that is the same editing experience —
 *  but `null` round-trips as `null` unless the operator actually types. */
function toDescription(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function draftFromDefinition(definition: RoleDefinition): DefinitionDraft {
  const windows: Record<string, WindowDraft> = {};
  for (const window of definition.windows) {
    windows[window.windowCode] = {
      isReadWrite: window.isReadWrite,
      isActive: window.isActive,
    };
  }
  return {
    name: definition.name,
    description: definition.description ?? "",
    permissionCodes: [...definition.permissionCodes].sort(),
    windows,
    includedRoleCodes: [...definition.includedRoleCodes].sort(),
  };
}

/** The server hashes the definition itself, so the client only has to send the
 *  same fields back. Comparison here decides whether Save is offered. */
function sameDraft(a: DefinitionDraft, b: DefinitionDraft): boolean {
  if (a.name !== b.name) return false;
  if (a.description !== b.description) return false;
  if (a.permissionCodes.length !== b.permissionCodes.length) return false;
  if (a.permissionCodes.some((code, index) => code !== b.permissionCodes[index])) return false;
  if (a.includedRoleCodes.length !== b.includedRoleCodes.length) return false;
  if (a.includedRoleCodes.some((code, index) => code !== b.includedRoleCodes[index])) return false;
  const codes = Object.keys(a.windows);
  if (codes.length !== Object.keys(b.windows).length) return false;
  return codes.every((code) => {
    const other = b.windows[code];
    const mine = a.windows[code]!;
    return (
      other !== undefined &&
      mine.isReadWrite === other.isReadWrite &&
      mine.isActive === other.isActive
    );
  });
}

/* -------------------------------------------------------------- main view */

export function AdminRoleDefinitionView({
  roleCode,
  canManage,
  canRead,
  onBack,
}: {
  roleCode: string;
  /** `role.manage` on a tenant-scoped assignment — the server's write gate. */
  canManage: boolean;
  /** `config.read` — the server's read gate for the definition and options. */
  canRead: boolean;
  onBack: () => void;
}) {
  const { session } = useAuth();
  const t = useT();
  const token = session!.accessToken;

  const [definition, setDefinition] = useState<RoleDefinition | null>(null);
  const [options, setOptions] = useState<RoleDefinitionOptions | null>(null);
  const [roles, setRoles] = useState<AdminRoleSummary[] | null>(null);
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "denied" | "session-expired" | "error"
  >("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DefinitionDraft | null>(null);

  const [saveState, setSaveState] = useState<"idle" | "previewing" | "committing">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    previewHash: string;
    affectedUserCount: number;
    version: number;
  } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Epic 4 open item 2 — the lifecycle switch. Deactivation is a separate
  // action from editing the definition, so it keeps its own dialog, pending
  // flag, and error line rather than riding the preview/commit flow.
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const [permissionQuery, setPermissionQuery] = useState("");
  const [permissionModule, setPermissionModule] = useState("all");
  const [permissionSelectedOnly, setPermissionSelectedOnly] = useState(false);
  const [windowQuery, setWindowQuery] = useState("");
  const [windowModule, setWindowModule] = useState("all");
  const [windowSelectedOnly, setWindowSelectedOnly] = useState(false);

  // A definition reload must not land on a draft the actor has already moved
  // on from, so every in-flight load carries a generation.
  const generation = useRef(0);
  const lifetime = useRef(0);
  useEffect(
    () => () => {
      lifetime.current += 1;
    },
    [],
  );

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoadState("loading");
    setLoadError(null);
    try {
      const [nextDefinition, nextOptions, nextRoles] = await Promise.all([
        api.roleDefinition(token, roleCode),
        api.roleDefinitionOptions(token),
        api.adminRoles(token),
      ]);
      if (generation.current !== requestGeneration) return;
      setDefinition(nextDefinition);
      setOptions(nextOptions);
      setRoles(nextRoles);
      setDraft(draftFromDefinition(nextDefinition));
      setLoadState("ready");
    } catch (err) {
      if (generation.current !== requestGeneration) return;
      if (err instanceof ApiError && err.status === 403) {
        setLoadState("denied");
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        setLoadState("session-expired");
        return;
      }
      setLoadError(
        err instanceof ApiError ? err.message : t("roleDef.loadFailed"),
      );
      setLoadState("error");
    }
  }, [token, roleCode, t]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const dirty = useMemo(() => {
    if (!definition || !draft) return false;
    return !sameDraft(draft, draftFromDefinition(definition));
  }, [definition, draft]);

  const orderedWindowCodes = useMemo(() => {
    if (!options || !draft) return [];
    // Order comes from the dictionary option list, not from insertion, so two
    // administrators selecting the same set send the same array and the same
    // server-side hash.
    return options.windows
      .map((window) => window.code)
      .filter((code) => draft.windows[code] !== undefined);
  }, [draft, options]);

  const toWindows = useCallback(
    (): WindowAccessInput[] =>
      orderedWindowCodes.map((code) => ({
        windowCode: code,
        isReadWrite: draft!.windows[code]!.isReadWrite,
        isActive: draft!.windows[code]!.isActive,
      })),
    [draft, orderedWindowCodes],
  );

  const startPreview = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!definition || !draft || saveState !== "idle") return;
      const name = draft.name.trim();
      if (name.length === 0) {
        setSaveError(t("roleDef.nameRequired"));
        return;
      }
      setSaveError(null);
      setSaved(null);
      setSaveState("previewing");
      try {
        const result = await api.previewRoleDefinition(token, roleCode, {
          version: definition.version,
          name,
          description: toDescription(draft.description),
          permissionCodes: draft.permissionCodes,
          windows: toWindows(),
          includedRoleCodes: draft.includedRoleCodes,
        });
        setPreview({
          previewHash: result.previewHash,
          affectedUserCount: result.affectedUserCount,
          version: result.role.version,
        });
      } catch (err) {
        setSaveError(
          err instanceof ApiError ? err.message : t("roleDef.previewFailed"),
        );
      } finally {
        setSaveState("idle");
      }
    },
    [definition, draft, saveState, token, roleCode, toWindows, t],
  );

  const commit = useCallback(async () => {
    if (!preview || !draft || saveState !== "idle") return;
    setSaveError(null);
    setSaveState("committing");
    try {
      const updated = await api.updateRoleDefinition(token, roleCode, {
        version: preview.version,
        name: draft.name.trim(),
        description: toDescription(draft.description),
        permissionCodes: draft.permissionCodes,
        windows: toWindows(),
        includedRoleCodes: draft.includedRoleCodes,
        previewHash: preview.previewHash,
        confirm: true,
      });
      setDefinition(updated);
      setDraft(draftFromDefinition(updated));
      setPreview(null);
      setSaved(
        t("roleDef.saveSuccess", { version: updated.version }),
      );
    } catch (err) {
      setPreview(null);
      setSaveError(
        err instanceof ApiError ? err.message : t("roleDef.saveFailed"),
      );
    } finally {
      setSaveState("idle");
    }
  }, [preview, draft, saveState, token, roleCode, toWindows, t]);

  const confirmDelete = useCallback(async () => {
    if (deletePending) return;
    const life = lifetime.current;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await api.deleteRoleDefinition(token, roleCode);
      if (lifetime.current !== life) return;
      setDeleteOpen(false);
      onBack();
    } catch (err) {
      if (lifetime.current !== life) return;
      setDeleteError(err instanceof ApiError ? err.message : t("roleDef.deleteFailed"));
    } finally {
      if (lifetime.current === life) setDeletePending(false);
    }
  }, [deletePending, token, roleCode, onBack, t]);

  const confirmLifecycle = useCallback(async () => {
    if (lifecyclePending || !definition) return;
    const life = lifetime.current;
    setLifecyclePending(true);
    setLifecycleError(null);
    try {
      // The definition is replaced with what the server returned rather than
      // patched locally, so `version` and `isActive` come from the write that
      // produced them — the same rule the definition save follows.
      const updated = await api.setRoleDefinitionActive(
        token,
        roleCode,
        !definition.isActive,
      );
      if (lifetime.current !== life) return;
      setDefinition(updated);
      setDraft(draftFromDefinition(updated));
      setPreview(null);
      setLifecycleOpen(false);
      setSaved(
        updated.isActive
          ? t("roleDef.reactivatedSuccess", { version: updated.version })
          : t("roleDef.deactivatedSuccess", { version: updated.version }),
      );
    } catch (err) {
      if (lifetime.current !== life) return;
      setLifecycleError(
        err instanceof ApiError ? err.message : t("roleDef.lifecycleFailed"),
      );
    } finally {
      if (lifetime.current === life) setLifecyclePending(false);
    }
  }, [lifecyclePending, definition, token, roleCode, t]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            {t("roleDef.backRoles")}
          </Button>
          <code className="font-mono text-xs text-ink-dim">{roleCode}</code>
        </div>
        {canManage && definition && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={lifecyclePending}
              onClick={() => {
                setLifecycleError(null);
                setLifecycleOpen(true);
              }}
            >
              {definition.isActive ? t("roleDef.deactivateRole") : t("roleDef.reactivateRole")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              {t("roleDef.deleteRole")}
            </Button>
          </div>
        )}
      </div>

      <AdminSectionState
        loading={loadState === "loading"}
        loadingLabel={t("roleDef.loadingDefinition")}
        denied={loadState === "denied" || !canRead}
        sessionExpired={loadState === "session-expired"}
        error={loadError}
        requiredPermission="config.read"
        onRetry={load}
      >
        {definition && options && draft && (
          <form onSubmit={startPreview} className="space-y-4">
            {saved && <Alert tone="success">{saved}</Alert>}
            {saveError && <Alert tone="error">{saveError}</Alert>}

            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-ink">{t("roleDef.roleHeading")}</h2>
                  <p className="mt-0.5 text-sm text-ink-dim">
                    {t("roleDef.roleCodeFixed", {
                      code: <code className="font-mono text-xs">{definition.code}</code>,
                      version: <span className="tabular-nums">{definition.version}</span>,
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {definition.isFullAccess && (
                    <StatusPill tone="warning">{t("roleDef.fullAccess")}</StatusPill>
                  )}
                  {definition.isActive ? (
                    <StatusPill tone="success">{t("roleDef.active")}</StatusPill>
                  ) : (
                    <StatusPill tone="neutral">{t("roleDef.inactive")}</StatusPill>
                  )}
                  <StatusPill tone={dirty ? "warning" : "neutral"}>
                    {dirty ? t("roleDef.unsavedChanges") : t("roleDef.matchesStored")}
                  </StatusPill>
                </div>
              </div>

              <div className="mt-4 max-w-md space-y-3">
                <Field label={t("roleDef.fieldName")} required hint={t("roleDef.fieldNameHint")}>
                  <Input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, name: event.target.value } : current,
                      )
                    }
                    disabled={!canManage}
                    maxLength={200}
                    required
                  />
                </Field>
                <Field
                  label={t("roleDef.fieldDescription")}
                  hint={t("roleDef.fieldDescriptionHint")}
                >
                  <textarea
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, description: event.target.value } : current,
                      )
                    }
                    disabled={!canManage}
                    maxLength={500}
                    rows={3}
                    className="w-full rounded border border-line-strong bg-panel px-3 py-2 text-sm text-ink focus-visible:border-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
                  />
                </Field>
                <p className="text-xs text-ink-dim tabular-nums">
                  {t("roleDef.charCount", { current: draft.description.length })}
                </p>
              </div>

              {definition.enforcementStatus === "enforced" ? (
                <div className="mt-4 rounded border border-status-ok bg-status-ok-soft p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone="success">{t("roleDef.enforcedPill")}</StatusPill>
                    <span className="text-sm font-medium text-status-ok">
                      {t("roleDef.enforcedTitle")}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-status-ok">{t("roleDef.enforcedBody")}</p>
                </div>
              ) : (
                <div className="mt-4 rounded border border-status-warn bg-status-warn-soft p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone="warning">{t("roleDef.partialPill")}</StatusPill>
                    <span className="text-sm font-medium text-status-warn">
                      {t("roleDef.partialTitle")}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-status-warn">{t("roleDef.partialBody")}</p>
                </div>
              )}
            </Card>

            <PermissionPicker
              options={options.permissions}
              selected={draft.permissionCodes}
              query={permissionQuery}
              onQueryChange={setPermissionQuery}
              module={permissionModule}
              onModuleChange={setPermissionModule}
              selectedOnly={permissionSelectedOnly}
              onSelectedOnlyChange={setPermissionSelectedOnly}
              disabled={!canManage}
              onToggle={(code) =>
                setDraft((current) => {
                  if (!current) return current;
                  const has = current.permissionCodes.includes(code);
                  const next = has
                    ? current.permissionCodes.filter((existing) => existing !== code)
                    : [...current.permissionCodes, code].sort();
                  return { ...current, permissionCodes: next };
                })
              }
              onClear={() =>
                setDraft((current) => (current ? { ...current, permissionCodes: [] } : current))
              }
            />

            <IncludedRolesPicker
              roles={roles}
              currentRoleCode={definition.code}
              selected={draft.includedRoleCodes}
              disabled={!canManage}
              onToggle={(code) =>
                setDraft((current) => {
                  if (!current) return current;
                  const has = current.includedRoleCodes.includes(code);
                  const next = has
                    ? current.includedRoleCodes.filter((existing) => existing !== code)
                    : [...current.includedRoleCodes, code].sort();
                  return { ...current, includedRoleCodes: next };
                })
              }
            />

            <WindowPicker
              options={options.windows}
              draft={draft}
              orderedCodes={orderedWindowCodes}
              query={windowQuery}
              onQueryChange={setWindowQuery}
              module={windowModule}
              onModuleChange={setWindowModule}
              selectedOnly={windowSelectedOnly}
              onSelectedOnlyChange={setWindowSelectedOnly}
              disabled={!canManage}
              onToggleWindow={(code) =>
                setDraft((current) => {
                  if (!current) return current;
                  const windows = { ...current.windows };
                  if (windows[code]) delete windows[code];
                  else windows[code] = { isReadWrite: false, isActive: true };
                  return { ...current, windows };
                })
              }
              onToggleFlag={(windowCode: string, flag: WindowFlag) =>
                setDraft((current) => {
                  if (!current) return current;
                  const existing = current.windows[windowCode];
                  if (!existing) return current;
                  return {
                    ...current,
                    windows: {
                      ...current.windows,
                      [windowCode]: { ...existing, [flag]: !existing[flag] },
                    },
                  };
                })
              }
            />

            {canManage && (
              <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-panel px-3 py-2">
                <p className="text-sm text-ink-dim" role="status" aria-live="polite">
                  {t("roleDef.statusBar", {
                    permissions: <span className="tabular-nums">{draft.permissionCodes.length}</span>,
                    windows: <span className="tabular-nums">{orderedWindowCodes.length}</span>,
                  })}
                  {dirty ? t("roleDef.statusUnsaved") : t("roleDef.statusClean")}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={!dirty || saveState !== "idle"}
                    onClick={() => definition && setDraft(draftFromDefinition(definition))}
                  >
                    {t("roleDef.discardChanges")}
                  </Button>
                  <Button type="submit" disabled={!dirty || saveState !== "idle"}>
                    {saveState === "idle" ? t("roleDef.reviewImpact") : t("roleDef.checking")}
                  </Button>
                </div>
              </div>
            )}

            {!canManage && (
              <Alert tone="info">
                {t("roleDef.viewOnlyAlert")}
              </Alert>
            )}
          </form>
        )}
      </AdminSectionState>

      <OverlayDialog
        open={preview !== null}
        title={t("roleDef.previewTitle")}
        description={t("roleDef.previewDescription")}
        pending={saveState === "committing"}
        onClose={() => setPreview(null)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setPreview(null)}
              disabled={saveState === "committing"}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void commit()} disabled={saveState === "committing"}>
              {saveState === "committing" ? t("roleDef.saving") : t("roleDef.confirmSave")}
            </Button>
          </>
        }
      >
        {preview && draft && (
          <div className="space-y-3">
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-dim">{t("roleDef.previewName")}</dt>
              <dd className="wrap-break-word text-ink">{draft.name.trim()}</dd>
              <dt className="text-ink-dim">{t("roleDef.previewDesc")}</dt>
              <dd className="wrap-break-word text-ink">
                {toDescription(draft.description) ?? (
                  <span className="text-ink-faint">{t("roleDef.previewNone")}</span>
                )}
              </dd>
              <dt className="text-ink-dim">{t("roleDef.previewPermissions")}</dt>
              <dd className="tabular-nums text-ink">{draft.permissionCodes.length}</dd>
              <dt className="text-ink-dim">{t("roleDef.previewWindows")}</dt>
              <dd className="tabular-nums text-ink">{orderedWindowCodes.length}</dd>
              <dt className="text-ink-dim">{t("roleDef.previewReadOnly")}</dt>
              <dd className="tabular-nums text-ink">
                {orderedWindowCodes.filter((code) => !draft.windows[code]!.isReadWrite).length}
              </dd>
              <dt className="text-ink-dim">{t("roleDef.previewInactive")}</dt>
              <dd className="tabular-nums text-ink">
                {orderedWindowCodes.filter((code) => !draft.windows[code]!.isActive).length}
              </dd>
              <dt className="text-ink-dim">{t("roleDef.previewUsers")}</dt>
              <dd className="tabular-nums text-ink">{preview.affectedUserCount}</dd>
            </dl>

            {preview.affectedUserCount > 0 && (
              <Alert tone="warning">
                {t("roleDef.previewImpactWarning", {
                  count: <span className="tabular-nums">{preview.affectedUserCount}</span>,
                })}
              </Alert>
            )}

            <p className="text-xs text-ink-faint">
              {t("roleDef.previewRef", {
                ref: (
                  <code className="font-mono text-ink-dim">
                    {preview.previewHash.slice(0, 16)}
                  </code>
                ),
              })}
            </p>
          </div>
        )}
      </OverlayDialog>

      <OverlayDialog
        open={deleteOpen}
        title={t("roleDef.deleteTitle", { code: roleCode })}
        description={t("roleDef.deleteDescription")}
        pending={deletePending}
        onClose={() => setDeleteOpen(false)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeleteOpen(false)}
              disabled={deletePending}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void confirmDelete()} disabled={deletePending}>
              {deletePending ? t("roleDef.deleting") : t("roleDef.deleteRole")}
            </Button>
          </>
        }
      >
        {deleteError && <Alert tone="error">{deleteError}</Alert>}
      </OverlayDialog>

      {definition && (
        <OverlayDialog
          open={lifecycleOpen}
          title={
            definition.isActive
              ? t("roleDef.deactivateTitle", { code: roleCode })
              : t("roleDef.reactivateTitle", { code: roleCode })
          }
          description={
            definition.isActive
              ? t("roleDef.deactivateDescription")
              : t("roleDef.reactivateDescription")
          }
          pending={lifecyclePending}
          onClose={() => setLifecycleOpen(false)}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setLifecycleOpen(false)}
                disabled={lifecyclePending}
              >
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void confirmLifecycle()} disabled={lifecyclePending}>
                {lifecyclePending
                  ? t("roleDef.saving")
                  : definition.isActive
                    ? t("roleDef.deactivateRole")
                    : t("roleDef.reactivateRole")}
              </Button>
            </>
          }
        >
          {lifecycleError && <Alert tone="error">{lifecycleError}</Alert>}
        </OverlayDialog>
      )}
    </>
  );
}

/* ------------------------------------------------------- permission picker */

function PermissionPicker({
  options,
  selected,
  query,
  onQueryChange,
  module,
  onModuleChange,
  selectedOnly,
  onSelectedOnlyChange,
  disabled,
  onToggle,
  onClear,
}: {
  options: RoleDefinitionPermissionOption[];
  selected: string[];
  query: string;
  onQueryChange: (value: string) => void;
  module: string;
  onModuleChange: (value: string) => void;
  selectedOnly: boolean;
  onSelectedOnlyChange: (value: boolean) => void;
  disabled: boolean;
  onToggle: (code: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  const modules = useMemo(() => {
    const seen = new Map<string, number>();
    for (const option of options) {
      const key = option.moduleCode ?? "unattributed";
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [options]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return options.filter((option) => {
      if (module !== "all" && (option.moduleCode ?? "unattributed") !== module) return false;
      if (selectedOnly && !selectedSet.has(option.code)) return false;
      if (!normalized) return true;
      return `${option.code} ${option.description}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [options, module, selectedOnly, selectedSet, query]);

  const unselectable = options.filter((option) => !option.selectable).length;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{t("roleDef.permissionsHeading")}</h2>
          <p className="mt-0.5 text-sm text-ink-dim">
            {t("roleDef.permissionsDescription")}
          </p>
        </div>
        <p className="text-sm tabular-nums text-ink-dim" role="status" aria-live="polite">
          {t("roleDef.permSelected", {
            count: <span className="tabular-nums">{selected.length}</span>,
          })}{" "}
          ·{" "}
          {t("roleDef.permShown", {
            count: <span className="tabular-nums">{visible.length}</span>,
          })}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label={t("roleDef.permSearchLabel")}>
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("roleDef.permSearchPlaceholder")}
            autoComplete="off"
            aria-label={t("roleDef.permSearchAria")}
            className="sm:w-64"
          />
        </Field>
        <Field label={t("roleDef.permModuleLabel")}>
          <select
            value={module}
            onChange={(event) => onModuleChange(event.target.value)}
            aria-label={t("roleDef.permModuleAria")}
            className="mt-1 min-h-[44px] rounded border border-line-strong bg-panel-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent-soft sm:min-h-[36px]"
          >
            <option value="all">{t("roleDef.permModuleAll")}</option>
            {modules.map(([code, count]) => (
              <option key={code} value={code}>
                {code} ({count})
              </option>
            ))}
          </select>
        </Field>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink-dim sm:min-h-[36px]">
          <input
            type="checkbox"
            checked={selectedOnly}
            onChange={(event) => onSelectedOnlyChange(event.target.checked)}
            className="h-4 w-4 accent-(--accent)"
          />
          {t("roleDef.permSelectedOnly")}
        </label>
        <div className="flex flex-1 items-center justify-end gap-2">
          {unselectable > 0 && (
            <p className="text-xs text-ink-faint">
              {t("roleDef.permNotGrantable", {
                count: <span className="tabular-nums">{unselectable}</span>,
              })}
            </p>
          )}
          <Button
            variant="ghost"
            type="button"
            onClick={onClear}
            disabled={disabled || selected.length === 0}
          >
            {t("roleDef.permClearSelection")}
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="mt-3 rounded border border-dashed border-line-strong bg-panel-2 px-4 py-6 text-center text-sm text-ink-dim">
          {t("roleDef.permEmpty")}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded border border-line">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line-strong">
                <th scope="col" className="w-10 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  <span className="sr-only">{t("roleDef.permColGrant")}</span>
                </th>
                <th scope="col" className="px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  {t("roleDef.permColPermission")}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  {t("roleDef.permColModule")}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  {t("roleDef.permColAvailability")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((option) => {
                const isSelected = selectedSet.has(option.code);
                const reason = !option.selectable
                  ? option.moduleCode === null
                    ? t("roleDef.permReasonNoModule")
                    : !option.isActive
                      ? t("roleDef.permReasonNotRegistered")
                      : t("roleDef.permReasonOutside")
                  : null;
                return (
                  <tr
                    key={option.code}
                    className={`border-b border-line last:border-b-0 ${
                      isSelected ? "bg-accent-soft" : "hover:bg-panel-2"
                    }`}
                  >
                    <td className="px-3 align-middle">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={disabled || !option.selectable}
                        onChange={() => onToggle(option.code)}
                        aria-label={t("roleDef.permGrantAria", { code: option.code })}
                        className="h-4 w-4 accent-(--accent)"
                      />
                    </td>
                    <td className="min-h-row px-3 align-middle">
                      <code className="break-all font-mono text-xs font-medium text-ink">
                        {option.code}
                      </code>
                      <p className="text-xs text-ink-dim">{option.description}</p>
                    </td>
                    <td className="min-h-row px-3 align-middle text-xs text-ink-dim">
                      {option.moduleCode ?? "—"}
                    </td>
                    <td className="min-h-row px-3 align-middle text-xs">
                      {reason ? (
                        <span className="text-ink-faint">{reason}</span>
                      ) : (
                        <span className="text-ink-dim">{t("roleDef.permGrantable")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* --------------------------------------------------------- included roles */

/** iDempiere AD_Role_Included parity. The option list is the tenant's role
 *  catalog (GET /admin/roles), which the server already filters to what the
 *  actor may see; the server still refuses self-links, inactive roles, and
 *  cycles, so this picker is a convenience, not the boundary.
 *
 *  ponytail: the catalog is the full role summary list, not an
 *  "included-role options" endpoint - inactive roles are hidden here but the
 *  server remains the authority; add a dedicated options route only if the
 *  summary list ever becomes too coarse. */
function IncludedRolesPicker({
  roles,
  currentRoleCode,
  selected,
  disabled,
  onToggle,
}: {
  /** The catalog loads with the rest of the page, so it is never null here. */
  roles: AdminRoleSummary[] | null;
  currentRoleCode: string;
  selected: string[];
  disabled: boolean;
  onToggle: (code: string) => void;
}) {
  const t = useT();
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const options = useMemo(() => {
    if (!roles) return [];
    return roles
      .filter((role) => role.code !== currentRoleCode && role.isActive)
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [roles, currentRoleCode]);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{t("roleDef.includedHeading")}</h2>
          <p className="mt-0.5 text-sm text-ink-dim">{t("roleDef.includedDescription")}</p>
        </div>
        <p className="text-sm text-ink-dim" role="status" aria-live="polite">
          {t("roleDef.includedSelected", { count: <span className="tabular-nums">{selected.length}</span> })}
        </p>
      </div>

      {options.length === 0 ? (
        <p className="mt-3 rounded border border-dashed border-line-strong bg-panel-2 px-4 py-6 text-center text-sm text-ink-dim">
          {t("roleDef.includedEmpty")}
        </p>
      ) : (
        <ul className="mt-3 rounded border border-line">
          {options.map((option) => (
            <li
              key={option.code}
              className={
                'border-b border-line last:border-b-0 ' +
                (selectedSet.has(option.code) ? 'bg-accent-soft' : 'hover:bg-panel-2')
              }
            >
              <label className="flex min-h-row items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedSet.has(option.code)}
                  disabled={disabled}
                  onChange={() => onToggle(option.code)}
                  aria-label={t("roleDef.includedToggleAria", { code: option.code })}
                  className="h-4 w-4 accent-(--accent)"
                />
                <code className="font-mono text-xs font-medium text-ink">{option.code}</code>
                <span className="min-w-0 truncate text-ink-dim">{option.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------- window picker */

function WindowPicker({
  options,
  draft,
  orderedCodes,
  query,
  onQueryChange,
  module,
  onModuleChange,
  selectedOnly,
  onSelectedOnlyChange,
  disabled,
  onToggleWindow,
  onToggleFlag,
}: {
  options: RoleDefinitionWindowOption[];
  draft: DefinitionDraft;
  orderedCodes: string[];
  query: string;
  onQueryChange: (value: string) => void;
  module: string;
  onModuleChange: (value: string) => void;
  selectedOnly: boolean;
  onSelectedOnlyChange: (value: boolean) => void;
  disabled: boolean;
  onToggleWindow: (code: string) => void;
  onToggleFlag: (windowCode: string, flag: WindowFlag) => void;
}) {
  const t = useT();
  const modules = useMemo(() => {
    const seen = new Map<string, number>();
    for (const option of options) {
      seen.set(option.moduleCode, (seen.get(option.moduleCode) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [options]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return options.filter((option) => {
      if (module !== "all" && option.moduleCode !== module) return false;
      if (selectedOnly && draft.windows[option.code] === undefined) return false;
      if (!normalized) return true;
      return `${option.code} ${option.name} ${option.requiredPermissions.join(" ")}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [options, module, selectedOnly, draft.windows, query]);

  const readOnlyCount = orderedCodes.filter((code) => !draft.windows[code]!.isReadWrite).length;
  const inactiveCount = orderedCodes.filter((code) => !draft.windows[code]!.isActive).length;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{t("roleDef.windowsHeading")}</h2>
          <p className="mt-0.5 text-sm text-ink-dim">{t("roleDef.windowsDescription")}</p>
        </div>
        <p className="text-sm text-ink-dim" role="status" aria-live="polite">
          {t("roleDef.winSelected", { count: <span className="tabular-nums">{orderedCodes.length}</span> })}
          {" · "}
          {t("roleDef.winReadOnly", { count: <span className="tabular-nums">{readOnlyCount}</span> })}
          {" · "}
          {t("roleDef.winInactive", { count: <span className="tabular-nums">{inactiveCount}</span> })}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label={t("roleDef.winSearchLabel")}>
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("roleDef.winSearchPlaceholder")}
            autoComplete="off"
            aria-label={t("roleDef.winSearchAria")}
            className="sm:w-72"
          />
        </Field>
        <Field label={t("roleDef.winModuleLabel")}>
          <select
            value={module}
            onChange={(event) => onModuleChange(event.target.value)}
            aria-label={t("roleDef.winModuleAria")}
            className="mt-1 min-h-[44px] rounded border border-line-strong bg-panel-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent-soft sm:min-h-[36px]"
          >
            <option value="all">{t("roleDef.winModuleAll")}</option>
            {modules.map(([code, count]) => (
              <option key={code} value={code}>
                {code} ({count})
              </option>
            ))}
          </select>
        </Field>
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink-dim sm:min-h-[36px]">
          <input
            type="checkbox"
            checked={selectedOnly}
            onChange={(event) => onSelectedOnlyChange(event.target.checked)}
            className="h-4 w-4 accent-(--accent)"
          />
          {t("roleDef.winSelectedOnly")}
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="mt-3 rounded border border-dashed border-line-strong bg-panel-2 px-4 py-6 text-center text-sm text-ink-dim">
          {t("roleDef.winEmpty")}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded border border-line">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line-strong">
                <th scope="col" className="w-10 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  <span className="sr-only">{t("roleDef.winColInclude")}</span>
                </th>
                <th scope="col" className="px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  {t("roleDef.winColWindow")}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  {t("roleDef.winColRequired")}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  {t("roleDef.winColWrite")}
                </th>
                <th scope="col" className="px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.055em] text-ink-faint">
                  {t("roleDef.winColActive")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((option) => {
                const state = draft.windows[option.code];
                const included = state !== undefined;
                return (
                  <tr
                    key={option.code}
                    className={`border-b border-line last:border-b-0 ${
                      included ? "bg-accent-soft" : "hover:bg-panel-2"
                    }`}
                  >
                    <td className="px-3 align-middle">
                      <input
                        type="checkbox"
                        checked={included}
                        disabled={disabled || !option.selectable}
                        onChange={() => onToggleWindow(option.code)}
                        aria-label={t("roleDef.winIncludeAria", { code: option.code })}
                        className="h-4 w-4 accent-(--accent)"
                      />
                    </td>
                    <td className="min-h-row px-3 align-middle">
                      <code className="break-all font-mono text-xs font-medium text-ink">
                        {option.code}
                      </code>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-dim">
                        <span>{option.name}</span>
                        {option.isDetail && <Badge>{t("roleDef.winDetail")}</Badge>}
                        {!option.selectable && (
                          <span className="text-ink-faint">{t("roleDef.winNotGrantable")}</span>
                        )}
                      </div>
                    </td>
                    <td className="min-h-row px-3 align-middle text-xs text-ink-dim">
                      {option.requiredPermissions.length === 0 ? (
                        "—"
                      ) : (
                        <span className="break-all font-mono">{option.requiredPermissions.join(", ")}</span>
                      )}
                    </td>
                    <td className="min-h-row px-3 align-middle">
                      <label className="flex items-center gap-1.5 text-xs text-ink-dim">
                        <input
                          type="checkbox"
                          checked={state?.isReadWrite ?? false}
                          disabled={disabled || !included}
                          onChange={() => onToggleFlag(option.code, "isReadWrite")}
                          aria-label={t("roleDef.winWriteAria", { code: option.code })}
                          className="h-4 w-4 accent-(--accent)"
                        />
                        {state ? (state.isReadWrite ? t("roleDef.winReadWrite") : t("roleDef.winReadOnlyLabel")) : "—"}
                      </label>
                    </td>
                    <td className="min-h-row px-3 align-middle">
                      <label className="flex items-center gap-1.5 text-xs text-ink-dim">
                        <input
                          type="checkbox"
                          checked={state ? state.isActive : false}
                          disabled={disabled || !included}
                          onChange={() => onToggleFlag(option.code, "isActive")}
                          aria-label={t("roleDef.winActiveAria", { code: option.code })}
                          className="h-4 w-4 accent-(--accent)"
                        />
                        {state ? (state.isActive ? t("roleDef.winActiveLabel") : t("roleDef.winInactiveLabel")) : "—"}
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* --------------------------------------------------------- create and copy */

export function CreateRoleDialog({
  open,
  mode,
  sourceCode,
  canManage,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** `create` writes an empty definition; `copy` clones grants without users. */
  mode: "create" | "copy";
  sourceCode?: string;
  canManage: boolean;
  onClose: () => void;
  onCreated: (roleCode: string) => void;
}) {
  const { session } = useAuth();
  const t = useT();
  const token = session!.accessToken;
  const formRef = useRef<HTMLFormElement>(null);
  const lifetime = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPending(false);
  }, [open]);

  useEffect(
    () => () => {
      lifetime.current += 1;
    },
    [],
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending || !formRef.current || !canManage) return;
      const data = new FormData(formRef.current);
      const code = String(data.get("code") ?? "").trim();
      const name = String(data.get("name") ?? "").trim();
      const description = toDescription(String(data.get("description") ?? ""));
      if (code.length === 0 || name.length === 0) {
        setError(t("roleDef.createValidation"));
        return;
      }
      const life = lifetime.current;
      setError(null);
      setPending(true);
      try {
        if (mode === "copy") {
          // No description sent: the copy carries the source's, which is the
          // documented meaning of an omitted field on that route.
          await api.copyRoleDefinition(token, sourceCode ?? "", { code, name });
        } else {
          await api.createRoleDefinition(token, {
            code,
            name,
            description,
            permissionCodes: [],
            windows: [],
            includedRoleCodes: [],
          });
        }
        if (lifetime.current !== life) return;
        onCreated(code);
      } catch (err) {
        if (lifetime.current !== life) return;
        setError(err instanceof ApiError ? err.message : t("roleDef.createFailed"));
      } finally {
        if (lifetime.current === life) setPending(false);
      }
    },
    [pending, canManage, mode, sourceCode, token, onCreated, t],
  );

  return (
    <OverlayDialog
      open={open}
      title={mode === "copy" ? t("roleDef.copyTitle") : t("roleDef.createTitle")}
      description={
        mode === "copy"
          ? t("roleDef.copyDescription", { source: sourceCode ?? "" })
          : t("roleDef.createDescription")
      }
      pending={pending}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="create-role-form" disabled={pending || !canManage}>
            {pending ? t("roleDef.creating") : mode === "copy" ? t("roleDef.copyBtn") : t("roleDef.createBtn")}
          </Button>
        </>
      }
    >
      <form id="create-role-form" ref={formRef} onSubmit={submit} className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label={t("roleDef.fieldCode")} required hint={t("roleDef.fieldCodeHint")}>
          <Input name="code" maxLength={100} autoComplete="off" required disabled={pending} />
        </Field>
        <Field label={t("roleDef.fieldName")} required>
          <Input name="name" maxLength={200} autoComplete="off" required disabled={pending} />
        </Field>
        {mode === "create" && (
          <Field label={t("roleDef.fieldDescription")} hint={t("roleDef.fieldDescHintCopy")}>
            <textarea
              name="description"
              maxLength={500}
              rows={3}
              disabled={pending}
              className="w-full rounded border border-line-strong bg-panel px-3 py-2 text-sm text-ink focus-visible:border-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            />
          </Field>
        )}
      </form>
    </OverlayDialog>
  );
}
