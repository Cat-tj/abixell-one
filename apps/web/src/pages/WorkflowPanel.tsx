import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type WorkflowAssignment, type WorkflowInstance } from "../lib/api";
import { useT } from "../i18n/LocaleProvider";
import type { MessageKey } from "../i18n/dictionaries/en";

const ACTION_LABEL: Record<"approve" | "reject" | "return" | "resubmit", MessageKey> = {
  approve: "workflow.approve",
  reject: "workflow.reject",
  return: "workflow.return",
  resubmit: "workflow.resubmit",
};
import { OverlayDialog } from "../shell/components/OverlayDialog";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Select,
  StatusPill,
  Timeline,
  type Column,
} from "../shell/components/ui";
import { AdminSectionState } from "./admin/console/AdminSection";

/**
 * Checkpoint 0D — Workflow & Approval Engine panel.
 *
 * Demonstrates the generic engine end-to-end against a demo transaction
 * only: start an instance, act on a task (Approve / Reject / Return /
 * Resubmit — whatever the current Step's Transitions allow), inspect the
 * History of one instance, and trigger the Escalation sweep. No
 * Complaint/Survey/Procurement business logic here by design — this proves
 * the engine, not a business module.
 */

type OrgUnitOption = { id: string; name: string };
type HistoryEntry = { id?: string; actionCode: string; occurredAt: string; comment: string | null };
type ResourceState = { loading: boolean; error: string | null; denied: boolean; sessionExpired: boolean };

const initialResourceState: ResourceState = { loading: true, error: null, denied: false, sessionExpired: false };

/** A failed read must never render as an empty queue: 401 and 403 stay
 * distinct from a load failure, matching the console resource model. */
function describeFailure(error: unknown, t: ReturnType<typeof useT>, fallback: string): ResourceState {
  const denied = error instanceof ApiError && error.status === 403;
  const sessionExpired = error instanceof ApiError && error.status === 401;
  return {
    loading: false,
    denied,
    sessionExpired,
    error: sessionExpired
      ? t("workflow.sessionExpired")
      : denied
        ? t("workflow.noPermission")
        : error instanceof ApiError
          ? error.message
          : fallback,
  };
}

