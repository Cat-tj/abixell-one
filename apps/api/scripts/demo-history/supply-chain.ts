/**
 * Sector "supply-chain": a year of procurement and warehouse history for
 * PT Sentra Layanan Terpadu.
 *
 * One deterministic day-by-day simulation of the stock of every catalogue item
 * (consumption, reorder reviews per supplier, deliveries, inspections) produces
 * a list of dated events. The events are then replayed in date order through
 * the real API so that numbering, workflow, ledgers and valuation layers stay
 * consistent, and finally the business dates are backdated with SQL.
 *
 * Idempotent: every document is found again by a deterministic key (supplier +
 * order date for purchase orders, idempotency keys for receipts/inspections,
 * `[k:...]` tags in movement notes) so a re-run creates nothing new.
 */
import { makeRand, type DemoCtx } from "./harness.js";
import {
  ITEMS,
  SUPPLIERS,
  WAREHOUSES,
  USERS,
  activityFactor,
  DEMO_PASSWORD,
  type ItemSpec,
  type SupplierKey,
  type WarehouseKey,
} from "./catalog.js";

const SECTOR = "supply-chain";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const addDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
const nextWorkday = (d: string) => (dow(d) === 0 ? addDays(d, 1) : d);
const monthOf = (d: string) => d.slice(0, 7);
const diffDays = (a: string, b: string) => Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
const iso = (d: string, hour: number, minute = 0) =>
  new Date(`${d}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`).toISOString();

function roundQty(q: number): number {
  const step = q >= 5000 ? 500 : q >= 1000 ? 100 : q >= 200 ? 10 : q >= 50 ? 5 : 1;
  return Math.max(step, Math.ceil(q / step) * step);
}
function roundPrice(p: number): number {
  if (p >= 1000) return Math.round(p / 100) * 100;
  if (p >= 100) return Math.round(p / 10) * 10;
  return Math.max(1, Math.round(p));
}

/** Review period (days) and weekday offset per supplier. */
const REVIEW: Record<SupplierKey, { every: number; offset: number; viaPr: boolean }> = {
  UNGGAS: { every: 7, offset: 1, viaPr: false },
  DAGING: { every: 7, offset: 2, viaPr: false },
  TELUR: { every: 7, offset: 3, viaPr: false },
  SAYUR: { every: 7, offset: 1, viaPr: false },
  IKAN: { every: 7, offset: 2, viaPr: false },
  BERAS: { every: 14, offset: 1, viaPr: false },
  SEMBAKO: { every: 14, offset: 3, viaPr: false },
  AIR: { every: 14, offset: 4, viaPr: false },
  BUMBU: { every: 28, offset: 3, viaPr: false },
  KEMASAN: { every: 21, offset: 4, viaPr: true },
  KIMIA: { every: 30, offset: 5, viaPr: true },
  APD: { every: 45, offset: 6, viaPr: true },
  SPAREPART: { every: 60, offset: 6, viaPr: true },
};

/** Days of cover an item cycle represents (usage per day = reorderQty / cycle). */
function cycleDays(i: ItemSpec): number {
  if (i.perishable) return 4;
  switch (i.category) {
    case "Bahan Pokok": return 14;
    case "Protein": return 5;
    case "Sayur & Buah": return 10;
    case "Bumbu & Saus": return 20;
    case "Minuman": return 14;
    case "Kemasan": return 14;
    case "Kimia Kebersihan": return 30;
    case "Suku Cadang": return 90;
    case "APD": return 60;
  }
}
/** How often (days) consumption is booked as a stock issue. */
function flushEvery(i: ItemSpec): number {
  if (i.perishable) return 7;
  if (i.grade === "food") return 14;
  return 30;
}

// ---------------------------------------------------------------------------
// simulation model
// ---------------------------------------------------------------------------

interface Delivery {
  idx: number;
  date: string; // physical receipt
  inspectDate: string;
  lines: { itemCode: string; recv: number; acc: number; rej: number; quar: number; short: number }[];
}
interface OrderLine {
  item: ItemSpec;
  qty: number;
  price: number;
}
interface Order {
  key: string; // `${supplierCode}@${orderDate}`
  supplier: SupplierKey;
  supplierCode: string;
  date: string;
  expected: string;
  lines: OrderLine[];
  viaPr: boolean;
  prDate: string;
  deliveries: Delivery[];
  cancelled?: string;
  late: boolean;
  rfq?: number; // forced order from RFQ index
}
interface IssueEv {
  item: ItemSpec;
  date: string;
  qty: number;
}

interface RfqSpec {
  idx: number;
  date: string;
  deadline: string;
  awardDate?: string;
  title: string;
  notes: string;
  supplier: SupplierKey; // winner
  bidders: { key: SupplierKey; factor: number; lead: number; tech: number; comm: number }[];
  items: { code: string; qty: number }[];
}

const RFQS: RfqSpec[] = [
  {
    idx: 1, date: "2025-12-03", deadline: "2025-12-08", awardDate: "2025-12-10", title: "Pengadaan Beras Premium Kuartal I-2026",
    notes: "Kontrak harga beras premium untuk dapur pusat, kebutuhan Januari-Maret 2026.",
    supplier: "BERAS",
    bidders: [
      { key: "BERAS", factor: 0.985, lead: 3, tech: 88, comm: 92 },
      { key: "SEMBAKO", factor: 1.03, lead: 5, tech: 80, comm: 78 },
    ],
    items: [{ code: "RICE", qty: 4000 }],
  },
  {
    idx: 2, date: "2026-02-16", deadline: "2026-02-21", awardDate: "2026-02-24", title: "Paket Kemasan Ramadan 1447H",
    notes: "Kotak nasi, sendok garpu dan gelas untuk lonjakan pesanan iftar/sahur selama Ramadan.",
    supplier: "KEMASAN",
    bidders: [
      { key: "KEMASAN", factor: 0.97, lead: 4, tech: 90, comm: 90 },
      { key: "KIMIA", factor: 1.06, lead: 6, tech: 72, comm: 70 },
    ],
    items: [{ code: "BOX-NASI", qty: 40000 }, { code: "SENDOK-GARPU", qty: 30000 }, { code: "GELAS-CUP", qty: 30000 }],
  },
  {
    idx: 3, date: "2026-06-08", deadline: "2026-06-13", awardDate: "2026-06-16", title: "Pengadaan APD Tahunan Karyawan Lapangan",
    notes: "Sepatu safety, sarung tangan, masker dan apron untuk seluruh karyawan dapur dan cleaning.",
    supplier: "APD",
    bidders: [
      { key: "APD", factor: 0.96, lead: 5, tech: 91, comm: 89 },
      { key: "KIMIA", factor: 1.05, lead: 7, tech: 74, comm: 72 },
      { key: "KEMASAN", factor: 1.08, lead: 7, tech: 68, comm: 66 },
    ],
    items: [{ code: "PPE-SEPATU", qty: 60 }, { code: "PPE-SARUNG", qty: 400 }, { code: "PPE-MASKER", qty: 120 }, { code: "PPE-APRON", qty: 80 }],
  },
  {
    idx: 4, date: "2026-08-17", deadline: "2026-08-22", awardDate: "2026-08-25", title: "Suku Cadang AC dan Genset Semester II",
    notes: "Filter AC, MCB dan oli genset untuk perawatan preventif AC kantor/site dan genset gudang.",
    supplier: "SPAREPART",
    bidders: [
      { key: "SPAREPART", factor: 0.98, lead: 4, tech: 93, comm: 87 },
      { key: "KIMIA", factor: 1.1, lead: 9, tech: 65, comm: 62 },
    ],
    items: [{ code: "SPR-FILTER-AC", qty: 60 }, { code: "SPR-MCB", qty: 20 }, { code: "SPR-OLI-GENSET", qty: 8 }],
  },
  {
    idx: 5, date: "2026-11-04", deadline: "2026-11-18",
    title: "Kontrak Daging Sapi dan Ikan Semester I-2027",
    notes: "Penawaran harga tetap daging sapi has dalam dan fillet ikan dori untuk Januari-Juni 2027. Evaluasi sedang berjalan.",
    supplier: "DAGING",
    bidders: [
      { key: "DAGING", factor: 0.98, lead: 2, tech: 86, comm: 88 },
      { key: "IKAN", factor: 1.02, lead: 2, tech: 82, comm: 84 },
      { key: "UNGGAS", factor: 1.07, lead: 3, tech: 70, comm: 68 },
    ],
    items: [{ code: "DAGING-SAPI", qty: 1200 }, { code: "IKAN-DORI", qty: 1500 }],
  },
];

interface SimResult {
  orders: Order[];
  issues: IssueEv[];
  endStock: Map<string, number>;
}

