/**
 * Phase 5 — Asset register (AST-CORE-001…005, AST-CORE-010).
 *
 * The working list: search by name, number, or physical tag, filter by
 * category, status, and location, and register a new asset. Retired and
 * disposed assets are hidden by default but never deleted — one toggle
 * brings them back.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AssetRecord,
  type CustodianReference,
  type Employee,
  type ProjectRecord,
  type SiteRecord,
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
import { loadLocationCatalogue } from "./locations";
import { assetStatusLabel, assetStatusTone } from "./status";

type OrganizationUnitOption = { id: string; name: string };

export function AssetsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [custodians, setCustodians] = useState<CustodianReference[]>([]);
  const [units, setUnits] = useState<OrganizationUnitOption[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [includeTerminal, setIncludeTerminal] = useState(false);

  const [name, setName] = useState("");
  const [assetTag, setAssetTag] = useState("");
  const [category, setCategory] = useState("");
  const [unitId, setUnitId] = useState("");
  const [custodianId, setCustodianId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [locationDetail, setLocationDetail] = useState("");
  const [acquisitionReference, setAcquisitionReference] = useState("");
  const [acquiredAt, setAcquiredAt] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.assets(token, {
        search: search || undefined,
        status: statusFilter || undefined,
        category: categoryFilter || undefined,
        includeTerminal: includeTerminal || undefined,
      });
      setAssets(result.assets);
      setCustodians(result.custodians);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ast.list.msg.couldNotLoadTheAssetRegister"));
    } finally {
      setLoading(false);
    }
  }, [token, search, statusFilter, categoryFilter, includeTerminal, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reference data for the create form, resolved once. Each call may
  // legitimately be denied for a user who only holds asset permissions, so
  // failures are silent and simply leave the picker empty.
  useEffect(() => {
    void (async () => {
      const [unitList, employeeList, locations] = await Promise.all([
        api.organizationUnits(token).catch(() => [] as OrganizationUnitOption[]),
        api.employees(token).catch(() => [] as Employee[]),
        loadLocationCatalogue(token),
      ]);
      setUnits(unitList);
      setEmployees(employeeList.filter((e) => e.employmentStatus === "active"));
      setSites(locations.sites);
      setProjects(locations.projects);
    })();
  }, [token]);

  const custodianName = (id: string | null) =>
    id ? (custodians.find((c) => c.id === id)?.fullName ?? "—") : "—";

  async function createAsset() {
    if (!name.trim()) {
      setNotice(null);
      setError(t("common.form.missing", { fields: t("ast.list.f.name") }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await api.createAsset(token, {
        name: name.trim(),
        assetTag: assetTag.trim() || null,
        category: category || null,
        organizationUnitId: unitId || null,
        custodianEmployeeId: custodianId || null,
        siteId: siteId || null,
        projectId: projectId || null,
        locationDetail: locationDetail || null,
        acquisitionReference: acquisitionReference || null,
        acquiredAt: acquiredAt || null,
      });
      setNotice(`Asset ${created.asset.assetNumber} registered.`);
      setName("");
      setAssetTag("");
      setLocationDetail("");
      setAcquisitionReference("");
      setAcquiredAt("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ast.list.msg.couldNotRegisterTheAsset"));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<AssetRecord>[] = [
    { header: t("ast.list.h.number"), cell: (row) => <span className="font-medium">{row.assetNumber}</span> },
    { header: t("ast.list.h.name"), cell: (row) => row.name },
    { header: t("ast.list.h.tag"), cell: (row) => (row.assetTag ? <Badge>{row.assetTag}</Badge> : "—") },
    { header: t("ast.list.h.category"), cell: (row) => row.category ?? "—" },
    { header: t("ast.list.h.custodian"), cell: (row) => custodianName(row.custodianEmployeeId) },
    {
      header: t("ast.list.h.status"),
      cell: (row) => <StatusPill tone={assetStatusTone(row.status)}>{assetStatusLabel(row.status)}</StatusPill>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("ast.list.title.assets")} subtitle={t("ast.list.sub.whatYouOwnWhereItIsAndWhoHoldsIt")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("ast.list.t.registerAnAsset")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("ast.list.f.name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ast.list.p.eGCompressor40kw")} />
          </Field>
          <Field label={t("ast.list.f.physicalTag")}>
            <Input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} placeholder={t("ast.list.p.optional")} />
          </Field>
          <Field label={t("ast.list.f.category")}>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t("ast.list.p.eGMachinery")} />
          </Field>
          <Field label={t("ast.list.f.responsibleUnit")}>
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">{t("ast.list.t.tenantWide")}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("ast.list.f.custodian")}>
            <Select value={custodianId} onChange={(e) => setCustodianId(e.target.value)}>
              <option value="">{t("ast.list.t.unassigned")}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("ast.list.f.site")}>
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">{t("ast.list.t.none")}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("ast.list.f.project")}>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t("ast.list.t.none")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("ast.list.f.locationDetail")}>
            <Input
              value={locationDetail}
              onChange={(e) => setLocationDetail(e.target.value)}
              placeholder={t("ast.list.p.eGUtilityRoom")}
            />
          </Field>
          <Field label={t("ast.list.f.acquisitionReference")}>
            <Input
              value={acquisitionReference}
              onChange={(e) => setAcquisitionReference(e.target.value)}
              placeholder={t("ast.list.p.orderOrDocumentReference")}
            />
          </Field>
          <Field label={t("ast.list.f.acquiredOn")}>
            <Input type="date" value={acquiredAt} onChange={(e) => setAcquiredAt(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button disabled={busy} onClick={() => void createAsset()}>
              Register
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("ast.list.f.search")}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("ast.list.p.nameNumberOrTag")}
            />
          </Field>
          <Field label={t("ast.list.f.category")}>
            <Input value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} />
          </Field>
          <Field label={t("ast.list.f.status")}>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t("ast.list.t.any")}</option>
              <option value="in_use">{t("ast.list.t.inUse")}</option>
              <option value="idle">{t("ast.list.t.idle")}</option>
              <option value="retired">{t("ast.list.t.retired")}</option>
              <option value="disposed">{t("ast.list.t.disposed")}</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={includeTerminal}
                onChange={(e) => setIncludeTerminal(e.target.checked)}
              />
              Include retired and disposed
            </label>
          </div>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={assets}
          keyOf={(row) => row.id}
          onRowClick={(row) => navigate(`/assets/${row.id}`)}
          empty={
            <EmptyState
              title={t("ast.list.title.noAssetsYet")}
              description={t("ast.list.d.registerOneAboveToStartTrackingWhereItIs")}
            />
          }
        />
      )}
    </div>
  );
}
