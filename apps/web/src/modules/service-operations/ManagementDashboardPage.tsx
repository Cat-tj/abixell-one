/**
 * SO-CORE-017 — KPI Dashboard (L2 Management).
 *
 * Four core KPIs, all computed by the backend in PostgreSQL NUMERIC:
 * Production Achievement, Meal Fulfillment, Food Waste, Food Cost per Meal.
 * This page is presentation-only: it renders whatever the backend returns.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type DashboardL2 } from "../../lib/api";
import { Alert, Card, Field, Input, PageHeader, Spinner } from "../../shell/components/ui";

function KpiTile({ label, kpi }: { label: string; kpi: { value: string; unit: string; dataPoints: number } }) {
  return (
    <Card>
      <p className="text-xs font-bold text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">
        {kpi.value}
        <span className="ml-1 text-sm font-normal text-slate-500">{kpi.unit}</span>
      </p>
      <p className="mt-1 text-xs text-slate-500">{kpi.dataPoints} data points</p>
    </Card>
  );
}

export function ManagementDashboardPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [period, setPeriod] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [dashboard, setDashboard] = useState<DashboardL2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // A cleared month field would send `period=` and get a 400; wait for a value.
    if (!/^\d{4}-\d{2}$/.test(period)) return;
    setLoading(true);
    setError(null);
    try {
      setDashboard(await api.getMgmtDashboard(token, period));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mo.dash.msg.couldNotLoadDashboard"));
    } finally {
      setLoading(false);
    }
  }, [token, period, t]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <PageHeader title={t("mo.dash.t.title")} subtitle={t("mo.dash.t.subtitle")} />
      <Field label={t("mo.dash.f.period")}>
        <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="max-w-xs" />
      </Field>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {loading ? (
        <Spinner />
      ) : dashboard ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label={t("mo.dash.kpi.productionAchievement")} kpi={dashboard.productionAchievement} />
          <KpiTile label={t("mo.dash.kpi.mealFulfillment")} kpi={dashboard.mealFulfillment} />
          <KpiTile label={t("mo.dash.kpi.foodWaste")} kpi={dashboard.foodWaste} />
          <KpiTile label={t("mo.dash.kpi.foodCostPerMeal")} kpi={dashboard.foodCostPerMeal} />
        </div>
      ) : null}
    </div>
  );
}