function simulate(ctx: DemoCtx, startStock: Map<string, number>): SimResult {
  const rng = makeRand(8801177);
  const start = ctx.cal.start;
  const today = ctx.cal.today;
  const supCode = (k: SupplierKey) => SUPPLIERS.find((s) => s.key === k)!.code;

  const S = new Map<string, number>(); // on-hand (accepted) stock
  const acc = new Map<string, number>(); // fractional consumption carry
  const pend = new Map<string, number>(); // consumption not yet booked as an issue
  const nextFlush = new Map<string, string>();
  for (const i of ITEMS) {
    S.set(i.code, startStock.get(i.code) ?? i.openingQty);
    acc.set(i.code, 0);
    pend.set(i.code, 0);
    nextFlush.set(i.code, addDays(start, 5 + (i.code.length % 7)));
  }

  // price drift per item: slow inflation + noise, perishables more volatile
  const drift = new Map<string, number>();
  for (const i of ITEMS) drift.set(i.code, (rng.next() - 0.5) * 0.02 + (i.perishable ? 0.0045 : 0.0025));
  const priceOf = (i: ItemSpec, date: string) => {
    const m = diffDays(start, date) / 30;
    const noise = 1 + (rng.next() - 0.5) * (i.perishable ? 0.07 : 0.025);
    return roundPrice(i.unitCost * (1 + (drift.get(i.code) ?? 0) * m) * noise);
  };

  const orders: Order[] = [];
  const issues: IssueEv[] = [];
  const arrivals = new Map<string, { order: Order; delivery: Delivery }[]>(); // inspect date -> items
  const onOrder = new Map<string, number>(); // qty ordered and not yet accepted/cancelled

  const reviewDays = new Map<string, SupplierKey[]>();
  const nextReview = new Map<SupplierKey, string>();
  for (const [k, r] of Object.entries(REVIEW) as [SupplierKey, (typeof REVIEW)[SupplierKey]][]) {
    // procurement-through-PR suppliers need two days for the PR; others order from day 1
    const first = nextWorkday(addDays(start, Math.max(r.offset, r.viaPr ? 3 : 1)));
    nextReview.set(k, first);
  }
  void reviewDays;

  const forced = RFQS.filter((r) => r.awardDate).map((r) => ({
    rfq: r.idx,
    date: nextWorkday(addDays(r.awardDate!, 3)),
    supplier: r.supplier,
    items: r.items,
  }));

  const placeOrder = (supplier: SupplierKey, date: string, wanted: { item: ItemSpec; qty: number }[], rfq?: number) => {
    if (wanted.length === 0) return;
    const r = REVIEW[supplier];
    const key = `${supCode(supplier)}@${date}`;
    if (orders.some((o) => o.key === key)) return;
    const maxLead = Math.max(...wanted.map((w) => w.item.leadTimeDays));
    const late = rng.chance(0.12);
    let deliv = nextWorkday(addDays(date, maxLead + (late ? rng.int(1, 4) : 0)));
    const expected = nextWorkday(addDays(date, maxLead));
    const prDate = r.viaPr ? (() => { let d = addDays(date, -2); while (dow(d) === 0) d = addDays(d, -1); return d < start ? start : d; })() : date;
    const o: Order = {
      key, supplier, supplierCode: supCode(supplier), date, expected,
      lines: wanted.map((w) => ({ item: w.item, qty: w.qty, price: priceOf(w.item, date) })),
      viaPr: r.viaPr || rfq !== undefined && false, prDate, deliveries: [], late, rfq,
    };
    // non-food PR orders can be cancelled before delivery (supplier out of stock / price changed)
    if (r.viaPr && rfq === undefined && date > addDays(start, 30) && rng.chance(0.04)) {
      o.cancelled = rng.pick(["Supplier kehabisan stok, dialihkan ke pesanan berikutnya", "Harga naik di atas batas persetujuan, PR diajukan ulang", "Pemasok tidak sanggup memenuhi jadwal kirim"]);
    }
    if (!o.cancelled) {
      const partial = wanted.length >= 2 && rng.chance(0.09);
      const mk = (idx: number, date: string, fraction: number, final: boolean): Delivery => {
        const lines = o.lines.map((l) => {
          let recv = idx === 0 && partial ? Math.max(1, Math.floor(l.qty * fraction)) : final && partial ? l.qty - Math.max(1, Math.floor(l.qty * 0.7)) : l.qty;
          if (!partial) recv = l.qty;
          let rej = 0, quar = 0, short = 0;
          const roll = rng.next();
          const perishFactor = l.item.perishable ? 1.6 : 1;
          if (roll < 0.06 * perishFactor) rej = Math.max(1, Math.round(recv * (0.03 + rng.next() * 0.07)));
          else if (roll < 0.08 * perishFactor + 0.015) quar = Math.max(1, Math.round(recv * (0.02 + rng.next() * 0.03)));
          else if (roll < 0.08 * perishFactor + 0.03 && !partial && recv > 5) { short = Math.max(1, Math.round(recv * (0.03 + rng.next() * 0.04))); recv -= short; }
          if (rej + quar >= recv) { rej = 0; quar = 0; }
          return { itemCode: l.item.code, recv, acc: recv - rej - quar, rej, quar, short };
        });
        const inspectDate = rng.chance(0.2) ? nextWorkday(addDays(date, 1)) : date;
        return { idx, date, inspectDate, lines };
      };
      if (partial) {
        o.deliveries.push(mk(0, deliv, 0.7, false));
        o.deliveries.push(mk(1, nextWorkday(addDays(deliv, rng.int(2, 4))), 0.3, true));
      } else {
        o.deliveries.push(mk(0, deliv, 1, true));
      }
      // book the inventory position and schedule stock appearance on inspection dates
      for (const l of o.lines) onOrder.set(l.item.code, (onOrder.get(l.item.code) ?? 0) + l.qty);
      for (const d of o.deliveries) {
        const arr = arrivals.get(d.inspectDate) ?? [];
        arr.push({ order: o, delivery: d });
        arrivals.set(d.inspectDate, arr);
      }
    }
    orders.push(o);
  };

  // main day loop
  let day = start;
  while (day <= today) {
    // 1. accepted stock enters on the inspection day
    for (const { order, delivery } of arrivals.get(day) ?? []) {
      for (const l of delivery.lines) {
        S.set(l.itemCode, (S.get(l.itemCode) ?? 0) + l.acc);
      }
      void order;
    }
    // inventory position bookkeeping: order qty leaves "on order" once the last delivery has been inspected
    for (const o of orders) {
      if (o.cancelled || o.deliveries.length === 0) continue;
      const last = o.deliveries[o.deliveries.length - 1];
      if (last.inspectDate === day) for (const l of o.lines) onOrder.set(l.item.code, (onOrder.get(l.item.code) ?? 0) - l.qty);
    }

    // 2. consumption
    const f = activityFactor(monthOf(day));
    const wd = dow(day);
    const dayFactor = wd === 0 ? 0.25 : wd === 6 ? 0.75 : 1.05;
    for (const i of ITEMS) {
      const base = (i.reorderQty / cycleDays(i)) * f * dayFactor * (0.88 + rng.next() * 0.24) * (i.category === "Suku Cadang" ? 0.5 : 1);
      let a = (acc.get(i.code) ?? 0) + base;
      let take = Math.floor(a);
      a -= take;
      const have = S.get(i.code) ?? 0;
      if (take > have) take = have;
      acc.set(i.code, a);
      S.set(i.code, have - take);
      pend.set(i.code, (pend.get(i.code) ?? 0) + take);
    }

    // 3. book consumption as stock issues on the item's schedule
    for (const i of ITEMS) {
      if ((nextFlush.get(i.code) ?? "9") <= day && dow(day) !== 0) {
        const q = pend.get(i.code) ?? 0;
        if (q > 0) issues.push({ item: i, date: day, qty: q });
        pend.set(i.code, 0);
        nextFlush.set(i.code, addDays(day, flushEvery(i)));
      }
    }

    // 4. forced orders (RFQ awards) and supplier reviews
    for (const fo of forced) {
      if (fo.date === day) {
        const wanted = fo.items.map((x) => ({ item: ITEMS.find((i) => i.code === x.code)!, qty: x.qty }));
        placeOrder(fo.supplier, day, wanted, fo.rfq);
      }
    }
    for (const [sup, rv] of nextReview) {
      if (rv !== day) continue;
      const cfg = REVIEW[sup];
      const wanted: { item: ItemSpec; qty: number }[] = [];
      const fnext = activityFactor(monthOf(addDays(day, 14)));
      for (const i of ITEMS.filter((x) => x.supplier === sup)) {
        const useF = (i.reorderQty / cycleDays(i)) * fnext * (i.category === "Suku Cadang" ? 0.5 : 1);
        const P = (S.get(i.code) ?? 0) + (onOrder.get(i.code) ?? 0);
        const s = useF * (i.leadTimeDays + cfg.every) + i.minQty;
        if (P <= s) {
          const top = s + Math.max(useF * cfg.every, i.reorderQty * fnext * 0.5);
          const q = roundQty(top - P);
          wanted.push({ item: i, qty: q });
        }
      }
      placeOrder(sup, day, wanted);
      nextReview.set(sup, nextWorkday(addDays(day, cfg.every)));
    }

    day = addDays(day, 1);
  }
  void pend;
  return { orders, issues, endStock: S };
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

interface PoState {
  id: string;
  number: string;
  supplierId: string;
  lineIds: Map<string, string>; // itemCode -> po line id
  issued: boolean;
}
interface Ev {
  date: string;
  prio: number;
  seq: number;
  label: string;
  run: () => Promise<void>;
}

const count: Record<string, number> = {};
const made = (k: string, n = 1) => { count[k] = (count[k] ?? 0) + n; };

async function ensureWorkflow(
  ctx: DemoCtx,
  existing: Set<string>,
  def: { code: string; name: string; entityType: string; steps: { code: string; name: string; type: "task" | "approval" | "end"; initial?: boolean; terminal?: "approved" | "rejected" }[]; transitions: [string, string, string, string][]; rules: { step: string; role?: string }[] },
) {
  if (existing.has(def.code)) return;
  await ctx.call("POST", "/workflow/definitions", { code: def.code, name: def.name, entityType: def.entityType, description: `Alur persetujuan ${def.name}` });
  const base = `/workflow/definitions/${def.code}/versions/1`;
  for (const s of def.steps) {
    await ctx.call("POST", `${base}/steps`, {
      code: s.code, name: s.name, stepType: s.type,
      ...(s.initial ? { isInitial: true } : {}),
      ...(s.terminal ? { isTerminal: true, terminalStatus: s.terminal } : {}),
    });
  }
  for (const [from, to, action, name] of def.transitions) {
    await ctx.call("POST", `${base}/transitions`, { fromStepCode: from, toStepCode: to, actionCode: action, name });
  }
  for (const r of def.rules) {
    await ctx.call("POST", `${base}/assignment-rules`, r.role
      ? { stepCode: r.step, assignmentType: "role", roleCode: r.role, organizationUnitStrategy: "tenant" }
      : { stepCode: r.step, assignmentType: "specific_user", specificUserSource: "submitter" });
  }
  await ctx.call("POST", `${base}/publish`);
  existing.add(def.code);
  made("workflowDefinition");
}

const SIMPLE_STEPS: { code: string; name: string; type: "task" | "approval" | "end"; initial?: boolean; terminal?: "approved" | "rejected" }[] = [
  { code: "SUBMITTED", name: "Submitted", type: "task", initial: true },
  { code: "APPROVED", name: "Approved", type: "end", terminal: "approved" },
  { code: "REJECTED", name: "Rejected", type: "end", terminal: "rejected" },
];
const SIMPLE_TRANSITIONS: [string, string, string, string][] = [
  ["SUBMITTED", "APPROVED", "approve", "Approve"],
  ["SUBMITTED", "APPROVED", "submit", "Submit"],
  ["SUBMITTED", "APPROVED", "complete", "Complete"],
  ["SUBMITTED", "APPROVED", "award", "Award"],
  ["SUBMITTED", "REJECTED", "reject", "Reject"],
  ["SUBMITTED", "REJECTED", "cancel", "Cancel"],
];

export async function run(ctx: DemoCtx): Promise<void> {
  const t = ctx.tenantId;
  const log = (m: string) => ctx.log(SECTOR, m);
  const as = (key: keyof typeof USERS) => USERS[key];
  const callAs = <T = any>(key: keyof typeof USERS, method: any, url: string, body?: unknown): Promise<T> =>
    ctx.callAs<T>(as(key).email, DEMO_PASSWORD, method, url, body);
  const whU = "warehouse" as const;
  const purU = "purchasing" as const;
  const mgrU = "manager" as const;

  // -- users, org units, warehouses ----------------------------------------
  const uid: Record<string, string> = {};
  for (const k of [whU, purU, mgrU] as const) uid[k] = (await callAs(k, "GET", "/me")).userId;
  const orgs = await ctx.call<any[]>("GET", "/organization-units");
  const org = (name: string) => orgs.find((o) => o.name === name)?.id as string | undefined;
  const orgCatering = org("Catering Operations");
  const orgWarehouse = org("Warehouse & Logistics");
  const orgFacility = org("Facility Services");

  const whList = await ctx.call<any[]>("GET", "/wms/warehouses");
  const wh: Record<WarehouseKey, string> = { FOOD: whList.find((w) => w.code === "WH-FOOD").id, GENERAL: whList.find((w) => w.code === "WH-GEN").id };
  const locId = new Map<string, string>(); // `${whKey}:${locCode}`
  for (const w of WAREHOUSES) {
    const locs = await ctx.call<any[]>("GET", `/wms/warehouse-locations?warehouseId=${wh[w.key]}`);
    for (const l of locs) locId.set(`${w.key}:${l.code}`, l.id);
  }
  const items = await ctx.call<any[]>("GET", "/items");
  const itemId = new Map<string, string>(items.map((x) => [x.code, x.id]));
  const suppliers = await ctx.call<any[]>("GET", "/suppliers");
  const supplierId = new Map<string, string>(suppliers.map((x) => [x.code, x.id]));
  const supKeyByCode = new Map(SUPPLIERS.map((s) => [s.code, s.key]));
  void supKeyByCode;

  // -- 0. workflows ---------------------------------------------------------
  const wfExisting = new Set((await ctx.sql(`SELECT code FROM workflow_definitions WHERE tenant_id = $1`, [t])).map((r) => r.code as string));
  await ensureWorkflow(ctx, wfExisting, {
    code: "purchase_request_approval", name: "Persetujuan Purchase Request", entityType: "purchase_request",
    steps: [
      { code: "DRAFT", name: "Draft", type: "task", initial: true },
      { code: "REVIEW", name: "Review Manajer", type: "approval" },
      { code: "APPROVED", name: "Approved", type: "end", terminal: "approved" },
      { code: "REJECTED", name: "Rejected", type: "end", terminal: "rejected" },
    ],
    transitions: [
      ["DRAFT", "REVIEW", "submit", "Ajukan"],
      ["DRAFT", "REJECTED", "cancel", "Batalkan"],
      ["REVIEW", "APPROVED", "approve", "Setujui"],
      ["REVIEW", "REJECTED", "reject", "Tolak"],
    ],
    rules: [{ step: "DRAFT", role: "PURCHASING_OPS" }, { step: "REVIEW", role: "OPS_MANAGER" }],
  });
  for (const [code, name] of [
    ["scm_rfq", "RFQ dan Tender"], ["scm_stock_opname", "Stock Opname"], ["scm_stock_transfer", "Transfer Stok"],
    ["scm_supplier_evaluation", "Evaluasi Pemasok"], ["scm_supplier_contract", "Kontrak Pemasok"],
    ["scm_inventory_disposal", "Pemusnahan Persediaan"],
  ] as const) {
    await ensureWorkflow(ctx, wfExisting, { code, name, entityType: code, steps: SIMPLE_STEPS, transitions: SIMPLE_TRANSITIONS, rules: [{ step: "SUBMITTED" }] });
  }

  // -- 1. simulate ----------------------------------------------------------
  const wmsBal = await ctx.call<any[]>("GET", "/wms/balances");
  const itemCodeById = new Map(items.map((x) => [x.id as string, x.code as string]));
  const startStock = new Map<string, number>();
  for (const b of wmsBal) {
    if (b.stockCondition !== "unrestricted") continue;
    const code = itemCodeById.get(b.itemId);
    if (code) startStock.set(code, (startStock.get(code) ?? 0) + Number(b.quantity));
  }
  // The sim must be independent of what was already booked by an earlier run:
  // use the opening quantities of the catalogue (identical to the opening ledger).
  const openingStart = new Map<string, number>(ITEMS.map((i) => [i.code, i.openingQty]));
  void startStock;
  const sim = simulate(ctx, openingStart);
  const today = ctx.cal.today;
  const liveOrders = sim.orders.filter((o) => o.date <= today);
  log(`simulation: ${liveOrders.length} orders (${liveOrders.filter((o) => o.cancelled).length} cancelled), ${sim.issues.length} issue bookings`);

  // -- 2. existing documents (idempotency) --------------------------------
  const poRows = await ctx.sql(
    `SELECT po.id, po.order_number, po.order_date::text AS order_date, po.issued_at, po.cancelled_at, s.code AS supplier_code
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = $1`, [t]);
  const poState = new Map<string, PoState>();
  const poByKey = new Map<string, any>();
  for (const r of poRows) poByKey.set(`${r.supplier_code}@${r.order_date}`, r);
  const prRows = await ctx.sql(`SELECT id, request_number, justification FROM purchase_requests WHERE tenant_id = $1 AND justification LIKE '%[k:%'`, [t]);
  const prByKey = new Map<string, any>();
  for (const r of prRows) { const m = /\[k:([^\]]+)\]/.exec(r.justification); if (m) prByKey.set(m[1], r); }
  const coreKeys = new Set<string>((await ctx.sql(`SELECT note FROM stock_movements WHERE tenant_id = $1 AND note LIKE '%[k:%'`, [t])).map((r) => /\[k:([^\]]+)\]/.exec(r.note)?.[1] ?? ""));
  const wmsKeys = new Set<string>((await ctx.sql(`SELECT notes FROM scm_advanced_stock_movements WHERE tenant_id = $1 AND notes LIKE '%[k:%'`, [t])).map((r) => /\[k:([^\]]+)\]/.exec(r.notes)?.[1] ?? ""));

  async function loadPo(key: string): Promise<PoState | null> {
    const cached = poState.get(key);
    if (cached) return cached;
    const row = poByKey.get(key);
    if (!row) return null;
    const lines = await ctx.sql(`SELECT l.id, i.code, o.supplier_id FROM purchase_order_lines l JOIN items i ON i.id = l.item_id JOIN purchase_orders o ON o.id = l.purchase_order_id WHERE l.purchase_order_id = $1`, [row.id]);
    const st: PoState = { id: row.id, number: row.order_number, supplierId: lines[0]?.supplier_id ?? supplierId.get(row.supplier_code)!, lineIds: new Map(lines.map((l) => [l.code, l.id])), issued: !!row.issued_at };
    poState.set(key, st);
    return st;
  }

  // -- 3. build event list --------------------------------------------------
  const events: Ev[] = [];
  let seq = 0;
  const push = (date: string, prio: number, label: string, run: () => Promise<void>) => {
    if (date > today) return;
    events.push({ date, prio, seq: seq++, label, run });
  };
  const errors: string[] = [];
  const bump = (k: string) => made(k);
  const wrap = (label: string, fn: () => Promise<void>) => async () => {
    try { await fn(); } catch (e: any) { errors.push(`${label}: ${String(e?.message ?? e).slice(0, 300)}`); }
  };

  const prNarr: Record<SupplierKey, string> = {
    KEMASAN: "Kemasan makanan (kotak nasi, sendok-garpu, gelas)",
    KIMIA: "Bahan kimia kebersihan dan janitorial",
    APD: "Alat pelindung diri karyawan lapangan",
    SPAREPART: "Suku cadang perawatan AC, genset dan exhaust",
    UNGGAS: "", DAGING: "", TELUR: "", SAYUR: "", IKAN: "", BERAS: "", SEMBAKO: "", AIR: "", BUMBU: "",
  };

  // Documents tracked for backdating
  const poDates = new Map<string, { po: string; order: string; issueDate: string }>();
  const prInfo = new Map<string, { id: string; date: string; approveDate: string; rejected?: boolean }>();

  // --- 3a. purchase requests (rejected / pending extras) ---
  const extraPrs: { tag: string; date: string; org: string | undefined; just: string; req: string; lines: { itemCode: string; quantity: number; note?: string }[]; fate: "rejected" | "pending" | "draft" | "approved_noPO" }[] = [
    { tag: "X1", date: "2026-01-14", org: orgCatering, just: "Pembelian kompor gas 2 tungku tambahan untuk dapur pusat", req: "2026-01-30", lines: [{ itemCode: "SPR-MCB", quantity: 40, note: "Termasuk instalasi listrik" }], fate: "rejected" },
    { tag: "X2", date: "2026-04-22", org: orgFacility, just: "Stok sepatu safety cadangan 100 pasang di luar anggaran APD tahunan", req: "2026-05-10", lines: [{ itemCode: "PPE-SEPATU", quantity: 100 }], fate: "rejected" },
    { tag: "X3", date: "2026-09-02", org: orgWarehouse, just: "Permintaan oli genset tambahan menjelang musim hujan (genset cadangan gudang)", req: "2026-09-20", lines: [{ itemCode: "SPR-OLI-GENSET", quantity: 4 }], fate: "approved_noPO" },
    { tag: "X4", date: "2026-11-03", org: orgFacility, just: "Disinfektan konsentrat tambahan untuk program sanitasi site pelanggan baru", req: "2026-11-14", lines: [{ itemCode: "CLN-DISINFEKTAN", quantity: 60 }, { itemCode: "SABUN-TANGAN", quantity: 40 }], fate: "pending" },
    { tag: "X5", date: "2026-11-06", org: orgCatering, just: "Penambahan stok kotak snack untuk event akhir tahun pelanggan", req: "2026-11-25", lines: [{ itemCode: "BOX-SNACK", quantity: 6000 }], fate: "pending" },
    { tag: "X6", date: "2026-11-08", org: orgWarehouse, just: "Penggantian filter AC gudang dan ruang kantor (draft, menunggu kuotasi)", req: "2026-11-28", lines: [{ itemCode: "SPR-FILTER-AC", quantity: 24 }], fate: "draft" },
  ];
  for (const x of extraPrs) {
    push(x.date, 0, `PR ${x.tag}`, wrap(`PR ${x.tag}`, async () => {
      const key = `extra-${x.tag}`;
      if (prByKey.has(key)) return;
      const body = { organizationUnitId: x.org ?? null, justification: `${x.just} [k:${key}]`, requiredDate: x.req, lines: x.lines };
      const view = await callAs(purU, "POST", "/purchase-requests", body);
      const id = view.request.id;
      let rejected = false;
      if (x.fate !== "draft") {
        await callAs(purU, "POST", `/purchase-requests/${id}/actions/submit`, { comment: "Mohon persetujuan pembelian" });
        if (x.fate === "rejected") { await callAs(mgrU, "POST", `/purchase-requests/${id}/actions/reject`, { comment: "Di luar anggaran periode berjalan, mohon ajukan di anggaran berikutnya" }); rejected = true; }
        else if (x.fate === "approved_noPO") await callAs(mgrU, "POST", `/purchase-requests/${id}/actions/approve`, { comment: "Disetujui" });
      }
      prByKey.set(key, { id, request_number: view.request.requestNumber, justification: key });
      prInfo.set(key, { id, date: x.date, approveDate: addDays(x.date, 1), rejected });
      bump(`purchaseRequest.${x.fate}`);
    }));
  }

  // --- 3b. orders ---
  for (const o of liveOrders) {
    const wkey = ITEMS.find((i) => i.code === o.lines[0].item.code)!.warehouse;
    const warehouseId = wh[wkey];
    // PR + PO + issue
    push(o.date, 1, `PO ${o.key}`, wrap(`PO ${o.key}`, async () => {
      let st = await loadPo(o.key);
      if (!st) {
        let prId: string | null = null;
        const prKey = `order-${o.key}`;
        if (o.viaPr) {
          const known = prByKey.get(prKey);
          if (known) prId = known.id;
          else {
            const orgId = o.supplier === "SPAREPART" ? orgFacility : o.supplier === "KEMASAN" ? orgCatering : o.supplier === "APD" ? orgFacility : orgWarehouse;
            const view = await callAs(purU, "POST", "/purchase-requests", {
              organizationUnitId: orgId ?? null,
              justification: `Replenishment ${prNarr[o.supplier]} — stok mendekati titik pesan ulang [k:${prKey}]`,
              requiredDate: o.expected,
              lines: o.lines.map((l) => ({ itemCode: l.item.code, quantity: l.qty, note: `Harga acuan Rp ${l.price.toLocaleString("id-ID")}/${l.item.unit}` })),
            });
            prId = view.request.id;
            await callAs(purU, "POST", `/purchase-requests/${prId}/actions/submit`, { comment: "Stok di bawah titik pesan ulang" });
            await callAs(mgrU, "POST", `/purchase-requests/${prId}/actions/approve`, { comment: "Disetujui sesuai anggaran" });
            prByKey.set(prKey, { id: prId, request_number: view.request.requestNumber });
            prInfo.set(prKey, { id: prId!, date: o.prDate, approveDate: addDays(o.prDate, 1) });
            bump("purchaseRequest.approved");
          }
        }
        const view = await callAs(purU, "POST", "/purchase-orders", {
          supplierCode: o.supplierCode,
          ...(prId ? { purchaseRequestId: prId } : {}),
          currency: "IDR",
          orderDate: o.date,
          expectedDate: o.expected,
          lines: o.lines.map((l) => ({ itemCode: l.item.code, quantity: l.qty, unitPrice: l.price })),
        });
        const po = view.order;
        poByKey.set(o.key, { id: po.id, order_number: po.orderNumber, order_date: o.date, issued_at: null, cancelled_at: null, supplier_code: o.supplierCode });
        poDates.set(o.key, { po: po.id, order: o.date, issueDate: o.date });
        bump("purchaseOrder");
        st = (await loadPo(o.key))!;
      }
      if (!st.issued) {
        await callAs(purU, "POST", `/purchase-orders/${st.id}/issue`, {});
        st.issued = true;
        bump("purchaseOrder.issued");
      }
      const row = poByKey.get(o.key);
      if (o.cancelled && !row?.cancelled_at) {
        await callAs(purU, "POST", `/purchase-orders/${st.id}/cancel`, { reason: o.cancelled });
        row.cancelled_at = "x";
        bump("purchaseOrder.cancelled");
      }
    }));

    // deliveries
    for (const d of o.deliveries) {
      const grnKey = `dsc-grn:${o.key}:${d.idx}`;
      push(d.date, 2, `GRN ${grnKey}`, wrap(`GRN ${grnKey}`, async () => {
        const st = await loadPo(o.key);
        if (!st) throw new Error("PO missing");
        const lines = d.lines.filter((l) => l.recv > 0).map((l) => {
          const spec = ITEMS.find((i) => i.code === l.itemCode)!;
          const price = o.lines.find((x) => x.item.code === l.itemCode)!.price;
          return {
            purchaseOrderLineId: st.lineIds.get(l.itemCode)!, itemId: itemId.get(l.itemCode)!, warehouseId,
            locationId: locId.get(`${spec.warehouse}:${spec.location}`)!, quantityReceived: l.recv, unitCost: price,
            accountAssignmentType: "stock" as const, inspectionRequired: true,
            notes: d.idx > 0 ? "Pengiriman susulan" : o.late ? "Terlambat dari jadwal, sopir menyampaikan kendala lalu lintas" : undefined,
          };
        });
        const before = await ctx.sql(`SELECT 1 FROM scm_receiving_records WHERE tenant_id = $1 AND idempotency_key = $2`, [t, grnKey]);
        await callAs(whU, "POST", "/wms/receiving-records", {
          idempotencyKey: grnKey, purchaseOrderId: st.id, supplierId: st.supplierId, warehouseId,
          receivedAt: iso(d.date, 8 + (d.idx % 3), 15), receivedBy: uid[whU],
          notes: `Penerimaan barang ${o.supplier === "SPAREPART" ? "suku cadang" : "dari " + SUPPLIERS.find((s) => s.key === o.supplier)!.name}${o.late ? " (terlambat)" : ""}`,
          lines,
        });
        if (before.length === 0) bump("receivingRecord");
      }));

      push(d.inspectDate, 3, `QC ${grnKey}`, wrap(`QC ${grnKey}`, async () => {
        const st = await loadPo(o.key);
        if (!st) throw new Error("PO missing");
        const recLines = await ctx.sql(
          `SELECT l.id, i.code, r.id AS record_id FROM scm_receiving_lines l JOIN scm_receiving_records r ON r.id = l.receiving_record_id JOIN items i ON i.id = l.item_id WHERE r.tenant_id = $1 AND r.idempotency_key = $2`,
          [t, grnKey]);
        for (const l of d.lines) {
          const rl = recLines.find((x) => x.code === l.itemCode);
          if (!rl || l.recv <= 0) continue;
          const spec = ITEMS.find((i) => i.code === l.itemCode)!;
          const warehouseId = wh[spec.warehouse];
          const price = o.lines.find((x) => x.item.code === l.itemCode)!.price;
          const insKey = `dsc-insp:${grnKey}:${l.itemCode}`;
          const had = await ctx.sql(`SELECT 1 FROM scm_inspections WHERE tenant_id = $1 AND idempotency_key = $2`, [t, insKey]);
          const result = l.rej === 0 && l.quar === 0 ? "accepted" : l.acc === 0 ? (l.rej > 0 ? "rejected" : "quarantined") : "mixed";
          const reason = l.rej > 0 ? (spec.perishable ? "Sebagian tidak segar / suhu penerimaan di atas batas" : "Kemasan rusak / tidak sesuai spesifikasi")
            : l.quar > 0 ? "Menunggu konfirmasi mutu dari pemasok (sampel dikirim ke QC)" : null;
          const inspectAt = iso(d.inspectDate, 10, 30);
          await callAs(whU, "POST", "/wms/inspections", {
            receivingLineId: rl.id, idempotencyKey: insKey, inspectedAt: inspectAt, inspectedBy: uid[whU],
            quantityAccepted: l.acc, quantityRejected: l.rej, quantityQuarantined: l.quar, result, reason,
          });
          if (had.length === 0) bump("inspection");

          // core ledger mirror (accepted quantity only)
          const ck = `core-in:${grnKey}:${l.itemCode}`;
          if (l.acc > 0 && !coreKeys.has(ck)) {
            const r = await callAs(whU, "POST", "/stock/goods-in", {
              itemCode: l.itemCode, quantity: l.acc, reference: st.number, note: `Penerimaan ${st.number} / ${grnKey.split(":").pop()} [k:${ck}]`,
            });
            await ctx.sql(`UPDATE stock_movements SET occurred_at = $2::timestamptz, created_at = $2::timestamptz WHERE id = $1`, [r.movement.id, inspectAt]);
            coreKeys.add(ck);
            bump("coreStockIn");
          }

          // discrepancies and returns
          const discKey = (type: string) => ctx.sql(`SELECT id FROM scm_discrepancy_records WHERE tenant_id = $1 AND receiving_line_id = $2 AND discrepancy_type = $3`, [t, rl.id, type]);
          const mkDisc = async (type: "shortage" | "quality" | "damage", qty: number, desc: string, resolution: string | null) => {
            if ((await discKey(type)).length > 0) return;
            const dr = await callAs(whU, "POST", "/wms/discrepancies", { receivingLineId: rl.id, discrepancyType: type, quantity: qty, description: desc });
            bump(`discrepancy.${type}`);
            await ctx.sql(`UPDATE scm_discrepancy_records SET created_at = $2::timestamptz WHERE id = $1`, [dr.id, inspectAt]);
            if (resolution) {
              await callAs(whU, "PATCH", `/wms/discrepancies/${dr.id}/resolve`, { status: "resolved", resolvedAt: iso(addDays(d.inspectDate, 2), 14), resolvedBy: uid[purU], resolutionNotes: resolution });
              bump("discrepancy.resolved");
            }
          };
          if (l.short > 0) await mkDisc("shortage", l.short, `Kuantitas diterima ${l.short} ${spec.unit} lebih sedikit dari surat jalan/PO`, "Pemasok menerbitkan nota kredit untuk selisih kuantitas");
          if (l.rej > 0) await mkDisc(spec.perishable ? "quality" : "damage", l.rej, `${l.rej} ${spec.unit} ${spec.name} ditolak saat inspeksi: ${reason}`, "Barang diretur ke pemasok, penggantian mengikuti nota retur");
          if (l.quar > 0) await mkDisc("quality", l.quar, `${l.quar} ${spec.unit} ${spec.name} ditahan (karantina) menunggu hasil uji mutu`, null);

          if (l.rej > 0) {
            const rtvKey = `dsc-rtv:${grnKey}:${l.itemCode}`;
            const have = await ctx.sql(`SELECT id FROM scm_return_to_vendors WHERE tenant_id = $1 AND idempotency_key = $2`, [t, rtvKey]);
            if (have.length === 0) {
              const retAt = iso(addDays(d.inspectDate, 1 + (dow(addDays(d.inspectDate, 1)) === 0 ? 1 : 0)), 15);
              if (retAt.slice(0, 10) <= new Date().toISOString().slice(0, 10)) {
                await callAs(whU, "POST", "/wms/returns-to-vendor", {
                  idempotencyKey: rtvKey, supplierId: st.supplierId, purchaseOrderId: st.id, warehouseId,
                  returnedAt: retAt, returnedBy: uid[whU], reason: `Retur barang tidak lolos inspeksi: ${reason}`,
                  notes: `Retur ${l.rej} ${spec.unit} ${spec.name} dari ${st.number}`,
                  lines: [{ receivingLineId: rl.id, itemId: itemId.get(l.itemCode)!, warehouseId, locationId: locId.get(`${spec.warehouse}:${spec.location}`)!, stockCondition: "rejected", ownerType: "own", quantity: l.rej }],
                });
                bump("returnToVendor");
                void price;
              }
            }
          }
        }
      }));
    }
  }

  // --- 3c. stock issues ---
  for (const e of sim.issues) {
    if (e.date > today) continue;
    const key = `iss:${e.item.code}:${e.date}`;
    push(e.date, 5, key, wrap(key, async () => {
      if (wmsKeys.has(key) && coreKeys.has(key)) return;
      const spec = e.item;
      const usage = spec.grade === "food" ? "Pemakaian produksi katering harian (Dapur Pusat dan site pelanggan)"
        : spec.category === "Kemasan" ? "Pemakaian kemasan produksi katering"
        : spec.category === "Kimia Kebersihan" ? "Pemakaian bahan cleaning service dan sanitasi site"
        : spec.category === "APD" ? "Distribusi APD ke karyawan lapangan"
        : "Pemakaian suku cadang pemeliharaan fasilitas";
      const ref = `PAKAI-${e.date.replace(/-/g, "").slice(2)}-${spec.code}`;
      const at = iso(e.date, 16, 30);
      if (!wmsKeys.has(key)) {
        await callAs(whU, "POST", "/wms/movements", {
          itemId: itemId.get(spec.code)!, warehouseId: wh[spec.warehouse], locationId: locId.get(`${spec.warehouse}:${spec.location}`)!,
          movementType: "out", quantity: e.qty, unitCost: spec.unitCost,
          referenceType: spec.grade === "food" ? "production_issue" : "consumable_issue", referenceNumber: ref,
          notes: `${usage} [k:${key}]`, occurredAt: at,
        });
        wmsKeys.add(key);
        bump("stockIssue.wms");
      }
      if (!coreKeys.has(key)) {
        const r = await callAs(whU, "POST", "/stock/goods-out", { itemCode: spec.code, quantity: e.qty, reference: ref, note: `${usage} [k:${key}]` });
        await ctx.sql(`UPDATE stock_movements SET occurred_at = $2::timestamptz, created_at = $2::timestamptz WHERE id = $1`, [r.movement.id, at]);
        coreKeys.add(key);
        bump("stockIssue.core");
      }
    }));
  }

  // --- 3d. RFQs ---
  const rfqState = new Map<number, { id: string; bids: Map<string, string> }>();
  for (const r of RFQS) {
    push(r.date, 1, `RFQ ${r.idx}`, wrap(`RFQ ${r.idx}`, async () => {
      const tag = `[SC-RFQ-${r.idx}]`;
      let existing = (await ctx.sql(`SELECT id FROM scm_rfqs WHERE tenant_id = $1 AND notes LIKE $2`, [t, `%${tag}%`]))[0];
      let rfqId = existing?.id as string | undefined;
      if (!rfqId) {
        const rfqItems = r.items.map((x, n) => {
          const spec = ITEMS.find((i) => i.code === x.code)!;
          return { itemId: itemId.get(x.code)!, targetQuantity: x.qty, targetUnitPrice: spec.unitCost, specifications: spec.name, sortOrder: n };
        });
        const view = await callAs(purU, "POST", "/procurement/rfqs", {
          title: r.title, procurementType: r.idx === 5 ? "tender" : "rfq", organizationUnitId: orgWarehouse ?? null,
          submissionDeadline: iso(r.deadline, 17), notes: `${r.notes} ${tag}`, items: rfqItems,
          invitedSuppliers: r.bidders.map((b) => ({ supplierId: supplierId.get(SUPPLIERS.find((s) => s.key === b.key)!.code)! })),
        });
        rfqId = view.rfq.id;
        bump("rfq");
        const rfqItemRows = view.items as any[];
        const bidIds = new Map<string, string>();
        for (const b of r.bidders) {
          const sup = SUPPLIERS.find((s) => s.key === b.key)!;
          const lines = r.items.map((x) => {
            const spec = ITEMS.find((i) => i.code === x.code)!;
            const price = roundPrice(spec.unitCost * b.factor);
            const ri = rfqItemRows.find((q) => q.itemId === itemId.get(x.code))!;
            return { rfqItemId: ri.id, offeredQuantity: x.qty, offeredUnitPrice: price, offeredTotalPrice: price * x.qty };
          });
          const bid = await callAs(purU, "POST", "/procurement/bids", {
            rfqId, supplierId: supplierId.get(sup.code)!, currency: "IDR",
            totalAmount: lines.reduce((s, l) => s + l.offeredTotalPrice, 0), leadTimeDays: b.lead,
            validUntil: addDays(r.deadline, 30), notes: `Penawaran ${sup.name}`, lines,
          });
          bidIds.set(b.key, bid.bid.id);
          bump("rfqBid");
        }
        // scoring (rank by combined score)
        const ranked = [...r.bidders].sort((a, b) => (b.tech + b.comm) - (a.tech + a.comm));
        for (const b of r.bidders) {
          const rank = ranked.findIndex((x) => x.key === b.key) + 1;
          await callAs(purU, "PATCH", `/procurement/bids/${bidIds.get(b.key)}/score`, {
            technicalScore: b.tech, commercialScore: b.comm, rank,
            status: r.awardDate ? (rank === 1 ? "shortlisted" : "evaluated") : "submitted",
          });
        }
        rfqState.set(r.idx, { id: rfqId!, bids: bidIds });
        // timestamps
        await ctx.sql(`UPDATE scm_rfqs SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1`, [rfqId, iso(r.date, 9)]);
        await ctx.sql(`UPDATE scm_supplier_bids SET submitted_at = $2::timestamptz + (random() * interval '3 days'), created_at = $2::timestamptz + interval '1 day', updated_at = $3::timestamptz WHERE rfq_id = $1`,
          [rfqId, iso(addDays(r.date, 1), 11), iso(addDays(r.date, 6), 16)]);
      }
    }));
    if (r.awardDate) {
      // award happens when the resulting PO is created (day after award + 3)
      const poDate = nextWorkday(addDays(r.awardDate, 3));
      push(poDate, 2, `RFQ award ${r.idx}`, wrap(`RFQ award ${r.idx}`, async () => {
        const key = `${SUPPLIERS.find((s) => s.key === r.supplier)!.code}@${poDate}`;
        const st = await loadPo(key);
        if (!st) throw new Error("award PO missing");
        const rfq = (await ctx.sql(`SELECT id, status FROM scm_rfqs WHERE tenant_id = $1 AND notes LIKE $2`, [t, `%[SC-RFQ-${r.idx}]%`]))[0];
        if (!rfq || rfq.status === "closed") return;
        const winBid = (await ctx.sql(`SELECT b.id, b.status FROM scm_supplier_bids b WHERE b.rfq_id = $1 AND b.supplier_id = $2`, [rfq.id, st.supplierId]))[0];
        if (winBid && winBid.status !== "awarded") {
          await callAs(purU, "POST", "/procurement/bids/award", { bidId: winBid.id, resultingPurchaseOrderId: st.id });
          bump("rfqAward");
        }
        // rejected losers
        await ctx.sql(`UPDATE scm_supplier_bids SET status = 'rejected' WHERE rfq_id = $1 AND status IN ('evaluated','submitted')`, [rfq.id]);
        await callAs(purU, "POST", `/procurement/rfqs/${rfq.id}/act`, { actionCode: "award", comment: "Pemenang tender ditetapkan, PO diterbitkan" });
        await ctx.sql(`UPDATE scm_rfqs SET awarded_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1`, [rfq.id, iso(r.awardDate!, 15)]);
        await ctx.sql(`UPDATE scm_supplier_bids SET updated_at = $2::timestamptz WHERE rfq_id = $1`, [rfq.id, iso(r.awardDate!, 15)]);
      }));
    }
  }

  // -- 4. replay events ---------------------------------------------------------
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.prio !== b.prio ? a.prio - b.prio : a.seq - b.seq));
  log(`replaying ${events.length} events`);
  const t0 = Date.now();
  let n = 0;
  for (const ev of events) {
    await ev.run();
    n++;
    if (n % 400 === 0) log(`  ... ${n}/${events.length} (${((Date.now() - t0) / 1000).toFixed(0)}s) up to ${ev.date}`);
  }
  if (errors.length) {
    log(`${errors.length} event errors (first 12):`);
    for (const e of errors.slice(0, 12)) log("  ! " + e);
  }

  // -- 5. periodic documents and finishing -----------------------------------------
  await laterPhases(ctx, { callAs, uid, wh, locId, itemId, supplierId, orgWarehouse, orgFacility, orgCatering, sim, liveOrders, loadPo, poByKey, coreKeys, wmsKeys, errors });

  // -- 6. backdating ------------------------------------------------------------
  await backdate(ctx, liveOrders, prByKey);

  log("summary: " + JSON.stringify(count));
  if (errors.length) log(`total event errors: ${errors.length}`);
}

