import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "../src/domain/shared-kernel/errors.js";
import {
  GRADE_MISMATCH_CODE,
  assertGradeCompatible,
  assertWarehouseRegradeAllowed,
  isGradeCompatible,
} from "../src/modules/supply-chain/advanced/domain/grade-policy.js";
import { SupplyChainService } from "../src/modules/supply-chain/core/application/supply-chain.service.js";
import { SupplyChainAdvancedService } from "../src/modules/supply-chain/advanced/application/supply-chain-advanced.service.js";

const ctx = (itemGrade: "food" | "non_food" | null, warehouseGrade: "food" | "non_food" | null) => ({
  itemCode: "RICE-01",
  itemGrade,
  warehouseCode: "WH-A",
  warehouseGrade,
});

describe("WMS food-grade separation — policy", () => {
  it("allows matching grades", () => {
    expect(() => assertGradeCompatible(ctx("food", "food"))).not.toThrow();
    expect(() => assertGradeCompatible(ctx("non_food", "non_food"))).not.toThrow();
  });

  it("rejects a food item in a non_food warehouse and vice versa", () => {
    expect(isGradeCompatible("food", "non_food")).toBe(false);
    expect(isGradeCompatible("non_food", "food")).toBe(false);
    expect(() => assertGradeCompatible(ctx("food", "non_food"))).toThrow(ConflictError);
    try {
      assertGradeCompatible(ctx("non_food", "food"));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect((e as ConflictError).code).toBe(GRADE_MISMATCH_CODE);
      expect((e as Error).message).toContain("RICE-01");
    }
  });

  it("treats NULL grade on either side as unrestricted", () => {
    for (const g of ["food", "non_food", null] as const) {
      expect(isGradeCompatible(null, g)).toBe(true);
      expect(isGradeCompatible(g, null)).toBe(true);
    }
  });

  it("blocks re-grading a warehouse that holds stock of the other grade", () => {
    expect(() => assertWarehouseRegradeAllowed("WH-A", "food", ["non_food"])).toThrow(ConflictError);
    expect(() => assertWarehouseRegradeAllowed("WH-A", "food", ["food"])).not.toThrow();
    expect(() => assertWarehouseRegradeAllowed("WH-A", "food", [])).not.toThrow();
    // clearing the grade is always safe
    expect(() => assertWarehouseRegradeAllowed("WH-A", null, ["food", "non_food"])).not.toThrow();
  });
});

