import type { ActorContext } from "../../domain/shared-kernel/audit-context.js";
import type { RbacService } from "../rbac/rbac.service.js";

/**
 * LOA price visibility — `wms.price.view` gates every price-shaped field on
 * WMS and procurement reads. Rows the caller may see keep coming back, but
 * the listed fields are nulled unless the ACTIVE assignment carries the
 * permission. Read paths opt in per endpoint by listing the fields they
 * expose (e.g. ["unitCost", "totalCost"]).
 */
export async function maskPrices<T extends Record<string, unknown>>(
  rbac: RbacService,
  actor: ActorContext,
  rows: T[],
  fields: string[],
): Promise<T[]> {
  let allowed: boolean;
  try {
    await rbac.requirePermission(actor, "wms.price.view");
    allowed = true;
  } catch {
    allowed = false;
  }
  if (allowed) return rows;
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fields.includes(k) ? null : v])) as T,
  );
}

// ---------------------------------------------------------------------------
// Response-level masking (wired once in app.ts for the whole WMS/procurement
// surface, so a new endpoint cannot forget it)
// ---------------------------------------------------------------------------

/** Every price-shaped field name exposed by SCM core, WMS and procurement. */
export const PRICE_FIELDS: readonly string[] = [
  "unitPrice",
  "unitCost",
  "totalCost",
  "totalValue",
  "effectiveUnitCost",
  "landedCostAdded",
  "costPerUnitAdded",
  "allocatedAmount",
  "amount",
  "lineAmount",
  "invoiceAmount",
  "approvedAmount",
  "totalAmount",
  "targetUnitPrice",
  "offeredUnitPrice",
  "offeredTotalPrice",
  "agreedUnitPrice",
  "committedAmount",
  "spentAmount",
  "additionalSpentAmount",
  "totalSpend",
  "avgPoValue",
  // catering recipe costing (POST /catering/recipes/:code/cost) reads WMS valuation layers
  "lineCost",
  "costPerMeal",
  // snake_case spellings that can appear inside free-form event payloads
  "unit_cost",
  "unit_price",
  "total_cost",
  "total_value",
];

const PRICE_FIELD_SET: ReadonlySet<string> = new Set(PRICE_FIELDS);

/** URL prefixes whose responses are price-masked. */
export const PRICE_MASKED_PREFIXES: readonly string[] = [
  "/wms",
  "/procurement",
  "/supply-chain",
  "/purchase-orders",
  "/purchase-requests",
  "/stock",
  // Recipe costing derives unitCost/lineCost/totalCost from scm_valuation_layers.
  "/catering",
];

export async function canViewPrices(rbac: RbacService, actor: ActorContext): Promise<boolean> {
  try {
    await rbac.requirePermission(actor, "wms.price.view");
    return true;
  } catch {
    return false; // fail closed: any RBAC failure hides prices
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** True when the payload carries at least one price-shaped field. */
export function containsPriceField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPriceField);
  if (!isPlainObject(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (PRICE_FIELD_SET.has(k) || containsPriceField(v)) return true;
  }
  return false;
}

/** Pure deep copy with every price-shaped field set to null (Dates etc. kept). */
export function nullPriceFields<T>(value: T, fields: ReadonlySet<string> = PRICE_FIELD_SET): T {
  if (Array.isArray(value)) return value.map((v) => nullPriceFields(v, fields)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = fields.has(k) ? null : nullPriceFields(v, fields);
  }
  return out as T;
}

/** Single-row variant of {@link maskPrices} (nested lines/arrays are masked too). */
export async function maskPriceRow<T>(
  rbac: RbacService,
  actor: ActorContext,
  row: T,
  fields: string[] = [...PRICE_FIELDS],
): Promise<T> {
  if (await canViewPrices(rbac, actor)) return row;
  return nullPriceFields(row, new Set(fields));
}

interface MaskRequest {
  url: string;
  routeOptions?: { url?: string | undefined } | undefined;
  actor?: ActorContext | undefined;
}

/**
 * Route path used for prefix matching. Prefer the DECODED route pattern the
 * router matched (`routeOptions.url`, e.g. "/wms/valuation-layers"): matching
 * on the raw `request.url` let `/%77ms/valuation-layers` bypass the mask while
 * still reaching the /wms handler. Falls back to a decoded, slash-collapsed
 * `request.url` path when no route matched (404). Returns null when the URL
 * cannot be decoded; callers then treat the request as masked (fail closed).
 */
function resolveMaskPath(request: MaskRequest): string | null {
  const pattern = request.routeOptions?.url;
  if (typeof pattern === "string" && pattern.length > 0) return pattern;
  const raw = (request.url.split("?")[0] ?? "").split("#")[0] ?? "";
  try {
    return decodeURIComponent(raw).replace(/\/{2,}/g, "/");
  } catch {
    return null;
  }
}

/**
 * Fastify `preSerialization` hook factory. Masks any response on a covered
 * prefix for actors without `wms.price.view`. Operates on the serialized
 * payload only, so write paths (services, repositories, ledger) are untouched.
 *
 * Known limit (documented, tested): only object/array payloads are masked.
 * String, Buffer or stream payloads under a masked prefix pass through as-is
 * because preSerialization cannot see inside them. No such routes exist today;
 * a route that streams or returns pre-serialized JSON under a masked prefix
 * must mask its own data.
 *
 * Fail closed: a masked-prefix response carrying price fields but no
 * `request.actor` is masked. Every route under the masked prefixes uses
 * `app.authenticate`, so an actor-less response there is an error body or a
 * mis-wired public route; neither should expose prices.
 */
export function createPriceMaskHook(
  rbac: RbacService,
  prefixes: readonly string[] = PRICE_MASKED_PREFIXES,
) {
  return async (request: MaskRequest, _reply: unknown, payload: unknown): Promise<unknown> => {
    const path = resolveMaskPath(request);
    const covered = path === null || prefixes.some((p) => path === p || path.startsWith(`${p}/`));
    if (!covered) return payload;
    if (payload === null || typeof payload !== "object") return payload;
    if (!containsPriceField(payload)) return payload;
    if (request.actor && (await canViewPrices(rbac, request.actor))) return payload;
    return nullPriceFields(payload);
  };
}
