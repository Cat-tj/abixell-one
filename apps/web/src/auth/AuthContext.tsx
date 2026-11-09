import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { api, ApiError } from "../lib/api";

interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  tenantCode: string;
  /** User's full name, populated from GET /me. */
  fullName?: string;
  /** User's email address, populated from GET /me. */
  email?: string;
  /** User's preferred locale (en | id), populated from GET /me. */
  preferredLocale?: string;
  /** Epic 1 (§4.1 B): the server-side session this login created. The
   * session row, not any client state, holds the active Role. */
  sessionId?: string;
  /** The ACTIVE role+scope pair (Epic 1 §4.1 C). Set at login (server
   * default), updated only by POST /auth/switch-role — a client-side
   * write alone grants nothing, every route evaluates the session row. */
  assignmentId?: string;
  /** Display names of the ACTIVE Role and its scope, from /me — shown in
   * the user menu and the switch dialog. */
  activeRoleName?: string;
  activeScopeName?: string;
}

interface AuthContextValue {
  session: Session | null;
  /** True only during the very first render, while a persisted session
   * (if any) is being validated/refreshed against the backend. Route
   * guards should wait for this before deciding to redirect to /login —
   * otherwise a returning user with a valid persisted session would
   * flash through the login page on every page reload. */
  initializing: boolean;
  login: (session: Session) => void;
  /** Patch the current session in place (state + storage) — used by the
   * role & site selection screen to record the chosen work context without
   * re-running the login handshake. */
  updateSession: (patch: Partial<Session>) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Frontend token/session persistence (Checkpoint 0F — resolves the gap
// left open explicitly since 0B: "Penyimpanan token di frontend bersifat
// in-memory saja ... sesi hilang saat halaman di-refresh"). The refresh
// token (opaque, 7-day TTL, hashed server-side, single-use/rotated on
// every use — see refresh-token.ts) is what's actually persisted;
// localStorage is an accepted, documented trade-off here, not an
// oversight — this is a pure JSON Bearer-token API (no cookies, so no
// CSRF surface either way), a Dedicated Deployment per client (ADR-0003,
// smaller/more trusted attack surface than a multi-tenant SaaS frontend
// would be), and the realistic alternative (httpOnly refresh cookie +
// a same-origin BFF) is a real architecture change out of this
// checkpoint's "no big new capability" scope — tracked as a Future
// Enhancement in the Checkpoint 0F Technical Debt Register, not silently
// assumed solved. An XSS vulnerability anywhere in the frontend would be
// able to read this token; that risk exists with or without persistence
// (an in-memory token is just as readable by injected script while the
// tab is open) and is mitigated at the source by helmet's security
// headers (Checkpoint 0F, app.ts) and standard React output-escaping,
// not by where the token happens to be stored.
const STORAGE_KEY = "abixell.session";

function readPersistedSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function persistSession(session: Session | null): void {
  try {
    if (session) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — the
    // session still works for the current tab via in-memory state, it
    // just won't survive a reload. Not a fatal error.
  }
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  // Persists across React StrictMode's double effect invocation (a ref
  // survives that, unlike a variable declared inside the effect body) —
  // see the rehydration effect below for why this matters here
  // specifically.
  const rehydrationStarted = useRef(false);

  const login = useCallback((s: Session) => {
    setSession(s);
    persistSession(s);
  }, []);

  const updateSession = useCallback((patch: Partial<Session>) => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      persistSession(next);
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    const current = session;
    setSession(null);
    persistSession(null);
    if (current) {
      // Best-effort, fire-and-forget: revoke the refresh token
      // server-side (Checkpoint 0F `POST /auth/logout`) so a copy of it
      // left in localStorage (e.g. browser history, a shared machine)
      // can't be replayed. The user is signed out locally regardless of
      // whether this call succeeds.
      api.logout(current.refreshToken).catch(() => {});
    }
  }, [session]);

  // On mount: rehydrate a persisted session, then immediately exchange
  // its refresh token for a fresh access token. The access token's own
  // 15-minute TTL almost certainly already expired between page loads
  // (or the tab being reopened) — proactively refreshing here means the
  // user lands back on the Dashboard already authenticated, instead of
  // the app trusting a probably-stale access token until the first API
  // call 401s.
  //
  // `rehydrationStarted` guards against React StrictMode's deliberate
  // double-invoke of effects in development — refresh tokens are
  // single-use/rotated on every use (refresh-token.ts), so firing this
  // effect's body twice for the same mount would consume the token on
  // the first call and then genuinely 401 on the second, logging a real
  // error out of a false alarm. Caught by the Checkpoint 0F Playwright
  // E2E smoke test (`e2e-smoke.mjs`), which is why this guard exists at
  // all — it was not a hypothetical.
  useEffect(() => {
    if (rehydrationStarted.current) return;
    rehydrationStarted.current = true;

    const persisted = readPersistedSession();
    if (!persisted) {
      setInitializing(false);
      return;
    }
    api
      .refresh(persisted.refreshToken)
      .then((result) => {
        const refreshed: Session = { ...persisted, ...result };
        setSession(refreshed);
        persistSession(refreshed);
      })
      .catch(() => {
        // Refresh token expired/revoked/invalid — the persisted session
        // is no longer usable, clear it rather than leaving a dead
        // session object around.
        persistSession(null);
      })
      .finally(() => setInitializing(false));
    // Intentionally run once on mount only — this project's ESLint
    // config does not enable react-hooks/exhaustive-deps, so no
    // suppression comment is needed (an unused one would itself fail
    // lint, as happened once already in Checkpoint 0E).
  }, []);

  // Keep the access token alive while the app stays open. Its TTL is 15
  // minutes (jwt.ts) and the mount effect above only refreshes on page
  // load, so without this every API call started failing with "Invalid or
  // expired access token" a quarter of an hour into a session. Refresh
  // every 12 minutes, and when the tab becomes visible again (background
  // timers are throttled, so the interval alone can miss the window).
  const lastRefreshAt = useRef(0);
  const refreshInFlight = useRef(false);
  const signedIn = session !== null;
  useEffect(() => {
    if (!signedIn) return;
    const REFRESH_EVERY_MS = 12 * 60 * 1000;
    lastRefreshAt.current = Date.now();

    const refreshNow = () => {
      if (refreshInFlight.current) return;
      // Another tab may have rotated the refresh token already; the
      // persisted copy is always the newest one.
      const latest = readPersistedSession();
      if (!latest) return;
      refreshInFlight.current = true;
      api
        .refresh(latest.refreshToken)
        .then((result) => {
          const next: Session = { ...latest, ...result };
          lastRefreshAt.current = Date.now();
          setSession(next);
          persistSession(next);
        })
        .catch((err) => {
          // Only a rejected refresh token ends the session; a network
          // blip just waits for the next attempt.
          if (err instanceof ApiError && err.status === 401) {
            setSession(null);
            persistSession(null);
          }
        })
        .finally(() => {
          refreshInFlight.current = false;
        });
    };

    const timer = window.setInterval(refreshNow, REFRESH_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshAt.current >= REFRESH_EVERY_MS) {
        refreshNow();
      }
    };
    // Pick up a token another tab just refreshed instead of using a stale one.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const latest = readPersistedSession();
      if (latest) {
        lastRefreshAt.current = Date.now();
        setSession(latest);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, [signedIn]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, initializing, login, updateSession, logout }),
    [session, initializing, login, updateSession, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
