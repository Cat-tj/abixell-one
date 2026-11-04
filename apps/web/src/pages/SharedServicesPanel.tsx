import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  type DocumentRecord,
  type DomainEvent,
  type IntegrationEndpoint,
  type IntegrationLogEntry,
  type Notification,
  type ScheduledJob,
  type ScheduledJobRun,
  type WorkflowInstance,
} from "../lib/api";
import { useT } from "../i18n/LocaleProvider";
import { OverlayDialog } from "../shell/components/OverlayDialog";
import {
  Alert,
  Button,
  Card,
  type Column,
  DataTable,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  StatusPill,
} from "../shell/components/ui";

/**
 * Checkpoint 0E — Enterprise Shared Services panel.
 *
 * Five cross-cutting services, all reusable by any future business module and
 * none of them aware of Complaint/Survey/Procurement: Notification Engine,
 * Document/File Service, Scheduler, Integration Boundary, and Observability.
 * Tahap A keeps server behavior authoritative: every mutation is confirmed in
 * a dialog, and read permissions are separated from management permissions.
 */

type Message = { type: "error" | "success"; text: string };
type ResourceState<T> = {
  data: T;
  loading: boolean;
  error: string | null;
  status: number | null;
};

type Dialog =
  | { kind: "mark-read"; notification: Notification }
  | { kind: "upload" }
  | { kind: "delete-document"; document: DocumentRecord }
  | { kind: "trigger-job"; job: ScheduledJob }
  | { kind: "job-runs"; job: ScheduledJob }
  | { kind: "endpoint" }
  | { kind: "endpoint-status"; endpoint: IntegrationEndpoint }
  | null;