// ---------------------------------------------------------------------------
// later phases: evaluations, contracts, opname, disposal, landed cost, analytics, FIFO
// ---------------------------------------------------------------------------

async function laterPhases(ctx: DemoCtx, c: any): Promise<void> {
  const t = ctx.tenantId;
  const log = (m: string) => ctx.log(SECTOR, m);
  const { callAs, uid, wh, locId, itemId, supplierId } = c;
  const coreKeys: Set<string> = c.coreKeys;
  const errors: string[] = c.errors;
  const guard = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e: any) { errors.push(`${label}: ${String(e?.message ?? e).slice(0, 300)}`); log(`! ${label}: ${String(e?.message ?? e).slice(0, 200)}`); }
  };
  const today = ctx.cal.today;

  // -- supplier evaluations (quarterly) from the simulated delivery record --
  await guard("evaluations", async () => {
    const quarters = [
      { name: "Q4-2025 (Nov-Des)", from: "2025-11-09", to: "2025-12-31" },
      { name: "Q1-2026", from: "2026-01-01", to: "2026-03-31" },
      { name: "Q2-2026", from: "2026-04-01", to: "2026-06-30" },
      { name: "Q3-2026", from: "2026-07-01", to: "2026-09-30" },
    ];
    const evaluated: SupplierKey[] = ["BERAS", "UNGGAS", "DAGING", "TELUR", "SAYUR", "IKAN", "SEMBAKO", "KEMASAN", "KIMIA", "SPAREPART"];
    const done = await ctx.sql(`SELECT supplier_id, evaluation_period FROM scm_supplier_evaluations WHERE tenant_id = $1`, [t]);
    const have = new Set(done.map((r) => `${r.supplier_id}|${r.evaluation_period}`));
    for (const q of quarters) {
      for (const sk of evaluated) {
        const sup = SUPPLIERS.find((s) => s.key === sk)!;
        const sid = supplierId.get(sup.code)!;
        if (have.has(`${sid}|${q.name}`)) continue;
        const ords = (c.liveOrders as Order[]).filter((o) => o.supplier === sk && !o.cancelled && o.date >= q.from && o.date <= q.to && o.deliveries.length > 0);
        if (ords.length === 0) continue;
        const late = ords.filter((o) => o.late).length / ords.length;
        let recv = 0, rej = 0;
        for (const o of ords) for (const d of o.deliveries) for (const l of d.lines) { recv += l.recv; rej += l.rej + l.quar; }
        const rejRate = recv ? rej / recv : 0;
        const quality = Math.max(40, Math.min(99, Math.round(100 - rejRate * 400)));
        const delivery = Math.max(40, Math.min(99, Math.round(100 - late * 120)));
        const pricing = 78 + ((sup.code.charCodeAt(5) * 7 + q.name.length) % 15);
        const service = 76 + ((sup.code.charCodeAt(6) * 5 + q.name.length) % 18);
        const ev = await callAs("purchasing", "POST", "/procurement/evaluations", {
          supplierId: sid, evaluationPeriod: q.name, periodStartDate: q.from, periodEndDate: q.to,
          qualityScore: quality, deliveryScore: delivery, pricingScore: pricing, serviceScore: service,
          notes: `${ords.length} pesanan, ${(late * 100).toFixed(0)}% terlambat, tingkat penolakan ${(rejRate * 100).toFixed(1)}%.`,
        });
        const id = ev.evaluation.id;
        await callAs("purchasing", "POST", `/procurement/evaluations/${id}/act`, { actionCode: "approve", comment: "Hasil evaluasi disetujui" });
        const ts = iso(addDays(q.to, 5 > 0 ? 6 : 0) > iso(today, 0) ? today : addDays(q.to, 6), 11);
        await ctx.sql(`UPDATE scm_supplier_evaluations SET created_at = $2::timestamptz, updated_at = $2::timestamptz, evaluated_at = $2::timestamptz WHERE id = $1`, [id, ts]).catch(() => undefined);
        made("supplierEvaluation");
      }
    }
  });

  // -- supplier contracts ------------------------------------------------------
  await guard("contracts", async () => {
    const specs: { sup: SupplierKey; title: string; type: "blanket_po" | "fixed_price" | "service_rate" | "consignment"; start: string; end: string; committed: number; codes: string[]; created: string }[] = [
      { sup: "BERAS", title: "Perjanjian Pasokan Beras Premium 2026", type: "blanket_po", start: "2026-01-01", end: "2026-12-31", committed: 1_450_000_000, codes: ["RICE"], created: "2025-12-18" },
      { sup: "UNGGAS", title: "Perjanjian Harga Tetap Ayam Potong Semester I-2026", type: "fixed_price", start: "2026-01-01", end: "2026-06-30", committed: 950_000_000, codes: ["AYAM"], created: "2025-12-20" },
      { sup: "KEMASAN", title: "Kontrak Pasokan Kemasan Makanan 2026", type: "blanket_po", start: "2026-03-01", end: "2027-02-28", committed: 420_000_000, codes: ["BOX-NASI", "SENDOK-GARPU", "GELAS-CUP", "BOX-SNACK"], created: "2026-02-26" },
      { sup: "SEMBAKO", title: "Kontrak Sembako (Minyak, Gula, Tepung) 2026", type: "blanket_po", start: "2026-02-01", end: "2027-01-31", committed: 600_000_000, codes: ["MINYAK", "GULA", "TEPUNG", "GARAM"], created: "2026-01-27" },
    ];
    for (const s of specs) {
      const sup = SUPPLIERS.find((x) => x.key === s.sup)!;
      const sid = supplierId.get(sup.code)!;
      const ex = await ctx.sql(`SELECT id FROM scm_supplier_contracts WHERE tenant_id = $1 AND supplier_id = $2 AND title = $3`, [t, sid, s.title]);
      if (ex.length) continue;
      const view = await callAs("purchasing", "POST", "/procurement/contracts", {
        supplierId: sid, title: s.title, contractType: s.type, startDate: s.start, endDate: s.end, currency: "IDR", committedAmount: s.committed,
        termsAndConditions: "Pembayaran sesuai termin pemasok, harga ditinjau ulang tiap kuartal, denda keterlambatan 0,5% per hari.",
        items: s.codes.map((code) => ({ itemId: itemId.get(code)!, agreedUnitPrice: ITEMS.find((i) => i.code === code)!.unitCost, minOrderQuantity: 1, leadTimeDays: ITEMS.find((i) => i.code === code)!.leadTimeDays })),
      });
      const id = view.contract.id;
      await callAs("purchasing", "POST", `/procurement/contracts/${id}/act`, { actionCode: "approve", comment: "Kontrak disetujui manajemen" });
      // spend recorded so far under this contract
      const spent = (c.liveOrders as Order[]).filter((o) => o.supplier === s.sup && !o.cancelled && o.date >= s.start && o.date <= s.end)
        .reduce((a, o) => a + o.lines.filter((l) => s.codes.includes(l.item.code)).reduce((x, l) => x + l.qty * l.price, 0), 0);
      if (spent > 0) await callAs("purchasing", "POST", `/procurement/contracts/${id}/spend`, { additionalSpentAmount: Math.min(Math.round(spent), s.committed * 0.95) });
      await ctx.sql(`UPDATE scm_supplier_contracts SET created_at = $2::timestamptz, updated_at = $2::timestamptz, approved_at = $2::timestamptz WHERE id = $1`, [id, iso(s.created, 10)]).catch(() => undefined);
      made("supplierContract");
    }
  });

  // -- stock counts (opname) --------------------------------------------------------
  await guard("opname", async () => {
    const plan: { whKey: WarehouseKey; date: string; variance: boolean; leaveOpen?: boolean }[] = [
      { whKey: "FOOD", date: "2026-01-31", variance: false }, { whKey: "GENERAL", date: "2026-01-31", variance: false },
      { whKey: "FOOD", date: "2026-04-30", variance: false }, { whKey: "GENERAL", date: "2026-04-30", variance: false },
      { whKey: "FOOD", date: "2026-07-31", variance: false }, { whKey: "GENERAL", date: "2026-07-31", variance: false },
      { whKey: "FOOD", date: "2026-11-07", variance: true }, { whKey: "GENERAL", date: "2026-11-07", variance: true },
      { whKey: "FOOD", date: "2026-11-09", variance: false, leaveOpen: true },
    ];
    for (const p of plan) {
      const tag = `[SC-OPN-${p.whKey}-${p.date}]`;
      const ex = await ctx.sql(`SELECT id, status, opname_number FROM scm_stock_opnames WHERE tenant_id = $1 AND notes LIKE $2`, [t, `%${tag}%`]);
      let id: string;
      let opnameNumber: string;
      if (ex.length) {
        if (p.leaveOpen) continue;
        id = ex[0].id;
        opnameNumber = ex[0].opname_number;
      } else {
        // the live ledger is the system quantity at the moment of the count
        const bal = await ctx.call<any[]>("GET", `/wms/balances?warehouseId=${wh[p.whKey]}`);
        const rows = bal.filter((b) => b.stockCondition === "unrestricted" && Number(b.quantity) > 0);
        const lines = rows.map((b, n) => {
          const sys = Number(b.quantity);
          let phys = sys;
          if (p.variance && n % 7 === 3) phys = Math.max(0, sys - Math.max(1, Math.round(sys * 0.02)));
          if (p.variance && n % 11 === 5) phys = sys + Math.max(1, Math.round(sys * 0.01));
          return { itemId: b.itemId, locationId: b.locationId, systemQuantity: sys, physicalQuantity: p.leaveOpen ? null : phys, notes: phys !== sys ? "Selisih hasil hitung fisik" : undefined, sortOrder: n };
        });
        if (lines.length === 0) continue;
        const view = await ctx.call("POST", "/wms/opnames", { warehouseId: wh[p.whKey], opnameDate: p.date, notes: `Stock opname ${p.whKey === "FOOD" ? "Gudang Pangan" : "Gudang Umum"} ${p.leaveOpen ? "(sedang berlangsung)" : "periodik"} ${tag}`, lines });
        id = view.opname.id;
        opnameNumber = view.opname.opnameNumber;
      }
      if (!p.leaveOpen) {
        // API quirk: the adjustment pass posts the weighted-average layer cost unrounded, and the ledger refuses
        // more than 4 decimals. Lines of items whose average cost is not clean are counted without variance.
      if (ex.length === 0 || ex[0].status === "in_progress") {
        await ctx.sql(
          `UPDATE scm_stock_opname_lines l SET physical_quantity = l.system_quantity
            WHERE l.opname_id = $1 AND l.physical_quantity IS NOT NULL AND l.physical_quantity <> l.system_quantity
              AND EXISTS (SELECT 1 FROM (SELECT SUM(v.remaining_quantity * v.effective_unit_cost) / NULLIF(SUM(v.remaining_quantity), 0) AS a
                                           FROM scm_valuation_layers v JOIN scm_stock_opnames o ON o.id = l.opname_id
                                          WHERE v.tenant_id = o.tenant_id AND v.item_id = l.item_id AND v.warehouse_id = o.warehouse_id AND v.remaining_quantity > 0) q
                           WHERE q.a IS NOT NULL AND round(q.a, 4) <> q.a)`, [id]);
        // the approval task is assigned to the submitter (the admin account)
        await ctx.call("POST", `/wms/opnames/${id}/act`, { actionCode: "approve", comment: "Hasil hitung fisik disetujui" });
      }
        // mirror variances into the core ledger
        const lineRows = await ctx.sql(`SELECT l.system_quantity, l.physical_quantity, i.code FROM scm_stock_opname_lines l JOIN items i ON i.id = l.item_id WHERE l.opname_id = $1`, [id]);
        for (const l of lineRows) {
          const v = Number(l.physical_quantity) - Number(l.system_quantity);
          if (v === 0) continue;
          const ck = `core-opn:${id}:${l.code}`;
          if (coreKeys.has(ck)) continue;
          const r = await callAs("warehouse", "POST", v > 0 ? "/stock/goods-in" : "/stock/goods-out", { itemCode: l.code, quantity: Math.abs(v), reference: opnameNumber, note: `Penyesuaian stock opname [k:${ck}]` });
          await ctx.sql(`UPDATE stock_movements SET occurred_at = $2::timestamptz, created_at = $2::timestamptz WHERE id = $1`, [r.movement.id, iso(p.date, 17)]);
          coreKeys.add(ck);
          made("coreStockAdjustment");
        }
      }
      const ts = iso(p.date, 9);
      await ctx.sql(`UPDATE scm_stock_opnames SET created_at = $2::timestamptz, updated_at = $3::timestamptz, completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $3::timestamptz END WHERE id = $1`, [id, ts, iso(p.date, 17)]);
      if (ex.length === 0) made(p.leaveOpen ? "stockOpname.open" : "stockOpname.adjusted");
    }
  });

  // -- inventory disposals (expired / damaged), recent ----------------------------------
  await guard("disposals", async () => {
    const plan: { code: string; qty: number; type: "expired" | "write_off" | "scrap"; reason: string; days: number }[] = [
      { code: "SAYUR", qty: 12, type: "expired", reason: "Sayur layu melewati batas simpan chiller", days: 21 },
      { code: "BUAH-PISANG", qty: 9, type: "expired", reason: "Pisang terlalu matang tidak layak disajikan", days: 11 },
      { code: "BOX-SNACK", qty: 180, type: "write_off", reason: "Kotak snack penyok akibat penumpukan di rak", days: 4 },
    ];
    for (const d of plan) {
      const tag = `[SC-DSP-${d.code}]`;
      const ex = await ctx.sql(`SELECT id, status FROM scm_inventory_disposals WHERE tenant_id = $1 AND idempotency_key = $2`, [t, `dsc-dsp:${d.code}`]);
      if (ex.length && ex[0].status !== "draft") continue;
      const spec = ITEMS.find((i) => i.code === d.code)!;
      const bal = await ctx.call<any[]>("GET", `/wms/balances?itemId=${itemId.get(d.code)}&warehouseId=${wh[spec.warehouse]}`);
      const b = bal.find((x) => x.stockCondition === "unrestricted" && Number(x.quantity) >= d.qty);
      if (!b) { log(`skip disposal ${d.code}: not enough stock`); continue; }
      const view = await ctx.call("POST", "/wms/disposals", {
        idempotencyKey: `dsc-dsp:${d.code}`, warehouseId: wh[spec.warehouse], disposalType: d.type, reason: d.reason, notes: `Berita acara pemusnahan ${tag}`,
        lines: [{ itemId: b.itemId, warehouseId: wh[spec.warehouse], locationId: b.locationId, quantity: d.qty, unitCost: spec.unitCost, notes: d.reason }],
      });
      const id = view.disposal.id;
      // approving a draft runs the workflow's submit transition straight to its approved end state
      await ctx.call("POST", `/wms/disposals/${id}/approve`, { comment: "Disetujui, disaksikan petugas QC" });
      const r = await callAs("warehouse", "POST", "/stock/goods-out", { itemCode: d.code, quantity: d.qty, reference: view.disposal.disposalNumber, note: `Pemusnahan persediaan ${d.reason} [k:core-dsp:${d.code}]` });
      void r;
      made("inventoryDisposal");
    }
  });

  // -- landed costs on recent imports/large orders ------------------------------------------
  await guard("landedCosts", async () => {
    const ords = (c.liveOrders as Order[]).filter((o) => !o.cancelled && o.date >= addDays(today, -60) && ["SPAREPART", "KEMASAN", "APD", "DAGING"].includes(o.supplier) && o.deliveries.length > 0 && o.deliveries[0].inspectDate <= today).slice(0, 4);
    for (const o of ords) {
      const st = await c.loadPo(o.key);
      if (!st) continue;
      const ex = await ctx.sql(`SELECT 1 FROM scm_landed_costs WHERE tenant_id = $1 AND purchase_order_id = $2`, [t, st.id]);
      if (ex.length) continue;
      const layers = await ctx.sql(`SELECT l.item_id, l.valuation_layer_id, l.quantity_accepted, l.unit_cost FROM scm_receiving_lines l JOIN scm_receiving_records r ON r.id = l.receiving_record_id WHERE r.purchase_order_id = $1 AND l.valuation_layer_id IS NOT NULL`, [st.id]);
      if (layers.length === 0) continue;
      const base = layers.reduce((s: number, l: any) => s + Number(l.quantity_accepted) * Number(l.unit_cost), 0);
      const amount = Math.max(250_000, Math.round(base * 0.025 / 50_000) * 50_000);
      const totalQty = layers.reduce((s: number, l: any) => s + Number(l.quantity_accepted), 0);
      const lc = await callAs("warehouse", "POST", "/wms/landed-costs", {
        purchaseOrderId: st.id, costType: o.supplier === "DAGING" ? "Biaya kirim berpendingin" : "Ongkos kirim dan asuransi", currency: "IDR", amount, allocationMethod: "by_quantity",
        notes: `Biaya pendukung pembelian ${st.number}`,
        allocations: layers.map((l: any) => {
          const alloc = Math.round(amount * (Number(l.quantity_accepted) / totalQty));
          return { itemId: l.item_id, valuationLayerId: l.valuation_layer_id, allocatedAmount: alloc, costPerUnitAdded: Math.round((alloc / Number(l.quantity_accepted)) * 100) / 100 };
        }),
      });
      await callAs("warehouse", "POST", `/wms/landed-costs/${lc.landedCost.id}/apply`, {});
      made("landedCost");
    }
  });

  // -- spend analytics snapshots (monthly) -------------------------------------------------------
  await guard("spend", async () => {
    for (const m of ctx.cal.months) {
      const [y, mo] = m.split("-").map(Number);
      const from = `${m}-01`;
      const to = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      const end = to > today ? today : to;
      const ex = await ctx.sql(`SELECT 1 FROM scm_spend_analytics_snapshots WHERE tenant_id = $1 AND period_type = 'monthly' AND period_key = $2`, [t, `${from}_${end}`]);
      if (ex.length) continue;
      const s = await callAs("purchasing", "POST", "/procurement/spend-analytics/compute", { periodType: "monthly", periodStart: from, periodEnd: end });
      const ts = iso(end, 20);
      await ctx.sql(`UPDATE scm_spend_analytics_snapshots SET created_at = $2::timestamptz, snapshot_date = $3::date WHERE id = $1`, [s.id, ts, end]);
      made("spendSnapshot");
    }
  });

  // -- FIFO layers: remaining quantity = what is on hand, held by the newest layers ----------------
  await guard("fifo", async () => {
    const layers = await ctx.sql(
      `SELECT l.id, l.item_id, l.original_quantity::float8 AS orig, l.remaining_quantity::float8 AS rem, l.received_date FROM scm_valuation_layers l WHERE l.tenant_id = $1 AND l.stock_condition = 'unrestricted' ORDER BY l.item_id, l.received_date DESC, l.created_at DESC`, [t]);
    const bal = await ctx.sql(`SELECT item_id, sum(quantity)::float8 AS q FROM scm_advanced_stock_balances WHERE tenant_id = $1 AND stock_condition = 'unrestricted' GROUP BY item_id`, [t]);
    const onHand = new Map(bal.map((r) => [r.item_id as string, r.q as number]));
    const byItem = new Map<string, any[]>();
    for (const l of layers) { const a = byItem.get(l.item_id) ?? []; a.push(l); byItem.set(l.item_id, a); }
    let changed = 0;
    for (const [iid, ls] of byItem) {
      let left = onHand.get(iid) ?? 0;
      for (const l of ls) {
        const keep = Math.max(0, Math.min(l.orig, left));
        left -= keep;
        if (Math.abs(keep - l.rem) > 1e-9) {
          await ctx.call("POST", "/wms/valuation-layers/consume", { layerId: l.id, remainingQuantity: keep });
          changed++;
        }
      }
    }
    if (changed) made("valuationLayerConsumed", changed);
  });
}

