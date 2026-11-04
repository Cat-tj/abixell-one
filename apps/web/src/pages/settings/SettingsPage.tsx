/**
 * Settings — the single administrative surface for a tenant.
 *
 * Consolidates the former Admin Console (/admin) and Panel Admin (/administration)
 * into one page. Every tab renders the component that actually owns its data —
 * there is no generic "configuration" body standing in for several different
 * things. Sinergi Supply patterns: labelled forms with hints, per-section save
 * with feedback, toggle switches for binary decisions, and status banners.
 *
 * Permissions stay granular (Epic 15 Decision #7): the 16 `config.<category>.*`
 * codes gate each tab, `admin.console.read` gates the governance overview, and
 * `user.role.manage` gates governed access changes. Client gates are UX only;
 * every endpoint enforces its own permission.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Building2,
  DatabaseBackup,
  FileText,
  LayoutDashboard,
  Layers,
  Palette,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api } from "../../lib/api";
import { PERMISSIONS } from "../../lib/capabilities";
import { useT } from "../../i18n/LocaleProvider";
import type { MessageKey } from "../../i18n/dictionaries/en";
import { Alert, PageHeader, PermissionDeniedState } from "../../shell/components/ui";
import { useShell } from "../../shell/layout/AppShell";
import { SettingsOverviewView } from "./SettingsOverviewView";
import { UserAccessPanel } from "../admin/panel/UserAccessPanel";
import { ConfigurationPanel } from "../ConfigurationPanel";
import { OrganizationPanel } from "../admin/panel/OrganizationPanel";
import { WorkflowPanel } from "../WorkflowPanel";
import { SharedServicesPanel } from "../SharedServicesPanel";
import { AdminModulesView } from "../admin/console/AdminModulesView";
import { AdminWorkflowsView } from "../admin/console/AdminWorkflowsView";
import { BackupTab } from "./BackupTab";
import { AppearanceTab } from "./AppearanceTab";
import { DocumentsTab } from "./DocumentsTab";

type TabKey =
  | "overview"
  | "access"
  | "modules"
  | "platform"
  | "organization"
  | "workflows"
  | "services"
  | "backup"
  | "appearance"
  | "documents";

interface Tab {
  key: TabKey;
  icon: typeof LayoutDashboard;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  /** Any-of read gate for showing the tab. */
  readAnyOf: string[];
}

const TABS: Tab[] = [
  { key: "overview", icon: LayoutDashboard, labelKey: "settings.tabOverview", descriptionKey: "settings.tabOverviewDesc", readAnyOf: [PERMISSIONS.adminConsoleRead] },
  { key: "access", icon: Users, labelKey: "settings.tabAccess", descriptionKey: "settings.tabAccessDesc", readAnyOf: [PERMISSIONS.configUserRead, PERMISSIONS.configUserManage, "user.role.manage", PERMISSIONS.configManage] },
  { key: "modules", icon: Boxes, labelKey: "settings.tabModules", descriptionKey: "settings.tabModulesDesc", readAnyOf: [PERMISSIONS.configModuleRead, PERMISSIONS.configModuleManage, PERMISSIONS.configManage] },
  { key: "platform", icon: ShieldCheck, labelKey: "settings.tabPlatform", descriptionKey: "settings.tabPlatformDesc", readAnyOf: [PERMISSIONS.configPlatformRead, PERMISSIONS.configPlatformManage, PERMISSIONS.configManage] },
  { key: "organization", icon: Building2, labelKey: "settings.tabOrganization", descriptionKey: "settings.tabOrganizationDesc", readAnyOf: [PERMISSIONS.configOrgRead, PERMISSIONS.configOrgManage, PERMISSIONS.configManage] },
  { key: "workflows", icon: Workflow, labelKey: "settings.tabWorkflows", descriptionKey: "settings.tabWorkflowsDesc", readAnyOf: [PERMISSIONS.configWorkflowRead, PERMISSIONS.configWorkflowManage, PERMISSIONS.configManage] },
  { key: "services", icon: Layers, labelKey: "settings.tabServices", descriptionKey: "settings.tabServicesDesc", readAnyOf: [PERMISSIONS.configNotificationRead, PERMISSIONS.configNotificationManage, PERMISSIONS.configDocumentRead, PERMISSIONS.configDocumentManage, PERMISSIONS.configManage] },
  { key: "backup", icon: DatabaseBackup, labelKey: "settings.tabBackup", descriptionKey: "settings.tabBackupDesc", readAnyOf: [PERMISSIONS.configSystemRead, PERMISSIONS.configSystemManage, PERMISSIONS.configManage] },
  { key: "appearance", icon: Palette, labelKey: "settings.tabAppearance", descriptionKey: "settings.tabAppearanceDesc", readAnyOf: [PERMISSIONS.configPlatformRead, PERMISSIONS.configPlatformManage, PERMISSIONS.configManage] },
  { key: "documents", icon: FileText, labelKey: "settings.tabDocuments", descriptionKey: "settings.tabDocumentsDesc", readAnyOf: [PERMISSIONS.configDocumentRead, PERMISSIONS.configDocumentManage, PERMISSIONS.configManage] },
];

function isTabKey(value: string | null): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

type PanelMessage = { type: "error" | "success"; text: string };

