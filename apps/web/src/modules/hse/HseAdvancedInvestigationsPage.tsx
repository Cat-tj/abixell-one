/**
 * HSE Advanced — Investigations & Risk page.
 *
 * Investigation frameworks (versioned), investigations bound to a Core HSE
 * record, the tenant's risk matrix, and JSA/HIRA assessments.
 *
 * The framework version is copied onto the investigation at creation and never
 * rewritten (ADR-0027 §2); the risk rating is stored on the assessment at
 * assessment time (§3), so editing the matrix never re-rates history.
 */

import { useCallback, useEffect, useState } from "react";
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
  Textarea,
  type Column,
} from "../../shell/components/ui";
import { formatDate, formatDateShort } from "../../shared/format";
import { useAuth } from "../../auth/AuthContext";
import { useT } from "../../i18n/LocaleProvider";
import {
  ApiError,
  api,
  type HseInvestigation,
  type HseInvestigationFramework,
  type HseRecord,
  type HseRiskAssessment,
  type HseRiskMatrix,
  type RiskAssessmentType,
} from "../../lib/api";

type ModalState =
  | { kind: "none" }
  | { kind: "create-framework"; code: string; name: string; description: string; causeCategories: string }
  | { kind: "start-investigation"; recordId: string; frameworkId: string }
  | {
      kind: "conclude-investigation";
      id: string;
      findings: string;
      rootCause: string;
      factors: { category: string; description: string; isRootCause: boolean }[];
    }
  | {
      kind: "create-assessment";
      assessmentType: RiskAssessmentType;
      title: string;
      taskDescription: string;
      likelihood: string;
      severity: string;
    };

const ASSESSMENT_TYPE_LABEL: Record<RiskAssessmentType, string> = {
  jsa: "JSA",
  hira: "HIRA",
};

