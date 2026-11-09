/**
 * Wave A8 / WP-PLT-A8-01 — The published partner contract (ADR-0028 §4).
 *
 * This is the ONLY list of what partners can reach. Adding a route to the
 * partner surface means adding it here; the onReady coverage check in
 * index.ts fails startup on any drift between this registry and declared
 * routes. Each entry names the credential permission it requires — checked
 * per request by `requirePartnerPermission`.
 */

export interface PartnerRouteEntry {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Full path including the `/api/partner/v1` prefix. */
  path: string;
  /** Permission the credential must carry. Must be part of the credential's
   * explicit permission set (validated as a tenant subset at issuance). */
  permission: string;
}

export const PARTNER_API_PREFIX = "/api/partner/v1";

export const PARTNER_ROUTE_REGISTRY: PartnerRouteEntry[] = [
  { method: "GET", path: `${PARTNER_API_PREFIX}/customers`, permission: "customer.read" },
  { method: "GET", path: `${PARTNER_API_PREFIX}/customers/:id`, permission: "customer.read" },
];
