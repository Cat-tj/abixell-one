/**
 * Checkpoint 1C.1 — Reusable enterprise Application Shell.
 *
 * Replaces the Phase 0 static placeholder shell. The SAME shell renders
 * for every Tenant/client (ADR-0003); what differs — the workspace title
 * (Tenant name) and which navigation sections appear — is driven by data
 * (Tenant record + the user's granted permissions), never a per-client
 * build.
 *
 * Responsibilities:
 *  - Fetch the signed-in user's context once (`/me` + `/tenants/me`) and
 *    expose it via ShellContext so nested pages don't each re-fetch it.
 *  - Render responsive, grouped, capability-gated navigation (persistent
 *    sidebar on desktop, an accessible overlay drawer below 1024px).
 *  - Own the workspace header, scope summary, and sign-out affordances.
 *  - Render the active section through <Outlet/>.
 *
 * Navigation is capability-gated for UX only — see capabilities.ts. All
 * authorization remains backend-enforced.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type MenuNode } from "../../lib/api";
import {
  activeServedModuleCodes,
  filterServedNav,
  servedNavGroups,
  type ServedNavGroup,
  type ServedNavPage,
} from "../../lib/servedNav";
import { GUARD_ENFORCE, evaluateRouteAccess, isEntryFlowRoute } from "../../lib/routeRegistry";
import { Alert, Button, Spinner } from "../components/ui";
import { ThemeToggle } from "../components/ThemeToggle";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { UserMenu } from "../components/UserMenu";
import { SwitchRoleDialog } from "../components/SwitchRoleDialog";
import { useOnlineStatus } from "../useOnlineStatus";
import { useLocale, useT } from "../../i18n/LocaleProvider";
import { moduleIcon, pageIcon, childPageIcon } from "../navIcons";

interface ShellContextValue {
  /** Raw permission codes from `GET /me`. */
  permissions: string[];
  /** Data-Scope types the actor holds (customer / organization_unit / tenant). */
  scopeTypes: string[];
  /** Active module codes reported by the tenant-scoped `GET /me`. */
  activeModuleCodes: string[];
  /**
   * The navigation the server filtered for THIS caller (§4.3 step 7), shaped
   * for rendering. The sidebar and Overview both render from it — a page that
   * needs destinations must read them here, never from `capabilities.ts`,
   * which describes the whole application rather than this caller's view.
   */
  navGroups: ServedNavGroup[];
  userId: string;
  activeRoleCode: string | null;
  tenantName: string;
  setTenantName: (name: string) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** Read the shell-provided user context from within a routed page. */
export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within AppShell");
  return ctx;
}

/**
 * One navigation row (§4.3 step 6).
 *
 * A page the server marked `locked` is rendered as text, never as a link: the
 * caller's role cannot open it, so an anchor would only produce a denied page
 * on click. It stays visible with the reason the server sent, which is the
 * whole point of the state — a role that cannot do something should still be
 * able to see that the function exists and what to ask an administrator for
 * ("MODUL AKTIF + role tidak boleh → menu tampil, NONAKTIF + keterangan").
 *
 * The reason is rendered as visible text, not a `title` alone: a tooltip is
 * unreachable on touch and easy to miss with a keyboard.
 */