// ---------------------------------------------------------------------------
// backdating
// ---------------------------------------------------------------------------

async function backdate(ctx: DemoCtx, orders: Order[], prByKey: Map<string, any>): Promise<void> {
  const t = ctx.tenantId;
  const log = (m: string) => ctx.log(SECTOR, m);
  const poRows = await ctx.sql(`SELECT po.id, po.order_number, po.order_date::text AS d, s.code AS sc, po.purchase_request_id FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = $1`, [t]);
  const byKey = new Map(poRows.map((r) => [`${r.sc}@${r.d}`, r]));
  const entityTs = new Map<string, string>(); // entity id -> creation timestamp (for workflow/audit backdating)

  for (const o of orders) {
    const r = byKey.get(o.key);
    if (!r) continue;
    const created = iso(o.date, 9, 10);
    const issued = iso(o.date, 10, 5);
    await ctx.sql(`UPDATE purchase_orders SET created_at = $2::timestamptz, issued_at = CASE WHEN issued_at IS NULL THEN NULL ELSE $3::timestamptz END, cancelled_at = CASE WHEN cancelled_at IS NULL THEN NULL ELSE $4::timestamptz END, updated_at = $3::timestamptz WHERE id = $1`,
      [r.id, created, issued, iso(addDays(o.date, 2), 13)]);
    entityTs.set(r.id, created);
    // receiving timestamps
    for (const d of o.deliveries) {
      await ctx.sql(`UPDATE scm_receiving_records SET created_at = received_at, updated_at = COALESCE((SELECT max(i.inspected_at) FROM scm_inspections i JOIN scm_receiving_lines l ON l.id = i.receiving_line_id WHERE l.receiving_record_id = scm_receiving_records.id), received_at) WHERE tenant_id = $1 AND idempotency_key = $2`, [t, `dsc-grn:${o.key}:${d.idx}`]);
    }
    if (r.purchase_request_id) {
      const pr = [...prByKey.values()].find((x) => x.id === r.purchase_request_id);
      void pr;
      const ts = iso(o.prDate, 9, 0);
      await ctx.sql(`UPDATE purchase_requests SET created_at = $2::timestamptz, updated_at = $3::timestamptz, converted_at = $4::timestamptz WHERE id = $1`, [r.purchase_request_id, ts, iso(addDays(o.prDate, 1), 15), created]);
      entityTs.set(r.purchase_request_id, ts);
    }
  }
  // extra PRs (not linked to POs)
  const extra = await ctx.sql(`SELECT id, justification FROM purchase_requests WHERE tenant_id = $1 AND justification LIKE '%[k:extra-X%'`, [t]);
  const extraDates: Record<string, string> = { X1: "2026-01-14", X2: "2026-04-22", X3: "2026-09-02", X4: "2026-11-03", X5: "2026-11-06", X6: "2026-11-08" };
  for (const r of extra) {
    const m = /\[k:extra-(X\d)\]/.exec(r.justification);
    if (!m) continue;
    const ts = iso(extraDates[m[1]], 9, 30);
    await ctx.sql(`UPDATE purchase_requests SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1`, [r.id, ts]);
    entityTs.set(r.id, ts);
  }
  // discrepancy / RTV / inspection timestamps follow their movements
  await ctx.sql(`UPDATE scm_inspections SET created_at = inspected_at WHERE tenant_id = $1 AND created_at <> inspected_at`, [t]);
  await ctx.sql(`UPDATE scm_return_to_vendors SET created_at = returned_at WHERE tenant_id = $1`, [t]);
  await ctx.sql(`UPDATE scm_valuation_layers SET created_at = received_date::timestamptz + interval '10 hours' WHERE tenant_id = $1 AND created_at > received_date::timestamptz + interval '2 days'`, [t]);

  // workflow + audit trail for the PR / RFQ / evaluation / contract entities we created
  const wfEntities = await ctx.sql(
    `SELECT wi.id AS instance_id, wi.entity_id, wi.entity_type FROM workflow_instances wi WHERE wi.tenant_id = $1 AND wi.entity_type IN ('purchase_request')`, [t]);
  for (const w of wfEntities) {
    const ts = entityTs.get(w.entity_id);
    if (!ts) continue;
    await backdateWorkflow(ctx, w.instance_id, w.entity_id, ts);
  }
  const rfqs = await ctx.sql(`SELECT r.id, r.workflow_instance_id, r.created_at FROM scm_rfqs r WHERE r.tenant_id = $1 AND r.workflow_instance_id IS NOT NULL`, [t]);
  for (const r of rfqs) await backdateWorkflow(ctx, r.workflow_instance_id, r.id, new Date(r.created_at).toISOString());
  const evs = await ctx.sql(`SELECT id, workflow_instance_id, created_at FROM scm_supplier_evaluations WHERE tenant_id = $1 AND workflow_instance_id IS NOT NULL`, [t]);
  for (const r of evs) await backdateWorkflow(ctx, r.workflow_instance_id, r.id, new Date(r.created_at).toISOString());
  const cts = await ctx.sql(`SELECT id, workflow_instance_id, created_at FROM scm_supplier_contracts WHERE tenant_id = $1 AND workflow_instance_id IS NOT NULL`, [t]);
  for (const r of cts) await backdateWorkflow(ctx, r.workflow_instance_id, r.id, new Date(r.created_at).toISOString());

  // year in document numbers follows the business date (sequences were generated today)
  await ctx.sql(`UPDATE purchase_orders SET order_number = replace(order_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND order_date < '2026-01-01' AND order_number LIKE '%-2026-%'`, [t]);
  await ctx.sql(`UPDATE purchase_requests SET request_number = replace(request_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND created_at < '2026-01-01' AND request_number LIKE '%-2026-%'`, [t]);
  await ctx.sql(`UPDATE scm_receiving_records SET receipt_number = replace(receipt_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND received_at < '2026-01-01' AND receipt_number LIKE '%-2026-%'`, [t]);
  await ctx.sql(`UPDATE scm_inspections SET inspection_number = replace(inspection_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND inspected_at < '2026-01-01' AND inspection_number LIKE '%-2026-%'`, [t]);
  await ctx.sql(`UPDATE scm_return_to_vendors SET return_number = replace(return_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND returned_at < '2026-01-01' AND return_number LIKE '%-2026-%'`, [t]);
  await ctx.sql(`UPDATE scm_rfqs SET rfq_number = replace(rfq_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND created_at < '2026-01-01' AND rfq_number LIKE '%-2026-%'`, [t]);

  // landed costs follow the delivery of their purchase order; disposals follow their planned age
  await ctx.sql(`UPDATE scm_landed_costs lc SET created_at = (SELECT max(r.received_at) + interval '2 days' FROM scm_receiving_records r WHERE r.purchase_order_id = lc.purchase_order_id), updated_at = (SELECT max(r.received_at) + interval '2 days' FROM scm_receiving_records r WHERE r.purchase_order_id = lc.purchase_order_id)
                  WHERE lc.tenant_id = $1 AND lc.created_at > now() - interval '1 day' AND EXISTS (SELECT 1 FROM scm_receiving_records r WHERE r.purchase_order_id = lc.purchase_order_id)`, [t]);
  const dspAge: Record<string, number> = { SAYUR: 21, "BUAH-PISANG": 11, "BOX-SNACK": 4 };
  for (const [code, days] of Object.entries(dspAge)) {
    const ts = iso(addDays(ctx.cal.today, -days), 15);
    await ctx.sql(`UPDATE scm_inventory_disposals SET created_at = $3::timestamptz, updated_at = $3::timestamptz WHERE tenant_id = $1 AND idempotency_key = $2 AND created_at > now() - interval '1 day'`, [t, `dsc-dsp:${code}`, ts]);
  }

  // core stock balances: last movement date
  await ctx.sql(`UPDATE stock_balances b SET updated_at = COALESCE((SELECT max(m.occurred_at) FROM stock_movements m WHERE m.item_id = b.item_id AND m.tenant_id = b.tenant_id), b.updated_at) WHERE b.tenant_id = $1`, [t]);
  log("backdating done");
}