export function HseAdvancedInvestigationsPage() {
  const { session } = useAuth();
  const token = session?.accessToken ?? "";
  const t = useT();

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const [frameworks, setFrameworks] = useState<HseInvestigationFramework[]>([]);
  const [investigations, setInvestigations] = useState<HseInvestigation[]>([]);
  const [records, setRecords] = useState<HseRecord[]>([]);
  const [matrix, setMatrix] = useState<HseRiskMatrix | null>(null);
  const [assessments, setAssessments] = useState<HseRiskAssessment[]>([]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [f, i, r, m, a] = await Promise.all([
        api.hseAdvFrameworks(token),
        api.hseAdvInvestigations(token),
        api.hseRecords(token),
        api.hseAdvRiskMatrix(token),
        api.hseAdvRiskAssessments(token),
      ]);
      setFrameworks(f || []);
      setInvestigations(i || []);
      setRecords(r || []);
      setMatrix(m || null);
      setAssessments(a || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.inv.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Form problems are shown in the page alert; the forms sit lower on the page, so bring it into view. */
  const reject = (message: string) => {
    setNotice(null);
    setError(message);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError ? err.message : fallback);

  const createFramework = async () => {
    if (modal.kind !== "create-framework") return;
    if (!modal.code.trim() || !modal.name.trim()) {
      reject(t("hse.inv.codeNameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHseAdvFramework(token, {
        code: modal.code.trim(),
        name: modal.name.trim(),
        description: modal.description.trim() || null,
        causeCategories: modal.causeCategories
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      });
      setNotice(t("hse.inv.frameworkCreated"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.inv.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const startInvestigation = async () => {
    if (modal.kind !== "start-investigation") return;
    if (!modal.recordId || !modal.frameworkId) {
      reject(t("hse.inv.pickRecordFramework"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHseAdvInvestigation(token, modal.recordId, { frameworkId: modal.frameworkId });
      setNotice(t("hse.inv.started"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.inv.startFailed"));
    } finally {
      setBusy(false);
    }
  };

  const saveInvestigation = async (conclude: boolean) => {
    if (modal.kind !== "conclude-investigation") return;
    if (conclude && !modal.rootCause.trim()) {
      reject(t("hse.inv.rootCauseRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateHseAdvInvestigation(token, modal.id, {
        findings: modal.findings.trim() || null,
        rootCause: modal.rootCause.trim() || null,
        contributingFactors: modal.factors
          .map((f) => ({ ...f, category: f.category.trim(), description: f.description.trim() }))
          .filter((f) => f.category && f.description),
        concluded: conclude,
      });
      setNotice(conclude ? t("hse.inv.concludedNotice") : t("hse.inv.updatedNotice"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.inv.updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createAssessment = async () => {
    if (modal.kind !== "create-assessment") return;
    const likelihood = Number(modal.likelihood);
    const severity = Number(modal.severity);
    if (!modal.title.trim()) {
      reject(t("hse.inv.titleRequired"));
      return;
    }
    if (!Number.isInteger(likelihood) || !Number.isInteger(severity)) {
      reject(t("hse.inv.wholeNumbers"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createHseAdvRiskAssessment(token, {
        assessmentType: modal.assessmentType,
        title: modal.title.trim(),
        taskDescription: modal.taskDescription.trim() || null,
        likelihood,
        severity,
      });
      setNotice(t("hse.inv.assessmentRecorded"));
      setModal({ kind: "none" });
      await load();
    } catch (err) {
      fail(err, t("hse.inv.assessmentFailed"));
    } finally {
      setBusy(false);
    }
  };

  const patchFactor = (index: number, patch: Partial<{ category: string; description: string; isRootCause: boolean }>) => {
    setModal((m) => {
      if (m.kind !== "conclude-investigation") return m;
      const factors = m.factors.map((f, i) => (i === index ? { ...f, ...patch } : f));
      return { ...m, factors };
    });
  };

  const frameworkColumns: Column<HseInvestigationFramework>[] = [
    { header: t("fin.common.code"), cell: (row) => <span className="font-mono text-sm">{row.code}</span> },
    { header: t("fin.common.name"), cell: (row) => <span>{row.name}</span> },
    { header: t("hse.inv.colVersion"), className: "text-right", cell: (row) => <span>v{row.version}</span> },
    {
      header: t("hse.inv.colCauseCategories"),
      cell: (row) => (
        <span className="text-sm text-ink-dim">
          {row.causeCategories.join(", ") || t("hse.common.notAvailable")}
        </span>
      ),
    },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={row.isActive ? "success" : "neutral"}>
          {row.isActive ? t("hse.inv.active") : t("hse.inv.inactive")}
        </StatusPill>
      ),
    },
  ];

  const investigationColumns: Column<HseInvestigation>[] = [
    {
      header: t("hse.inv.colFramework"),
      cell: (row) => (
        <span className="text-sm">
          <span className="font-mono">{row.frameworkCode}</span> v{row.frameworkVersion}
        </span>
      ),
    },
    { header: t("hse.inv.colStarted"), cell: (row) => <span>{formatDateShort(row.startedAt)}</span> },
    {
      header: t("hse.inv.colRootCause"),
      cell: (row) => (
        <span className="text-sm text-ink-dim">{row.rootCause || t("hse.common.notAvailable")}</span>
      ),
    },
    {
      header: t("fin.common.status"),
      mobileRole: "status",
      cell: (row) =>
        row.concludedAt ? (
          <StatusPill tone="success">{t("hse.inv.concluded")}</StatusPill>
        ) : (
          <StatusPill tone="info">{t("hse.inv.open")}</StatusPill>
        ),
    },
    {
      header: t("fin.common.actions"),
      mobileRole: "detail",
      cell: (row) => (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            setModal({
              kind: "conclude-investigation",
              id: row.id,
              findings: row.findings ?? "",
              rootCause: row.rootCause ?? "",
              factors: row.contributingFactors,
            })
          }
        >
          {t("hse.inv.recordFindings")}
        </Button>
      ),
    },
  ];

  const assessmentColumns: Column<HseRiskAssessment>[] = [
    {
      header: t("fin.common.type"),
      cell: (row) => <Badge>{ASSESSMENT_TYPE_LABEL[row.assessmentType]}</Badge>,
    },
    { header: t("hse.common.title"), cell: (row) => <span>{row.title}</span> },
    {
      header: t("hse.inv.colRating"),
      className: "text-right",
      cell: (row) => (
        <span className="font-mono text-sm">
          {row.likelihood} × {row.severity} = {row.score} ({row.bandCode})
        </span>
      ),
    },
    {
      header: t("hse.inv.colResidual"),
      className: "text-right",
      cell: (row) =>
        row.residualScore ? (
          <span className="font-mono text-sm">
            {row.residualScore} ({row.residualBandCode})
          </span>
        ) : (
          <span className="text-sm text-ink-dim">{t("hse.common.notAvailable")}</span>
        ),
    },
    { header: t("hse.inv.colAssessed"), cell: (row) => <span>{formatDate(row.assessedAt)}</span> },
  ];

  const recordLabel = (recordId: string) => {
    const r = records.find((x) => x.id === recordId);
    return r ? `${r.recordNumber} · ${r.title}` : recordId;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("hse.inv.title")}
        subtitle={t("hse.inv.subtitle")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {loading ? (
        <div className="flex items-center justify-center p-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.inv.frameworks")}</h2>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  setModal({ kind: "create-framework", code: "", name: "", description: "", causeCategories: "" })
                }
              >
                + {t("hse.inv.addFramework")}
              </Button>
            </div>
            <DataTable
              columns={frameworkColumns}
              rows={frameworks}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("hse.inv.noFrameworksTitle")} description={t("hse.inv.noFrameworksDescription")} />}
            />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.inv.investigations")}</h2>
              <Button
                variant="secondary"
                disabled={busy || records.length === 0}
                title={records.length === 0 ? t("hse.inv.noRecordsToInvestigate") : undefined}
                onClick={() => setModal({ kind: "start-investigation", recordId: "", frameworkId: "" })}
              >
                + {t("hse.inv.addInvestigation")}
              </Button>
            </div>
            <DataTable
              columns={investigationColumns}
              rows={investigations}
              keyOf={(row) => row.id}
              empty={
                <EmptyState
                  title={t("hse.inv.noInvestigationsTitle")}
                  description={t("hse.inv.noInvestigationsDescription")}
                />
              }
            />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.inv.riskMatrix")}</h2>
            </div>
            {matrix ? (
              <Card>
                <div className="text-sm text-ink">
                  <span className="font-mono">{matrix.code}</span> {matrix.name}
                </div>
                <div className="mt-1 text-sm text-ink-dim">
                  {t("hse.inv.matrixScale", {
                    likelihood: matrix.likelihoodScale.map((p) => p.value).join(" · "),
                    severity: matrix.severityScale.map((p) => p.value).join(" · "),
                  })}
                </div>
              </Card>
            ) : (
              <EmptyState
                title={t("hse.inv.noMatrixTitle")}
                description={t("hse.inv.noMatrixDescription")}
              />
            )}
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">{t("hse.inv.assessments")}</h2>
              <Button
                variant="secondary"
                disabled={busy || !matrix}
                title={!matrix ? t("hse.inv.noMatrixDescription") : undefined}
                onClick={() =>
                  setModal({
                    kind: "create-assessment",
                    assessmentType: "jsa",
                    title: "",
                    taskDescription: "",
                    likelihood: "",
                    severity: "",
                  })
                }
              >
                + {t("hse.inv.addAssessment")}
              </Button>
            </div>
            <DataTable
              columns={assessmentColumns}
              rows={assessments}
              keyOf={(row) => row.id}
              empty={<EmptyState title={t("hse.inv.noAssessmentsTitle")} description={t("hse.inv.noAssessmentsDescription")} />}
            />
          </div>
        </div>
      )}

      {modal.kind === "create-framework" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.inv.createFramework")}</h2>
          <div className="space-y-3">
            <Field label={t("fin.common.code")} required>
              <Input
                placeholder="ICAM"
                value={modal.code}
                onChange={(e) => setModal({ ...modal, code: e.target.value })}
              />
            </Field>
            <Field label={t("fin.common.name")} required>
              <Input
                placeholder="Incident Cause Analysis Method"
                value={modal.name}
                onChange={(e) => setModal({ ...modal, name: e.target.value })}
              />
            </Field>
            <Field label={t("fin.common.description")}>
              <Textarea
                rows={2}
                value={modal.description}
                onChange={(e) => setModal({ ...modal, description: e.target.value })}
              />
            </Field>
            <Field label={t("hse.inv.causeCategories")} hint={t("hse.inv.causeCategoriesHint")}>
              <Input
                placeholder="human, equipment, environment, organisation"
                value={modal.causeCategories}
                onChange={(e) => setModal({ ...modal, causeCategories: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => createFramework()}>
              {t("fin.common.create")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "start-investigation" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.inv.startInvestigation")}</h2>
          <div className="space-y-3">
            <Field label={t("hse.inv.coreRecord")} required>
              <Select
                value={modal.recordId}
                onChange={(e) => setModal({ ...modal, recordId: e.target.value })}
              >
                <option value="">{t("hse.inv.selectRecord")}</option>
                {records.map((r) => (
                  <option key={r.id} value={r.id}>
                    {recordLabel(r.id)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("hse.inv.framework")} required>
              <Select
                value={modal.frameworkId}
                onChange={(e) => setModal({ ...modal, frameworkId: e.target.value })}
              >
                <option value="">{t("hse.inv.selectFramework")}</option>
                {frameworks
                  .filter((f) => f.isActive)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.code} v{f.version} · {f.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => startInvestigation()}>
              {t("hse.inv.start")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "conclude-investigation" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.inv.recordFindingsTitle")}</h2>
          <div className="space-y-3">
            <Field label={t("hse.inv.findings")}>
              <Textarea
                rows={3}
                value={modal.findings}
                onChange={(e) => setModal({ ...modal, findings: e.target.value })}
              />
            </Field>
            <Field label={t("hse.inv.rootCause")} hint={t("hse.inv.rootCauseHint")}>
              <Textarea
                rows={2}
                value={modal.rootCause}
                onChange={(e) => setModal({ ...modal, rootCause: e.target.value })}
              />
            </Field>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink-dim">{t("hse.inv.contributingFactors")}</span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setModal({
                      ...modal,
                      factors: [...modal.factors, { category: "", description: "", isRootCause: false }],
                    })
                  }
                >
                  + {t("hse.inv.addFactor")}
                </Button>
              </div>
              {modal.factors.map((factor, index) => (
                <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                  <Input
                    placeholder={t("fin.common.category")}
                    value={factor.category}
                    onChange={(e) => patchFactor(index, { category: e.target.value })}
                  />
                  <Input
                    placeholder={t("fin.common.description")}
                    value={factor.description}
                    onChange={(e) => patchFactor(index, { description: e.target.value })}
                  />
                  <label className="flex items-center gap-2 text-sm text-ink-dim">
                    <input
                      type="checkbox"
                      checked={factor.isRootCause}
                      onChange={(e) => patchFactor(index, { isRootCause: e.target.checked })}
                    />
                    {t("hse.inv.rootCauseCheck")}
                  </label>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      setModal((m) =>
                        m.kind === "conclude-investigation"
                          ? { ...m, factors: m.factors.filter((_, i) => i !== index) }
                          : m,
                      )
                    }
                  >
                    {t("hse.common.remove")}
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => saveInvestigation(true)}>
              {t("hse.inv.saveAndConclude")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => saveInvestigation(false)}>
              {t("hse.inv.saveDraft")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}

      {modal.kind === "create-assessment" ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.inv.recordAssessment")}</h2>
          <div className="space-y-3">
            <Field label={t("fin.common.type")} required>
              <Select
                value={modal.assessmentType}
                onChange={(e) =>
                  setModal({ ...modal, assessmentType: e.target.value as RiskAssessmentType })
                }
              >
                <option value="jsa">{t("hse.inv.optJsa")}</option>
                <option value="hira">{t("hse.inv.optHira")}</option>
              </Select>
            </Field>
            <Field label={t("hse.common.title")} required>
              <Input value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} />
            </Field>
            <Field label={t("hse.inv.taskDescription")}>
              <Textarea
                rows={2}
                value={modal.taskDescription}
                onChange={(e) => setModal({ ...modal, taskDescription: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("hse.inv.likelihood")} required>
                <Select
                  value={modal.likelihood}
                  onChange={(e) => setModal({ ...modal, likelihood: e.target.value })}
                >
                  <option value="">{t("fin.common.select")}</option>
                  {(matrix?.likelihoodScale ?? []).map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.value} · {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("hse.common.severity")} required>
                <Select
                  value={modal.severity}
                  onChange={(e) => setModal({ ...modal, severity: e.target.value })}
                >
                  <option value="">{t("fin.common.select")}</option>
                  {(matrix?.severityScale ?? []).map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.value} · {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy} onClick={() => createAssessment()}>
              {t("hse.inv.record")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setModal({ kind: "none" })}>
              {t("common.cancel")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
