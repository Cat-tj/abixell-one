import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError, type TenantSelectionRequired } from "../lib/api";
import { useT } from "../i18n/LocaleProvider";
import { LanguageSwitcher } from "../shell/components/LanguageSwitcher";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set once the password verifies against more than one tenant: the form is
  // replaced by a tenant list, and picking one re-submits the same
  // credentials with that tenant. No credential is issued before this point.
  const [tenantChoice, setTenantChoice] = useState<TenantSelectionRequired["tenants"] | null>(
    null,
  );

  async function submit(tenantId?: string) {
    setError(null);
    setLoading(true);
    try {
      const result = await api.login({ email, password, ...(tenantId ? { tenantId } : {}) });
      if (result.status === "tenant_selection_required") {
        setTenantChoice(result.tenants);
        return;
      }
      login({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId: result.userId,
        tenantId: result.tenantId,
        tenantCode: result.tenantCode,
        // Epic 1 (§4.1 B): the session the token names. The active Role
        // lives on the server-side session row, so the picker below
        // switches it through the API rather than storing it locally.
        sessionId: result.sessionId,
      });
      // Always route through the role & site picker, even for a single
      // assignment — the user's chosen work context is what shapes the shell.
      navigate("/select-workspace", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("login.failed"));
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  return (
    <div className="relative grid min-h-screen bg-panel lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* Brand panel, as on the Altora Store sign-in page. Desktop only. */}
      <div className="hidden flex-col justify-end bg-accent p-10 text-accent-on lg:flex">
        <div className="flex max-w-[420px] flex-col gap-1.5">
          <h2 className="text-[clamp(1.6rem,1.2rem+1.4vw,2.4rem)] font-extrabold leading-[1.1] tracking-[-0.03em]">
            {t("login.title")}
          </h2>
          <p className="text-[1.05rem] opacity-85">{t("login.tagline")}</p>
        </div>
      </div>
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-[400px] flex-col gap-4 self-center justify-self-center px-4 py-8"
      >
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold text-ink">{t("login.formTitle")}</h1>
          <p className="mt-1 text-sm text-ink-faint">{t("login.subtitle")}</p>
          <p className="mt-0.5 text-xs font-semibold text-ink-faint lg:hidden">{t("login.title")}</p>
        </div>

        {tenantChoice ? (
          <fieldset disabled={loading} className="space-y-3">
            <legend className="text-sm text-ink-dim">{t("login.tenantLegend")}</legend>
            {tenantChoice.map((tenant) => (
              <button
                key={tenant.tenantId}
                type="button"
                onClick={() => void submit(tenant.tenantId)}
                className="flex min-h-[52px] w-full items-center justify-between rounded-lg border border-line-strong px-4 py-2 text-left text-sm hover:bg-panel-2 disabled:opacity-50"
              >
                <span className="font-medium text-ink">{tenant.tenantName}</span>
                <span className="text-xs text-ink-faint">{tenant.tenantCode}</span>
              </button>
            ))}
          </fieldset>
        ) : (
          <>
            <label className="block text-sm font-bold text-ink">
              {t("login.email")}
              <input
                type="email"
                autoComplete="username"
                className="mt-1 min-h-[46px] w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-[0.9375rem] font-normal focus:border-accent"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            <label className="block text-sm font-bold text-ink">
              {t("login.password")}
              <input
                type="password"
                autoComplete="current-password"
                className="mt-1 min-h-[46px] w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-[0.9375rem] font-normal focus:border-accent"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          </>
        )}

        {error && <p className="rounded-md bg-status-danger-soft px-4 py-3 text-sm font-bold text-status-danger">{error}</p>}

        {tenantChoice ? (
          <button
            type="button"
            onClick={() => {
              setTenantChoice(null);
              setError(null);
            }}
            disabled={loading}
            className="min-h-[46px] w-full rounded-full border border-line-strong px-5 py-1.5 text-sm font-bold text-ink hover:bg-panel-2 disabled:opacity-50"
          >
            {t("login.otherEmail")}
          </button>
        ) : (
          <button
            type="submit"
            disabled={loading}
            className="min-h-[46px] w-full rounded-full bg-accent px-5 py-1.5 text-[0.95rem] font-extrabold text-accent-on hover:bg-accent-line disabled:opacity-50"
          >
            {loading ? t("login.submitting") : t("login.submit")}
          </button>
        )}
      </form>
    </div>
  );
}
