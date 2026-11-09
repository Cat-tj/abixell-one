/**
 * Checkpoint 1C.6 — Complaint Administration & Configuration (a section of
 * Administration). Gated on complaint.configure. Manages the reference-data
 * catalogs that drive the Complaint experience (create + activate/deactivate)
 * and shows the numbering, notification templates, and configured workflow
 * read-only — because Core supports only create for those, or editing would
 * require the versioning flow. No fake controls: the backend reports which
 * capabilities are editable.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ComplaintConfigView,
  type ReferenceItemView,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  type Column,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  StatusPill,
} from "../../shell/components/ui";
import { OverlayDialog } from "../../shell/components/OverlayDialog";
import { useT, type Translate } from "../../i18n/LocaleProvider";

function configErrorMessage(t: Translate, err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 401) return t("complaintConfig.sessionExpired");
  if (err instanceof ApiError && err.status === 403) return t("complaintConfig.accessDenied");
  return err instanceof ApiError ? err.message : fallback;
}

const REF_TYPE_KEYS: { typeCode: string; titleKey: "complaintConfig.categories" | "complaintConfig.severity" | "complaintConfig.priority"; singularKey: "complaintConfig.categorySingular" | "complaintConfig.severitySingular" | "complaintConfig.prioritySingular"; key: "categories" | "severities" | "priorities" }[] = [
  { typeCode: "complaint_category", titleKey: "complaintConfig.categories", singularKey: "complaintConfig.categorySingular", key: "categories" },
  { typeCode: "complaint_severity", titleKey: "complaintConfig.severity", singularKey: "complaintConfig.severitySingular", key: "severities" },
  { typeCode: "priority_level", titleKey: "complaintConfig.priority", singularKey: "complaintConfig.prioritySingular", key: "priorities" },
];

export function ComplaintConfigPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();

  const [config, setConfig] = useState<ComplaintConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<
    | { kind: "create"; typeCode: string }
    | { kind: "toggle"; typeCode: string; item: ReferenceItemView }
    | null
  >(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const loadRequestRef = useRef(0);
  const dialogRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextConfig = await api.complaintConfig(token);
      if (loadRequestRef.current === requestId) setConfig(nextConfig);
    } catch (err) {
      if (loadRequestRef.current !== requestId) return;
      setError(configErrorMessage(t, err, t("complaintConfig.loadFailed")));
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, [t, token]);

  useEffect(() => {
    setConfig(null);
    setDialog(null);
    setDialogError(null);
    setNotice(null);
    setQueries({});
    pendingRef.current = false;
    setPending(false);
    void load();
    // Existing API methods do not accept AbortSignal. Invalidate both read
    // and mutation completions on unmount or session change instead.
    return () => {
      loadRequestRef.current += 1;
      dialogRequestRef.current += 1;
    };
  }, [load]);

  function openCreateDialog(typeCode: string, button: HTMLButtonElement) {
    if (pendingRef.current || loading || error || !config?.capabilities.referenceDataCreate) return;
    triggerRef.current = button;
    dialogRequestRef.current += 1;
    setDialog({ kind: "create", typeCode });
    setDialogError(null);
  }

  function openToggleDialog(typeCode: string, item: ReferenceItemView, button: HTMLButtonElement) {
    if (pendingRef.current || loading || error || !config?.capabilities.referenceDataToggleActive) return;
    triggerRef.current = button;
    dialogRequestRef.current += 1;
    setDialog({ kind: "toggle", typeCode, item });
    setDialogError(null);
  }

  function closeDialog() {
    if (pendingRef.current) return;
    dialogRequestRef.current += 1;
    setDialog(null);
    setDialogError(null);
  }

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || pendingRef.current || loading || error || !config) return;
    const allowed = dialog.kind === "create"
      ? config.capabilities.referenceDataCreate
      : config.capabilities.referenceDataToggleActive;
    if (!allowed) return;
    // Capture form values before awaiting; lock synchronously before React renders.
    const data = new FormData(event.currentTarget);
    const code = String(data.get("code") ?? "").trim();
    const label = String(data.get("label") ?? "").trim();
    if (dialog.kind === "create" && (!code || !label)) {
      setDialogError(t("complaintConfig.codeAndLabelRequired"));
      return;
    }
    const requestId = ++dialogRequestRef.current;
    pendingRef.current = true;
    setPending(true);
    setDialogError(null);
    setNotice(null);
    try {
      const item = dialog.kind === "create"
        ? await api.createComplaintRefItem(token, dialog.typeCode, { code, label })
        : await api.setComplaintRefItemActive(token, dialog.typeCode, dialog.item.id, !dialog.item.isActive);
      if (dialogRequestRef.current !== requestId) return;
      setNotice(dialog.kind === "create"
        ? t("complaintConfig.itemCreated")
        : (item.isActive ? t("complaintConfig.itemActivated") : t("complaintConfig.itemDeactivated")));
      // Refresh errors belong to the page, not the successful mutation dialog.
      // Keep the trigger mounted while refreshing so OverlayDialog restores focus.
      await load();
      if (dialogRequestRef.current !== requestId) return;
      setDialog(null);
    } catch (err) {
      if (dialogRequestRef.current === requestId) {
        setDialogError(configErrorMessage(t, err, t("complaintConfig.failedSave")));
      }
    } finally {
      if (dialogRequestRef.current === requestId) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  if (loading && !config) return <Spinner label={t("complaintConfig.loading")} />;
  if (!config) {
    return (
      <div className="space-y-3">
        <Alert tone="error">{error ?? t("complaintConfig.failedLoad")}</Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void load()}>{t("complaintConfig.retry")}</Button>
          <Button variant="secondary" onClick={() => navigate("/complaints")}>
            {t("complaintConfig.backToAdmin")}
          </Button>
        </div>
      </div>
    );
  }
  const actionsDisabled = pending || loading || error !== null;
  const selectedType = REF_TYPE_KEYS.find((rt) => rt.typeCode === dialog?.typeCode);
  const actionLabel = dialog?.kind === "toggle"
    ? (dialog.item.isActive ? t("complaintConfig.deactivate") : t("complaintConfig.activate"))
    : t("complaintConfig.create");

  return (
    <div>
      <PageHeader
        title={t("complaintConfig.title")}
        subtitle={t("complaintConfig.subtitle")}
        actions={
          <Button variant="secondary" onClick={() => navigate("/complaints")}>
            {t("complaintConfig.backToAdmin")}
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      {/* Reference Data */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("complaintConfig.referenceData")}</h2>
        <div className="space-y-6">
          {REF_TYPE_KEYS.map((rt) => {
            const items = config.referenceData[rt.key];
            const query = queries[rt.typeCode] ?? "";
            const normalizedQuery = query.trim().toLocaleLowerCase();
            const visibleItems = normalizedQuery
              ? items.filter((item) => `${item.code} ${item.label}`.toLocaleLowerCase().includes(normalizedQuery))
              : items;
            const columns: Column<ReferenceItemView>[] = [
              {
                header: t("complaintConfig.code"),
                cell: (item) => <code className="font-mono text-xs text-slate-600">{item.code}</code>,
                mobileRole: "title",
              },
              {
                header: t("complaintConfig.label"),
                cell: (item) => item.label,
              },
              {
                header: t("complaintConfig.status"),
                cell: (item) =>
                  item.isActive ? (
                    <StatusPill tone="success">{t("complaintConfig.active")}</StatusPill>
                  ) : (
                    <StatusPill tone="neutral">{t("complaintConfig.inactive")}</StatusPill>
                  ),
                mobileRole: "status",
              },
              {
                header: t("complaintConfig.action"),
                cell: (item) =>
                  config.capabilities.referenceDataToggleActive ? (
                    <Button
                      variant="ghost"
                      className="w-full sm:w-auto"
                      disabled={actionsDisabled}
                      onClick={(event) => {
                        openToggleDialog(rt.typeCode, item, event.currentTarget);
                      }}
                    >
                      {item.isActive ? t("complaintConfig.deactivate") : t("complaintConfig.activate")}
                    </Button>
                  ) : null,
                className: "text-right",
              },
            ];

            const typeTitle = t(rt.titleKey);
            const singular = t(rt.singularKey);
            const itemsLabel = items.length !== 1 ? t("complaintConfig.itemsLabelPlural") : t("complaintConfig.itemsLabelSingular");

            return (
              <Card key={rt.typeCode}>
                <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">{typeTitle}</h3>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {t("complaintConfig.showing", {
                        visibleItems: String(visibleItems.length),
                        totalItems: String(items.length),
                        itemsLabel,
                      })}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <Field label={t("complaintConfig.searchField", { typeTitle })}>
                      <Input
                        type="search"
                        placeholder={t("complaintConfig.searchPlaceholder")}
                        value={query}
                        onChange={(event) => setQueries((prev) => ({ ...prev, [rt.typeCode]: event.target.value }))}
                        disabled={loading}
                        autoComplete="off"
                      />
                    </Field>
                    {config.capabilities.referenceDataCreate && (
                      <Button
                        variant="primary"
                        disabled={actionsDisabled}
                        onClick={(event) => {
                          openCreateDialog(rt.typeCode, event.currentTarget);
                        }}
                      >
                        {t("complaintConfig.createItem", { singular })}
                      </Button>
                    )}
                  </div>
                </div>
                <DataTable
                  columns={columns}
                  rows={visibleItems}
                  keyOf={(item) => item.id}
                  mobileBreakpoint="md"
                  empty={
                    <EmptyState
                      title={items.length === 0 ? t("complaintConfig.noItemsConfigured", { typeTitle }) : t("complaintConfig.noMatchingItems")}
                      description={
                        items.length === 0
                          ? t("complaintConfig.createFirstItem", { singular })
                          : t("complaintConfig.tryDifferentSearch")
                      }
                      action={
                        items.length === 0 && config.capabilities.referenceDataCreate ? (
                          <Button
                            variant="primary"
                            disabled={actionsDisabled}
                            onClick={(event) => {
                              openCreateDialog(rt.typeCode, event.currentTarget);
                            }}
                          >
                            {t("complaintConfig.createItem", { singular })}
                          </Button>
                        ) : undefined
                      }
                    />
                  }
                />
              </Card>
            );
          })}
        </div>
      </section>

      {/* Numbering + Notifications */}
      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">{t("complaintConfig.numbering")}</h2>
          {config.numbering ? (
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-slate-400">{t("complaintConfig.pattern")}</dt>
                <dd className="font-mono text-slate-700">{config.numbering.pattern}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-400">{t("complaintConfig.currentSequence")}</dt>
                <dd className="text-slate-700">{config.numbering.currentSequence}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-slate-400">{t("complaintConfig.noNumbering")}</p>
          )}
          {!config.capabilities.numberingEditable && (
            <p className="mt-2 text-xs text-slate-400">{t("complaintConfig.readOnlyRelease")}</p>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">{t("complaintConfig.notifications")}</h2>
          {config.notificationTemplates.length === 0 ? (
            <p className="text-sm text-slate-400">{t("complaintConfig.noNotifications")}</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {config.notificationTemplates.map((tpl) => (
                <li key={tpl.id} className="py-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-slate-600">{tpl.eventType}</span>
                    <Badge>{tpl.channel}</Badge>
                  </div>
                  {tpl.subjectTemplate && <div className="mt-0.5 text-slate-600">{tpl.subjectTemplate}</div>}
                </li>
              ))}
            </ul>
          )}
          {!config.capabilities.notificationTemplateEditable && (
            <p className="mt-2 text-xs text-slate-400">{t("complaintConfig.readOnlyRelease")}</p>
          )}
        </Card>
      </section>

      {/* Workflow (read-only) */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">{t("complaintConfig.workflow")}</h2>
        <Card>
          {config.workflow ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-slate-700">{config.workflow.definition.name}</span>
                <Badge>
                  v{config.workflow.versionNumber ?? "—"} · {config.workflow.versionStatus ?? t("complaintConfig.noPublishedVersion")}
                </Badge>
                {!config.capabilities.workflowEditable && (
                  <span className="text-xs text-slate-400">{t("complaintConfig.readOnlyWorkflow")}</span>
                )}
              </div>
              <p className="mb-1 text-xs text-slate-400 lg:hidden">{t("complaintConfig.workflowScroll")}</p>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-bold text-slate-500">{t("complaintConfig.step")}</th>
                      <th className="px-3 py-2 text-left text-xs font-bold text-slate-500">{t("complaintConfig.slaHours")}</th>
                      <th className="px-3 py-2 text-left text-xs font-bold text-slate-500">{t("complaintConfig.actions")}</th>
                      <th className="px-3 py-2 text-left text-xs font-bold text-slate-500">{t("complaintConfig.assignedTo")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {config.workflow.steps.map((s) => (
                      <tr key={s.code}>
                        <td className="px-3 py-2 align-top">
                          <div className="font-medium text-slate-700">{s.name}</div>
                          <div className="font-mono text-xs text-slate-400">
                            {s.code}
                            {s.isInitial ? ` · ${t("complaintConfig.initial")}` : ""}
                            {s.isTerminal ? ` · ${t("complaintConfig.terminal")} (${s.terminalStatus})` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top text-slate-600">{s.slaHours ?? "—"}</td>
                        <td className="px-3 py-2 align-top text-slate-600">
                          {s.transitions.length === 0
                            ? "—"
                            : s.transitions.map((tr) => (
                                <div key={tr.actionCode}>
                                  {tr.name} → {tr.toStepCode ?? "?"}
                                  {tr.condition ? ` [${tr.condition.field} ${tr.condition.operator} ${String(tr.condition.value)}]` : ""}
                                </div>
                              ))}
                        </td>
                        <td className="px-3 py-2 align-top text-slate-600">
                          {s.assignmentRules.length === 0
                            ? "—"
                            : s.assignmentRules.map((r, i) => (
                                <div key={i}>
                                  {r.assignmentType === "role"
                                    ? `${r.roleCode} (${r.organizationUnitStrategy})`
                                    : `user: ${r.specificUserSource}`}
                                </div>
                              ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">{t("complaintConfig.noWorkflow")}</p>
          )}
        </Card>
      </section>

      {loading && <Spinner label={t("complaintConfig.loadingRefresh")} />}
      <OverlayDialog
        open={dialog !== null}
        title={dialog?.kind === "toggle"
          ? t("complaintConfig.toggleDialogTitle", { action: actionLabel })
          : t("complaintConfig.createDialogTitle", { singularTitle: selectedType ? t(selectedType.singularKey) : t("complaintConfig.noneAssigned") })}
        description={
          dialog?.kind === "toggle"
            ? t("complaintConfig.togglePrompt", { action: actionLabel.toLowerCase(), itemLabel: dialog.item.label })
            : t("complaintConfig.createPrompt")
        }
        pending={pending}
        onClose={closeDialog}
        restoreFocusRef={triggerRef}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={pending}>
              {t("complaintConfig.cancel")}
            </Button>
            <Button type="submit" form="complaint-config-item-form" disabled={actionsDisabled}>
              {pending ? t("complaintConfig.saving") : actionLabel}
            </Button>
          </>
        }
      >
        {dialogError && (
          <div className="mb-4">
            <Alert tone="error">{dialogError}</Alert>
          </div>
        )}
        <form id="complaint-config-item-form" className="space-y-4" onSubmit={submitDialog}>
          {dialog?.kind === "create" ? (
            <>
              <Field label={t("complaintConfig.codeFieldLabel")} required hint={t("complaintConfig.codeFieldHint")}>
                <Input name="code" placeholder={t("complaintConfig.codeFieldLabel")} required disabled={pending} autoComplete="off" />
              </Field>
              <Field label={t("complaintConfig.labelFieldLabel")} required hint={t("complaintConfig.labelFieldHint")}>
                <Input name="label" placeholder={t("complaintConfig.labelFieldLabel")} required disabled={pending} autoComplete="off" />
              </Field>
            </>
          ) : (
            <p className="text-sm text-slate-600">
              {t("complaintConfig.togglePromptDetail", { itemLabel: <strong key="label">{dialog?.item.label}</strong> })}
            </p>
          )}
        </form>
      </OverlayDialog>
    </div>
  );
}
