/**
 * Phase 3 — Workforce employee directory (HR-CORE-010).
 *
 * List, search, filter, and create employees. Presentation only: Data Scope
 * and authorization are enforced by the backend, which returns exactly the
 * employees this user may see.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type Employee, type PositionRecord } from "../../lib/api";
import {
  Alert,
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

/** Minimal shapes for the org pickers — the API client returns these
 * inline, so only what this page renders is modelled here. */
type LegalEntityOption = { id: string; name: string };
type OrganizationUnitOption = { id: string; name: string };

function statusTone(status: string): "success" | "neutral" | "warning" {
  if (status === "active") return "success";
  if (status === "ended") return "neutral";
  return "warning";
}

export function EmployeesPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [rows, setRows] = useState<Employee[]>([]);
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [legalEntities, setLegalEntities] = useState<LegalEntityOption[]>([]);
  const [units, setUnits] = useState<OrganizationUnitOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [positionCode, setPositionCode] = useState("");
  const [legalEntityId, setLegalEntityId] = useState("");
  const [organizationUnitId, setOrganizationUnitId] = useState("");
  const [joinedAt, setJoinedAt] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [employees, positionList, legalEntityList, unitList] = await Promise.all([
        api.employees(token, { search: search || undefined, employmentStatus: statusFilter || undefined }),
        api.positions(token).catch(() => [] as PositionRecord[]),
        api.legalEntities(token).catch(() => [] as LegalEntityOption[]),
        api.organizationUnits(token).catch(() => [] as OrganizationUnitOption[]),
      ]);
      setRows(employees);
      setPositions(positionList.filter((p) => p.isActive));
      setLegalEntities(legalEntityList);
      setUnits(unitList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mw.emp.msg.couldNotLoadEmployees"));
    } finally {
      setLoading(false);
    }
  }, [token, search, statusFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createEmployee() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createEmployee(token, {
        fullName,
        email: email || null,
        positionCode: positionCode || null,
        legalEntityId: legalEntityId || null,
        organizationUnitId: organizationUnitId || null,
        joinedAt: joinedAt || null,
      });
      setNotice(t("mw.emp.msg.employeeCreated"));
      setFullName("");
      setEmail("");
      setJoinedAt("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mw.emp.msg.couldNotCreateTheEmployee"));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Employee>[] = [
    { header: t("mw.emp.h.number"), cell: (row) => <span className="font-medium">{row.employeeNumber}</span> },
    { header: t("mw.emp.h.name"), cell: (row) => row.fullName },
    {
      header: t("mw.emp.h.status"),
      cell: (row) => <StatusPill tone={statusTone(row.employmentStatus)}>{row.employmentStatus}</StatusPill>,
    },
    { header: t("mw.emp.h.joined"), cell: (row) => formatDateShort(row.joinedAt) },
    { header: t("mw.emp.h.account"), cell: (row) => (row.userId ? "Linked" : "—") },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("mw.emp.title.employees")} subtitle={t("mw.emp.sub.whoWorksHereAndWhereTheyBelongInTheOrgan")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mw.emp.t.addAnEmployee")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("mw.emp.f.fullName")} required>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder={t("mw.emp.p.fullName")} />
          </Field>
          <Field label={t("mw.emp.f.email")}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("mw.emp.p.optional")} />
          </Field>
          <Field label={t("mw.emp.f.position")}>
            <Select value={positionCode} onChange={(e) => setPositionCode(e.target.value)}>
              <option value="">—</option>
              {positions.map((p) => (
                <option key={p.id} value={p.code}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("mw.emp.f.legalEntity")}>
            <Select value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
              <option value="">—</option>
              {legalEntities.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("mw.emp.f.organizationUnit")}>
            <Select value={organizationUnitId} onChange={(e) => setOrganizationUnitId(e.target.value)}>
              <option value="">—</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-3">
            <Field label={t("mw.emp.f.joined")}>
              <Input type="date" value={joinedAt} onChange={(e) => setJoinedAt(e.target.value)} />
            </Field>
            <Button disabled={busy || !fullName} onClick={() => void createEmployee()}>
              {t("common.create")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("mw.emp.f.search")}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("mw.emp.p.nameOrEmployeeNumber")}
            />
          </Field>
          <Field label={t("mw.emp.f.status")}>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t("mw.emp.t.all")}</option>
              <option value="active">{t("mw.emp.t.active")}</option>
              <option value="inactive">{t("mw.emp.t.inactive")}</option>
              <option value="ended">{t("mw.emp.t.ended")}</option>
            </Select>
          </Field>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          onRowClick={(row) => navigate(`/employees/${row.id}`)}
          empty={<EmptyState title={t("mw.emp.title.noEmployeesFound")} description={t("mw.emp.d.addOneAboveOrAdjustYourSearch")} />}
        />
      )}
    </div>
  );
}