export function SettingsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const { permissions, activeModuleCodes } = useShell();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState<TabKey>(isTabKey(requested) ? requested : "overview");
  const [orgUnits, setOrgUnits] = useState<{ id: string; name: string }[]>([]);
  const [message, setMessage] = useState<PanelMessage | null>(null);

  useEffect(() => {
    api.organizationUnits(token)
      .then((units) => setOrgUnits(units.map((unit) => ({ id: unit.id, name: unit.name }))))
      .catch(() => setOrgUnits([]));
  }, [token]);

  const has = (code: string) => permissions.includes(code);
  const canReadTab = (tab: Tab) => tab.readAnyOf.some(has);
  const visibleTabs = useMemo(
    () => TABS.filter((tab) => tab.readAnyOf.some((code) => permissions.includes(code))),
    [permissions],
  );

  const canManage = (readCode: string, manageCode: string) =>
    has(manageCode) || has(PERMISSIONS.configManage) || has(readCode);

  const selectTab = (key: TabKey) => {
    setActiveTab(key);
    setMessage(null);
    setSearchParams(key === "overview" ? {} : { tab: key }, { replace: true });
  };

  if (visibleTabs.length === 0) {
    return (
      <>
        <PageHeader title={t("settings.title")} />
        <PermissionDeniedState />
      </>
    );
  }

  const current = TABS.find((tab) => tab.key === activeTab);
  const tab = current && canReadTab(current) ? current : visibleTabs[0];

  const renderTab = () => {
    switch (tab.key) {
      case "overview":
        return <SettingsOverviewView />;
      case "access":
        return <UserAccessPanel canManageAccess={has("user.role.manage") || canManage(PERMISSIONS.configUserRead, PERMISSIONS.configUserManage)} />;
      case "modules":
        return (
          <div className="space-y-4">
            <ConfigurationPanel section="module" token={token} orgUnits={orgUnits} canManage={canManage(PERMISSIONS.configModuleRead, PERMISSIONS.configModuleManage)} onMessage={setMessage} />
            <AdminModulesView />
          </div>
        );
      case "platform":
        return (
          <div className="space-y-4">
            <ConfigurationPanel section="platform" token={token} orgUnits={orgUnits} canManage={canManage(PERMISSIONS.configPlatformRead, PERMISSIONS.configPlatformManage)} onMessage={setMessage} />
            <ConfigurationPanel section="system" token={token} orgUnits={orgUnits} canManage={canManage(PERMISSIONS.configSystemRead, PERMISSIONS.configSystemManage)} onMessage={setMessage} />
          </div>
        );
      case "organization":
        return <OrganizationPanel token={token} canManage={canManage(PERMISSIONS.configOrgRead, PERMISSIONS.configOrgManage)} onMessage={setMessage} />;
      case "workflows":
        return (
          <div className="space-y-4">
            <WorkflowPanel token={token} orgUnits={orgUnits} canStart={canManage(PERMISSIONS.configWorkflowRead, PERMISSIONS.configWorkflowManage)} canAct={canManage(PERMISSIONS.configWorkflowRead, PERMISSIONS.configWorkflowManage)} canManage={canManage(PERMISSIONS.configWorkflowRead, PERMISSIONS.configWorkflowManage)} onMessage={setMessage} />
            <AdminWorkflowsView />
          </div>
        );
      case "services":
        return (
          <SharedServicesPanel
            token={token}
            canManageDocuments={canManage(PERMISSIONS.configDocumentRead, PERMISSIONS.configDocumentManage)}
            canManageScheduler={canManage(PERMISSIONS.configSystemRead, PERMISSIONS.configSystemManage)}
            canReadIntegration={has(PERMISSIONS.configPlatformRead) || has(PERMISSIONS.configManage)}
            canManageIntegration={canManage(PERMISSIONS.configPlatformRead, PERMISSIONS.configPlatformManage)}
            canReadObservability={has(PERMISSIONS.configPlatformRead) || has(PERMISSIONS.configManage)}
            onMessage={setMessage}
          />
        );
      case "backup":
        return <BackupTab token={token} canManage={canManage(PERMISSIONS.configSystemRead, PERMISSIONS.configSystemManage)} onMessage={setMessage} />;
      case "appearance":
        return <AppearanceTab canManage={canManage(PERMISSIONS.configPlatformRead, PERMISSIONS.configPlatformManage)} />;
      case "documents":
        return <DocumentsTab token={token} canManage={canManage(PERMISSIONS.configDocumentRead, PERMISSIONS.configDocumentManage)} onMessage={setMessage} />;
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

      {activeModuleCodes.length === 0 && (
        <Alert tone="warning">{t("settings.noModulesWarning")}</Alert>
      )}

      <nav className="mb-6 overflow-x-auto border-b border-line" aria-label={t("settings.sectionsLabel")}>
        <div className="flex min-w-max gap-1">
          {visibleTabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => selectTab(item.key)}
              aria-current={tab.key === item.key ? "page" : undefined}
              className={`-mb-px inline-flex min-h-[44px] items-center gap-2 rounded-t px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:min-h-[36px] ${
                tab.key === item.key
                  ? "border-b-2 border-accent text-ink"
                  : "border-b-2 border-transparent text-ink-dim hover:text-ink"
              }`}
            >
              <item.icon size={16} aria-hidden="true" className="shrink-0" />
              <span>{t(item.labelKey)}</span>
            </button>
          ))}
        </div>
      </nav>

      <p className="mb-4 text-sm text-ink-dim">{t(tab.descriptionKey)}</p>

      {message && (
        <div className="mb-4">
          <Alert tone={message.type === "error" ? "error" : "success"}>
            {message.text}
          </Alert>
        </div>
      )}

      {renderTab()}
    </div>
  );
}