export function WorkflowPanel({
  token,
  orgUnits,
  canStart,
  canAct,
  canManage,
  onMessage,
}: {
  token: string;
  orgUnits: OrgUnitOption[];
  canStart: boolean;
  canAct: boolean;
  canManage: boolean;
  onMessage: (m: { type: "error" | "success"; text: string }) => void;
}) {
  const t = useT();
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [myAssignments, setMyAssignments] = useState<WorkflowAssignment[]>([]);
  const [instancesState, setInstancesState] = useState<ResourceState>(initialResourceState);
  const [assignmentsState, setAssignmentsState] = useState<ResourceState>(initialResourceState);
  const [selectedInstanceId, setSelectedInstanceId] = useState("");

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyPending, setHistoryPending] = useState(false);

  const [startOpen, setStartOpen] = useState(false);
  const [startOrgUnitId, setStartOrgUnitId] = useState("");
  const [startCategory, setStartCategory] = useState("normal");
  const [startPending, setStartPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [actionOpen, setActionOpen] = useState(false);
  const [actionAssignment, setActionAssignment] = useState<WorkflowAssignment | null>(null);
  const [actionCode, setActionCode] = useState("");
  const [actionComment, setActionComment] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [claimTarget, setClaimTarget] = useState<{ assignment: WorkflowAssignment; releasing: boolean } | null>(null);
  const [claimPending, setClaimPending] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepPending, setSweepPending] = useState(false);
  const [sweepError, setSweepError] = useState<string | null>(null);

  const refreshGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const lifetime = useRef(0);
  const startBusy = useRef(false);
  const actionBusy = useRef(false);
  const claimBusy = useRef(false);
  const sweepBusy = useRef(false);

  useEffect(() => {
    lifetime.current += 1;
    return () => {
      lifetime.current += 1;
      refreshGeneration.current += 1;
      historyGeneration.current += 1;
      startBusy.current = false;
      actionBusy.current = false;
      claimBusy.current = false;
      sweepBusy.current = false;
    };
  }, [token]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setInstancesState((state) => ({ ...state, loading: true, error: null }));
    setAssignmentsState((state) => ({ ...state, loading: true, error: null }));

    const [instanceResult, assignmentResult] = await Promise.allSettled([
      api.workflowInstances(token),
      api.myWorkflowAssignments(token),
    ]);
    if (generation !== refreshGeneration.current) return;

    if (instanceResult.status === "fulfilled") {
      setInstances(instanceResult.value);
      setInstancesState({ loading: false, error: null, denied: false, sessionExpired: false });
    } else {
      setInstancesState(describeFailure(instanceResult.reason, t, t("workflow.instancesLoad")));
    }

    if (assignmentResult.status === "fulfilled") {
      setMyAssignments(assignmentResult.value);
      setAssignmentsState({ loading: false, error: null, denied: false, sessionExpired: false });
    } else {
      setAssignmentsState(describeFailure(assignmentResult.reason, t, t("workflow.tasksLoad")));
    }
  }, [t, token]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (orgUnits.length > 0 && !orgUnits.some((unit) => unit.id === startOrgUnitId)) {
      setStartOrgUnitId(orgUnits[0].id);
    }
  }, [orgUnits, startOrgUnitId]);

  const openHistory = useCallback(
    async (instanceId: string) => {
      const generation = ++historyGeneration.current;
      setSelectedInstanceId(instanceId);
      setHistoryOpen(true);
      setHistoryPending(true);
      setHistoryError(null);
      try {
        const result = await api.workflowInstanceHistory(token, instanceId);
        if (generation !== historyGeneration.current) return;
        setHistory(result);
      } catch (err) {
        if (generation !== historyGeneration.current) return;
        setHistory([]);
        setHistoryError(err instanceof ApiError ? err.message : t("workflow.historyLoad"));
      } finally {
        if (generation === historyGeneration.current) setHistoryPending(false);
      }
    },
    [t, token],
  );

  async function handleStartInstance() {
    if (startBusy.current || !canStart) return;
    if (!startOrgUnitId) {
      setStartError(t("common.form.missing", { fields: t("workflow.orgUnit") }));
      return;
    }
    const life = lifetime.current;
    startBusy.current = true;
    setStartPending(true);
    setStartError(null);
    try {
      const orgUnitId = startOrgUnitId;
      const category = startCategory;
      const tx = await api.createDemoTransaction(token, `Demo transaction ${new Date().toISOString()}`);
      const result = await api.startWorkflowInstance(token, {
        definitionCode: "demo_approval_workflow",
        entityId: tx.id,
        contextData: { organizationUnitId: orgUnitId, category },
      });
      if (lifetime.current !== life) return;
      onMessage({
        type: "success",
        text: t("workflow.instanceStart", {
          category,
          routing:
            result.assignment.assignmentType === "role"
              ? t("workflow.roleRouting", { code: result.assignment.assignedRoleCode ?? "" })
              : t("workflow.userRouting"),
        }),
      });
      setStartOpen(false);
      setSelectedInstanceId(result.instance.id);
      await refresh();
    } catch (err) {
      if (lifetime.current === life) setStartError(err instanceof ApiError ? err.message : t("workflow.startFailed"));
    } finally {
      if (lifetime.current === life) setStartPending(false);
      startBusy.current = false;
    }
  }

  function openAction(assignment: WorkflowAssignment, code: string) {
    if (actionBusy.current) return;
    setActionAssignment(assignment);
    setActionCode(code);
    setActionComment("");
    setActionError(null);
    setActionOpen(true);
  }

  async function handleAct() {
    if (!actionAssignment || actionBusy.current || !actionCode || !canAct) return;
    const assignment = actionAssignment;
    const code = actionCode;
    const comment = actionComment.trim() || null;
    const life = lifetime.current;
    actionBusy.current = true;
    setActionPending(true);
    setActionError(null);
    try {
      const result = await api.actOnWorkflowAssignment(token, assignment.id, { actionCode: code, comment });
      if (lifetime.current !== life) return;
      onMessage({
        type: "success",
        text: t("workflow.actionRecorded", { code, status: result.instance.status }),
      });
      setActionOpen(false);
      await refresh();
    } catch (err) {
      if (lifetime.current === life)
        setActionError(err instanceof ApiError ? err.message : t("workflow.actionFailed"));
    } finally {
      if (lifetime.current === life) setActionPending(false);
      actionBusy.current = false;
    }
  }

  function openClaim(assignment: WorkflowAssignment) {
    if (claimBusy.current) return;
    setClaimTarget({ assignment, releasing: Boolean(assignment.claimedByUserId) });
    setClaimError(null);
  }

  async function handleClaimDecision() {
    if (!claimTarget || claimBusy.current || !canAct) return;
    const { assignment, releasing } = claimTarget;
    const life = lifetime.current;
    claimBusy.current = true;
    setClaimPending(true);
    setClaimError(null);
    try {
      if (releasing) {
        await api.releaseWorkflowAssignmentClaim(token, assignment.id);
      } else {
        await api.claimWorkflowAssignment(token, assignment.id);
      }
      if (lifetime.current !== life) return;
      onMessage({
        type: "success",
        text: releasing ? t("workflow.releaseSuccess") : t("workflow.claimSuccess"),
      });
      setClaimTarget(null);
      await refresh();
    } catch (err) {
      if (lifetime.current === life) {
        setClaimError(
          err instanceof ApiError
            ? err.message
            : releasing
              ? t("workflow.releaseFailed")
              : t("workflow.claimFailed"),
        );
      }
    } finally {
      if (lifetime.current === life) setClaimPending(false);
      claimBusy.current = false;
    }
  }

  async function handleEscalationSweep() {
    if (sweepBusy.current || !canManage) return;
    const life = lifetime.current;
    sweepBusy.current = true;
    setSweepPending(true);
    setSweepError(null);
    try {
      const result = await api.triggerWorkflowEscalationSweep(token);
      if (lifetime.current !== life) return;
      onMessage({
        type: "success",
        text: t("workflow.sweepSuccess", { count: result.escalatedCount }),
      });
      setSweepOpen(false);
      await refresh();
    } catch (err) {
      if (lifetime.current === life) setSweepError(err instanceof ApiError ? err.message : t("workflow.sweepFailed"));
    } finally {
      if (lifetime.current === life) setSweepPending(false);
      sweepBusy.current = false;
    }
  }

  const instanceColumns: Column<WorkflowInstance>[] = [
    { header: t("workflow.entity"), mobileRole: "title", cell: (row) => <span className="font-mono">{row.entityId.slice(0, 8)}…</span> },
    {
      header: t("workflow.statusHeader"),
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={row.status === "approved" ? "success" : row.status === "rejected" ? "danger" : "info"}>{row.status}</StatusPill>
      ),
    },
    { header: t("workflow.startedHeader"), cell: (row) => new Date(row.startedAt).toLocaleString() },
    {
      header: t("workflow.actionsHeader"),
      cell: (row) => (
        <Button variant="ghost" className="min-h-0 px-1 py-1 text-xs underline" onClick={() => void openHistory(row.id)}>
          {t("workflow.viewHistory")}
        </Button>
      ),
    },
  ];

  const assignmentColumns: Column<WorkflowAssignment>[] = [
    {
      header: t("workflow.routingHeader"),
      mobileRole: "title",
      cell: (row) =>
        row.assignmentType === "role"
          ? `${t("workflow.role")} ${row.assignedRoleCode ?? t("workflow.unavailable")}`
          : t("workflow.directAssignment"),
    },
    { header: t("workflow.dueHeader"), cell: (row) => (row.dueAt ? new Date(row.dueAt).toLocaleString() : t("workflow.noDueDate")) },
    {
      header: t("workflow.statusHeader"),
      mobileRole: "status",
      cell: (row) => (
        <StatusPill tone={row.claimedByUserId ? "info" : "warning"}>{row.claimedByUserId ? t("workflow.claimed") : row.status}</StatusPill>
      ),
    },
    {
      header: t("workflow.actionsHeader"),
      cell: (row) =>
        canAct ? (
          <div className="flex flex-wrap gap-1">
            {(["approve", "reject", "return", "resubmit"] as const).map((code) => (
              <Button key={code} variant="secondary" className="min-h-0 px-2 py-1 text-xs" onClick={() => openAction(row, code)}>
                {t(ACTION_LABEL[code])}
              </Button>
            ))}
            <Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" onClick={() => openClaim(row)}>
              {row.claimedByUserId ? t("workflow.releaseClaim") : t("workflow.claim")}
            </Button>
          </div>
        ) : (
          "—"
        ),
    },
  ];

  const historyItems = history.map((entry, index) => ({
    key: entry.id ?? `${entry.occurredAt}-${index}`,
    title: entry.actionCode,
    timestamp: entry.occurredAt,
    detail: entry.comment ?? undefined,
  }));
  const actionTitle = actionCode
    ? t(ACTION_LABEL[actionCode as keyof typeof ACTION_LABEL] ?? "workflow.title")
    : t("workflow.title");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{t("workflow.title")}</h2>
          <p className="text-sm text-slate-500">{t("workflow.subtitle")}</p>
        </div>
        {canStart && (
          <Button
            onClick={() => {
              setStartError(null);
              setStartOpen(true);
            }}
          >
            {t("workflow.startWorkflow")}
          </Button>
        )}
      </div>

      <Card>
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">{t("workflow.myTasks")}</h3>
            <p className="text-xs text-slate-500">{t("workflow.myTasksDesc")}</p>
          </div>
          {assignmentsState.loading === false && assignmentsState.error === null && (
            <span className="text-xs text-slate-500">
              {myAssignments.length} {t(myAssignments.length === 1 ? "workflow.result" : "workflow.results")}
            </span>
          )}
        </div>
        <AdminSectionState {...assignmentsState} loadingLabel={t("workflow.loadingTasks")} onRetry={() => void refresh()}>
          <DataTable
            columns={assignmentColumns}
            rows={myAssignments}
            keyOf={(row) => row.id}
            empty={<EmptyState title={t("workflow.nothingPending")} description={t("workflow.noAssignments")} />}
            mobileBreakpoint="md"
          />
        </AdminSectionState>
      </Card>

      <Card>
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">{t("workflow.instances")}</h3>
            <p className="text-xs text-slate-500">{t("workflow.instancesDesc")}</p>
          </div>
          {instancesState.loading === false && instancesState.error === null && (
            <span className="text-xs text-slate-500">
              {instances.length} {t(instances.length === 1 ? "workflow.result" : "workflow.results")}
            </span>
          )}
        </div>
        <AdminSectionState {...instancesState} loadingLabel={t("workflow.loadingInstances")} onRetry={() => void refresh()}>
          <DataTable
            columns={instanceColumns}
            rows={instances}
            keyOf={(row) => row.id}
            empty={
              <EmptyState
                title={t("workflow.noInstances")}
                description={t("workflow.noInstancesDesc")}
              />
            }
          />
        </AdminSectionState>
      </Card>

      {canManage && (
        <Card>
          <h3 className="text-base font-semibold">{t("workflow.escalationSweep")}</h3>
          <p className="mt-1 text-sm text-slate-500">{t("workflow.sweepDesc")}</p>
          <Button
            className="mt-3"
            onClick={() => {
              setSweepError(null);
              setSweepOpen(true);
            }}
          >
            {t("workflow.runSweep")}
          </Button>
        </Card>
      )}

      <OverlayDialog
        open={startOpen}
        title={t("workflow.startTitle")}
        description={t("workflow.startDesc")}
        pending={startPending}
        onClose={() => setStartOpen(false)}
        footer={
          <>
            <Button variant="secondary" disabled={startPending} onClick={() => setStartOpen(false)}>
              {t("workflow.cancel")}
            </Button>
            <Button disabled={startPending} onClick={() => void handleStartInstance()}>
              {startPending ? t("workflow.starting") : t("workflow.startWorkflow")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {startError && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {startError}
            </div>
          )}
          <Field label={t("workflow.orgUnit")} required hint={t("workflow.orgUnitHint")}>
            <Select value={startOrgUnitId} onChange={(event) => setStartOrgUnitId(event.target.value)} disabled={startPending}>
              <option value="" disabled>
                {t("workflow.selectUnit")}
              </option>
              {orgUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("workflow.category")} required hint={t("workflow.categoryHint")}>
            <Select value={startCategory} onChange={(event) => setStartCategory(event.target.value)} disabled={startPending}>
              <option value="normal">{t("workflow.normal")}</option>
              <option value="high_risk">{t("workflow.highRisk")}</option>
            </Select>
          </Field>
        </div>
      </OverlayDialog>

      <OverlayDialog
        open={actionOpen}
        title={t("workflow.actionTitle", { code: actionTitle })}
        description={t("workflow.actionDesc", { code: actionTitle })}
        pending={actionPending}
        onClose={() => setActionOpen(false)}
        footer={
          <>
            <Button variant="secondary" disabled={actionPending} onClick={() => setActionOpen(false)}>
              {t("workflow.cancel")}
            </Button>
            <Button disabled={actionPending} onClick={() => void handleAct()}>
              {actionPending ? t("workflow.saving") : t("workflow.confirm", { code: actionTitle })}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {actionError && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {actionError}
            </div>
          )}
          <Field label={t("workflow.task")} hint={t("workflow.taskHint")}>
            <Input
              readOnly
              value={
                actionAssignment
                  ? actionAssignment.assignmentType === "role"
                    ? `${t("workflow.role")} ${actionAssignment.assignedRoleCode ?? t("workflow.unavailable")}`
                    : t("workflow.directAssignment")
                  : ""
              }
            />
          </Field>
          <Field label={t("workflow.comment")} hint={t("workflow.commentHint")}>
            <Input
              value={actionComment}
              onChange={(event) => setActionComment(event.target.value)}
              disabled={actionPending}
              placeholder={t("workflow.commentPlaceholder")}
            />
          </Field>
        </div>
      </OverlayDialog>

      <OverlayDialog
        open={claimTarget !== null}
        title={claimTarget?.releasing ? t("workflow.releaseTitle") : t("workflow.claimTitle")}
        description={
          claimTarget?.releasing
            ? t("workflow.releaseDesc")
            : t("workflow.claimDesc")
        }
        pending={claimPending}
        onClose={() => setClaimTarget(null)}
        footer={
          <>
            <Button variant="secondary" disabled={claimPending} onClick={() => setClaimTarget(null)}>
              {t("workflow.cancel")}
            </Button>
            <Button disabled={claimPending} onClick={() => void handleClaimDecision()}>
              {claimPending ? t("workflow.saving") : claimTarget?.releasing ? t("workflow.releaseClaim") : t("workflow.claim")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {claimError && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {claimError}
            </div>
          )}
          {claimTarget && (
            <p className="text-sm text-slate-600">
              {t("workflow.taskLabel")}{" "}
              <strong>
                {claimTarget.assignment.assignmentType === "role"
                  ? `${t("workflow.role")} ${claimTarget.assignment.assignedRoleCode ?? t("workflow.unavailable")}`
                  : t("workflow.directAssignment")}
              </strong>
            </p>
          )}
          <p className="text-sm text-slate-500">{t("workflow.serverRechecks")}</p>
        </div>
      </OverlayDialog>

      <OverlayDialog
        open={historyOpen}
        title={t("workflow.history")}
        description={
          selectedInstanceId
            ? t("workflow.historyDesc", { id: `${selectedInstanceId.slice(0, 8)}…` })
            : undefined
        }
        pending={historyPending}
        onClose={() => setHistoryOpen(false)}
        footer={
          <Button variant="secondary" onClick={() => setHistoryOpen(false)}>
            {t("workflow.close")}
          </Button>
        }
      >
        {historyError ? (
          <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {historyError}
          </div>
        ) : historyPending ? (
          <p className="text-sm text-slate-500">{t("workflow.loadingHistory")}</p>
        ) : (
          <Timeline items={historyItems} />
        )}
      </OverlayDialog>

      <OverlayDialog
        open={sweepOpen}
        title={t("workflow.sweepTitle")}
        description={t("workflow.sweepDialogDesc")}
        pending={sweepPending}
        onClose={() => setSweepOpen(false)}
        footer={
          <>
            <Button variant="secondary" disabled={sweepPending} onClick={() => setSweepOpen(false)}>
              {t("workflow.cancel")}
            </Button>
            <Button disabled={sweepPending} onClick={() => void handleEscalationSweep()}>
              {sweepPending ? t("workflow.running") : t("workflow.confirmSweep")}
            </Button>
          </>
        }
      >
        {sweepError && (
          <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {sweepError}
          </div>
        )}
        <p className="text-sm text-slate-600">{t("workflow.serverApplies")}</p>
      </OverlayDialog>
    </div>
  );
}
