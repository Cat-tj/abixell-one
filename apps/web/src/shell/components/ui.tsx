/**
 * Checkpoint 1C.1 — Lightweight reusable component foundation.
 *
 * Intentionally minimal (FD-1C-03): only the generic primitives the 1C.1
 * experience foundation actually uses live here. Data-heavy primitives
 * (DataTable, Timeline, Form fields) are deferred to the checkpoints that
 * first need them, to avoid shipping unused abstractions.
 *
 * Epic 4 Wave 1 — repainted onto the design tokens from DESIGN.md. These
 * components carry the direction for the whole product, so they name tokens
 * (`bg-panel`, `text-ink-dim`, `border-line`) rather than palette values, and
 * they obey the two standing rules: the accent marks the primary action, the
 * focus ring and the selected row — never a status; and status keeps its own
 * four colors, each paired with its soft background.
 */
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { useT } from "../../i18n/LocaleProvider";

/* ------------------------------------------------------------------ Button */

type ButtonVariant = "primary" | "secondary" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-on font-bold hover:bg-accent-line disabled:opacity-50",
  secondary:
    "border border-line-strong bg-panel text-ink font-bold hover:bg-panel-2 disabled:opacity-50",
  ghost: "text-ink-dim hover:bg-panel-2 hover:text-ink disabled:opacity-50",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }
>(function Button({ variant = "primary", className = "", children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={`inline-flex min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 py-1 text-sm font-semibold transition-colors sm:min-h-[40px] ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

/* -------------------------------------------------------------------- Card */

export function Card({
  className = "",
  children,
  onClick,
}: PropsWithChildren<{ className?: string; onClick?: () => void }>) {
  return (
    <section
      className={`rounded-xl border border-line bg-panel p-4 sm:p-[18px] ${className}`}
      onClick={onClick}
    >
      {children}
    </section>
  );
}

/* -------------------------------------------------------------- PageHeader */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-[0.92rem] text-ink-faint">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- Badge */

/**
 * A non-urgent qualifier next to a title. Rectangular, not a pill: DESIGN.md
 * §5 allows pill geometry only for the 19px status marker, so a Badge and a
 * StatusPill never read as the same thing.
 */
export function Badge({
  children,
  className = "",
}: PropsWithChildren<{ className?: string }>) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-panel-2 px-2.5 py-0.5 text-xs font-bold text-ink-dim ${className}`}
    >
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- StatusPill */

type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

const STATUS_TONES: Record<StatusTone, string> = {
  neutral: "bg-status-idle-soft text-status-idle",
  // `info` is not a status color in this direction, and the accent is never
  // used for one; an informational marker is neutral.
  info: "bg-panel-2 text-ink-dim",
  success: "bg-status-ok-soft text-status-ok",
  warning: "bg-status-warn-soft text-status-warn",
  danger: "bg-status-danger-soft text-status-danger",
};

export function StatusPill({
  tone = "neutral",
  children,
}: PropsWithChildren<{ tone?: StatusTone }>) {
  return (
    <span
      className={`inline-flex min-h-[22px] items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-bold ${STATUS_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------- EmptyState */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-line bg-panel px-6 py-8 text-center">
      <h2 className="text-base font-extrabold text-ink">{title}</h2>
      {description && (
        <p className="mt-1 max-w-md text-sm text-ink-faint">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- Spinner */

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8 text-sm text-ink-dim"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-ink-dim"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}

/* ------------------------------------------------------------------- Alert */

type AlertTone = "error" | "success" | "info" | "warning";

const ALERT_TONES: Record<AlertTone, string> = {
  error: "bg-status-danger-soft text-status-danger",
  success: "bg-status-ok-soft text-status-ok",
  info: "bg-panel-3 text-ink-dim",
  warning: "bg-status-warn-soft text-status-warn",
};

/** Inline feedback primitive — the foundation's feedback mechanism for
 * 1C.1. A global toast/queue is deliberately deferred until a page needs
 * cross-view notifications. */
export function Alert({
  tone = "info",
  children,
}: PropsWithChildren<{ tone?: AlertTone }>) {
  return (
    <div className={`rounded-md px-4 py-3 text-sm font-semibold ${ALERT_TONES[tone]}`} role="alert">
      {children}
    </div>
  );
}

/* ------------------------------------------------- Form primitives (1C.2) */

const CONTROL_CLASS =
  "mt-1 min-h-[44px] w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-[0.9375rem] text-ink placeholder:text-ink-faint focus:border-accent disabled:bg-panel-2 disabled:opacity-60";

/** Labelled field wrapper — pairs a label with a control and optional hint. */
export function Field({
  label,
  required,
  hint,
  children,
}: PropsWithChildren<{ label: string; required?: boolean; hint?: ReactNode }>) {
  return (
    <label className="block text-sm">
      <span className="font-bold text-ink">
        {label}
        {required && <span className="ml-0.5 text-status-danger">*</span>}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

/** Forwards its ref so a field can take focus programmatically (e.g. moving
 * focus to the input a validation failure belongs to). Additive: callers
 * that pass no ref are unaffected. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} className={`${CONTROL_CLASS} ${className}`} {...rest} />;
  },
);

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL_CLASS} ${className}`} {...rest} />;
}

export function Select({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${CONTROL_CLASS} ${className}`} {...rest}>
      {children}
    </select>
  );
}

/* ---------------------------------------------------------------- Toggle */

/**
 * Binary switch for a single on/off decision — the Settings page's idiom for
 * yes/no configuration (module activation, feature flags, service toggles).
 * A native checkbox keeps it keyboard- and screen-reader-accessible; the
 * visual is a labelled switch. `checked` is controlled and `onChange` carries
 * the next value, matching the rest of the form primitives.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch. */
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
          checked ? "border-accent bg-accent" : "border-line-strong bg-panel-3"
        }`}
      >
        <span
          className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-panel transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className="text-sm text-ink-dim">{label}</span>
    </label>
  );
}

/* --------------------------------------------------------- DataTable (1C.3) */

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** Optional extra classes for the cell (e.g. alignment, width). */
  className?: string;
  /** Optional role used to create a stronger stacked-card hierarchy. */
  mobileRole?: "title" | "status" | "detail";
}

/** Generic, responsive table. Horizontal-scrolls inside its own container so
 * the page never scrolls sideways. Rows are optionally clickable.
 *
 * Desktop rows are a fixed 32px (DESIGN.md §3): the value of a dense table is
 * that the eye can run down a column without re-finding its place. Cells keep
 * a minimum height rather than a fixed one so a cell wrapping to two lines
 * still grows instead of clipping its content. */
export function DataTable<T>({
  columns,
  rows,
  keyOf,
  onRowClick,
  empty,
  mobileBreakpoint = "sm",
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  /** `md` keeps cards through 767px for dense admin views. Default preserves
   * every existing caller's original 640px transition. */
  mobileBreakpoint?: "sm" | "md";
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const cardVisibility = mobileBreakpoint === "md" ? "md:hidden" : "sm:hidden";
  const tableVisibility = mobileBreakpoint === "md" ? "hidden md:block" : "hidden sm:block";

  return (
    <>
      {/* Mobile (Checkpoint 1C.7): stacked cards instead of a sideways-scrolling
          table, so dense operational/management tables stay usable on a phone.
          Cards follow the 44px touch-target rule, not the 32px desktop density. */}
      <ul className={`space-y-2 ${cardVisibility}`}>
        {rows.map((row) => {
          const titleColumns = columns.filter((column) => column.mobileRole === "title");
          const statusColumns = columns.filter((column) => column.mobileRole === "status");
          const detailColumns = columns.filter(
            (column) => column.mobileRole !== "title" && column.mobileRole !== "status",
          );
          const hasHierarchy = titleColumns.length > 0 || statusColumns.length > 0;

          return (
            <li
              key={keyOf(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`rounded-lg border border-line bg-panel p-3 ${onRowClick ? "cursor-pointer active:bg-panel-2" : ""}`}
            >
              {hasHierarchy && (
                <div className="mb-2 flex items-start justify-between gap-3 border-b border-line pb-2">
                  <div className="min-w-0 space-y-0.5">
                    {titleColumns.map((column, index) => (
                      <div key={index} className="wrap-break-word text-sm font-semibold text-ink">
                        {column.cell(row)}
                      </div>
                    ))}
                  </div>
                  <div className="shrink-0 space-y-1 text-right">
                    {statusColumns.map((column, index) => (
                      <div key={index}>{column.cell(row)}</div>
                    ))}
                  </div>
                </div>
              )}
              {(hasHierarchy ? detailColumns : columns).map((column, index) => (
                <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] items-start gap-3 py-1">
                  <span className="text-xs font-bold text-ink-faint">
                    {column.header}
                  </span>
                  <span className="min-w-0 wrap-break-word text-right text-sm text-ink">
                    {column.cell(row)}
                  </span>
                </div>
              ))}
            </li>
          );
        })}
      </ul>

      {/* Desktop/tablet: the full table (still scrolls inside its own box). */}
      <div className={`${tableVisibility} overflow-x-auto rounded-lg border border-line bg-panel`}>
        <table className="min-w-full border-collapse text-[0.92rem] tabular-nums">
          <thead>
            <tr className="border-b border-line">
              {columns.map((column, index) => (
                <th
                  key={index}
                  scope="col"
                  className={`h-10 whitespace-nowrap bg-panel-2 px-3 ${/\btext-(right|center)\b/.test(column.className ?? "") ? "" : "text-left"} text-[0.84rem] font-extrabold text-ink-faint ${column.className ?? ""}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={keyOf(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-line last:border-b-0 hover:bg-panel-2 ${onRowClick ? "cursor-pointer" : ""}`}
              >
                {columns.map((column, index) => (
                  <td
                    key={index}
                    className={`h-10 px-3 py-2 align-middle text-ink ${column.className ?? ""}`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------ Permission denied */

export function PermissionDeniedState({
  permission,
  action,
}: {
  permission?: string;
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <EmptyState
      title={t("common.permissionDenied")}
      description={
        <>
          {permission ? (
            <>
              {t("common.permissionRequired")}{" "}
              <code className="rounded bg-panel-3 px-1.5 py-0.5 font-mono text-xs text-ink-dim">
                {permission}
              </code>
              .
            </>
          ) : (
            t("common.permissionNone")
          )}{" "}
          {t("common.askAdmin")}
        </>
      }
      action={action}
    />
  );
}

/* ---------------------------------------------------------- Timeline (1C.2) */

export interface TimelineItem {
  key: string;
  title: string;
  timestamp?: string | null;
  detail?: ReactNode;
}

/** Vertical progress timeline — generic, ordered oldest→newest by caller. */
export function Timeline({ items }: { items: TimelineItem[] }) {
  const t = useT();
  if (items.length === 0) {
    return <p className="text-sm text-ink-dim">{t("common.noActivity")}</p>;
  }
  return (
    <ol className="relative ml-2 border-l border-line">
      {items.map((item) => (
        <li key={item.key} className="mb-4 ml-4">
          <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-panel bg-line-strong" />
          <div className="text-sm font-medium text-ink">{item.title}</div>
          {item.timestamp && (
            <div className="text-xs text-ink-faint">
              {new Date(item.timestamp).toLocaleString()}
            </div>
          )}
          {item.detail && <div className="mt-0.5 text-sm text-ink-dim">{item.detail}</div>}
        </li>
      ))}
    </ol>
  );
}