function NavRow({
  page,
  nested,
  collapsed,
  onNavigate,
  allPaths = [],
}: {
  page: ServedNavPage;
  nested: boolean;
  /** Every menu path, so a parent path (/project-delivery) is not shown as
   * active while a more specific menu entry (/project-delivery/advanced/…) is. */
  allPaths?: string[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = nested ? childPageIcon(page.code) : pageIcon(page.code);
  const { pathname } = useLocation();
  const base = collapsed
    ? "flex min-h-[44px] items-center justify-center rounded-md"
    : nested
      ? "flex min-h-[44px] items-center gap-2.5 rounded-md px-3 py-1 text-[0.88rem] font-semibold lg:min-h-[38px]"
      : "flex min-h-[44px] items-center gap-3 rounded-md px-3 py-1 text-[0.92rem] font-semibold lg:min-h-[42px]";

  const shadowed = allPaths.some(
    (other) =>
      other !== page.path &&
      other.startsWith(`${page.path}/`) &&
      (pathname === other || pathname.startsWith(`${other}/`)),
  );

  if (page.locked) {
    return (
      <div
        className={`${base} cursor-not-allowed text-ink-faint`}
        aria-disabled="true"
        data-nav-locked={page.code}
        title={collapsed ? page.label : undefined}
      >
        {collapsed ? (
          <Icon className="h-4 w-4 shrink-0" />
        ) : (
          <>
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{page.label}</span>
            {page.lockedReason && (
              <span className="text-[11px] leading-snug text-ink-faint">{page.lockedReason}</span>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <NavLink
      to={page.path}
      end={page.path === "/"}
      onClick={onNavigate}
      title={collapsed ? page.label : undefined}
      className={({ isActive }: { isActive: boolean }) =>
        `${base} transition-colors ${
          isActive && !shadowed
            ? "bg-accent-soft font-extrabold text-accent [&>svg]:text-accent"
            : "text-ink-dim hover:bg-panel-2 [&>svg]:text-ink-faint"
        }`
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{page.label}</span>}
    </NavLink>
  );
}

function scopeSummary(scopeTypes: string[], t: ReturnType<typeof useT>): string {
  const labels = [
    scopeTypes.includes("tenant") ? t("shell.scopeTenant") : null,
    scopeTypes.includes("organization_unit") ? t("shell.scopeOrgUnit") : null,
    scopeTypes.includes("customer") ? t("shell.scopeCustomer") : null,
  ].filter((label): label is string => label !== null);

  return labels.length > 0 ? labels.join(" · ") : t("shell.scopeNone");
}

function NavigationContent({
  groups,
  query,
  onQueryChange,
  expandedModules,
  onToggleModule,
  collapsed,
  onExpand,
  onNavigate,
  filterId,
}: {
  groups: ServedNavGroup[];
  query: string;
  onQueryChange: (query: string) => void;
  expandedModules: Record<string, boolean>;
  onToggleModule: (moduleCode: string) => void;
  collapsed: boolean;
  onExpand?: () => void;
  onNavigate?: () => void;
  filterId: string;
}) {
  const t = useT();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(
    () => filterServedNav(groups, query),
    [groups, query],
  );
  const allPaths = useMemo(
    () =>
      groups.flatMap((group) =>
        group.nodes.flatMap((node) => (node.type === "page" ? [node.path] : node.pages.map((p) => p.path))),
      ),
    [groups],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!collapsed && (
        <div className="px-3 pb-3">
          <label htmlFor={filterId} className="sr-only">
            {t("shell.filterNavigation")}
          </label>
          <div className="relative">
            <input
              ref={filterInputRef}
              id={filterId}
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("shell.filterNavigation")}
              autoComplete="off"
              className="min-h-[44px] w-full rounded-full border border-line-strong bg-panel px-4 pr-10 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden focus:ring-2 focus:border-accent lg:min-h-[40px]"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  onQueryChange("");
                  filterInputRef.current?.focus();
                }}
                aria-label={t("shell.clearFilter")}
                className="absolute inset-y-0 right-0 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-r text-lg leading-none text-ink-faint hover:text-ink-dim focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent lg:min-h-[36px] lg:min-w-[36px]"
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

      <nav aria-label={t("shell.primaryNavigation")} className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-4">
        {filteredGroups.length > 0 ? (
          <div className={collapsed ? "space-y-2" : "space-y-4"}>
            {filteredGroups.map((group) => (
              <section key={group.key} aria-labelledby={`${filterId}-${group.key}`}>
                {!collapsed && (
                  <h2
                    id={`${filterId}-${group.key}`}
                    className="px-3 pb-1 text-[0.78rem] font-bold text-ink-faint"
                    title={group.description}
                  >
                    {group.label}
                  </h2>
                )}
                <div className="space-y-0.5">
                  {group.nodes.map((node) => {
                    if (node.type === "page") {
                      return (
                        <NavRow
                          key={node.code}
                          page={node}
                          nested={false}
                          collapsed={collapsed}
                          onNavigate={onNavigate}
                          allPaths={allPaths}
                        />
                      );
                    }

                    const isExpanded = Boolean(
                      normalizedQuery || expandedModules[node.moduleCode],
                    );
                    const triggerId = `${filterId}-module-${node.moduleCode}-trigger`;
                    const contentId = `${filterId}-module-${node.moduleCode}-content`;
                    const ModuleIcon = moduleIcon(node.moduleCode);

                    return (
                      <div key={node.moduleCode} className="space-y-0.5">
                        <button
                          id={triggerId}
                          type="button"
                          aria-expanded={isExpanded}
                          aria-controls={contentId}
                          title={collapsed ? node.label : undefined}
                          onClick={() => {
                            if (collapsed) onExpand?.();
                            onToggleModule(node.moduleCode);
                          }}
                          className={
                            collapsed
                              ? "flex min-h-[44px] w-full items-center justify-center rounded-md text-ink-dim hover:bg-panel-2 hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
                              : "flex min-h-[44px] w-full items-center justify-between rounded-md px-3 py-1 text-left text-[0.92rem] font-semibold text-ink-dim hover:bg-panel-2 lg:min-h-[42px]"
                          }
                        >
                          {collapsed ? (
                            <ModuleIcon className="h-5 w-5 shrink-0" />
                          ) : (
                            <>
                              <span className="flex min-w-0 items-center gap-3">
                                <ModuleIcon className="h-5 w-5 shrink-0 text-ink-faint" />
                                <span className="truncate">{node.label}</span>
                              </span>
                              <svg
                                aria-hidden="true"
                                className={`h-4 w-4 shrink-0 transition-transform duration-150 ${
                                  isExpanded ? "rotate-90 text-ink-dim" : "text-ink-faint"
                                }`}
                                viewBox="0 0 20 20"
                                fill="currentColor"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                                  clipRule="evenodd"
                                />
                              </svg>
                            </>
                          )}
                        </button>

                        <div
                          id={contentId}
                          role="region"
                          aria-labelledby={triggerId}
                          hidden={collapsed || !isExpanded}
                          className="ml-5 space-y-0.5 border-l border-line pl-2"
                        >
                          {node.pages.map((page) => (
                            <NavRow
                              key={page.code}
                              page={page}
                              nested
                              collapsed={collapsed}
                              onNavigate={onNavigate}
                              allPaths={allPaths}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div
            className="mx-1 rounded-lg bg-panel-2 px-3 py-4 text-sm text-ink-dim"
            role="status"
          >
            No visible areas match “{query.trim()}”.
            <button
              type="button"
              onClick={() => {
                onQueryChange("");
                filterInputRef.current?.focus();
              }}
              className="mt-2 flex min-h-[44px] items-center font-medium text-ink-dim underline decoration-line-strong underline-offset-4 hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent lg:min-h-[36px]"
            >
              Clear filter
            </button>
          </div>
        )}
      </nav>
    </div>
  );
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

function useNavigationDrawer(
  open: boolean,
  setOpen: (open: boolean) => void,
  drawerRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
) {
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current && triggerRef.current?.getClientRects().length) {
        triggerRef.current.focus();
      }
      wasOpen.current = false;
      return;
    }

    wasOpen.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      focusableElements(drawerRef.current ?? document.body)[0]?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;

      const focusable = focusableElements(drawerRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        drawerRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!drawerRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerRef, open, setOpen, triggerRef]);
}

export function AppShell() {
  const { session, logout, updateSession } = useAuth();
  const token = session!.accessToken;
  const assignmentId = session!.assignmentId;
  const location = useLocation();
  const navigate = useNavigate();

  const [permissions, setPermissions] = useState<string[]>([]);
  const [activeRoleCode, setActiveRoleCode] = useState<string | null>(null);
  const [scopeTypes, setScopeTypes] = useState<string[]>([]);
  const [activeModuleCodes, setActiveModuleCodes] = useState<string[]>([]);
  // The navigation the server sent for THIS caller (§4.3 step 7). Held as the
  // payload, not as a rendered tree: `groups` below is derived from it.
  const [menu, setMenu] = useState<MenuNode[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("sidebar-modules");
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [tenantName, setTenantName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | boolean | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [navigationQuery, setNavigationQuery] = useState("");
  const [switchRoleOpen, setSwitchRoleOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const loadGeneration = useRef(0);
  const online = useOnlineStatus();
  const t = useT();
  const { locale } = useLocale();

  // Route guard (Epic 3 Wave 1 §4.3 step 1; Wave 2 step 8 adds the third
  // cause). It resolves the current path against the route registry;
  // GUARD_ENFORCE decides whether the shell acts on the answer. Derived, not
  // stored: `location` and `permissions` already trigger the render, so an
  // extra effect would only add a frame of stale state.
  //
  // Entry-flow routes are exempt: /login, /select-workspace and the public
  // survey render outside the shell's navigation by design and carry no
  // permission, so withholding them would lock a user out of their own sign-in.
  const routeGuardReport = useMemo(
    () => evaluateRouteAccess(location.pathname, permissions),
    [location.pathname, permissions],
  );
  // §4.3 step 8's second cause. `activeModuleCodes` comes from `/me`, so a
  // route is withheld as module-inactive exactly when the server's own filter
  // hid its menu — the two cannot disagree. `platform` is exempt: it is the
  // shell's own module (Overview, Profile, Administration, Admin Console), is
  // never activated per tenant, and every page behind it is permission-gated
  // anyway; a naive check here would lock the whole workspace out.
  const moduleInactive = useMemo(() => {
    const code = routeGuardReport.entry?.moduleCode;
    return (
      GUARD_ENFORCE
      && code !== undefined
      && code !== "platform"
      && !activeModuleCodes.includes(code)
    );
  }, [routeGuardReport.entry, activeModuleCodes]);
  // Three causes can withhold a page (§4.3 step 8), and they ask different
  // things of the user: an inactive module is a tenant decision, a missing
  // right is an administrator decision, an unknown address is neither.
  const guardBlocks =
    GUARD_ENFORCE && !loading && !error
    && (!routeGuardReport.ok || moduleInactive)
    && !isEntryFlowRoute(routeGuardReport.entry);

  const closeMobileNavigation = useCallback(() => setMobileNavOpen(false), []);
  const toggleModule = useCallback((moduleCode: string) => {
    setExpandedModules((prev) => {
      const next = { ...prev, [moduleCode]: !prev[moduleCode] };
      try {
        localStorage.setItem("sidebar-modules", JSON.stringify(next));
      } catch {
        // Intentional no-op: persist preferensi UI bersifat best-effort.
      }
      return next;
    });
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar-collapsed", String(next));
      } catch {
        // Intentional no-op.
      }
      return next;
    });
  }, []);

  useNavigationDrawer(
    mobileNavOpen,
    setMobileNavOpen,
    drawerRef,
    menuTriggerRef,
  );

  const load = useCallback(async () => {
    // Guard against a slower earlier load resolving after a newer one (token
    // or assignment changed mid-flight) and overwriting the newer context.
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      // `/me` (permissions + active modules) is required — it drives navigation.
      // Epic 1 (§4.1 C): the server reports the SESSION's active assignment
      // (resolved from the sessions row), not a client-chosen one. Switching
      // context goes through POST /auth/switch-role, and the next /me — and
      // thus this load — reflects it.
      const me = await api.me(token);
      if (loadGeneration.current !== generation) return;
      setPermissions(me.permissions);
      setActiveRoleCode(me.activeRoleCode);
      setScopeTypes(me.scopeTypes);
      setActiveModuleCodes(me.activeModuleCodes ?? []);
      setMenu(me.menu ?? []);
      updateSession({
        fullName: me.fullName,
        email: me.email,
        preferredLocale: me.preferredLocale,
        sessionId: me.sessionId,
        assignmentId: me.activeAssignmentId ?? undefined,
        activeRoleName: me.activeAssignmentName ?? undefined,
        activeScopeName: me.activeScopeName ?? undefined,
      });
      // The Tenant name is only the workspace title, and reading it needs
      // `tenant.read` — a permission a Customer User does NOT hold. Gate the
      // fetch on the permission the server just reported instead of firing a
      // guaranteed-403 request and falling back (ADR-0003 neutral title).
      if (me.permissions.includes("tenant.read")) {
        try {
          const tenant = await api.tenant(token);
          if (loadGeneration.current !== generation) return;
          setTenantName(tenant.name);
        } catch {
          if (loadGeneration.current !== generation) return;
          setTenantName("");
        }
      } else {
        setTenantName("");
      }
    } catch (err) {
      if (loadGeneration.current !== generation) return;
      setError(err instanceof ApiError ? err : true);
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [token, updateSession]);

  useEffect(() => {
    load();
    // `assignmentId` re-runs the load on a Role switch: the server has
    // already rewritten the session's active Role, `updateSession` recorded
    // the new value, and this refresh is what pulls the new permission set
    // and navigation (Epic 1 §4.1 C). Keeping it out of `load`'s own
    // dependency list is deliberate — the callback body does not read it.
  }, [load, assignmentId]);

  useEffect(() => {
    closeMobileNavigation();
  }, [closeMobileNavigation, location.pathname, location.search]);

  useEffect(() => {
    const desktopBreakpoint = window.matchMedia("(min-width: 1024px)");
    const closeAtDesktopBreakpoint = (event: MediaQueryListEvent) => {
      if (event.matches) closeMobileNavigation();
    };

    if (desktopBreakpoint.matches) closeMobileNavigation();
    desktopBreakpoint.addEventListener("change", closeAtDesktopBreakpoint);
    return () => {
      desktopBreakpoint.removeEventListener("change", closeAtDesktopBreakpoint);
    };
  }, [closeMobileNavigation]);

  // The render source is the served tree (§4.3 step 7), not a local
  // recalculation: what the server filtered out of `menu` cannot reappear
  // here, and `locked` arrives already decided. Labels and descriptions come
  // from the served `MenuNode`, so a tenant label override served by the
  // dictionary shows up without the shell knowing about it.
  const groups = useMemo(() => servedNavGroups(menu, locale), [menu, locale]);

  useEffect(() => {
    const activeCodes = activeServedModuleCodes(groups, location.pathname);
    if (activeCodes.length === 0) return;
    setExpandedModules((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const code of activeCodes) {
        if (!next[code]) {
          next[code] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups, location.pathname]);

  // Client-neutral fallback while the Tenant name loads (ADR-0003).
  const workspaceTitle = tenantName || t("shell.workspaceFallback");
  const currentScopeSummary = scopeSummary(scopeTypes, t);

  return (
    <div className="min-h-screen bg-ground text-ink lg:flex">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-60 -translate-y-20 rounded bg-accent px-4 py-2 text-sm font-medium text-accent-on shadow-lg transition-transform focus:translate-y-0 focus:outline-hidden focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground"
      >
        {t("shell.skipToContent")}
      </a>

      {/* Persistent desktop navigation. */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 border-r border-line bg-panel lg:flex lg:flex-col ${
          sidebarCollapsed ? "w-16" : "w-[264px]"
        }`}
      >
        <div
          className={`flex items-center ${
            sidebarCollapsed ? "justify-center px-2 py-4" : "justify-between px-5 pb-4 pt-[18px]"
          }`}
        >
          {sidebarCollapsed ? (
            <>
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-extrabold text-accent-on"
                title={workspaceTitle}
              >
                {workspaceTitle.charAt(0).toUpperCase()}
              </div>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={t("shell.expandSidebar")}
                title={t("shell.expandSidebar")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-panel-3 hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </>
          ) : (
            <>
              <div className="min-w-0">
                <div className="truncate text-base font-extrabold tracking-[-0.01em] text-ink" title={workspaceTitle}>
                  {workspaceTitle}
                </div>
                <div className="text-[0.78rem] font-medium text-ink-faint">{currentScopeSummary}</div>
              </div>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={t("shell.collapseSidebar")}
                title={t("shell.collapseSidebar")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-panel-3 hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </>
          )}
        </div>
        <NavigationContent
          groups={groups}
          query={navigationQuery}
          onQueryChange={setNavigationQuery}
          expandedModules={expandedModules}
          onToggleModule={toggleModule}
          collapsed={sidebarCollapsed}
          onExpand={() => setSidebarCollapsed(false)}
          filterId="desktop-navigation-filter"
        />
        <div className="border-t border-line p-3.5">
          <UserMenu
            fullName={session?.fullName}
            email={session?.email}
            activeRoleName={session?.activeRoleName}
            activeScopeName={session?.activeScopeName}
            onSwitchRole={() => setSwitchRoleOpen(true)}
            onSignOut={logout}
          />
        </div>
      </aside>

      {/* Tablet/mobile overlay navigation. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default bg-black/50"
            onClick={closeMobileNavigation}
            aria-label={t("shell.closeNavigation")}
            tabIndex={-1}
          />
          <aside
            id="mobile-navigation"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-navigation-title"
            tabIndex={-1}
            className="relative flex h-full w-full flex-col bg-panel shadow-2xl focus:outline-hidden sm:max-w-sm"
          >
            <div className="flex min-h-[64px] items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <h2 id="mobile-navigation-title" className="truncate text-sm font-semibold text-ink">
                  {workspaceTitle}
                </h2>
                <p className="mt-0.5 text-xs text-ink-dim">{currentScopeSummary}</p>
              </div>
              <button
                type="button"
                onClick={closeMobileNavigation}
                aria-label={t("shell.closeNavigation")}
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-xl text-ink-dim hover:bg-panel-3 hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex flex-1 flex-col pt-3">
              <NavigationContent
                groups={groups}
                query={navigationQuery}
                onQueryChange={setNavigationQuery}
                expandedModules={expandedModules}
                onToggleModule={toggleModule}
                collapsed={false}
                onNavigate={closeMobileNavigation}
                filterId="drawer-navigation-filter"
              />
            </div>
            <div className="space-y-3 border-t border-line p-3">
              {/* The topbar controls are desktop-only, so the drawer carries
                  its own pair; otherwise a phone user can reach neither. */}
              <div className="flex items-center gap-2">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
              <UserMenu
                fullName={session?.fullName}
                email={session?.email}
                activeRoleName={session?.activeRoleName}
                activeScopeName={session?.activeScopeName}
                onSwitchRole={() => setSwitchRoleOpen(true)}
                onSignOut={logout}
              />
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20">
          <header className="flex min-h-[64px] items-center justify-between gap-3 border-b border-line bg-ground px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                ref={menuTriggerRef}
                type="button"
                aria-expanded={mobileNavOpen}
                aria-controls="mobile-navigation"
                aria-label={t("shell.openNavigation")}
                onClick={() => setMobileNavOpen(true)}
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full border border-line-strong bg-panel px-4 text-sm font-bold text-ink hover:bg-panel-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent lg:hidden"
              >
                {t("shell.menu")}
              </button>
              <div className="min-w-0 lg:hidden">
                <div className="truncate text-sm font-semibold text-ink">{workspaceTitle}</div>
                <div className="truncate text-xs text-ink-dim">{currentScopeSummary}</div>
              </div>
              <div className="hidden min-w-0 lg:block">
                <div className="truncate text-[0.95rem] font-bold text-ink" title={workspaceTitle}>
                  {workspaceTitle}
                </div>
                <div className="text-[0.78rem] text-ink-faint">{currentScopeSummary}</div>
              </div>
            </div>
            <div className="hidden min-w-0 items-center gap-3 lg:flex">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </header>
          {!online && (
            <div
              className="border-b border-status-warn bg-status-warn-soft px-4 py-2 text-center text-xs font-medium text-status-warn"
              role="status"
              aria-live="polite"
            >
              {t("shell.offline")}
            </div>
          )}
          {/* Report mode only. Gated on the loaded state — while /me is in
              flight `permissions` is still [], so every gated route would read
              as denied and flash a false warning on each reload. */}
          {!GUARD_ENFORCE && !loading && !error && !routeGuardReport.ok && (
            <div
              className="border-b border-status-warn bg-status-warn-soft px-4 py-2 text-center text-xs font-medium text-status-warn"
              role="status"
              aria-live="polite"
            >
              {!routeGuardReport.registered
                ? `Route registry: ${routeGuardReport.pathname} is not registered (belum_terdaftar).`
                : `Route registry: ${routeGuardReport.pathname} needs one of ${routeGuardReport.missingPermissions.join(", ")}.`}{" "}
              Report only — the page still renders.
            </div>
          )}
        </div>

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-14 pt-5 focus:outline-hidden sm:px-6">
          <div className="mx-auto w-full max-w-[1600px]">
            {loading ? (
              <Spinner label={t("shell.loadingWorkspace")} />
            ) : error ? (
              <div className="space-y-3">
                <Alert tone="error">
                  {error instanceof ApiError ? error.message : t("shell.loadFailed")}
                </Alert>
                <Button variant="secondary" onClick={load}>
                  {t("common.retry")}
                </Button>
              </div>
            ) : guardBlocks ? (
              /* §4.3 "Penjelasan saat alamat dibuka langsung". Three causes,
                 three explanations, because they ask different things of the
                 user: an inactive module is a tenant decision ("ask them to
                 turn it on"), a missing right is an administrator decision
                 ("ask for access"), an unknown address is neither ("check the
                 address"). Reporting an inactive module as a permission
                 problem would send the user to the wrong person. Copy is in
                 the shell's language; the roadmap states the meaning, not the
                 literal string. No silent redirect to Overview: the user
                 chooses to go there. */
              <div className="mx-auto max-w-xl space-y-3 py-8 text-center">
                <h1 className="text-lg font-semibold text-ink">
                  {moduleInactive
                    ? t("shell.guardInactiveTitle")
                    : routeGuardReport.registered
                      ? t("shell.guardDeniedTitle")
                      : t("shell.guardNotFoundTitle")}
                </h1>
                <p className="text-sm text-ink-dim">
                  {moduleInactive
                    ? t("shell.guardInactiveBody", {
                        path: routeGuardReport.pathname,
                        module: routeGuardReport.entry?.moduleCode ?? "",
                      })
                    : routeGuardReport.registered
                      ? t("shell.guardDeniedBody", {
                          path: routeGuardReport.pathname,
                          permissions: routeGuardReport.missingPermissions.join(", "),
                        })
                      : t("shell.guardNotFoundBody", { path: routeGuardReport.pathname })}
                </p>
                <Button variant="secondary" onClick={() => navigate("/")}>
                  {t("shell.backToOverview")}
                </Button>
              </div>
            ) : (
              <ShellContext.Provider
                value={{
                  permissions,
                  scopeTypes,
                  activeModuleCodes,
                  navGroups: groups,
                  activeRoleCode,
                  userId: session!.userId,
                  tenantName,
                  setTenantName,
                }}
              >
                <Outlet />
              </ShellContext.Provider>
            )}
          </div>
        </main>
      </div>

      {/* Epic 1 (§4.1 C): switching the session's active Role. Rendered once
          at the shell level so every UserMenu instance (desktop sidebar,
          mobile drawer, header) opens the same dialog. Recording the new
          assignmentId re-runs `load` above, which is what refreshes the
          permission set, the served menu and the scope label. */}
      <SwitchRoleDialog
        open={switchRoleOpen}
        token={token}
        currentAssignmentId={assignmentId}
        onClose={() => setSwitchRoleOpen(false)}
        onSwitched={(patch) => updateSession(patch)}
      />
    </div>
  );
}
