/**
 * Unified dynamic dashboard (`/dashboard`).
 *
 * Server-driven: every card comes from `GET /reporting/dashboard` with its
 * `drillTarget` already gated on the actor's active permissions. A card with a
 * target navigates on click — `route` targets go to an existing list page,
 * `list` targets go to the generic drill-down page (`/drilldown?dataset=…`),
 * which resolves the underlying records.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type ExecutiveDashboard } from "../../lib/api";
import { Alert, Card, EmptyState, PageHeader, Spinner } from "../../shell/components/ui";
import { ModuleChart } from "./ModuleChart";

function targetUrl(target: NonNullable<ExecutiveDashboard["modules"][number]["cards"][number]["drillTarget"]>): string {
  return target.kind === "list" ? `${target.path}?${new URLSearchParams(target.params)}` : target.path;
}

export function DashboardPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [data, setData] = useState<ExecutiveDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .reportingDashboard(token)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("dashboard.msg.failedToLoadDashboard"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  return (
    <div>
      <PageHeader title={t("dashboard.title.dashboard")} subtitle={t("dashboard.sub.summaryAcrossModules")} />

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : loading || !data ? (
        <Spinner label={t("dashboard.f.loadingDashboard")} />
      ) : data.modules.length === 0 ? (
        <EmptyState title={t("dashboard.title.noData")} description={t("dashboard.d.noActivatedModuleExposesData")} />
      ) : (
        <div className="space-y-6">
          {data.modules.map((module) => (
            <section key={module.moduleCode}>
              <h2 className="mb-2 text-sm font-semibold text-slate-800">{module.moduleName}</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {module.cards.map((card) => {
                  const target = card.drillTarget;
                  const clickable = target !== undefined;
                  return (
                    <Card
                      key={`${module.moduleCode}-${card.label}`}
                      className={`p-4 ${clickable ? "cursor-pointer transition hover:border-slate-300 hover:shadow-sm" : ""}`}
                      onClick={clickable ? () => navigate(targetUrl(target)) : undefined}
                    >
                      <p className="text-xs font-bold text-slate-500">{card.label}</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{card.value}</p>
                    </Card>
                  );
                })}
              </div>
              <div className="mt-4">
                <ModuleChart module={module} />
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