type EndpointForm = {
  code: string;
  name: string;
  direction: "outbound" | "inbound";
  baseUrl: string;
  webhookSecret: string;
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const emptyEndpointForm: EndpointForm = {
  code: "",
  name: "",
  direction: "outbound",
  baseUrl: "",
  webhookSecret: "",
};

function initialResource<T>(data: T, loading = true): ResourceState<T> {
  return { data, loading, error: null, status: null };
}

function errorMessage(error: unknown, t: ReturnType<typeof useT>, fallback: string) {
  if (error instanceof ApiError && error.status === 401) return t("sharedServices.sessionExpired");
  if (error instanceof ApiError && error.status === 403) return t("sharedServices.noPerm");
  return error instanceof ApiError ? error.message : fallback;
}

function errorStatus(error: unknown) {
  return error instanceof ApiError ? error.status : null;
}

function bytesLabel(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

function ResourceBlock<T>({
  resource,
  loadingLabel,
  children,
}: {
  resource: ResourceState<T>;
  loadingLabel: string;
  children: React.ReactNode;
}) {
  const t = useT();
  if (resource.loading) return <Spinner label={loadingLabel} />;
  if (resource.status === 401) return <EmptyState title={t("sharedServices.sessionExpiredTitle")} description={t("sharedServices.sessionExpired")} />;
  if (resource.status === 403) return <EmptyState title={t("sharedServices.accessDenied")} description={t("sharedServices.noPerm")} />;
  if (resource.error) return <Alert tone="error">{resource.error}</Alert>;
  return <>{children}</>;
}

export function SharedServicesPanel({
  token,
  canManageDocuments,
  canManageScheduler,
  canReadIntegration,
  canManageIntegration,
  canReadObservability,
  onMessage,
}: {
  token: string;
  canManageDocuments: boolean;
  canManageScheduler: boolean;
  canReadIntegration?: boolean;
  canManageIntegration?: boolean;
  canReadObservability: boolean;
  onMessage: (m: Message) => void;
}) {
  const t = useT();
  const integrationRead = canReadIntegration ?? canManageIntegration ?? false;
  const integrationManage = canManageIntegration ?? false;

  const [notifications, setNotifications] = useState<ResourceState<Notification[]>>(initialResource([]));
  const [instances, setInstances] = useState<ResourceState<WorkflowInstance[]>>(initialResource([]));
  const [documents, setDocuments] = useState<ResourceState<DocumentRecord[]>>(initialResource([], false));
  const [jobs, setJobs] = useState<ResourceState<ScheduledJob[]>>(initialResource([], canManageScheduler));
  const [jobRuns, setJobRuns] = useState<ResourceState<ScheduledJobRun[]>>(initialResource([], false));
  const [endpoints, setEndpoints] = useState<ResourceState<IntegrationEndpoint[]>>(initialResource([], integrationRead));
  const [integrationLog, setIntegrationLog] = useState<ResourceState<IntegrationLogEntry[]>>(initialResource([], integrationRead));
  const [events, setEvents] = useState<ResourceState<DomainEvent[]>>(initialResource([], canReadObservability));

  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadInputKey, setUploadInputKey] = useState(0);
  const [endpointForm, setEndpointForm] = useState<EndpointForm>(emptyEndpointForm);

  const generations = useRef<Record<string, number>>({});
  const dialogGeneration = useRef(0);
  const pendingRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | null>(null);

  const loadResource = useCallback(
    <T,>(
      key: string,
      setter: React.Dispatch<React.SetStateAction<ResourceState<T>>>,
      request: () => Promise<T>,
      fallback: string,
    ) => {
      const generation = (generations.current[key] ?? 0) + 1;
      generations.current[key] = generation;
      setter((state) => ({ ...state, loading: true, error: null, status: null }));
      request()
        .then((data) => {
          if (generations.current[key] !== generation) return;
          setter({ data, loading: false, error: null, status: null });
        })
        .catch((error) => {
          if (generations.current[key] !== generation) return;
          setter((state) => ({
            ...state,
            loading: false,
            error: errorMessage(error, t, fallback),
            status: errorStatus(error),
          }));
        });
    },
    [t],
  );

  const refresh = useCallback(() => {
    loadResource("notifications", setNotifications, () => api.myNotifications(token), t("sharedServices.notificationsLoad"));
    loadResource("instances", setInstances, () => api.workflowInstances(token), t("sharedServices.instancesLoad"));

    if (canManageScheduler) {
      loadResource("jobs", setJobs, () => api.scheduledJobs(token), t("sharedServices.jobsLoad"));
    } else {
      generations.current.jobs = (generations.current.jobs ?? 0) + 1;
      setJobs({ data: [], loading: false, error: null, status: null });
    }

    if (integrationRead) {
      loadResource("endpoints", setEndpoints, () => api.integrationEndpoints(token), t("sharedServices.endpointsLoad"));
      loadResource("integrationLog", setIntegrationLog, () => api.integrationLog(token), t("sharedServices.integrationLogLoad"));
    } else {
      generations.current.endpoints = (generations.current.endpoints ?? 0) + 1;
      generations.current.integrationLog = (generations.current.integrationLog ?? 0) + 1;
      setEndpoints({ data: [], loading: false, error: null, status: 403 });
      setIntegrationLog({ data: [], loading: false, error: null, status: 403 });
    }

    if (canReadObservability) {
      loadResource("events", setEvents, () => api.observabilityEvents(token), t("sharedServices.eventsLoad"));
    } else {
      generations.current.events = (generations.current.events ?? 0) + 1;
      setEvents({ data: [], loading: false, error: null, status: 403 });
    }
  }, [canManageScheduler, canReadObservability, integrationRead, loadResource, t, token]);

  useEffect(() => {
    refresh();
    // Capture the counters object once. The object identity never changes, but
    // reading `generations.current` inside the cleanup would re-read it after
    // an unknown number of renders; pinning it to the effect's own scope is
    // what the rule asks for and keeps the "invalidate every in-flight
    // request" intent unambiguous.
    const generationCounters = generations.current;
    return () => {
      Object.keys(generationCounters).forEach((key) => {
        generationCounters[key] += 1;
      });
      dialogGeneration.current += 1;
      pendingRef.current = false;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [refresh]);

  useEffect(() => {
    if (!instances.data.some((instance) => instance.id === selectedInstanceId)) {
      setSelectedInstanceId(instances.data[0]?.id ?? "");
    }
  }, [instances.data, selectedInstanceId]);

  const selectedInstance = useMemo(
    () => instances.data.find((instance) => instance.id === selectedInstanceId) ?? null,
    [instances.data, selectedInstanceId],
  );

  const loadDocuments = useCallback(
    (instance: WorkflowInstance | null) => {
      if (!instance) {
        generations.current.documents = (generations.current.documents ?? 0) + 1;
        setDocuments({ data: [], loading: false, error: null, status: null });
        return;
      }
      loadResource(
        "documents",
        setDocuments,
        () => api.documentsForEntity(token, "demo_transaction", instance.entityId),
        t("sharedServices.documentsLoad"),
      );
    },
    [loadResource, t, token],
  );

  useEffect(() => {
    loadDocuments(selectedInstance);
  }, [loadDocuments, selectedInstance]);

  function openDialog(nextDialog: Dialog, trigger?: HTMLButtonElement) {
    if (pendingRef.current) return;
    dialogGeneration.current += 1;
    restoreFocusRef.current = trigger ?? null;
    setDialog(nextDialog);
    setDialogError(null);
    if (nextDialog?.kind === "upload") {
      setUploadFile(null);
      setUploadInputKey((key) => key + 1);
    }
    if (nextDialog?.kind === "endpoint") setEndpointForm(emptyEndpointForm);
  }

  function closeDialog() {
    if (pendingRef.current) return;
    dialogGeneration.current += 1;
    setDialog(null);
    setDialogError(null);
    setUploadFile(null);
    setEndpointForm(emptyEndpointForm);
  }

  async function runMutation(action: () => Promise<unknown>, success: string, afterSuccess?: () => void) {
    if (pendingRef.current) return;
    const generation = ++dialogGeneration.current;
    pendingRef.current = true;
    setPending(true);
    setDialogError(null);
    try {
      await action();
      if (dialogGeneration.current !== generation) return;
      onMessage({ type: "success", text: success });
      setDialog(null);
      setUploadFile(null);
      setEndpointForm(emptyEndpointForm);
      afterSuccess?.();
    } catch (error) {
      if (dialogGeneration.current !== generation) return;
      const text = errorMessage(error, t, t("sharedServices.opFailed"));
      setDialogError(text);
      onMessage({ type: "error", text });
    } finally {
      if (dialogGeneration.current === generation) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  async function downloadDocument(document: DocumentRecord) {
    try {
      const blob = await api.downloadDocument(token, document.id);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = document.fileName;
      anchor.rel = "noopener";
      anchor.click();
    } catch (error) {
      onMessage({ type: "error", text: errorMessage(error, t, t("sharedServices.downloadFailed")) });
    }
  }

  function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || pendingRef.current) return;

    if (dialog.kind === "upload") {
      const file = uploadFile;
      const instance = selectedInstance;
      if (!instance) {
        setDialogError(t("sharedServices.selectInstance"));
        return;
      }
      if (!file) {
        setDialogError(t("sharedServices.selectFile"));
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setDialogError(t("sharedServices.fileTooLarge"));
        return;
      }
      void runMutation(
        () => api.uploadDocument(token, "demo_transaction", instance.entityId, file),
        `Uploaded ${file.name}.`,
        () => loadDocuments(instance),
      );
      return;
    }

    if (dialog.kind === "delete-document") {
      const document = dialog.document;
      const instance = selectedInstance;
      void runMutation(
        () => api.deleteDocument(token, document.id),
        t("sharedServices.documentDeleted"),
        () => loadDocuments(instance),
      );
      return;
    }

    if (dialog.kind === "mark-read") {
      const notification = dialog.notification;
      void runMutation(
        () => api.markNotificationRead(token, notification.id),
        t("sharedServices.markedRead"),
        refresh,
      );
      return;
    }

    if (dialog.kind === "trigger-job") {
      const job = dialog.job;
      void runMutation(
        () => api.triggerScheduledJob(token, job.jobCode),
        `Scheduler job '${job.jobCode}' triggered.`,
        refresh,
      );
      return;
    }

    if (dialog.kind === "endpoint-status") {
      const endpoint = dialog.endpoint;
      const next = !endpoint.isActive;
      void runMutation(
        () => api.setIntegrationEndpointActive(token, endpoint.code, next),
        `Endpoint ${next ? "activated" : "deactivated"}.`,
        refresh,
      );
      return;
    }

    if (dialog.kind === "endpoint") {
      const code = endpointForm.code.trim();
      const name = endpointForm.name.trim();
      const direction = endpointForm.direction;
      const baseUrl = endpointForm.baseUrl.trim() || null;
      const webhookSecret = endpointForm.webhookSecret || null;
      if (!code || !name) {
        setDialogError(t("sharedServices.codeNameRequired"));
        return;
      }
      void runMutation(
        () => api.createIntegrationEndpoint(token, { code, name, direction, baseUrl, webhookSecret }),
        t("sharedServices.endpointCreated"),
        refresh,
      );
    }
  }

  function openJobRuns(job: ScheduledJob, trigger?: HTMLButtonElement) {
    openDialog({ kind: "job-runs", job }, trigger);
    loadResource("jobRuns", setJobRuns, () => api.scheduledJobRuns(token, job.jobCode), t("sharedServices.jobRunsLoad"));
  }

  // Map a notification's event entity to the page that shows it. Unknown
  // entity types render no link rather than a broken one.
  const notificationLink = (item: Notification) => {
    if (!item.entityType || !item.entityId) return "—";
    const route =
      item.entityType === "complaint"
        ? `/complaints/${item.entityId}`
        : item.entityType === "work_order"
          ? `/work-orders`
          : undefined;
    if (!route) return "—";
    return (
      <Link to={route} className="text-sm font-medium text-accent underline-offset-2 hover:underline">
        {t("sharedServices.openTask")}
      </Link>
    );
  };

  const notificationColumns: Column<Notification>[] = [
    { header: t("sharedServices.colNotification"), mobileRole: "title", cell: (item) => item.subject ?? item.eventType },
    { header: t("sharedServices.colBody"), mobileRole: "detail", cell: (item) => item.body },
    { header: t("sharedServices.colChannel"), cell: (item) => item.channel },
    {
      header: t("sharedServices.colStatus"),
      mobileRole: "status",
      cell: (item) => <StatusPill tone={item.readAt ? "neutral" : "info"}>{item.readAt ? t("sharedServices.read") : t("sharedServices.unread")}</StatusPill>,
    },
    { header: t("sharedServices.colCreated"), cell: (item) => new Date(item.createdAt).toLocaleString() },
    {
      header: t("sharedServices.colOpen"),
      cell: (item) => notificationLink(item),
    },
    {
      header: t("sharedServices.colAction"),
      cell: (item) =>
        item.readAt ? (
          "—"
        ) : (
          <Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" onClick={(event) => openDialog({ kind: "mark-read", notification: item }, event.currentTarget)}>
            {t("sharedServices.markReadAction")}
          </Button>
        ),
    },
  ];

  const documentColumns: Column<DocumentRecord>[] = [
    { header: t("sharedServices.colFile"), mobileRole: "title", cell: (item) => item.fileName },
    { header: t("sharedServices.colMime"), mobileRole: "detail", cell: (item) => item.mimeType },
    { header: t("sharedServices.colSize"), cell: (item) => bytesLabel(item.sizeBytes) },
    { header: t("sharedServices.colUploaded"), cell: (item) => new Date(item.createdAt).toLocaleString() },
    {
      header: t("sharedServices.colActions"),
      cell: (item) => (
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" onClick={() => void downloadDocument(item)}>
            {t("sharedServices.download")}
          </Button>
          {canManageDocuments && (
            <Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" onClick={(event) => openDialog({ kind: "delete-document", document: item }, event.currentTarget)}>
              {t("sharedServices.delete")}
            </Button>
          )}
        </div>
      ),
    },
  ];

  const jobColumns: Column<ScheduledJob>[] = [
    {
      header: t("sharedServices.colJob"),
      mobileRole: "title",
      cell: (item) => (
        <span>
          {item.name}
          <span className="block font-mono text-xs text-slate-500">{item.jobCode}</span>
        </span>
      ),
    },
    { header: t("sharedServices.colInterval"), mobileRole: "detail", cell: (item) => t("sharedServices.everySeconds", { count: item.intervalSeconds }) },
    {
      header: t("sharedServices.colStatus"),
      mobileRole: "status",
      cell: (item) => <StatusPill tone={item.lastStatus === "failed" ? "danger" : item.lastStatus === "success" ? "success" : "neutral"}>{item.lastStatus ?? t("sharedServices.neverRun")}</StatusPill>,
    },
    { header: t("sharedServices.colLastRun"), cell: (item) => (item.lastRunAt ? new Date(item.lastRunAt).toLocaleString() : "—") },
    {
      header: t("sharedServices.colActions"),
      cell: (item) => (
        <div className="flex flex-wrap gap-1">
          <Button variant="secondary" className="min-h-0 px-2 py-1 text-xs" onClick={(event) => openDialog({ kind: "trigger-job", job: item }, event.currentTarget)}>
            {t("sharedServices.triggerNow")}
          </Button>
          <Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" onClick={(event) => openJobRuns(item, event.currentTarget)}>
            {t("sharedServices.history")}
          </Button>
        </div>
      ),
    },
  ];

  const endpointColumns: Column<IntegrationEndpoint>[] = [
    {
      header: t("sharedServices.colEndpoint"),
      mobileRole: "title",
      cell: (item) => (
        <span>
          {item.name}
          <span className="block font-mono text-xs text-slate-500">{item.code}</span>
        </span>
      ),
    },
    { header: t("sharedServices.colDirection"), mobileRole: "detail", cell: (item) => item.direction },
    { header: t("sharedServices.colBaseUrl"), cell: (item) => item.baseUrl ?? "—" },
    {
      header: t("sharedServices.colStatus"),
      mobileRole: "status",
      cell: (item) => <StatusPill tone={item.isActive ? "success" : "neutral"}>{item.isActive ? t("sharedServices.active") : t("sharedServices.inactive")}</StatusPill>,
    },
    {
      header: t("sharedServices.colAction"),
      cell: (item) =>
        integrationManage ? (
          <Button variant="ghost" className="min-h-0 px-2 py-1 text-xs" onClick={(event) => openDialog({ kind: "endpoint-status", endpoint: item }, event.currentTarget)}>
            {item.isActive ? t("sharedServices.deactivate") : t("sharedServices.activate")}
          </Button>
        ) : (
          "—"
        ),
    },
  ];

  const logColumns: Column<IntegrationLogEntry>[] = [
    { header: t("sharedServices.colEvent"), mobileRole: "title", cell: (item) => item.eventType },
    { header: t("sharedServices.colDirection"), mobileRole: "detail", cell: (item) => item.direction },
    { header: t("sharedServices.colStatus"), mobileRole: "status", cell: (item) => item.status },
    { header: t("sharedServices.colCreated"), cell: (item) => new Date(item.createdAt).toLocaleString() },
  ];

  const eventColumns: Column<DomainEvent>[] = [
    { header: t("sharedServices.colEvent"), mobileRole: "title", cell: (item) => item.eventType },
    { header: t("sharedServices.colEntity"), mobileRole: "detail", cell: (item) => item.entityType },
    { header: t("sharedServices.colEntityId"), cell: (item) => (item.entityId ? `${item.entityId.slice(0, 8)}…` : "—") },
    { header: t("sharedServices.colOccurred"), cell: (item) => new Date(item.occurredAt).toLocaleString() },
  ];

  const runColumns: Column<ScheduledJobRun>[] = [
    { header: t("sharedServices.colStarted"), mobileRole: "title", cell: (item) => new Date(item.startedAt).toLocaleString() },
    { header: t("sharedServices.colTrigger"), mobileRole: "detail", cell: (item) => item.trigger },
    { header: t("sharedServices.colStatus"), mobileRole: "status", cell: (item) => <StatusPill tone={item.status === "failed" ? "danger" : item.status === "success" ? "success" : "info"}>{item.status}</StatusPill> },
    { header: t("sharedServices.colFinished"), cell: (item) => (item.finishedAt ? new Date(item.finishedAt).toLocaleString() : "—") },
    { header: t("sharedServices.colError"), cell: (item) => item.errorMessage ?? "—" },
  ];

  const dialogTitle = dialog?.kind === "mark-read"
    ? t("sharedServices.markReadTitle")
    : dialog?.kind === "upload"
      ? t("sharedServices.uploadTitle")
      : dialog?.kind === "delete-document"
        ? t("sharedServices.deleteTitle")
        : dialog?.kind === "trigger-job"
          ? t("sharedServices.triggerTitle")
          : dialog?.kind === "endpoint"
            ? t("sharedServices.endpointTitle")
            : dialog?.kind === "endpoint-status"
              ? t("sharedServices.endpointStatusTitle", { action: dialog.endpoint.isActive ? t("sharedServices.deactivate") : t("sharedServices.activate") })
              : dialog?.kind === "job-runs"
                ? t("sharedServices.jobRunsTitle")
                : t("sharedServices.sharedServices");

  const dialogDescription = dialog?.kind === "endpoint"
    ? t("sharedServices.endpointDesc")
    : dialog?.kind === "upload"
      ? t("sharedServices.uploadDesc")
      : dialog?.kind === "job-runs"
        ? t("sharedServices.jobRunsDesc", { code: dialog.job.jobCode })
        : t("sharedServices.serverRechecks");

  const confirmLabel = dialog?.kind === "endpoint"
    ? t("sharedServices.createEndpoint")
    : dialog?.kind === "upload"
      ? t("sharedServices.upload")
      : dialog?.kind === "endpoint-status"
        ? (dialog.endpoint.isActive ? t("sharedServices.deactivate") : t("sharedServices.activate"))
        : dialog?.kind === "trigger-job"
          ? t("sharedServices.triggerNow")
          : t("sharedServices.confirm");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">{t("sharedServices.title")}</h2>
        <p className="text-sm text-slate-500">{t("sharedServices.subtitle")}</p>
      </div>

      <Card>
        <div className="mb-3">
          <h3 className="text-base font-semibold">{t("sharedServices.myNotifications")}</h3>
          <p className="text-xs text-slate-500">{t("sharedServices.notificationsDesc")}</p>
        </div>
        <ResourceBlock resource={notifications} loadingLabel={t("sharedServices.loadingNotifications")}>
          <DataTable
            columns={notificationColumns}
            rows={notifications.data}
            keyOf={(item) => item.id}
            mobileBreakpoint="md"
            empty={<EmptyState title={t("sharedServices.noNotifications")} description={t("sharedServices.noNotificationsDesc")} />}
          />
        </ResourceBlock>
      </Card>

      <Card>
        <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h3 className="text-base font-semibold">{t("sharedServices.docService")}</h3>
            <p className="text-xs text-slate-500">{t("sharedServices.docServiceDesc")}</p>
          </div>
          {canManageDocuments && (
            <Button disabled={!selectedInstance} onClick={(event) => openDialog({ kind: "upload" }, event.currentTarget)}>
              {t("sharedServices.uploadDocument")}
            </Button>
          )}
        </div>
        <Field label={t("sharedServices.workflowInstance")} required>
          <Select
            value={selectedInstanceId}
            onChange={(event) => setSelectedInstanceId(event.target.value)}
            disabled={instances.loading || instances.data.length === 0}
          >
            <option value="">{instances.data.length === 0 ? t("sharedServices.noInstancesLoaded") : t("sharedServices.selectInstanceOption")}</option>
            {instances.data.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.id.slice(0, 8)}… ({instance.status})
              </option>
            ))}
          </Select>
        </Field>
        {instances.error && <div className="mt-3"><Alert tone="error">{instances.error}</Alert></div>}
        <div className="mt-3">
          <ResourceBlock resource={documents} loadingLabel={t("sharedServices.loadingDocuments")}>
            <DataTable
              columns={documentColumns}
              rows={documents.data.filter((item) => item.deletedAt === null)}
              keyOf={(item) => item.id}
              mobileBreakpoint="md"
              empty={<EmptyState title={t("sharedServices.noDocs")} description={t("sharedServices.noDocsDesc")} />}
            />
          </ResourceBlock>
        </div>
      </Card>

      {canManageScheduler && (
        <Card>
          <div className="mb-3">
            <h3 className="text-base font-semibold">{t("sharedServices.scheduler")}</h3>
            <p className="text-xs text-slate-500">{t("sharedServices.schedulerDesc")}</p>
          </div>
          <ResourceBlock resource={jobs} loadingLabel={t("sharedServices.loadingJobs")}>
            <DataTable
              columns={jobColumns}
              rows={jobs.data}
              keyOf={(item) => item.id}
              mobileBreakpoint="md"
              empty={<EmptyState title={t("sharedServices.noJobs")} description={t("sharedServices.noJobsDesc")} />}
            />
          </ResourceBlock>
        </Card>
      )}

      {integrationRead && (
        <Card>
          <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <h3 className="text-base font-semibold">{t("sharedServices.integration")}</h3>
              <p className="text-xs text-slate-500">{t("sharedServices.integrationDesc")}</p>
            </div>
            {integrationManage && (
              <Button onClick={(event) => openDialog({ kind: "endpoint" }, event.currentTarget)}>{t("sharedServices.createEndpoint")}</Button>
            )}
          </div>
          <ResourceBlock resource={endpoints} loadingLabel={t("sharedServices.loadingEndpoints")}>
            <DataTable
              columns={endpointColumns}
              rows={endpoints.data}
              keyOf={(item) => item.id}
              mobileBreakpoint="md"
              empty={<EmptyState title={t("sharedServices.noEndpoints")} description={t("sharedServices.noEndpointsDesc")} />}
            />
          </ResourceBlock>
          <div className="mt-6">
            <h4 className="mb-3 text-sm font-semibold text-slate-700">{t("sharedServices.recentLog")}</h4>
            <ResourceBlock resource={integrationLog} loadingLabel={t("sharedServices.loadingIntegrationLog")}>
              <DataTable
                columns={logColumns}
                rows={integrationLog.data.slice(0, 20)}
                keyOf={(item) => item.id}
                mobileBreakpoint="md"
                empty={<EmptyState title={t("sharedServices.noLogEntries")} description={t("sharedServices.noLogEntriesDesc")} />}
              />
            </ResourceBlock>
          </div>
        </Card>
      )}

      {canReadObservability && (
        <Card>
          <div className="mb-3">
            <h3 className="text-base font-semibold">{t("sharedServices.observability")}</h3>
            <p className="text-xs text-slate-500">{t("sharedServices.observabilityDesc")}</p>
          </div>
          <ResourceBlock resource={events} loadingLabel={t("sharedServices.loadingEvents")}>
            <DataTable
              columns={eventColumns}
              rows={events.data.slice(0, 30)}
              keyOf={(item) => item.id}
              mobileBreakpoint="md"
              empty={<EmptyState title={t("sharedServices.noEvents")} description={t("sharedServices.noEventsDesc")} />}
            />
          </ResourceBlock>
        </Card>
      )}

      <OverlayDialog
        open={dialog !== null}
        title={dialogTitle}
        description={dialogDescription}
        pending={pending}
        onClose={closeDialog}
        restoreFocusRef={restoreFocusRef}
        size={dialog?.kind === "job-runs" ? "lg" : "md"}
        footer={
          dialog?.kind === "job-runs" ? (
            <Button variant="secondary" onClick={closeDialog}>{t("sharedServices.close")}</Button>
          ) : (
            <>
              <Button variant="secondary" disabled={pending} onClick={closeDialog}>
                {t("sharedServices.cancel")}
              </Button>
              <Button type="submit" form="shared-services-dialog-form" disabled={pending}>
                {pending ? t("sharedServices.saving") : confirmLabel}
              </Button>
            </>
          )
        }
      >
        {dialog?.kind === "job-runs" ? (
          <ResourceBlock resource={jobRuns} loadingLabel={t("sharedServices.loadingRuns")}>
            <DataTable
              columns={runColumns}
              rows={jobRuns.data}
              keyOf={(item) => item.id}
              mobileBreakpoint="md"
              empty={<EmptyState title={t("sharedServices.noRuns")} description={t("sharedServices.noRunsDesc")} />}
            />
          </ResourceBlock>
        ) : (
          <form id="shared-services-dialog-form" className="space-y-4" onSubmit={submitDialog}>
            {dialogError && <Alert tone="error">{dialogError}</Alert>}

            {dialog?.kind === "mark-read" && (
              <p className="text-sm text-slate-600">
                {t("sharedServices.markReadConfirm", { subject: <strong>{dialog.notification.subject ?? dialog.notification.eventType}</strong> })}
              </p>
            )}

            {dialog?.kind === "upload" && (
              <>
                <p className="text-sm text-slate-600">
                  {t("sharedServices.targetInstance")} <strong>{selectedInstance ? `${selectedInstance.id.slice(0, 8)}… (${selectedInstance.status})` : t("sharedServices.noInstanceSelected")}</strong>
                </p>
                <Field label={t("sharedServices.fileLabel")} required hint={t("sharedServices.fileHint")}>
                  <Input
                    key={uploadInputKey}
                    type="file"
                    disabled={pending}
                    onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                  />
                </Field>
              </>
            )}

            {dialog?.kind === "delete-document" && (
              <p className="text-sm text-slate-600">
                {t("sharedServices.deleteConfirm", { name: <strong>{dialog.document.fileName}</strong> })} {t("sharedServices.serverEnforces")}
              </p>
            )}

            {dialog?.kind === "trigger-job" && (
              <p className="text-sm text-slate-600">
                {t("sharedServices.triggerConfirm", { code: <strong>{dialog.job.jobCode}</strong> })} {t("sharedServices.existingRoute")}
              </p>
            )}

            {dialog?.kind === "endpoint-status" && (
              <p className="text-sm text-slate-600">
                {t("sharedServices.endpointToggleConfirm", { action: dialog.endpoint.isActive ? t("sharedServices.deactivate") : t("sharedServices.activate"), name: <strong>{dialog.endpoint.name}</strong> })} {t("sharedServices.logsNeverShow")}
              </p>
            )}

            {dialog?.kind === "endpoint" && (
              <>
                <Field label={t("sharedServices.codeLabel")} required>
                  <Input
                    value={endpointForm.code}
                    onChange={(event) => setEndpointForm((form) => ({ ...form, code: event.target.value }))}
                    disabled={pending}
                    autoComplete="off"
                  />
                </Field>
                <Field label={t("sharedServices.nameLabel")} required>
                  <Input
                    value={endpointForm.name}
                    onChange={(event) => setEndpointForm((form) => ({ ...form, name: event.target.value }))}
                    disabled={pending}
                    autoComplete="off"
                  />
                </Field>
                <Field label={t("sharedServices.directionLabel")} required>
                  <Select
                    value={endpointForm.direction}
                    onChange={(event) => setEndpointForm((form) => ({ ...form, direction: event.target.value as "outbound" | "inbound" }))}
                    disabled={pending}
                  >
                    <option value="outbound">{t("sharedServices.outbound")}</option>
                    <option value="inbound">{t("sharedServices.inbound")}</option>
                  </Select>
                </Field>
                <Field label={t("sharedServices.baseUrlLabel")} hint={t("sharedServices.baseUrlHint")}>
                  <Input
                    value={endpointForm.baseUrl}
                    onChange={(event) => setEndpointForm((form) => ({ ...form, baseUrl: event.target.value }))}
                    disabled={pending}
                    autoComplete="url"
                  />
                </Field>
                <Field label={t("sharedServices.webhookSecret")} hint={t("sharedServices.webhookHint")}>
                  <Input
                    type="password"
                    value={endpointForm.webhookSecret}
                    onChange={(event) => setEndpointForm((form) => ({ ...form, webhookSecret: event.target.value }))}
                    disabled={pending}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}
          </form>
        )}
      </OverlayDialog>
    </div>
  );
}
