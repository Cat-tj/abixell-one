/**
 * Phase 5 — Asset detail (AST-CORE-002…010).
 *
 * One coherent record: Overview, Location & Custodian, Documents, and
 * Movement History. Location, custodian, and status are never edited in
 * place — they change through an explicit movement, so the history always
 * tells the whole story. There is no maintenance tab: maintenance is
 * Advanced.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type AssetDetail,
  type AssetMovementRecord,
  type CustodianReference,
  type DocumentRecord,
  type Employee,
  type ProjectRecord,
  type SiteRecord,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  Textarea,
} from "../../shell/components/ui";
import { formatDate, formatDateShort, statusTone } from "../../shared/format";
import { loadLocationCatalogue } from "./locations";
import { assetStatusLabel, assetStatusTone } from "./status";

type OrganizationUnitOption = { id: string; name: string };

export function AssetDetailPage() {
  const t = useT();
  const { assetId } = useParams<{ assetId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [units, setUnits] = useState<OrganizationUnitOption[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [custodianCache, setCustodianCache] = useState<CustodianReference[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentsBlocked, setDocumentsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [assetTag, setAssetTag] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [acquisitionReference, setAcquisitionReference] = useState("");

  const [moveUnit, setMoveUnit] = useState("");
  const [moveCustodian, setMoveCustodian] = useState("");
  const [moveSite, setMoveSite] = useState("");
  const [moveProject, setMoveProject] = useState("");
  const [moveLocationDetail, setMoveLocationDetail] = useState("");
  const [moveReason, setMoveReason] = useState("");
  const [moveEffectiveDate, setMoveEffectiveDate] = useState("");

  const [newStatus, setNewStatus] = useState("idle");
  const [retirementStatus, setRetirementStatus] = useState<"retired" | "disposed">("retired");
  const [retirementReason, setRetirementReason] = useState("");
  const [confirmRetirement, setConfirmRetirement] = useState(false);

  const load = useCallback(async () => {
    if (!assetId) return;
    setLoading(true);
    setError(null);
    try {
      const record = await api.asset(token, assetId);
      setDetail(record);
      setName(record.asset.name);
      setAssetTag(record.asset.assetTag ?? "");
      setCategory(record.asset.category ?? "");
      setDescription(record.asset.description ?? "");
      setAcquisitionReference(record.asset.acquisitionReference ?? "");
      if (record.custodian) {
        setCustodianCache((prev) =>
          prev.some((c) => c.id === record.custodian!.id) ? prev : [...prev, record.custodian!],
        );
      }
      // Asset documents need a dedicated capability — a denial here is
      // expected for users who only hold asset.read.
      try {
        setDocuments(await api.documentsForEntity(token, "asset", assetId));
        setDocumentsBlocked(false);
      } catch {
        setDocuments([]);
        setDocumentsBlocked(true);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ast.detail.msg.couldNotLoadThisAsset"));
    } finally {
      setLoading(false);
    }
  }, [token, assetId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // The movement pickers AND the history labels both need the full location
  // catalogue, so it is resolved once here rather than per history row.
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

  async function run(action: () => Promise<unknown>, successMessage: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("ast.detail.msg.actionFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Shows a form message (and clears any success notice); always returns false. */
  function reject(message: string): false {
    setNotice(null);
    setError(message);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return false;
  }

  const unitName = (id: string | null) => (id ? (units.find((u) => u.id === id)?.name ?? "—") : "—");
  const siteName = (id: string | null) => (id ? (sites.find((s) => s.id === id)?.name ?? "—") : "—");
  const personName = (id: string | null) =>
    id ? (custodianCache.find((c) => c.id === id)?.fullName ?? employees.find((e) => e.id === id)?.fullName ?? "—") : "—";

  /** One-line description of what a ledger row actually changed. */
  function movementSummary(m: AssetMovementRecord): string {
    if (!m.appliedAt) return "Awaiting approval";
    const parts: string[] = [];
    if (m.fromSiteId !== m.toSiteId) parts.push(`Site ${siteName(m.fromSiteId)} → ${siteName(m.toSiteId)}`);
    if (m.fromCustodianEmployeeId !== m.toCustodianEmployeeId) {
      parts.push(`Custodian ${personName(m.fromCustodianEmployeeId)} → ${personName(m.toCustodianEmployeeId)}`);
    }
    if (m.fromOrganizationUnitId !== m.toOrganizationUnitId) {
      parts.push(`Unit ${unitName(m.fromOrganizationUnitId)} → ${unitName(m.toOrganizationUnitId)}`);
    }
    if (m.fromLocationDetail !== m.toLocationDetail) {
      parts.push(`Location ${m.fromLocationDetail ?? "—"} → ${m.toLocationDetail ?? "—"}`);
    }
    if (m.fromStatus !== m.toStatus && m.toStatus) {
      parts.push(`Status ${assetStatusLabel(m.fromStatus ?? "in_use")} → ${assetStatusLabel(m.toStatus)}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "No change recorded";
  }

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="error">{error ?? "Asset not found."}</Alert>;

  const { asset, custodian, movements, pendingMovement } = detail;
  const isTerminal = asset.status === "retired" || asset.status === "disposed";

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${asset.assetNumber} — ${asset.name}`}
        subtitle={asset.category ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Link to={`/asset-maintenance/assets/${asset.id}`}>
              <Button variant="secondary">{t("ast.detail.t.metersReliability")}</Button>
            </Link>
            <StatusPill tone={assetStatusTone(asset.status)}>{assetStatusLabel(asset.status)}</StatusPill>
          </div>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {isTerminal ? (
        <Alert tone="info">
          This asset is {assetStatusLabel(asset.status).toLowerCase()}. Its record and history stay available, but it
          can no longer be moved.
        </Alert>
      ) : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("ast.detail.t.overview")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("ast.detail.f.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("ast.detail.f.physicalTag")}>
            <Input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} />
          </Field>
          <Field label={t("ast.detail.f.category")}>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          <Field label={t("ast.detail.f.acquisitionReference")}>
            <Input value={acquisitionReference} onChange={(e) => setAcquisitionReference(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("ast.detail.f.description")}>
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">{t("ast.detail.f.acquired")}</dt>
            <dd className="text-slate-900">{formatDateShort(asset.acquiredAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("ast.detail.f.movementsRecorded")}</dt>
            <dd className="text-slate-900">{asset.version}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("ast.detail.f.retired")}</dt>
            <dd className="text-slate-900">{asset.retiredAt ? formatDate(asset.retiredAt) : "—"}</dd>
          </div>
        </dl>
        <div className="mt-3">
          <Button
            disabled={busy}
            onClick={() => {
              if (!name.trim()) {
                reject(t("common.form.missing", { fields: t("ast.detail.f.name") }));
                return;
              }
              void run(
                () =>
                  api.updateAsset(token, asset.id, {
                    name: name.trim(),
                    assetTag: assetTag || null,
                    category: category || null,
                    description: description || null,
                    acquisitionReference: acquisitionReference || null,
                  }),
                "Asset details updated.",
              );
            }}
          >
            Save details
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("ast.detail.t.locationCustodian")}</h2>
        <dl className="mb-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-slate-500">{t("ast.detail.f.responsibleUnit")}</dt>
            <dd className="text-slate-900">{unitName(asset.organizationUnitId)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("ast.detail.f.custodian")}</dt>
            <dd className="text-slate-900">{custodian ? custodian.fullName : "Unassigned"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("ast.detail.f.site")}</dt>
            <dd className="text-slate-900">{asset.siteId ? siteName(asset.siteId) : "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("ast.detail.f.locationDetail")}</dt>
            <dd className="text-slate-900">{asset.locationDetail ?? "—"}</dd>
          </div>
        </dl>

        {pendingMovement ? (
          <Alert tone="info">
            A movement is awaiting approval
            {pendingMovement.status ? (
              <>
                {" "}
                <StatusPill tone={statusTone(pendingMovement.status.instanceStatus)}>
                  {pendingMovement.status.stepName ?? pendingMovement.status.instanceStatus}
                </StatusPill>
              </>
            ) : null}
          </Alert>
        ) : null}

        {pendingMovement && pendingMovement.availableActions.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {pendingMovement.availableActions.map((action) => (
              <Button
                key={action.actionCode}
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api.actOnAssetMovement(token, pendingMovement.movement.id, action.actionCode),
                    `${action.name} recorded.`,
                  )
                }
              >
                {action.name}
              </Button>
            ))}
          </div>
        ) : null}

        {!isTerminal && !pendingMovement ? (
          <>
            <h3 className="mb-2 mt-4 text-xs font-bold text-slate-500">{t("ast.detail.t.moveThisAsset")}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("ast.detail.f.responsibleUnit")}>
                <Select value={moveUnit} onChange={(e) => setMoveUnit(e.target.value)}>
                  <option value="">{t("ast.detail.t.keepCurrent")}</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("ast.detail.f.custodian")}>
                <Select value={moveCustodian} onChange={(e) => setMoveCustodian(e.target.value)}>
                  <option value="">{t("ast.detail.t.keepCurrent")}</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.fullName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("ast.detail.f.site")}>
                <Select value={moveSite} onChange={(e) => setMoveSite(e.target.value)}>
                  <option value="">{t("ast.detail.t.keepCurrent")}</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("ast.detail.f.project")}>
                <Select value={moveProject} onChange={(e) => setMoveProject(e.target.value)}>
                  <option value="">{t("ast.detail.t.keepCurrent")}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("ast.detail.f.locationDetail")}>
                <Input
                  value={moveLocationDetail}
                  onChange={(e) => setMoveLocationDetail(e.target.value)}
                  placeholder={t("ast.detail.p.keepCurrent")}
                />
              </Field>
              <Field label={t("ast.detail.f.effectiveDate")}>
                <Input
                  type="date"
                  value={moveEffectiveDate}
                  onChange={(e) => setMoveEffectiveDate(e.target.value)}
                />
              </Field>
              <Field label={t("ast.detail.f.reason")}>
                <Input value={moveReason} onChange={(e) => setMoveReason(e.target.value)} placeholder={t("ast.detail.p.whyIsItMoving")} />
              </Field>
            </div>
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={async () => {
                  if (!moveUnit && !moveCustodian && !moveSite && !moveProject && !moveLocationDetail.trim()) {
                    reject(t("ast.detail.msg.moveNeedsChange"));
                    return;
                  }
                  const ok = await run(async () => {
                    // Only the fields the user actually chose are sent —
                    // an omitted field keeps its current value.
                    const body: Record<string, string> = {};
                    if (moveUnit) body.organizationUnitId = moveUnit;
                    if (moveCustodian) body.custodianEmployeeId = moveCustodian;
                    if (moveSite) body.siteId = moveSite;
                    if (moveProject) body.projectId = moveProject;
                    if (moveLocationDetail.trim()) body.locationDetail = moveLocationDetail.trim();
                    if (moveReason) body.reason = moveReason;
                    if (moveEffectiveDate) body.effectiveDate = moveEffectiveDate;
                    return api.moveAsset(token, asset.id, body);
                  }, "Movement recorded.");
                  if (!ok) return;
                  setMoveUnit("");
                  setMoveCustodian("");
                  setMoveSite("");
                  setMoveProject("");
                  setMoveLocationDetail("");
                  setMoveReason("");
                  setMoveEffectiveDate("");
                }}
              >
                Move asset
              </Button>
            </div>

            <h3 className="mb-2 mt-6 text-xs font-bold text-slate-500">{t("ast.detail.t.changeStatus")}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("ast.detail.f.newStatus")}>
                <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                  <option value="in_use">{t("ast.detail.t.inUse")}</option>
                  <option value="idle">{t("ast.detail.t.idle")}</option>
                </Select>
              </Field>
              <div className="flex items-end">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api.changeAssetStatus(token, asset.id, {
                          status: newStatus as "in_use" | "idle",
                          reason: moveReason || null,
                        }),
                      "Status change recorded.",
                    )
                  }
                >
                  Record status change
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </Card>

      {!isTerminal ? (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-slate-800">{t("ast.detail.t.retireOrDispose")}</h2>
          <p className="mb-3 text-sm text-slate-600">
            This is permanent. The asset stops moving, but the record and its full history stay readable — nothing is
            deleted.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("ast.detail.f.outcome")}>
              <Select
                value={retirementStatus}
                onChange={(e) => setRetirementStatus(e.target.value as "retired" | "disposed")}
              >
                <option value="retired">{t("ast.detail.t.retired")}</option>
                <option value="disposed">{t("ast.detail.t.disposed")}</option>
              </Select>
            </Field>
            <Field label={t("ast.detail.f.reason")}>
              <Input
                value={retirementReason}
                onChange={(e) => setRetirementReason(e.target.value)}
                placeholder={t("ast.detail.p.eGEndOfLife")}
              />
            </Field>
            <div className="flex items-end">
              <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={confirmRetirement}
                  onChange={(e) => setConfirmRetirement(e.target.checked)}
                />
                I confirm this asset is {retirementStatus}
              </label>
            </div>
          </div>
          <div className="mt-3">
            <Button
              disabled={busy}
              onClick={async () => {
                if (!confirmRetirement) {
                  reject(t("ast.detail.msg.confirmRetire"));
                  return;
                }
                const ok = await run(
                  () =>
                    api.retireAsset(token, asset.id, {
                      status: retirementStatus,
                      reason: retirementReason || null,
                    }),
                  "Asset retired.",
                );
                if (!ok) return;
                setConfirmRetirement(false);
                setRetirementReason("");
              }}
            >
              Confirm {retirementStatus === "disposed" ? "disposal" : "retirement"}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("ast.detail.t.documents")}</h2>
        {documentsBlocked ? (
          <Alert tone="info">
            Asset documents need a separate permission. Ask an administrator if you need access.
          </Alert>
        ) : (
          <>
            {documents.length === 0 ? (
              <p className="mb-3 text-sm text-slate-500">{t("ast.detail.n.noDocumentsAttached")}</p>
            ) : (
              <ul className="mb-3 space-y-1 text-sm text-slate-800">
                {documents.map((doc) => (
                  <li key={doc.id}>{doc.fileName}</li>
                ))}
              </ul>
            )}
            <input
              ref={fileInputRef}
              type="file"
              aria-label={t("ast.detail.f.attachAssetDocument")}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void run(() => api.uploadDocument(token, "asset", asset.id, file), "Document attached.");
                }
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
          </>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("ast.detail.t.movementHistory")}</h2>
        {movements.length === 0 ? (
          <p className="text-sm text-slate-500">{t("ast.detail.n.noMovementsRecorded")}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {movements.map((m) => (
              <li key={m.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {m.sequence !== null ? <Badge>#{m.sequence}</Badge> : null}
                  <StatusPill tone={m.appliedAt ? "success" : "warning"}>
                    {m.movementType === "status_change" ? "Status" : "Transfer"}
                  </StatusPill>
                  <span className="text-slate-700">{movementSummary(m)}</span>
                </div>
                <p className="mt-1 text-slate-500">
                  {m.appliedAt ? formatDate(m.appliedAt) : formatDate(m.createdAt)}
                  {m.effectiveDate ? ` · effective ${formatDateShort(m.effectiveDate)}` : ""}
                  {m.reason ? ` · ${m.reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
