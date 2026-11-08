/**
 * Phase 7 — Health, Safety & Environment (HSE-CORE-001/002/009/010).
 *
 * Register view with filtering for incidents and observations.
 * Shows record type, category, severity, location, responsible party,
 * lifecycle status, and allows navigation to detail view.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type HseRecord,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort } from "../../shared/format";
import { useT } from "../../i18n/LocaleProvider";

export function HseRegisterPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();
  const t = useT();

  const [records, setRecords] = useState<HseRecord[]>([]);
  const [categories, setCategories] = useState<{ code: string; label: string }[]>([]);
  const [severities, setSeverities] = useState<{ code: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterType, setFilterType] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterSeverity, setFilterSeverity] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRecords(
        await api.hseRecords(token, {
          recordType: filterType || undefined,
          categoryCode: filterCategory || undefined,
          severityCode: filterSeverity || undefined,
          occurredFrom: filterFrom ? new Date(`${filterFrom}T00:00:00`).toISOString() : undefined,
          occurredTo: filterTo ? new Date(`${filterTo}T23:59:59.999`).toISOString() : undefined,
          search: search || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.register.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, filterType, filterCategory, filterSeverity, filterFrom, filterTo, search, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const [categoryList, severityList] = await Promise.all([
        api.configReferenceDataItems(token, "hse_category").catch(() => [] as { code: string; label: string }[]),
        api.configReferenceDataItems(token, "hse_severity").catch(() => [] as { code: string; label: string }[]),
      ]);
      setCategories(categoryList);
      setSeverities(severityList);
    })();
  }, [token]);

  const categoryLabel = (code: string | null) => {
    if (!code) return t("hse.common.notAvailable");
    return categories.find((c) => c.code === code)?.label ?? code;
  };

  const severityLabel = (code: string | null) => {
    if (!code) return t("hse.common.notAvailable");
    return severities.find((s) => s.code === code)?.label ?? code;
  };

  const columns: Column<HseRecord>[] = [
    { header: t("hse.register.colNumber"), cell: (row) => <span className="font-medium">{row.recordNumber}</span> },
    {
      header: t("fin.common.type"),
      cell: (row) => (
        <Badge>{row.recordType === "incident" ? t("hse.common.incident") : t("hse.common.observation")}</Badge>
      ),
    },
    { header: t("fin.common.date"), cell: (row) => formatDateShort(row.occurredAt) },
    { header: t("hse.common.title"), cell: (row) => row.title },
    { header: t("fin.common.category"), cell: (row) => categoryLabel(row.categoryCode) },
    { header: t("hse.common.severity"), cell: (row) => severityLabel(row.severityCode) },
    {
      header: t("fin.common.status"),
      cell: (row) =>
        row.workflowInstanceId ? (
          <StatusPill tone="info">{t("hse.common.inProgress")}</StatusPill>
        ) : (
          <StatusPill tone="warning">{t("hse.common.notStarted")}</StatusPill>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("hse.register.title")} subtitle={t("hse.register.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex gap-2">
        <Button onClick={() => navigate("/hse/report")} variant="primary">
          {t("hse.register.reportNew")}
        </Button>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("fin.common.search")}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("hse.register.searchPlaceholder")}
            />
          </Field>
          <Field label={t("fin.common.type")}>
            <Select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">{t("fin.common.any")}</option>
              <option value="incident">{t("hse.common.incident")}</option>
              <option value="observation">{t("hse.common.observation")}</option>
            </Select>
          </Field>
          <Field label={t("fin.common.category")}>
            <Select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              <option value="">{t("fin.common.allCategories")}</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("hse.common.severity")}>
            <Select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)}>
              <option value="">{t("hse.common.allSeverities")}</option>
              {severities.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fin.common.from")}>
            <Input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </Field>
          <Field label={t("fin.common.to")}>
            <Input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          </Field>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={records}
          keyOf={(row) => row.id}
          onRowClick={(row) => navigate(`/hse/records/${row.id}`)}
          empty={
            <EmptyState
              title={t("hse.register.emptyTitle")}
              description={t("hse.register.emptyDescription")}
            />
          }
        />
      )}
    </div>
  );
}
