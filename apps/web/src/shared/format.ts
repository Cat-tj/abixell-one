/**
 * Module-neutral presentation helpers (Phase 2).
 *
 * `shared/` holds technical building blocks with no product semantics
 * (blueprint §11A) — these map backend-authoritative values to display
 * tone/text ONLY. They carry no business rule and drive no behaviour:
 * lifecycle, SLA truth, and authorization all remain in the backend.
 *
 * This also retires the "shared date formatter" debt: the Complaint module
 * now re-exports these instead of owning them, so other modules no longer
 * import presentation helpers from a business module's folder.
 */
import { translate } from "../i18n/t";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** `document.documentElement.lang` is kept in sync by `LocaleProvider` and
 * the pre-paint script in index.html, so it is the one place a module
 * outside React can read the active locale without a second source of
 * truth. Falls back to "en" when read before either has run (SSR, tests). */
function activeLocale(): "en" | "id" {
  return typeof document !== "undefined" && document.documentElement.lang === "id" ? "id" : "en";
}

function localeTag(): string {
  return activeLocale() === "id" ? "id-ID" : "en-US";
}

/** Cosmetic tone for a Workflow instance status. */
export function statusTone(instanceStatus: string | null | undefined): Tone {
  switch (instanceStatus) {
    case "approved":
      return "success";
    case "rejected":
    case "cancelled":
      return "danger";
    case "in_progress":
      return "info";
    default:
      return "neutral";
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(localeTag());
}

export function formatDateShort(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(localeTag());
}

/** Expands an exponent-notation numeric string ("1e21", "-1.5E-7") into plain digits. */
function expandExponent(value: string): string {
  const m = /^([+-]?)(\d*)\.?(\d*)[eE]([+-]?\d+)$/.exec(value);
  if (!m || (m[2] === "" && m[3] === "")) return value;
  const [, sign, int = "", frac = "", exp] = m;
  const shift = Number(exp);
  if (!Number.isInteger(shift) || Math.abs(shift) > 1000) return value;
  const digits = int + frac;
  const point = int.length + shift;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (sign === "-" ? "-" : "") + out;
}

/** Groups a decimal string for display without converting it to a number.
 * Rounds half away from zero to 2 decimals on the decimal digits (no float math). */
export function formatMoney(value: string | number | null | undefined): string {
  // Price fields are `null` when the viewer lacks `wms.price.view`.
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    // String(n) switches to exponent notation for |n| >= 1e21 or tiny values.
    value = expandExponent(String(value));
  } else if (/[eE]/.test(value)) {
    value = expandExponent(value.trim());
  }
  const negative = value.startsWith("-");
  const unsigned = negative || value.startsWith("+") ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  let cents = (fraction + "00").slice(0, 2);
  let integer = whole === "" ? "0" : whole;
  if (/^\d+$/.test(integer) && /^\d*$/.test(fraction)) {
    // Round half-up on the first dropped digit, carrying through BigInt on the digit string.
    if ((fraction[2] ?? "0") >= "5") {
      const bumped = (BigInt(integer + cents) + 1n).toString().padStart(3, "0");
      integer = bumped.slice(0, -2);
      cents = bumped.slice(-2);
    }
  }
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const isZero = /^0*$/.test(integer) && cents === "00";
  return `${negative && !isZero ? "−" : ""}${grouped},${cents}`;
}

/** Display-only due-date indicator derived solely from a backend-provided
 * timestamp — never an independent SLA computation. */
export function dueIndicator(dueAt: string | null | undefined): { label: string; tone: Tone } | null {
  if (!dueAt) return null;
  const due = new Date(dueAt).getTime();
  const now = Date.now();
  const locale = activeLocale();
  if (now > due) return { label: translate(locale, "due.overdue"), tone: "danger" };
  if (due - now < 24 * 60 * 60 * 1000) return { label: translate(locale, "due.soon"), tone: "warning" };
  return { label: translate(locale, "due.onTrack"), tone: "success" };
}
