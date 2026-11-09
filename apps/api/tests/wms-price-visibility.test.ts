import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  containsPriceField,
  createPriceMaskHook,
  maskPriceRow,
  maskPrices,
  nullPriceFields,
} from "../src/application/supply-chain/price-visibility.js";

const actor = { tenantId: "t1", userId: "u1" } as never;
const allow = { requirePermission: async () => undefined } as never;
const deny = {
  requirePermission: async (_a: unknown, code: string) => {
    if (code === "wms.price.view") throw new Error("forbidden");
  },
} as never;

const layer = { id: "l1", quantity: 5, unitCost: 12.5, totalValue: 62.5, createdAt: new Date("2026-01-01") };

describe("wms.price.view — masking helpers", () => {
  it("maskPrices keeps rows but nulls listed fields without the permission", async () => {
    const rows = await maskPrices(deny, actor, [layer], ["unitCost", "totalValue"]);
    expect(rows[0]).toMatchObject({ id: "l1", quantity: 5, unitCost: null, totalValue: null });
  });

  it("maskPrices returns rows untouched with the permission", async () => {
    expect(await maskPrices(allow, actor, [layer], ["unitCost"])).toEqual([layer]);
  });

  it("maskPriceRow masks nested lines and preserves Dates and non-price fields", async () => {
    const po = { id: "p1", lines: [{ itemId: "i", quantityOrdered: 2, unitPrice: "10.50" }], createdAt: layer.createdAt };
    const masked = await maskPriceRow(deny, actor, po);
    expect(masked.lines[0]).toEqual({ itemId: "i", quantityOrdered: 2, unitPrice: null });
    expect(masked.createdAt).toBe(layer.createdAt);
    expect(await maskPriceRow(allow, actor, po)).toBe(po);
  });

  it("nullPriceFields does not mutate its input", () => {
    const input = { amount: 3, nested: { unit_cost: 1 } };
    const out = nullPriceFields(input);
    expect(out).toEqual({ amount: null, nested: { unit_cost: null } });
    expect(input.amount).toBe(3);
    expect(containsPriceField({ a: [{ b: { totalSpend: 1 } }] })).toBe(true);
    expect(containsPriceField({ a: 1 })).toBe(false);
  });
});

describe("wms.price.view — HTTP preSerialization hook", () => {
  async function appWith(rbac: never) {
    const app = Fastify();
    app.decorateRequest("actor", undefined);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { actor: unknown }).actor = actor;
    });
    app.addHook("preSerialization", createPriceMaskHook(rbac));
    app.get("/wms/valuation-layers", async () => [layer]);
    app.get("/purchase-orders/1", async () => ({ id: "1", lines: [{ unitPrice: 9, quantityOrdered: 1 }] }));
    app.get("/wms/warehouses", async () => [{ id: "w", code: "WH", grade: "food" }]);
    app.post("/wms/movements", async () => ({ movement: { quantity: 1, unitCost: 3 } }));
    app.get("/catering/recipes/:code/cost", async () => ({
      recipeCode: "R1",
      lines: [{ itemId: "i", quantity: "2", unitCost: "3.00", lineCost: "6.00" }],
      totalCost: "6.00",
      costPerMeal: "1.50",
    }));
    app.get("/wms/blob", async (_req, reply) => reply.type("application/json").send('{"unitCost":9}'));
    app.get("/users", async () => [{ id: "u", amount: 7 }]);
    await app.ready();
    return app;
  }

  it("nulls price fields for users without the permission; rows still return", async () => {
    const app = await appWith(deny);
    const list = (await app.inject("/wms/valuation-layers")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "l1", quantity: 5, unitCost: null, totalValue: null });
    const po = (await app.inject("/purchase-orders/1")).json();
    expect(po.lines[0]).toEqual({ unitPrice: null, quantityOrdered: 1 });
    const write = await app.inject({ method: "POST", url: "/wms/movements", payload: {} });
    expect(write.statusCode).toBe(200);
    expect(write.json().movement).toEqual({ quantity: 1, unitCost: null });
  });

  it("returns full prices for users with the permission", async () => {
    const app = await appWith(allow);
    expect((await app.inject("/wms/valuation-layers")).json()[0]).toMatchObject({ unitCost: 12.5, totalValue: 62.5 });
    expect((await app.inject("/purchase-orders/1")).json().lines[0].unitPrice).toBe(9);
  });

  it("leaves grade and non-price payloads, and unrelated prefixes, alone", async () => {
    const app = await appWith(deny);
    expect((await app.inject("/wms/warehouses")).json()).toEqual([{ id: "w", code: "WH", grade: "food" }]);
    expect((await app.inject("/users")).json()).toEqual([{ id: "u", amount: 7 }]);
  });

  it("masks percent-encoded paths that still reach the /wms handler", async () => {
    const app = await appWith(deny);
    for (const url of ["/%77ms/valuation-layers", "/w%6Ds/valuation-layers", "/%70urchase-orders/1", "/wms/%76aluation-layers"]) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(200);
      const body = res.json();
      const row = Array.isArray(body) ? body[0] : (body.lines?.[0] ?? body);
      expect(JSON.stringify(row), url).not.toMatch(/12\.5|62\.5|"unitPrice":9/);
    }
    const allowed = await appWith(allow);
    expect((await allowed.inject("/%77ms/valuation-layers")).json()[0].unitCost).toBe(12.5);
  });

  it("masks catering recipe costing (unitCost/lineCost/totalCost/costPerMeal)", async () => {
    const app = await appWith(deny);
    const body = (await app.inject("/catering/recipes/R1/cost")).json();
    expect(body.lines[0]).toEqual({ itemId: "i", quantity: "2", unitCost: null, lineCost: null });
    expect(body.totalCost).toBeNull();
    expect(body.costPerMeal).toBeNull();
    expect((await (await appWith(allow)).inject("/catering/recipes/R1/cost")).json().totalCost).toBe("6.00");
  });

  it("fails closed when a masked-prefix response has no actor", async () => {
    const app = Fastify();
    app.addHook("preSerialization", createPriceMaskHook(allow));
    app.get("/wms/valuation-layers", async () => [layer]);
    await app.ready();
    expect((await app.inject("/wms/valuation-layers")).json()[0]).toMatchObject({ unitCost: null, totalValue: null });
  });

  it("falls back to the decoded URL when no route matched (404 bodies)", async () => {
    const hook = createPriceMaskHook(deny);
    const out = (await hook({ url: "/%77ms/nope?x=1", actor }, null, { unitCost: 1 })) as { unitCost: unknown };
    expect(out.unitCost).toBeNull();
    const bad = (await hook({ url: "/wms/%E0%A4%A", actor }, null, { unitCost: 1 })) as { unitCost: unknown };
    expect(bad.unitCost).toBeNull();
  });

  it("DOCUMENTED LIMIT: string/stream payloads under masked prefixes are not masked", async () => {
    const app = await appWith(deny);
    // No such route exists today; preSerialization only sees object payloads.
    expect((await app.inject("/wms/blob")).body).toBe('{"unitCost":9}');
    const hook = createPriceMaskHook(deny);
    expect(await hook({ url: "/wms/x", actor }, null, "unitCost=9")).toBe("unitCost=9");
  });
});
