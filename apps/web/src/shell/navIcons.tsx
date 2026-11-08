/**
 * Icon mapping for the navigation tree.
 *
 * The served menu is data (codes + labels), so it cannot carry an icon. This
 * module maps a menu/module code to a lucide icon for the shell to render —
 * the visual counterpart of `navLabels.ts`. Unknown codes fall back to a
 * neutral icon so a newly seeded page still renders with a glyph.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  BarChart,
  BarChart3,
  BookOpen,
  Boxes,
  Briefcase,
  Building2,
  Calculator,
  CalendarClock,
  CalendarOff,
  CalendarRange,
  ClipboardCheck,
  ClipboardList,
  FileCheck,
  FileSearch,
  FileSignature,
  FileText,
  Gauge,
  Landmark,
  LayoutDashboard,
  LayoutGrid,
  ListOrdered,
  Lock,
  MessageSquare,
  MessageSquareWarning,
  NotebookPen,
  Package,
  Percent,
  PiggyBank,
  Receipt,
  Rocket,
  Scale,
  Search,
  Settings,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Tags,
  Target,
  UtensilsCrossed,
  TrendingUp,
  UserCog,
  UserPlus,
  UserRound,
  Users,
  UsersRound,
  Warehouse,
  Wrench,
} from "lucide-react";

/** Icons for module folders (the collapsible group triggers). */
const MODULE_ICONS: Record<string, LucideIcon> = {
  customer_complaint: MessageSquareWarning,
  survey_assessment: ClipboardCheck,
  service_operations: Wrench,
  customer_commercial: Users,
  workforce: UserCog,
  warehouse_management: Warehouse,
  procurement_management: ShoppingCart,
  asset: Boxes,
  finance: Landmark,
  hse: ShieldCheck,
  project_delivery: Rocket,
  reporting_insight: BarChart3,
};

/** Icons for standalone pages hanging directly under a group. */
const PAGE_ICONS: Record<string, LucideIcon> = {
  "nav-overview": LayoutDashboard,
  "nav-settings": Settings,
};

/** Icons for pages nested inside a module folder. */
const CHILD_PAGE_ICONS: Record<string, LucideIcon> = {
  "nav-customer_complaint-complaints": MessageSquare,
  "nav-customer_complaint-complaints-admin": Settings2,
  "nav-customer_complaint-queue": ListOrdered,
  "nav-customer_complaint-verification": BadgeCheck,
  "nav-customer_complaint-management": LayoutGrid,
  "nav-customer_complaint-service-quality": Gauge,
  "nav-survey_assessment-my-surveys": ClipboardList,
  "nav-survey_assessment-surveys": ClipboardCheck,
  "nav-service_operations-my-work": Briefcase,
  "nav-service_operations-work-orders": ClipboardList,
  "nav-service_operations-service-types": Tags,
  "nav-service_operations-catering": UtensilsCrossed,
  "nav-service_operations-service-packs": Package,
  "nav-service_operations-service-optimization": Sparkles,
  "nav-customer_commercial-customer-commercial": Users,
  "nav-customer_commercial-sales-pipeline": TrendingUp,
  "nav-workforce-employees": UserRound,
  "nav-workforce-workforce-attendance": CalendarClock,
  "nav-workforce-workforce-leave-overtime": CalendarOff,
  "nav-workforce-workforce-payroll": Banknote,
  "nav-workforce-workforce-recruitment": UserPlus,
  "nav-workforce-workforce-performance": Target,
  "nav-workforce-workforce-planning": UsersRound,
  "nav-warehouse_management-items": Package,
  "nav-warehouse_management-scm-warehouses": Warehouse,
  "nav-warehouse_management-scm-operations": ArrowLeftRight,
  "nav-warehouse_management-scm-valuation": Calculator,
  "nav-procurement_management-suppliers": Building2,
  "nav-procurement_management-purchasing": ShoppingCart,
  "nav-procurement_management-scm-procurement": FileSearch,
  "nav-procurement_management-scm-contracts": FileSignature,
  "nav-procurement_management-scm-spend": BarChart,
  "nav-asset-assets": Boxes,
  "nav-asset-asset-maintenance": Wrench,
  "nav-finance-finance-transactions": ArrowLeftRight,
  "nav-finance-finance-cashflow": Banknote,
  "nav-finance-finance-accounts": Landmark,
  "nav-finance-finance-accounting": BookOpen,
  "nav-finance-finance-statements": FileText,
  "nav-finance-finance-journals": NotebookPen,
  "nav-finance-finance-open-items": Receipt,
  "nav-finance-finance-budgets": PiggyBank,
  "nav-finance-finance-bank-recon": Scale,
  "nav-finance-finance-fixed-assets": Building2,
  "nav-finance-finance-tax": Percent,
  "nav-finance-finance-periods": Lock,
  "nav-hse-hse": ShieldCheck,
  "nav-hse-hse-advanced-investigations": Search,
  "nav-hse-hse-advanced-permits-audit": FileCheck,
  "nav-hse-hse-advanced-monitoring-capa": Activity,
  "nav-project_delivery-project-delivery": Rocket,
  "nav-project_delivery-project-delivery-advanced-planning": CalendarRange,
  "nav-project_delivery-project-delivery-advanced-cost-ev": Calculator,
  "nav-reporting_insight-reporting-insight": BarChart3,
};

/** Icon for a module folder. */
export function moduleIcon(moduleCode: string): LucideIcon {
  return MODULE_ICONS[moduleCode] ?? Package;
}

/** Icon for a standalone page directly under a group. */
export function pageIcon(code: string): LucideIcon {
  return PAGE_ICONS[code] ?? FileCheck;
}

/** Icon for a page nested inside a module folder. */
export function childPageIcon(code: string): LucideIcon {
  return CHILD_PAGE_ICONS[code] ?? FileCheck;
}