describe("WMS food-grade separation — service wiring", () => {
  const actor = { tenantId: "t1", userId: "u1" } as never;
  const warehouse = {
    id: "w1",
    tenantId: "t1",
    code: "WH-A",
    organizationUnitId: null,
    grade: "non_food",
  };

  function build(repo: Record<string, unknown>) {
    const rbac = {
      requirePermission: vi.fn(async () => undefined),
      hasTenantScope: vi.fn(async () => true),
      requireOrganizationUnitScopeForActor: vi.fn(async () => undefined),
    };
    const audit = { record: vi.fn(async () => undefined) };
    return new SupplyChainAdvancedService(repo as never, rbac as never, audit as never, {} as never, {} as never, {} as never);
  }

  // The repository runs the guard inside its row-locked transaction; the fake
  // here mimics that contract (guard(current, heldGrades) before the write).
  function fakeUpdateWarehouse(held: string[], onWrite = vi.fn()) {
    return vi.fn(async (_t: string, _id: string, input: { grade?: string | null }, guard?: (w: unknown, h: string[]) => void) => {
      if (guard && input.grade !== undefined && input.grade !== warehouse.grade) guard(warehouse, held);
      onWrite();
      return { ...warehouse, grade: input.grade ?? warehouse.grade };
    });
  }

  it("rejects re-grading a warehouse holding conflicting stock (guard runs in the repo transaction)", async () => {
    const write = vi.fn();
    const updateWarehouse = fakeUpdateWarehouse(["non_food"], write);
    const svc = build({ findWarehouseById: async () => warehouse, updateWarehouse });
    await expect(svc.updateWarehouse(actor, "w1", { grade: "food" })).rejects.toMatchObject({ code: GRADE_MISMATCH_CODE });
    expect(write).not.toHaveBeenCalled();
    expect(typeof updateWarehouse.mock.calls[0]![3]).toBe("function");
  });

  it("allows re-grading an empty warehouse and an unchanged grade", async () => {
    const updateWarehouse = fakeUpdateWarehouse([]);
    const svc = build({ findWarehouseById: async () => warehouse, updateWarehouse });
    await expect(svc.updateWarehouse(actor, "w1", { grade: "food" })).resolves.toBeTruthy();
    await expect(svc.updateWarehouse(actor, "w1", { grade: "non_food" })).resolves.toBeTruthy(); // unchanged
    await expect(svc.updateWarehouse(actor, "w1", { name: "x" })).resolves.toBeTruthy();
    expect(updateWarehouse.mock.calls[2]![3]).toBeUndefined(); // no grade change -> no guard
  });

  it("rejects a stock transfer with a grade-incompatible line before any workflow starts", async () => {
    const createStockTransfer = vi.fn();
    const svc = build({
      findWarehouseById: async () => warehouse,
      findGradeContext: async (_t: string, _i: string, warehouseId: string) =>
        warehouseId === "w-food"
          ? ctx("food", "food")
          : ctx("food", "non_food"),
      createStockTransfer,
    });
    await expect(
      svc.createStockTransfer(actor, {
        fromWarehouseId: "w-food",
        toWarehouseId: "w-non-food",
        lines: [{ itemId: "i1", quantity: 1 }],
      } as never),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(createStockTransfer).not.toHaveBeenCalled();
  });
});

describe("item regrade guard (core updateItem)", () => {
  const actor = { tenantId: "t1", userId: "u1" } as never;
  const item = { id: "i1", tenantId: "t1", code: "RICE-01", grade: "food" };

  function build(conflicts: Array<{ warehouseCode: string; warehouseGrade: string }>) {
    const listConflictingWarehouses = vi.fn(async () => conflicts);
    // Fake repo mimics PgSupplyChainRepository.updateItem: run the guard under the lock, then write.
    const updateItem = vi.fn(async (_id: string, input: Record<string, unknown>, _by: string | null, guard?: (db: unknown) => Promise<void>) => {
      if (guard) await guard({ query: vi.fn() });
      return { ...item, ...input };
    });
    const repo = { findItemByCode: async () => item, updateItem };
    const svc = new SupplyChainService(
      repo as never,
      {} as never,
      {} as never,
      { record: vi.fn(async () => undefined) } as never,
      { requirePermission: vi.fn(async () => undefined) } as never,
      {} as never,
      { listConflictingWarehouses },
    );
    return { svc, updateItem, listConflictingWarehouses };
  }

  it("rejects food -> non_food while stock sits in a food warehouse (409 GRADE_MISMATCH)", async () => {
    const { svc } = build([{ warehouseCode: "WH-F", warehouseGrade: "food" }]);
    const err = await svc.updateItem(actor, "RICE-01", { grade: "non_food" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe(GRADE_MISMATCH_CODE);
    expect(err.message).toContain("WH-F");
  });

  it("allows regrade with no conflicting stock; skips the check for null / unchanged / absent grade", async () => {
    const { svc, listConflictingWarehouses } = build([]);
    await expect(svc.updateItem(actor, "RICE-01", { grade: "non_food" })).resolves.toBeTruthy();
    expect(listConflictingWarehouses).toHaveBeenCalledTimes(1);
    await svc.updateItem(actor, "RICE-01", { grade: null });
    await svc.updateItem(actor, "RICE-01", { grade: "food" }); // unchanged
    await svc.updateItem(actor, "RICE-01", { name: "Rice" });
    expect(listConflictingWarehouses).toHaveBeenCalledTimes(1);
  });
});
