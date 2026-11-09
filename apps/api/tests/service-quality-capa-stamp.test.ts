import { describe, expect, it } from "vitest";
import { ServiceQualityService } from "../src/application/service-quality/service-quality.service.js";
import type { ActorContext } from "../src/domain/shared-kernel/audit-context.js";

/**
 * Site-scoping (ADR-0007 amendment 2026-11-08): the CAPA approval Instance must
 * carry the owning Organization Unit derived from the parent (Complaint ->
 * Customer.ownerOrganizationUnitId, ADR-0012), like the Complaint's own Instance.
 */
describe("CAPA workflow Instance owning-unit stamp", () => {
  it("passes the Customer's owner Organization Unit in contextData", async () => {
    const started: Array<Record<string, unknown>> = [];
    const service = new ServiceQualityService(
      { createCapaAction: async () => ({ id: "capa-1", actionNumber: "CAPA-1" }), setCapaWorkflowInstance: async () => undefined } as never,
      { getForTrustedCaller: async () => ({ id: "cmp-1", customerId: "cust-1" }) } as never,
      {} as never,
      { getAuthorizedForPermission: async () => ({ id: "cust-1", ownerOrganizationUnitId: "unit-site-a" }) } as never,
      { generateNumberForTenant: async () => ({ number: "CAPA-1" }) } as never,
      { requireTenantScopedPermissionForActor: async () => undefined } as never,
      { record: async () => undefined } as never,
      {} as never,
      {
        startInstance: async (_actor: unknown, input: { contextData: Record<string, unknown> }) => {
          started.push(input.contextData);
          return { instance: { id: "wf-1" } };
        },
      } as never,
    );
    const actor = { tenantId: "t", userId: "u" } as ActorContext;
    await service.createCapaAction(actor, { complaintId: "cmp-1", actionType: "corrective", title: "x" } as never);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      complaintId: "cmp-1",
      customerId: "cust-1",
      organizationUnitId: "unit-site-a",
    });
  });
});
