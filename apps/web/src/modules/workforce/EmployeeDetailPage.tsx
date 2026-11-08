/**
 * Phase 3 — Employee detail (HR-CORE-002…008, HR-CORE-010).
 *
 * One coherent record with Overview, Employment & Organization, Documents,
 * and History sections. Placement and employment status are changed through
 * the placement action so a history period is always recorded — they are
 * never edited in place.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type DocumentRecord,
  type EmployeeDetail,
  type PositionRecord,
} from "../../lib/api";
import {
  Alert,
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
import { formatDateShort } from "../../shared/format";

type OrganizationUnitOption = { id: string; name: string };

function statusTone(status: string): "success" | "neutral" | "warning" {
  if (status === "active") return "success";
  if (status === "ended") return "neutral";
  return "warning";
}

export function EmployeeDetailPage() {
  const t = useT();
  const { employeeId } = useParams<{ employeeId: string }>();
  const { session } = useAuth();
  const token = session!.accessToken;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [units, setUnits] = useState<OrganizationUnitOption[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentsBlocked, setDocumentsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const [newPosition, setNewPosition] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [newStatus, setNewStatus] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [placementNote, setPlacementNote] = useState("");

  const load = useCallback(async () => {
    if (!employeeId) return;
    setLoading(true);
    setError(null);
    try {
      const [record, positionList, unitList] = await Promise.all([
        api.employee(token, employeeId),
        api.positions(token).catch(() => [] as PositionRecord[]),
        api.organizationUnits(token).catch(() => [] as OrganizationUnitOption[]),
      ]);
      setDetail(record);
      setPositions(positionList.filter((p) => p.isActive));
      setUnits(unitList);
      setFullName(record.employee.fullName);
      setEmail(record.employee.email ?? "");
      setPhone(record.employee.phone ?? "");
      setNewStatus(record.employee.employmentStatus);
      // Employee documents need a dedicated capability — a denial here is
      // expected for users who only hold workforce.read.
      try {
        setDocuments(await api.documentsForEntity(token, "employee", employeeId));
        setDocumentsBlocked(false);
      } catch {
        setDocuments([]);
        setDocumentsBlocked(true);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mw.empd.msg.couldNotLoadThisEmployee"));
    } finally {
      setLoading(false);
    }
  }, [token, employeeId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("mw.empd.msg.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="error">{error ?? "Employee not found."}</Alert>;

  const { employee, position, history } = detail;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${employee.employeeNumber} — ${employee.fullName}`}
        subtitle={position ? position.name : undefined}
        actions={<StatusPill tone={statusTone(employee.employmentStatus)}>{employee.employmentStatus}</StatusPill>}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mw.empd.t.overview")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t("mw.empd.f.fullName")}>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label={t("mw.empd.f.email")}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t("mw.empd.f.phone")}>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Button
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api.updateEmployeeProfile(token, employee.id, {
                    fullName,
                    email: email || null,
                    phone: phone || null,
                  }),
                "Profile updated.",
              )
            }
          >
            Save profile
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mw.empd.t.employmentOrganization")}</h2>
        <dl className="mb-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">{t("mw.empd.f.joined")}</dt>
            <dd className="text-slate-900">{formatDateShort(employee.joinedAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("mw.empd.f.employmentType")}</dt>
            <dd className="text-slate-900">{employee.employmentType ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("mw.empd.f.systemAccount")}</dt>
            <dd className="text-slate-900">{employee.userId ? "Linked" : "Not linked"}</dd>
          </div>
        </dl>

        <h3 className="mb-2 text-xs font-bold text-slate-500">{t("mw.empd.t.recordAPlacementChange")}</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("mw.empd.f.organizationUnit")}>
            <Select value={newUnit} onChange={(e) => setNewUnit(e.target.value)}>
              <option value="">{t("mw.empd.t.keepCurrent")}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("mw.empd.f.position")}>
            <Select value={newPosition} onChange={(e) => setNewPosition(e.target.value)}>
              <option value="">{t("mw.empd.t.keepCurrent")}</option>
              {positions.map((p) => (
                <option key={p.id} value={p.code}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("mw.empd.f.employmentStatus")}>
            <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
              <option value="active">{t("mw.empd.t.active")}</option>
              <option value="inactive">{t("mw.empd.t.inactive")}</option>
              <option value="ended">{t("mw.empd.t.ended")}</option>
            </Select>
          </Field>
          <Field label={t("mw.empd.f.effectiveFrom")}>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Field label={t("mw.empd.f.note")}>
            <Textarea
              rows={2}
              value={placementNote}
              onChange={(e) => setPlacementNote(e.target.value)}
              placeholder={t("mw.empd.p.whyIsThisChanging")}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api.changeEmployeePlacement(token, employee.id, {
                    organizationUnitId: newUnit || undefined,
                    positionCode: newPosition || undefined,
                    employmentStatus: newStatus,
                    effectiveFrom: effectiveFrom || undefined,
                    note: placementNote || null,
                  }),
                "Placement recorded.",
              )
            }
          >
            Record change
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mw.empd.t.documents")}</h2>
        {documentsBlocked ? (
          <Alert tone="info">
            Employee documents need a separate permission. Ask an administrator if you need access.
          </Alert>
        ) : (
          <>
            {documents.length === 0 ? (
              <p className="text-sm text-slate-500">{t("mw.empd.n.noDocumentsAttached")}</p>
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
              aria-label={t("mw.empd.f.attachEmployeeDocument")}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void run(
                    () => api.uploadDocument(token, "employee", employee.id, file),
                    "Document attached.",
                  );
                }
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
          </>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("mw.empd.t.employmentHistory")}</h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-500">{t("mw.empd.n.noHistoryRecorded")}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {history.map((period) => (
              <li key={period.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={statusTone(period.employmentStatus)}>{period.employmentStatus}</StatusPill>
                  <span className="text-slate-700">
                    {formatDateShort(period.effectiveFrom)} –{" "}
                    {period.effectiveTo ? formatDateShort(period.effectiveTo) : "present"}
                  </span>
                </div>
                {period.note ? <p className="mt-1 text-slate-500">{period.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