async function backdateWorkflow(ctx: DemoCtx, instanceId: string, entityId: string, ts: string): Promise<void> {
  await ctx.sql(`UPDATE workflow_instances SET started_at = $2::timestamptz, completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $2::timestamptz + interval '1 day' END WHERE id = $1`, [instanceId, ts]);
  await ctx.sql(
    `UPDATE workflow_history h SET occurred_at = $2::timestamptz + (x.rn * interval '5 hours')
       FROM (SELECT id, row_number() OVER (ORDER BY occurred_at, id) AS rn FROM workflow_history WHERE workflow_instance_id = $1) x WHERE h.id = x.id`, [instanceId, ts]);
  await ctx.sql(
    `UPDATE workflow_instance_assignments a SET assigned_at = $2::timestamptz + ((x.rn - 1) * interval '5 hours'),
            decided_at = CASE WHEN a.decided_at IS NULL THEN NULL ELSE $2::timestamptz + (x.rn * interval '5 hours') END
       FROM (SELECT id, row_number() OVER (ORDER BY assigned_at, id) AS rn FROM workflow_instance_assignments WHERE workflow_instance_id = $1) x WHERE a.id = x.id`, [instanceId, ts]);
  await ctx.sql(
    `UPDATE audit_log SET created_at = $2::timestamptz + (random() * interval '2 hours') WHERE entity_id = $1`, [entityId, ts]);
}
