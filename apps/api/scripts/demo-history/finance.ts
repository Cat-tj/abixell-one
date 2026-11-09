/**
 * Sector "finance" (runs LAST): twelve months of bookkeeping for
 * PT Sentra Layanan Terpadu on top of the master data, projects and operations
 * seeded by the other sectors.
 *
 *   config   extra GL accounts, workflow definitions, finance categories, extra
 *            service vendors, primary ledger, tax rules (PPN 11%, PPh 23 2%)
 *   ledger   opening balance journal, monthly invoices (AR), supplier bills (AP),
 *            receipts, payments, payroll, utilities, rent, accruals (+reversal),
 *            tax settlement, capex, depreciation, all through the accounting kernel
 *   cash     the cash/bank ledger (finance transactions) mirrors the GL bank legs
 *   ar/ap    open items, withholding items and allocations for every document
 *   tax      tax calculations (PPN output/input, PPh 23)
 *   assets   fixed assets, asset books and monthly depreciation runs
 *   budget   FY2026 budgets with versions, policies and consumption
 *   recon    imported bank statements, matches and closed reconciliations
 *   close    month-end close of every period older than two months (last step)
 *
 * Every record is looked up by its number/reference first, so a re-run creates
 * nothing new. SQL is used only to backdate timestamps and to insert the
 * finance categories / open periods that have no endpoint.
 *
 * Run only some steps while developing:  FINANCE_STEPS=config,ledger npx tsx ...
 */
import { createHash } from "node:crypto";
import type { DemoCtx } from "./harness.js";
import { makeRand } from "./harness.js";
import { BANK_ACCOUNTS, CUSTOMERS, DEMO_PASSWORD, SUPPLIERS, USERS, activityFactor, periodCodeOf } from "./catalog.js";
import type { SupplierKey } from "./catalog.js";

const S = "finance";
const counts: Record<string, number> = {};
const made = (k: string, n = 1) => {
  if (n > 0) counts[k] = (counts[k] ?? 0) + n;
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const catCode = (c: string): string => c.toLowerCase().replace(/-/g, "_");
const rp = (n: number): string => Math.round(n).toFixed(2);
const r0 = (n: number): number => Math.round(n);
const roundK = (n: number, k = 1000): number => Math.round(n / k) * k;
const uuidOf = (key: string): string => {
  const h = createHash("md5").update(`demo-fin:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const hashSeed = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const addDays = (date: string, days: number): string =>
  new Date(new Date(date + "T00:00:00Z").getTime() + days * 86400000).toISOString().slice(0, 10);
const monthOf = (date: string): string => date.slice(0, 7);
const lastDom = (month: string): number => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const dow = (date: string): number => new Date(date + "T00:00:00Z").getUTCDay();
/** Next Mon-Sat on or after the date. */
const workdayOnOrAfter = (date: string): string => (dow(date) === 0 ? addDays(date, 1) : date);
const workdayOnOrBefore = (date: string): string => (dow(date) === 0 ? addDays(date, -1) : date);
const nextMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};
const prevMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const monthsWorkdays = (month: string): number => {
  let n = 0;
  for (let d = 1; d <= lastDom(month); d++) if (dow(`${month}-${String(d).padStart(2, "0")}`) !== 0) n++;
  return n;
};

type Acc = string;
interface JLine {
  acc: Acc;
  dr?: number;
  cr?: number;
  desc?: string;
}
interface JournalSpec {
  num: string;
  date: string;
  desc: string;
  lines: JLine[];
  /** Cash/bank journals carry the event key so statements can be matched to GL lines. */
  bankKey?: string;
}

// ---------------------------------------------------------------------------
// accounts added to the foundation chart
// ---------------------------------------------------------------------------

const EXTRA_ACCOUNTS: { code: string; name: string; cls: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE"; normal: "debit" | "credit" }[] = [
  { code: "1240", name: "PPh Pasal 23 Dibayar Dimuka (Dipotong Pelanggan)", cls: "ASSET", normal: "debit" },
  { code: "1250", name: "PPh Pasal 25 Dibayar Dimuka (Angsuran)", cls: "ASSET", normal: "debit" },
  { code: "1530", name: "Peralatan Kantor & IT", cls: "ASSET", normal: "debit" },
  { code: "2160", name: "Beban yang Masih Harus Dibayar", cls: "LIABILITY", normal: "credit" },
  { code: "2440", name: "Utang PPh Pasal 23 (Dipotong dari Vendor)", cls: "LIABILITY", normal: "credit" },
  { code: "2450", name: "Utang PPh Pasal 25/29", cls: "LIABILITY", normal: "credit" },
  { code: "4910", name: "Pendapatan Bunga Bank", cls: "INCOME", normal: "credit" },
  { code: "5110", name: "HPP Tenaga Alih Daya (Outsourcing)", cls: "EXPENSE", normal: "debit" },
  { code: "6120", name: "Beban Asuransi", cls: "EXPENSE", normal: "debit" },
  { code: "6130", name: "Beban Pajak Penghasilan", cls: "EXPENSE", normal: "debit" },
  { code: "2210", name: "Utang Bank - Kredit Modal Kerja (KMK)", cls: "LIABILITY", normal: "credit" },
  { code: "6910", name: "Beban Bunga Pinjaman", cls: "EXPENSE", normal: "debit" },
];

const EXTRA_SUPPLIERS = [
  { code: "SUP-101", name: "PT Karya Tenaga Mandiri", category: "Jasa tenaga kerja alih daya", contactName: "Dedi Kurniawan", email: "dedi@karyatenaga.local", phone: "081280010101", address: "Jl. Raya Bekasi Km 22 No. 18, Bekasi", terms: "NET-30" },
  { code: "SUP-102", name: "CV Servis Teknik Prima", category: "Jasa perawatan & servis peralatan", contactName: "Agus Setiawan", email: "agus@servistekprima.local", phone: "081280010102", address: "Jl. Letjen Suprapto No. 41, Jakarta Pusat", terms: "NET-14" },
  { code: "SUP-103", name: "PT Asuransi Sentosa Raya", category: "Asuransi", contactName: "Melinda Hartati", email: "melinda@asuransisentosa.local", phone: "081280010103", address: "Gedung Wisma Raya Lt. 7, Jl. Jend. Sudirman, Jakarta", terms: "NET-30" },
] as const;

const FINANCE_CATEGORIES: [string, string][] = [
  ["PENERIMAAN-PELANGGAN", "Penerimaan dari pelanggan"],
  ["PEMBAYARAN-PEMASOK", "Pembayaran ke pemasok"],
  ["GAJI-UPAH", "Gaji dan upah"],
  ["PAJAK-BPJS", "Setoran pajak dan BPJS"],
  ["UTILITAS", "Listrik, air dan gas"],
  ["SEWA", "Sewa gedung dan kendaraan"],
  ["BBM-TRANSPORT", "BBM dan transportasi"],
  ["OPERASIONAL-UMUM", "Biaya operasional umum"],
  ["BIAYA-BANK", "Biaya administrasi bank"],
  ["BUNGA-BANK", "Bunga dan jasa giro"],
  ["PEMBELIAN-ASET", "Pembelian aset tetap"],
  ["TRANSFER-INTERNAL", "Transfer antar rekening perusahaan"],
  ["SALDO-AWAL", "Saldo awal kas dan bank"],
  ["PINJAMAN-BANK", "Pencairan, bunga dan angsuran pinjaman bank"],
];

// ---------------------------------------------------------------------------
// workflow definitions (finance transactions, budget versions, tax rule versions)
// ---------------------------------------------------------------------------

const SIMPLE_STEPS = [
  { code: "SUBMITTED", name: "Diajukan", type: "task", initial: true },
  { code: "APPROVED", name: "Disetujui", type: "end", terminal: "approved" },
  { code: "REJECTED", name: "Ditolak", type: "end", terminal: "rejected" },
] as const;
const SIMPLE_TRANSITIONS: [string, string, string, string][] = [
  ["SUBMITTED", "APPROVED", "approve", "Setujui"],
  ["SUBMITTED", "REJECTED", "reject", "Tolak"],
  ["SUBMITTED", "REJECTED", "cancel", "Batalkan"],
];

async function ensureWorkflow(ctx: DemoCtx, existing: Set<string>, code: string, name: string, entityType: string) {
  if (existing.has(code)) return;
  await ctx.call("POST", "/workflow/definitions", { code, name, entityType, description: `Alur persetujuan ${name}` });
  const base = `/workflow/definitions/${code}/versions/1`;
  for (const s of SIMPLE_STEPS) {
    await ctx.call("POST", `${base}/steps`, {
      code: s.code,
      name: s.name,
      stepType: s.type,
      ...("initial" in s ? { isInitial: true } : {}),
      ...("terminal" in s ? { isTerminal: true, terminalStatus: s.terminal } : {}),
    });
  }
  for (const [from, to, action, label] of SIMPLE_TRANSITIONS) {
    await ctx.call("POST", `${base}/transitions`, { fromStepCode: from, toStepCode: to, actionCode: action, name: label });
  }
  await ctx.call("POST", `${base}/assignment-rules`, { stepCode: "SUBMITTED", assignmentType: "specific_user", specificUserSource: "submitter" });
  await ctx.call("POST", `${base}/publish`);
  existing.add(code);
  made("workflowDefinition");
}

// ---------------------------------------------------------------------------
// the business story (pure functions of the catalog and the calendar)
// ---------------------------------------------------------------------------

/** Opening cash positions used by this ledger (the penerimaan account carries the customers' collections). */
const openingOf = (b: { code: string; openingBalance: number }): number => (b.code === "BANK-BCA-REC" ? 2_550_000_000 : b.openingBalance);

type BankKey = "MDR" | "REC" | "PAY" | "KAS";
const BANK_CODE: Record<BankKey, string> = { MDR: "BANK-MDR-OPS", REC: "BANK-BCA-REC", PAY: "BANK-BCA-PAY", KAS: "KAS-KECIL" };
const BANK_GL: Record<BankKey, string> = { MDR: "1121", REC: "1122", PAY: "1123", KAS: "1110" };

interface PayPart {
  key: string;
  date: string;
  /** cash received / paid */
  cash: number;
  /** tax withheld by the counterparty (PPh 23) */
  wh: number;
  /** portion of the document settled by this payment (cash + wh) */
  settles: number;
}
interface Invoice {
  key: string;
  custCode: string;
  custName: string;
  month: string;
  date: string;
  due: string;
  docNo: string;
  dpp: number;
  ppn: number;
  total: number;
  wh: number;
  rev: { "4110": number; "4120": number; "4130": number };
  opening: boolean;
  term: string;
  pays: PayPart[];
  note?: string;
}
interface Bill {
  key: string;
  supCode: string;
  month: string;
  date: string;
  due: string;
  docNo: string;
  base: number;
  ppn: number;
  total: number;
  wh: number;
  expAcc: string;
  desc: string;
  opening: boolean;
  pays: PayPart[];
  credit?: { key: string; date: string; amount: number; base: number; ppn: number; note: string };
}
interface CashEv {
  key: string;
  date: string;
  bank: BankKey;
  dir: "in" | "out";
  amount: number;
  category: string;
  desc: string;
  /** legs against the bank leg; must balance the bank leg */
  counter: JLine[];
  customerCode?: string;
  /** internal transfer partner (journal is Dr to / Cr from) */
  xfer?: { from: BankKey; to: BankKey };
  prio: number;
}
interface FixedAsset {
  tag: string;
  name: string;
  category: string;
  date: string;
  cost: number;
  ppn: number;
  glAcc: "1510" | "1520" | "1530";
  lifeMonths: number;
  note: string;
}
interface TaxCalcSpec {
  key: string;
  rule: "PPN-KELUARAN" | "PPN-MASUKAN" | "PPH23-JASA";
  date: string;
  basis: number;
}
interface World {
  invoices: Invoice[];
  bills: Bill[];
  journals: JournalSpec[];
  cash: CashEv[];
  assets: FixedAsset[];
  taxCalcs: TaxCalcSpec[];
  /** accrual journals that get reversed on the 1st of the next month */
  accruals: { num: string; reverseOn: string }[];
  pnl: Map<string, { rev: number; cost: number }>;
  /** spend by month and budget bucket, used for budget consumption */
  spend: Map<string, { cat: number; fac: number; ho: number }>;
  openingEquity: { modal: number; retained: number };
}

const PAY_DELAY: Record<string, number> = {
  "CUST-101": 2, "CUST-102": 8, "CUST-103": -3, "CUST-104": 12, "CUST-105": 15, "CUST-106": 5,
  "CUST-107": 0, "CUST-108": 10, "CUST-109": 25, "CUST-110": 4, "CUST-111": 6, "CUST-112": 3,
};
const TERM_DAYS: Record<string, number> = { COD: 0, "NET-7": 7, "NET-14": 14, "NET-30": 30, "NET-45": 45 };
const FOOD_SHARE: Partial<Record<SupplierKey, number>> = { BERAS: 0.15, UNGGAS: 0.22, DAGING: 0.15, TELUR: 0.1, SAYUR: 0.13, SEMBAKO: 0.11, IKAN: 0.06, BUMBU: 0.08 };
const TWICE_A_MONTH: SupplierKey[] = ["UNGGAS", "DAGING", "TELUR", "SAYUR", "IKAN"];

const CAPEX: FixedAsset[] = [
  { tag: "FA-2025-101", name: "Chiller & Freezer Dapur Sentral Cikarang", category: "Peralatan Dapur", date: "2025-12-12", cost: 285_000_000, ppn: 31_350_000, glAcc: "1510", lifeMonths: 96, note: "Pengadaan proyek fit-out dapur sentral" },
  { tag: "FA-2026-102", name: "Mobil Box Daihatsu Gran Max (2 unit)", category: "Kendaraan", date: "2026-02-10", cost: 560_000_000, ppn: 61_600_000, glAcc: "1520", lifeMonths: 96, note: "Armada distribusi makanan kota Bekasi" },
  { tag: "FA-2026-103", name: "Mesin Cuci Piring Industri Hobart", category: "Peralatan Dapur", date: "2026-04-08", cost: 142_000_000, ppn: 15_620_000, glAcc: "1510", lifeMonths: 72, note: "Penambahan kapasitas pencucian" },
  { tag: "FA-2026-104", name: "Steamer Nasi Gas 3 Unit", category: "Peralatan Dapur", date: "2026-05-14", cost: 96_000_000, ppn: 10_560_000, glAcc: "1510", lifeMonths: 72, note: "Kapasitas produksi 1.200 porsi tambahan" },
  { tag: "FA-2026-105", name: "Truk Engkel Box Pendingin", category: "Kendaraan", date: "2026-07-06", cost: 410_000_000, ppn: 45_100_000, glAcc: "1520", lifeMonths: 96, note: "Distribusi katering Karawang dan Cikarang" },
  { tag: "FA-2026-106", name: "Scrubber Dryer Industri (2 unit)", category: "Peralatan Kebersihan", date: "2026-08-12", cost: 88_000_000, ppn: 9_680_000, glAcc: "1510", lifeMonths: 60, note: "Mobilisasi layanan housekeeping terminal" },
  { tag: "FA-2026-107", name: "Genset 100 kVA Silent", category: "Peralatan Pendukung", date: "2026-09-16", cost: 235_000_000, ppn: 25_850_000, glAcc: "1510", lifeMonths: 120, note: "Cadangan listrik central kitchen Karawang" },
];

interface WorldInput {
  custStart: Map<string, string>; // code -> first billing month
  payroll: Map<string, { gross: number; deductions: number; net: number; employer: number }>;
  supplierTerms: Map<string, number>; // supplier code -> net days
}

function buildWorld(ctx: DemoCtx, input: WorldInput): World {
  const cal = ctx.cal;
  const today = cal.today;
  const months = cal.months;
  const currentMonth = monthOf(today);
  const pnl = new Map<string, { rev: number; cost: number }>();
  const spend = new Map<string, { cat: number; fac: number; ho: number }>();
  const addPnl = (m: string, rev: number, cost: number) => {
    const p = pnl.get(m) ?? { rev: 0, cost: 0 };
    p.rev += rev;
    p.cost += cost;
    pnl.set(m, p);
  };
  const addSpend = (m: string, bucket: "cat" | "fac" | "ho", amt: number) => {
    const s = spend.get(m) ?? { cat: 0, fac: 0, ho: 0 };
    s[bucket] += amt;
    spend.set(m, s);
  };
  const world: World = { invoices: [], bills: [], journals: [], cash: [], assets: [], taxCalcs: [], accruals: [], pnl, spend, openingEquity: { modal: 5_000_000_000, retained: 0 } };
  const rng = makeRand(hashSeed("finance-world-v1"));

  // workday-aligned calendar helpers -----------------------------------------------------
  const dateIn = (month: string, dom: number): string => workdayOnOrAfter(`${month}-${String(Math.min(dom, lastDom(month))).padStart(2, "0")}`);
  const isPast = (d: string) => d <= today;

  // revenue per customer per month ---------------------------------------------------------
  const frac = (m: string): number => (m === currentMonth ? Math.max(0.1, (Number(today.slice(8, 10)) - 1) / lastDom(m)) : 1);
  const invoiceDate = (m: string): string => (m === currentMonth ? addDays(today, -1) : workdayOnOrBefore(`${m}-${String(lastDom(m)).padStart(2, "0")}`));

  const monthRev = new Map<string, { C: number; S: number; hk: number }>();
  for (const m of months) {
    let C = 0;
    let S = 0;
    let hk = 0;
    for (const c of CUSTOMERS) {
      const start = input.custStart.get(c.code);
      if (!start || start > m) continue;
      const rr = makeRand(hashSeed(`${c.code}:${m}`));
      const meals = c.sites.reduce((a, s) => a + s.dailyMeals, 0);
      const ramp = start === m && m !== months[0] ? 0.55 : 1;
      let seasonal = 1;
      if (m === "2026-03") seasonal = 1.08; // Ramadan iftar/sahur boxes, Lebaran closure at month end
      if (m === "2025-12") seasonal = 0.96;
      if (m === "2026-01") seasonal = 0.97;
      const jitter = 0.965 + rr.next() * 0.06;
      const wd = monthsWorkdays(m) - (m === "2026-03" ? 4 : 1);
      const hasCat = c.services.includes("CATERING") && meals > 0;
      const cat = hasCat ? meals * c.contract.mealPrice * wd * 0.97 * jitter * seasonal * ramp * frac(m) : 0;
      const fee = c.contract.monthlyServiceFee * ramp * frac(m);
      C += cat;
      S += fee;
      if (c.services.includes("HOUSEKEEPING")) hk += fee;
    }
    monthRev.set(m, { C, S, hk });
  }

  // AR: invoices -----------------------------------------------------------------------------
  const makeInvoice = (c: (typeof CUSTOMERS)[number], m: string, opening: boolean): Invoice => {
    const start = input.custStart.get(c.code)!;
    const rr = makeRand(hashSeed(`inv:${c.code}:${m}`));
    const meals = c.sites.reduce((a, s) => a + s.dailyMeals, 0);
    const mm = opening ? nextMonth(m) : m; // opening (Oct) volume derived from November
    const ramp = !opening && start === m && m !== months[0] ? 0.55 : 1;
    let seasonal = 1;
    if (m === "2026-03") seasonal = 1.08;
    if (m === "2025-12") seasonal = 0.96;
    if (m === "2026-01") seasonal = 0.97;
    const jitter = 0.965 + rr.next() * 0.06;
    const wd = opening ? 24 : monthsWorkdays(m) - (m === "2026-03" ? 4 : 1);
    const hasCat = c.services.includes("CATERING") && meals > 0;
    const f = opening ? 0.93 : frac(m);
    const catDpp = hasCat ? meals * c.contract.mealPrice * wd * 0.97 * jitter * seasonal * ramp * f : 0;
    const feeDpp = c.contract.monthlyServiceFee * ramp * (opening ? 0.96 : f);
    void mm;
    const nonCat = c.services.filter((s) => s !== "CATERING");
    const hkShare = nonCat.includes("HOUSEKEEPING") ? 1 / nonCat.length : 0;
    const dpp = roundK(catDpp + feeDpp);
    const catR = roundK(catDpp);
    const hkR = roundK(feeDpp * hkShare);
    const facR = dpp - catR - hkR;
    const ppn = r0(dpp * 0.11);
    const total = dpp + ppn;
    const wh = r0(dpp * 0.02);
    const date = opening ? "2025-10-31" : invoiceDate(m);
    const term = TERM_DAYS[c.contract.paymentTermCode] ?? 30;
    const due = addDays(date, term);
    const docNo = `INV-${c.code.slice(5)}-${m}`;
    const inv: Invoice = {
      key: `${c.code}:${m}`,
      custCode: c.code,
      custName: c.name,
      month: m,
      date,
      due,
      docNo,
      dpp,
      ppn,
      total,
      wh,
      rev: { "4110": catR, "4120": hkR, "4130": facR },
      opening,
      term: c.contract.paymentTermCode,
      pays: [],
    };
    // payment behaviour
    const delay = PAY_DELAY[c.code] ?? 5;
    const payDate = (extra = 0) => workdayOnOrAfter(addDays(due, delay + extra + rr.int(-3, 4)));
    const splitter = rr.next();
    const parts: { date: string; f: number }[] = [];
    if (c.code === "CUST-109" && m === "2026-06") {
      parts.push({ date: payDate(), f: 0.55 });
      inv.note = "Sengketa jumlah porsi housekeeping; sisa tagihan ditahan klien menunggu berita acara";
    } else if (c.code === "CUST-105" && m === "2026-09") {
      // overdue: not paid yet
    } else if (c.code === "CUST-104" && m === "2026-05") {
      parts.push({ date: payDate(8), f: 1 });
      inv.note = "Terlambat bayar: menunggu penerbitan PO baru dari klien";
    } else if (splitter < 0.12) {
      const d1 = payDate();
      parts.push({ date: d1, f: 0.6 }, { date: workdayOnOrAfter(addDays(d1, rr.int(9, 16))), f: 0.4 });
    } else {
      parts.push({ date: payDate(), f: 1 });
    }
    let settledCash = 0;
    let settledWh = 0;
    const live = parts.filter((p) => isPast(p.date));
    const allPaid = live.length === parts.length && parts.length > 0 && Math.abs(parts.reduce((a, b) => a + b.f, 0) - 1) < 1e-9;
    live.forEach((p, i) => {
      const final = allPaid && i === live.length - 1;
      const whPart = final ? wh - settledWh : r0(wh * p.f);
      const cashPart = final ? total - wh - settledCash : r0((total - wh) * p.f);
      settledCash += cashPart;
      settledWh += whPart;
      inv.pays.push({ key: `${inv.key}#${i + 1}`, date: p.date, cash: cashPart, wh: whPart, settles: cashPart + whPart });
    });
    return inv;
  };

  for (const c of CUSTOMERS) {
    const start = input.custStart.get(c.code);
    if (!start) continue;
    if (start <= months[0]) {
      const o = makeInvoice(c, "2025-10", true);
      world.invoices.push(o);
    }
    for (const m of months) {
      if (start > m) continue;
      const inv = makeInvoice(c, m, false);
      if (inv.date > today || inv.dpp <= 0) continue;
      world.invoices.push(inv);
    }
  }

  // AP: bills ------------------------------------------------------------------------------------
  const termOf = (code: string): number => input.supplierTerms.get(code) ?? 30;
  const supKey = (k: SupplierKey) => SUPPLIERS.find((s) => s.key === k)!;
  const makeBill = (o: { sup: string; m: string; date: string; base: number; taxable: boolean; wh?: boolean; acc: string; desc: string; tag: string; opening?: boolean; late?: number }): Bill | null => {
    if (o.date > today && !o.opening) return null;
    const rr = makeRand(hashSeed(`bill:${o.sup}:${o.tag}:${o.date}`));
    const base = roundK(o.base, 100);
    const ppn = o.taxable ? r0(base * 0.11) : 0;
    const total = base + ppn;
    const wh = o.wh ? r0(base * 0.02) : 0;
    const due = addDays(o.date, termOf(o.sup));
    const bill: Bill = {
      key: `${o.sup}:${o.tag}:${o.date}`,
      supCode: o.sup,
      month: o.m,
      date: o.date,
      due,
      docNo: `BILL-${o.sup.slice(4)}-${o.date.replace(/-/g, "")}`,
      base,
      ppn,
      total,
      wh,
      expAcc: o.acc,
      desc: o.desc,
      opening: !!o.opening,
      pays: [],
    };
    const pd = workdayOnOrAfter(addDays(due, rr.int(-1, 3) + (o.late ?? 0)));
    if (isPast(pd)) bill.pays.push({ key: `${bill.key}#1`, date: pd, cash: total - wh, wh, settles: total });
    return bill;
  };

  const foodLabel: Partial<Record<SupplierKey, string>> = {
    BERAS: "Beras premium", UNGGAS: "Ayam potong dan fillet", DAGING: "Daging sapi has dalam dan sandung", TELUR: "Telur ayam negeri",
    SAYUR: "Sayur dan buah segar", SEMBAKO: "Minyak goreng, gula, tepung dan garam", IKAN: "Ikan dori dan tuna fillet", BUMBU: "Bumbu dasar, kecap dan saus",
  };
  const pushBill = (b: Bill | null) => {
    if (!b) return;
    world.bills.push(b);
  };
  // opening payables (October deliveries), paid in November
  for (const k of ["UNGGAS", "DAGING", "TELUR", "SAYUR", "IKAN", "BERAS", "SEMBAKO"] as SupplierKey[]) {
    const s = supKey(k);
    const base = k === "BERAS" ? 128_000_000 : k === "UNGGAS" ? 112_000_000 : k === "DAGING" ? 74_000_000 : k === "SEMBAKO" ? 61_000_000 : 38_000_000;
    pushBill(makeBill({ sup: s.code, m: "2025-10", date: "2025-10-30", base, taxable: false, acc: "5100", desc: `${foodLabel[k]} - pengiriman akhir Oktober 2025`, tag: "OPEN", opening: true }));
  }

  for (const m of months) {
    const mr = monthRev.get(m)!;
    const fr = frac(m);
    const food = mr.C * 0.405;
    for (const k of Object.keys(FOOD_SHARE) as SupplierKey[]) {
      const s = supKey(k);
      const amt = food * (FOOD_SHARE[k] ?? 0);
      const rr = makeRand(hashSeed(`food:${k}:${m}`));
      const vary = 0.96 + rr.next() * 0.08;
      if (TWICE_A_MONTH.includes(k)) {
        const d1 = dateIn(m, 14);
        const d2 = m === currentMonth ? addDays(today, -2) : dateIn(m, lastDom(m) - 1);
        const late = k === "UNGGAS" && m === "2026-01" ? 18 : 0;
        pushBill(makeBill({ sup: s.code, m, date: d1, base: (amt * vary) / 2, taxable: false, acc: "5100", desc: `${foodLabel[k]} - pengiriman 1-14 ${periodCodeOf(m).periodName}`, tag: "A" }));
        pushBill(makeBill({ sup: s.code, m, date: d2, base: (amt * (2 - vary)) / 2, taxable: false, acc: "5100", desc: `${foodLabel[k]} - pengiriman 15-akhir ${periodCodeOf(m).periodName}`, tag: "B", late }));
      } else {
        const d = m === currentMonth ? addDays(today, -3) : dateIn(m, 20);
        pushBill(makeBill({ sup: s.code, m, date: d, base: amt * vary, taxable: false, acc: "5100", desc: `${foodLabel[k]} - ${periodCodeOf(m).periodName}`, tag: "M" }));
      }
    }
    const rr = makeRand(hashSeed(`oth:${m}`));
    const d20 = m === currentMonth ? addDays(today, -4) : dateIn(m, 22);
    pushBill(makeBill({ sup: supKey("KEMASAN").code, m, date: d20, base: mr.C * 0.046 * (0.97 + rr.next() * 0.06), taxable: true, acc: "5300", desc: `Kotak nasi, sendok garpu dan plastik - ${periodCodeOf(m).periodName}`, tag: "M" }));
    pushBill(makeBill({ sup: supKey("KIMIA").code, m, date: d20, base: Math.max(8_000_000, mr.hk * 0.09 + mr.S * 0.02), taxable: true, acc: "5300", desc: `Chemical cleaning dan janitorial - ${periodCodeOf(m).periodName}`, tag: "M" }));
    pushBill(makeBill({ sup: supKey("AIR").code, m, date: d20, base: mr.C * 0.012, taxable: true, acc: "5100", desc: `Air minum galon dan botol - ${periodCodeOf(m).periodName}`, tag: "M" }));
    const idx = months.indexOf(m);
    if (idx % 2 === 0) pushBill(makeBill({ sup: supKey("SPAREPART").code, m, date: dateIn(m, 9), base: 17_000_000 + rr.int(0, 14_000_000), taxable: true, acc: "6500", desc: "Suku cadang AC, exhaust dan genset", tag: "M" }));
    if (idx % 2 === 1) pushBill(makeBill({ sup: supKey("APD").code, m, date: dateIn(m, 10), base: 9_000_000 + rr.int(0, 12_000_000), taxable: true, acc: "6800", desc: "APD: sarung tangan, masker, sepatu safety, hairnet", tag: "M" }));
    // service vendors
    pushBill(makeBill({ sup: "SUP-101", m, date: m === currentMonth ? addDays(today, -1) : workdayOnOrBefore(`${m}-${lastDom(m)}`), base: mr.S * 0.57 + mr.C * 0.14, taxable: true, wh: true, acc: "5110", desc: `Jasa tenaga kerja alih daya - ${periodCodeOf(m).periodName}`, tag: "M" }));
    pushBill(makeBill({ sup: "SUP-102", m, date: dateIn(m, 18), base: (12_000_000 + rr.int(0, 18_000_000)) * (1 + idx * 0.01), taxable: true, wh: true, acc: "6500", desc: `Jasa servis peralatan dapur dan AC - ${periodCodeOf(m).periodName}`, tag: "M" }));
    if (["2025-11", "2026-02", "2026-05", "2026-08"].includes(m)) {
      pushBill(makeBill({ sup: "SUP-103", m, date: dateIn(m, 5), base: 28_500_000 + idx * 150_000, taxable: false, acc: "6120", desc: "Premi asuransi kebakaran, kendaraan dan tanggung gugat triwulanan", tag: "Q" }));
    }
  }
  // credit note from the packaging vendor for damaged cartons (Jan 2026)
  const cnBill = world.bills.find((b) => b.supCode === "SUP-010" && b.month === "2026-01");
  if (cnBill) {
    cnBill.credit = { key: `${cnBill.key}#CN`, date: addDays(cnBill.date, 6), amount: 4_662_000, base: 4_200_000, ppn: 462_000, note: "Nota kredit: kotak nasi penyok dan bocor pada pengiriman 20 Januari" };
    cnBill.pays = cnBill.pays.map((p) => ({ ...p, cash: p.cash - 4_662_000, settles: p.settles - 4_662_000 }));
  }

  // cash events: receipts -----------------------------------------------------------------------
  const cash: CashEv[] = [];
  for (const inv of world.invoices) {
    for (const [i, p] of inv.pays.entries()) {
      cash.push({
        key: `RCP-${inv.docNo}-${i + 1}`,
        date: p.date,
        bank: "REC",
        dir: "in",
        amount: p.cash,
        category: "PENERIMAAN-PELANGGAN",
        desc: `Penerimaan ${inv.docNo} ${inv.custName}${inv.pays.length > 1 ? ` (termin ${i + 1}/${inv.pays.length})` : ""}`,
        counter: [
          ...(p.wh > 0 ? [{ acc: "1240", dr: p.wh, desc: `PPh 23 dipotong ${inv.custName}` } as JLine] : []),
          { acc: "1210", cr: p.settles, desc: `Pelunasan ${inv.docNo}` },
        ],
        customerCode: inv.custCode,
        prio: 2,
      });
    }
  }
  for (const b of world.bills) {
    for (const [i, p] of b.pays.entries()) {
      const sup = SUPPLIERS.find((s) => s.code === b.supCode)?.name ?? EXTRA_SUPPLIERS.find((s) => s.code === b.supCode)?.name ?? b.supCode;
      cash.push({
        key: `PAY-${b.docNo}-${i + 1}`,
        date: p.date,
        bank: "MDR",
        dir: "out",
        amount: p.cash,
        category: "PEMBAYARAN-PEMASOK",
        desc: `Pembayaran ${b.docNo} ${sup}`,
        counter: [
          { acc: "2110", dr: p.settles, desc: `Pelunasan ${b.docNo}` },
          ...(p.wh > 0 ? [{ acc: "2440", cr: p.wh, desc: "PPh 23 dipotong atas jasa" } as JLine] : []),
        ],
        prio: 3,
      });
    }
  }

  // payroll ---------------------------------------------------------------------------------------
  for (const m of months) {
    const date = workdayOnOrBefore(dateIn(m, 25));
    if (!isPast(date)) continue;
    const pr = input.payroll.get(m);
    const idx = months.indexOf(m);
    const gross = r0(pr?.gross ?? 440_000_000 + idx * 7_500_000);
    const ded = pr?.deductions ?? gross * 0.093;
    const net = pr?.net ?? gross - ded;
    const emp = pr?.employer ?? gross * 0.0875;
    const pph21 = r0(ded * 0.46);
    // Plug the BPJS line so the journal balances to the rupiah after rounding.
    const bpjs = gross + r0(emp) - r0(net) - pph21;
    const direct = r0(gross * 0.62);
    world.journals.push({
      num: `FIN-PAYROLL-${m}`,
      date,
      desc: `Beban gaji dan tunjangan ${periodCodeOf(m).periodName}`,
      lines: [
        { acc: "5200", dr: direct, desc: "Gaji tenaga produksi dan petugas lapangan" },
        { acc: "6100", dr: gross - direct, desc: "Gaji staf dan manajemen" },
        { acc: "6110", dr: r0(emp), desc: "Iuran BPJS perusahaan" },
        { acc: "2130", cr: r0(net), desc: "Gaji bersih terutang" },
        { acc: "2420", cr: pph21, desc: "PPh 21 karyawan" },
        { acc: "2150", cr: bpjs, desc: "BPJS (karyawan + perusahaan)" },
      ],
    });
    addPnl(m, 0, gross + emp);
    addSpend(m, "fac", direct);
    addSpend(m, "ho", gross - direct + emp);
    cash.push({ key: `GAJI-${m}`, date: workdayOnOrBefore(addDays(date, 2)), bank: "PAY", dir: "out", amount: r0(net), category: "GAJI-UPAH", desc: `Pembayaran gaji karyawan ${periodCodeOf(m).periodName}`, counter: [{ acc: "2130", dr: r0(net), desc: "Pelunasan gaji" }], prio: 1 });
    const nm = nextMonth(m);
    cash.push({ key: `PPH21-${m}`, date: dateIn(nm, 10), bank: "MDR", dir: "out", amount: pph21, category: "PAJAK-BPJS", desc: `Setoran PPh 21 masa ${periodCodeOf(m).periodName}`, counter: [{ acc: "2420", dr: pph21, desc: "Setoran PPh 21" }], prio: 4 });
    cash.push({ key: `BPJS-${m}`, date: dateIn(nm, 15), bank: "MDR", dir: "out", amount: bpjs, category: "PAJAK-BPJS", desc: `Iuran BPJS Kesehatan dan Ketenagakerjaan ${periodCodeOf(m).periodName}`, counter: [{ acc: "2150", dr: bpjs, desc: "Setoran BPJS" }], prio: 4 });
  }
  // payroll liabilities carried from October (paid in November)
  cash.push({ key: "PPH21-2025-10", date: "2025-11-10", bank: "MDR", dir: "out", amount: 19_400_000, category: "PAJAK-BPJS", desc: "Setoran PPh 21 masa Oktober 2025", counter: [{ acc: "2420", dr: 19_400_000, desc: "Setoran PPh 21" }], prio: 4 });
  cash.push({ key: "BPJS-2025-10", date: "2025-11-14", bank: "MDR", dir: "out", amount: 83_600_000, category: "PAJAK-BPJS", desc: "Iuran BPJS Oktober 2025", counter: [{ acc: "2150", dr: 83_600_000, desc: "Setoran BPJS" }], prio: 4 });

  // monthly book entries and expenses --------------------------------------------------------------
  const ppnOut = new Map<string, number>();
  const ppnIn = new Map<string, number>();
  const pph23 = new Map<string, number>();
  for (const inv of world.invoices) if (!inv.opening) ppnOut.set(inv.month, (ppnOut.get(inv.month) ?? 0) + inv.ppn);
  for (const b of world.bills) {
    if (b.opening) continue;
    ppnIn.set(b.month, (ppnIn.get(b.month) ?? 0) + b.ppn - (b.credit?.ppn ?? 0));
    if (b.wh) pph23.set(b.month, (pph23.get(b.month) ?? 0) + b.wh);
  }
  const monthPnlAdd = (m: string) => {
    for (const inv of world.invoices) if (!inv.opening && inv.month === m) addPnl(m, inv.dpp, 0);
    for (const b of world.bills) {
      if (b.month !== m || b.opening) continue;
      const net = b.base - (b.credit?.base ?? 0);
      addPnl(m, 0, net);
      if (b.expAcc === "5100" || b.expAcc === "5300") addSpend(m, "cat", net);
      else if (b.expAcc === "5110") addSpend(m, "fac", net);
      else addSpend(m, "ho", net);
    }
  };
  months.forEach(monthPnlAdd);

  for (const [mi, m] of months.entries()) {
    const mr = monthRev.get(m)!;
    const R = mr.C + mr.S;
    const eom = m === currentMonth ? null : workdayOnOrBefore(`${m}-${lastDom(m)}`);
    const rr = makeRand(hashSeed(`opex:${m}`));
    const nm = nextMonth(m);
    // utilities: accrued at month end, reversed on the 1st, paid around the 12th
    const util = roundK(41_000_000 + R * 0.0042 + rr.int(0, 4_000_000));
    if (eom) {
      world.journals.push({ num: `FIN-ACR-UTIL-${m}`, date: eom, desc: `Akrual tagihan listrik, air dan gas ${periodCodeOf(m).periodName}`, lines: [{ acc: "6300", dr: util, desc: "Akrual utilitas" }, { acc: "2160", cr: util, desc: "Beban yang masih harus dibayar" }] });
      world.accruals.push({ num: `FIN-ACR-UTIL-${m}`, reverseOn: dateIn(nm, 1) });
    }
    addPnl(m, 0, util);
    addSpend(m, "ho", util * 0.45);
    addSpend(m, "fac", util * 0.0);
    addSpend(m, "cat", util * 0.55);
    const payUtil = dateIn(nm, 5);
    if (isPast(payUtil) && eom) {
      cash.push({ key: `UTIL-${m}`, date: payUtil, bank: "MDR", dir: "out", amount: util, category: "UTILITAS", desc: `Pembayaran listrik PLN, PDAM dan gas ${periodCodeOf(m).periodName}`, counter: [{ acc: "6300", dr: util, desc: "Tagihan utilitas" }], prio: 5 });
    }
    // reversal bookkeeping: the accrual reversal credits 6300 in the next month; the payment debits it again
    if (m === months[0]) {
      // October utilities were paid in November without an accrual in this ledger
    }
    // rent, fuel, admin, bank fees
    const rent = "2026-01" === m ? 44_100_000 : mi >= 3 ? 44_100_000 : 42_000_000;
    cash.push({ key: `SEWA-KANTOR-${m}`, date: dateIn(m, 2), bank: "MDR", dir: "out", amount: rent, category: "SEWA", desc: `Sewa kantor pusat dan ruang arsip ${periodCodeOf(m).periodName}`, counter: [{ acc: "6700", dr: rent, desc: "Sewa kantor" }], prio: 5 });
    addPnl(m, 0, rent);
    addSpend(m, "ho", rent);
    for (const [half, dom] of [[1, 10], [2, 24]] as const) {
      const fuel = roundK(R * 0.0085 + rr.int(0, 3_000_000));
      const d = dateIn(m, dom);
      if (!isPast(d)) continue;
      cash.push({ key: `BBM-${m}-${half}`, date: d, bank: "MDR", dir: "out", amount: fuel, category: "BBM-TRANSPORT", desc: `Top-up kartu BBM armada dan tol periode ${half === 1 ? "1-15" : "16-akhir"} ${periodCodeOf(m).periodName}`, counter: [{ acc: "6600", dr: fuel, desc: "BBM dan tol" }], prio: 5 });
      addPnl(m, 0, fuel);
      addSpend(m, "fac", fuel * 0.4);
      addSpend(m, "cat", fuel * 0.6);
      const adm = roundK(13_000_000 + rr.int(0, 9_000_000) + R * 0.0008);
      cash.push({ key: `ADM-${m}-${half}`, date: addDays(d, 2), bank: "MDR", dir: "out", amount: adm, category: "OPERASIONAL-UMUM", desc: `Biaya administrasi umum (ATK, internet, perizinan, kebersihan kantor) ${half === 1 ? "paruh pertama" : "paruh kedua"} ${periodCodeOf(m).periodName}`, counter: [{ acc: "6800", dr: adm, desc: "Administrasi umum" }], prio: 5 });
      addPnl(m, 0, adm);
      addSpend(m, "ho", adm);
    }
    const petty = roundK(8_000_000 + rr.int(0, 4_000_000), 100_000);
    const pd = dateIn(m, 20);
    if (isPast(pd)) {
      cash.push({ key: `KAS-${m}`, date: pd, bank: "KAS", dir: "out", amount: petty, category: "OPERASIONAL-UMUM", desc: `Pengeluaran kas kecil (konsumsi rapat, parkir, materai) ${periodCodeOf(m).periodName}`, counter: [{ acc: "6800", dr: petty, desc: "Kas kecil" }], prio: 5 });
      addPnl(m, 0, petty);
      addSpend(m, "ho", petty);
    }
    const fee = 450_000 + mi * 12_000 + rr.int(0, 80_000);
    const interest = roundK(2_400_000 + mi * 260_000 + rr.int(0, 400_000), 100);
    const bd = m === currentMonth ? null : workdayOnOrBefore(`${m}-${lastDom(m)}`);
    if (bd) {
      cash.push({ key: `ADMBANK-${m}`, date: bd, bank: "MDR", dir: "out", amount: fee, category: "BIAYA-BANK", desc: `Biaya administrasi dan provisi bank ${periodCodeOf(m).periodName}`, counter: [{ acc: "6900", dr: fee, desc: "Biaya bank" }], prio: 6 });
      cash.push({ key: `BUNGA-${m}`, date: bd, bank: "REC", dir: "in", amount: interest, category: "BUNGA-BANK", desc: `Jasa giro rekening penerimaan ${periodCodeOf(m).periodName}`, counter: [{ acc: "4910", cr: interest, desc: "Bunga bank" }], prio: 6 });
      const wtax = r0(interest * 0.2);
      cash.push({ key: `PAJAKBUNGA-${m}`, date: bd, bank: "REC", dir: "out", amount: wtax, category: "BIAYA-BANK", desc: `Pajak final 20% atas jasa giro ${periodCodeOf(m).periodName}`, counter: [{ acc: "6130", dr: wtax, desc: "Pajak final bunga" }], prio: 7 });
      addPnl(m, interest, fee + wtax);
      addSpend(m, "ho", fee + wtax);
    }
    // PPh 25 installment
    const p25 = 48_000_000 + Math.floor(mi / 4) * 6_000_000;
    const p25d = dateIn(nm, 15);
    if (isPast(p25d) && eom) cash.push({ key: `PPH25-${m}`, date: p25d, bank: "MDR", dir: "out", amount: p25, category: "PAJAK-BPJS", desc: `Angsuran PPh Pasal 25 masa ${periodCodeOf(m).periodName}`, counter: [{ acc: "1250", dr: p25, desc: "Angsuran PPh 25" }], prio: 4 });
    // PPN settlement (netting journal at month end) and payment
    if (eom) {
      const out = ppnOut.get(m) ?? 0;
      const inn = ppnIn.get(m) ?? 0;
      const net = out - inn;
      world.journals.push({
        num: `FIN-PPN-${m}`,
        date: eom,
        desc: `Pengkreditan PPN masa ${periodCodeOf(m).periodName}`,
        lines: [
          { acc: "2430", dr: out, desc: "PPN Keluaran" },
          { acc: "1230", cr: inn, desc: "PPN Masukan yang dikreditkan" },
          { acc: "2410", cr: net, desc: "PPN kurang bayar" },
        ],
      });
      const pd2 = dateIn(nm, 14);
      if (isPast(pd2)) cash.push({ key: `SETOR-PPN-${m}`, date: pd2, bank: "MDR", dir: "out", amount: net, category: "PAJAK-BPJS", desc: `Setoran PPN masa ${periodCodeOf(m).periodName}`, counter: [{ acc: "2410", dr: net, desc: "Setoran PPN" }], prio: 4 });
      const w = pph23.get(m) ?? 0;
      const wd2 = dateIn(nm, 10);
      if (w > 0 && isPast(wd2)) cash.push({ key: `PPH23-${m}`, date: wd2, bank: "MDR", dir: "out", amount: w, category: "PAJAK-BPJS", desc: `Setoran PPh 23 yang dipotong dari vendor masa ${periodCodeOf(m).periodName}`, counter: [{ acc: "2440", dr: w, desc: "Setoran PPh 23" }], prio: 4 });
      // depreciation of pre-existing assets and prepaid amortisation
      world.journals.push({ num: `FIN-DEP-LAMA-${m}`, date: eom, desc: `Penyusutan aset tetap lama ${periodCodeOf(m).periodName}`, lines: [{ acc: "6400", dr: 31_400_000, desc: "Penyusutan peralatan dan kendaraan lama" }, { acc: "1590", cr: 31_400_000, desc: "Akumulasi penyusutan" }] });
      addPnl(m, 0, 31_400_000);
      addSpend(m, "ho", 31_400_000);
      if (m >= "2025-12") {
        world.journals.push({ num: `FIN-AMORT-SEWA-${m}`, date: eom, desc: `Amortisasi sewa gudang dan central kitchen dibayar dimuka ${periodCodeOf(m).periodName}`, lines: [{ acc: "6700", dr: 95_000_000, desc: "Amortisasi sewa" }, { acc: "1410", cr: 95_000_000, desc: "Sewa dibayar dimuka" }] });
        addPnl(m, 0, 95_000_000);
        addSpend(m, "cat", 95_000_000);
      }
      if (m <= "2026-04") {
        world.journals.push({ num: `FIN-AMORT-ASURANSI-${m}`, date: eom, desc: `Amortisasi biaya dibayar dimuka lainnya ${periodCodeOf(m).periodName}`, lines: [{ acc: "6120", dr: 20_000_000, desc: "Amortisasi asuransi dan langganan" }, { acc: "1410", cr: 20_000_000, desc: "Biaya dibayar dimuka" }] });
        addPnl(m, 0, 20_000_000);
        addSpend(m, "ho", 20_000_000);
      }
    }
    // tax calculations
    if (eom) {
      world.taxCalcs.push({ key: `PPN-OUT-${m}`, rule: "PPN-KELUARAN", date: eom, basis: world.invoices.filter((i) => !i.opening && i.month === m).reduce((a, i) => a + i.dpp, 0) });
      world.taxCalcs.push({ key: `PPN-IN-${m}`, rule: "PPN-MASUKAN", date: eom, basis: world.bills.filter((b) => !b.opening && b.month === m && b.ppn > 0).reduce((a, b) => a + b.base - (b.credit?.base ?? 0), 0) });
    }
    for (const b of world.bills) if (!b.opening && b.month === m && b.wh > 0) world.taxCalcs.push({ key: `PPH23-${b.docNo}`, rule: "PPH23-JASA", date: b.date, basis: b.base });
  }
  // rent prepaid: 6 months in advance, December and June
  for (const [m, label] of [["2025-12", "Desember 2025 - Mei 2026"], ["2026-06", "Juni - November 2026"]] as const) {
    cash.push({ key: `SEWA-GUDANG-${m}`, date: dateIn(m, 1), bank: "MDR", dir: "out", amount: 570_000_000, category: "SEWA", desc: `Sewa gudang dan central kitchen 6 bulan dimuka (${label})`, counter: [{ acc: "1410", dr: 570_000_000, desc: "Sewa dibayar dimuka" }], prio: 5 });
  }
  // working-capital loan (KMK): drawn in January, serviced monthly, partly repaid in August
  const loanDraw = "2026-01-05";
  if (isPast(loanDraw)) {
    cash.push({ key: "KMK-CAIR-2026-01", date: loanDraw, bank: "REC", dir: "in", amount: 1_200_000_000, category: "PINJAMAN-BANK", desc: "Pencairan kredit modal kerja Bank Mandiri (plafon Rp 1,2 miliar, tenor 12 bulan)", counter: [{ acc: "2210", cr: 1_200_000_000, desc: "Pencairan KMK" }], prio: 1 });
    for (const m of months) {
      if (m < "2026-01") continue;
      const outstanding = m >= "2026-09" ? 800_000_000 : 1_200_000_000;
      const intr = r0(outstanding * 0.0095);
      const d = dateIn(m, 25);
      if (!isPast(d)) continue;
      cash.push({ key: `KMK-BUNGA-${m}`, date: d, bank: "MDR", dir: "out", amount: intr, category: "PINJAMAN-BANK", desc: `Bunga kredit modal kerja ${periodCodeOf(m).periodName}`, counter: [{ acc: "6910", dr: intr, desc: "Bunga KMK" }], prio: 5 });
      addPnl(m, 0, intr);
      addSpend(m, "ho", intr);
    }
    if (isPast("2026-08-31")) cash.push({ key: "KMK-ANGSURAN-2026-08", date: "2026-08-31", bank: "REC", dir: "out", amount: 400_000_000, category: "PINJAMAN-BANK", desc: "Angsuran pokok kredit modal kerja (pelunasan sebagian)", counter: [{ acc: "2210", dr: 400_000_000, desc: "Angsuran pokok KMK" }], prio: 5 });
  }
  // capex
  for (const a of CAPEX) {
    if (a.date > today) continue;
    world.assets.push(a);
    cash.push({
      key: `CAPEX-${a.tag}`,
      date: a.date,
      bank: "MDR",
      dir: "out",
      amount: a.cost + a.ppn,
      category: "PEMBELIAN-ASET",
      desc: `Pembelian ${a.name}`,
      counter: [{ acc: a.glAcc, dr: a.cost, desc: a.name }, { acc: "1230", dr: a.ppn, desc: "PPN Masukan pembelian aset" }],
      prio: 5,
    });
    const m = monthOf(a.date);
    ppnIn.set(m, (ppnIn.get(m) ?? 0) + a.ppn);
    const tc = world.taxCalcs.find((t) => t.key === `PPN-IN-${m}`);
    if (tc) tc.basis += a.cost;
  }
  // the PPN netting journals were built before capex input VAT: patch them
  for (const j of world.journals) {
    if (!j.num.startsWith("FIN-PPN-")) continue;
    const m = j.num.slice(8);
    const out = ppnOut.get(m) ?? 0;
    const inn = ppnIn.get(m) ?? 0;
    j.lines = [
      { acc: "2430", dr: out, desc: "PPN Keluaran" },
      { acc: "1230", cr: inn, desc: "PPN Masukan yang dikreditkan" },
      { acc: "2410", cr: out - inn, desc: "PPN kurang bayar" },
    ];
    const pay = cash.find((c) => c.key === `SETOR-PPN-${m}`);
    if (pay) {
      pay.amount = out - inn;
      pay.counter = [{ acc: "2410", dr: out - inn, desc: "Setoran PPN" }];
    }
  }

  // sales / purchase documents as journals --------------------------------------------------------
  for (const inv of world.invoices) {
    if (inv.opening) continue;
    world.journals.push({
      num: `FIN-${inv.docNo}`,
      date: inv.date,
      desc: `Faktur penjualan ${inv.docNo} - ${inv.custName}`,
      lines: [
        { acc: "1210", dr: inv.total, desc: `Piutang ${inv.docNo}` },
        ...(inv.rev["4110"] > 0 ? [{ acc: "4110", cr: inv.rev["4110"], desc: "Pendapatan katering" } as JLine] : []),
        ...(inv.rev["4120"] > 0 ? [{ acc: "4120", cr: inv.rev["4120"], desc: "Pendapatan housekeeping" } as JLine] : []),
        ...(inv.rev["4130"] > 0 ? [{ acc: "4130", cr: inv.rev["4130"], desc: "Pendapatan facility dan camp" } as JLine] : []),
        { acc: "2430", cr: inv.ppn, desc: "PPN Keluaran 11%" },
      ],
    });
  }
  for (const b of world.bills) {
    if (b.opening) continue;
    world.journals.push({
      num: `FIN-${b.docNo}`,
      date: b.date,
      desc: `Tagihan pemasok ${b.docNo} - ${b.desc}`,
      lines: [
        { acc: b.expAcc, dr: b.base, desc: b.desc },
        ...(b.ppn > 0 ? [{ acc: "1230", dr: b.ppn, desc: "PPN Masukan" } as JLine] : []),
        { acc: "2110", cr: b.total, desc: `Utang ${b.docNo}` },
      ],
    });
    if (b.credit) {
      world.journals.push({
        num: `FIN-CN-${b.docNo}`,
        date: b.credit.date,
        desc: `Nota kredit pemasok untuk ${b.docNo}`,
        lines: [
          { acc: "2110", dr: b.credit.amount, desc: b.credit.note },
          { acc: "5300", cr: b.credit.base, desc: "Koreksi harga pokok kemasan" },
          { acc: "1230", cr: b.credit.ppn, desc: "Koreksi PPN Masukan" },
        ],
      });
    }
  }

  // opening balance -----------------------------------------------------------------------------------
  const openAR = world.invoices.filter((i) => i.opening).reduce((a, i) => a + i.total, 0);
  const openAP = world.bills.filter((b) => b.opening).reduce((a, b) => a + b.total, 0);
  const openBank = BANK_ACCOUNTS.reduce((a, b) => a + openingOf(b), 0);
  const inventory = 161_000_000;
  const prepaid = 120_000_000;
  const fixedGross = { "1510": 1_450_000_000, "1520": 820_000_000, "1530": 96_000_000 };
  const accumDep = 1_240_000_000;
  const taxPayable = 112_000_000;
  const otherLiab = { "2420": 19_400_000, "2150": 83_600_000 };
  const assets = openBank + openAR + inventory + prepaid + fixedGross["1510"] + fixedGross["1520"] + fixedGross["1530"] - accumDep;
  const liab = openAP + taxPayable + otherLiab["2420"] + otherLiab["2150"];
  const retained = assets - liab - world.openingEquity.modal;
  world.openingEquity.retained = retained;
  world.journals.unshift({
    num: "FIN-OPENING-2025-11",
    date: "2025-11-01",
    desc: "Saldo awal neraca (migrasi pembukuan ke sistem)",
    lines: [
      ...BANK_ACCOUNTS.map((b) => ({ acc: b.glCode, dr: openingOf(b), desc: `Saldo awal ${b.name}` }) as JLine),
      { acc: "1210", dr: openAR, desc: "Saldo awal piutang usaha (tagihan Oktober 2025)" },
      { acc: "1310", dr: inventory, desc: "Persediaan bahan pangan dan kemasan" },
      { acc: "1410", dr: prepaid, desc: "Biaya dibayar dimuka" },
      { acc: "1510", dr: fixedGross["1510"], desc: "Peralatan dapur dan operasional" },
      { acc: "1520", dr: fixedGross["1520"], desc: "Kendaraan operasional" },
      { acc: "1530", dr: fixedGross["1530"], desc: "Peralatan kantor dan IT" },
      { acc: "1590", cr: accumDep, desc: "Akumulasi penyusutan s.d. Oktober 2025" },
      { acc: "2110", cr: openAP, desc: "Saldo awal utang usaha" },
      { acc: "2410", cr: taxPayable, desc: "PPN kurang bayar masa Oktober 2025" },
      { acc: "2420", cr: otherLiab["2420"], desc: "PPh 21 masa Oktober 2025" },
      { acc: "2150", cr: otherLiab["2150"], desc: "BPJS Oktober 2025" },
      { acc: "3100", cr: world.openingEquity.modal, desc: "Modal disetor" },
      { acc: "3200", cr: retained, desc: "Saldo laba ditahan" },
    ],
  });
  // opening PPN payable settled in November
  cash.push({ key: "SETOR-PPN-2025-10", date: "2025-11-14", bank: "MDR", dir: "out", amount: taxPayable, category: "PAJAK-BPJS", desc: "Setoran PPN masa Oktober 2025", counter: [{ acc: "2410", dr: taxPayable, desc: "Setoran PPN" }], prio: 4 });
  // opening balances in the cash ledger journal are part of the opening journal (no cash event)

  // nothing is booked in the future
  cash.splice(0, cash.length, ...cash.filter((e) => e.date <= today));
  world.journals = world.journals.filter((j) => j.date <= today);
  // sort cash events and inject transfers between bank accounts -----------------------------------
  cash.sort((a, b) => (a.date === b.date ? a.prio - b.prio || a.key.localeCompare(b.key) : a.date < b.date ? -1 : 1));
  const bal: Record<BankKey, number> = { MDR: 0, REC: 0, PAY: 0, KAS: 0 };
  for (const b of BANK_ACCOUNTS) bal[b.code === "KAS-KECIL" ? "KAS" : b.code === "BANK-MDR-OPS" ? "MDR" : b.code === "BANK-BCA-REC" ? "REC" : "PAY"] = openingOf(b);
  const finalCash: CashEv[] = [];
  const buffer: Record<BankKey, number> = { MDR: 120_000_000, PAY: 5_000_000, KAS: 2_000_000, REC: 0 };
  let tseq = 0;
  let negSeen = false;
  let minRec = Infinity;
  const addTransfer = (date: string, to: BankKey, amount: number, why: string) => {
    tseq++;
    const ev: CashEv = { key: `TRF-${date.replace(/-/g, "")}-${tseq}`, date, bank: "REC", dir: "out", amount, category: "TRANSFER-INTERNAL", desc: why, counter: [], xfer: { from: "REC", to }, prio: 0 };
    if (to === "KAS") ev.xfer = { from: "MDR", to };
    if (to === "KAS") ev.bank = "MDR";
    finalCash.push(ev);
    bal[ev.xfer!.from] -= amount;
    bal[to] += amount;
  };
  for (const ev of cash) {
    if (ev.dir === "out" && ev.bank !== "REC") {
      const need = ev.amount + buffer[ev.bank] - bal[ev.bank];
      if (need > 0) {
        if (ev.bank === "KAS") addTransfer(ev.date, "KAS", roundK(Math.max(need, 10_000_000), 1_000_000), "Pengisian kas kecil dari rekening operasional");
        else if (ev.bank === "PAY") addTransfer(ev.date, "PAY", roundK(need + 1_000_000, 1_000_000), "Dana penggajian dari rekening penerimaan");
        else addTransfer(ev.date, "MDR", Math.ceil(need / 100_000_000) * 100_000_000, "Pengisian rekening operasional dari rekening penerimaan");
      }
    }
    finalCash.push(ev);
    bal[ev.bank] += ev.dir === "in" ? ev.amount : -ev.amount;
    if (bal.REC < minRec) minRec = bal.REC;
    if (bal.REC < 0 && !negSeen) {
      negSeen = true;
      ctx.log(S, `WARNING: simulated REC balance negative on ${ev.date} (${ev.key}): ${bal.REC}`);
    }
  }
  ctx.log(S, `simulated minimum balance of the penerimaan account: ${minRec}`);
  world.cash = finalCash;
  for (const k of Object.keys(bal) as BankKey[]) if (bal[k] < 0) ctx.log(S, `WARNING: simulated ${k} balance ends negative (${bal[k]})`);
  (world as any).endBalances = bal;
  return world;
}

async function loadInput(ctx: DemoCtx): Promise<WorldInput> {
  const t = ctx.tenantId;
  const custStart = new Map<string, string>();
  const first = ctx.cal.months[0];
  for (const c of CUSTOMERS) {
    const sm = c.contract.startDate.slice(0, 7);
    custStart.set(c.code, sm < first ? first : sm);
  }
  // payroll runs written by the workforce sector (take the biggest run per month)
  const rows = await ctx.sql<{ y: number; m: number; g: string; d: string; n: string; e: string }>(
    `SELECT period_year y, period_month m, max(total_gross) g, max(total_deductions) d, max(total_net) n, max(total_employer_contributions) e
       FROM workforce_payroll_runs WHERE tenant_id = $1 AND total_gross > 100000000 GROUP BY 1, 2`,
    [t],
  );
  const payroll = new Map<string, { gross: number; deductions: number; net: number; employer: number }>();
  for (const r of rows) {
    payroll.set(`${r.y}-${String(r.m).padStart(2, "0")}`, { gross: Number(r.g), deductions: Number(r.d), net: Number(r.n), employer: Number(r.e) });
  }
  const supplierTerms = new Map<string, number>();
  for (const s of SUPPLIERS) supplierTerms.set(s.code, TERM_DAYS[s.paymentTermCode] ?? 30);
  for (const s of EXTRA_SUPPLIERS) supplierTerms.set(s.code, TERM_DAYS[s.terms] ?? 30);
  return { custStart, payroll, supplierTerms };
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

interface Refs {
  le: string;
  coa: string;
  acc: Map<string, string>;
  period: Map<string, { id: string; status: string }>;
  cust: Map<string, string>;
  sup: Map<string, string>;
  ledgerId: string | null;
}

const ts = (ctx: DemoCtx, date: string, hour: number, minute = 0) => {
  const t = ctx.cal.at(date, hour, minute);
  return t > new Date().toISOString() ? new Date().toISOString() : t;
};

async function loadRefs(ctx: DemoCtx): Promise<Refs> {
  const t = ctx.tenantId;
  const le = (await ctx.sql<{ id: string }>(`SELECT id FROM legal_entities WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [t]))[0].id;
  const coa = (await ctx.call<any[]>("GET", `/accounting/charts?legalEntityId=${le}`))[0].id as string;
  const refs: Refs = { le, coa, acc: new Map(), period: new Map(), cust: new Map(), sup: new Map(), ledgerId: null };
  await refreshAccounts(ctx, refs);
  await refreshPeriods(ctx, refs);
  for (const r of await ctx.sql<{ id: string; code: string }>(`SELECT id, code FROM customers WHERE tenant_id = $1`, [t])) refs.cust.set(r.code, r.id);
  for (const r of await ctx.sql<{ id: string; code: string }>(`SELECT id, code FROM suppliers WHERE tenant_id = $1`, [t])) refs.sup.set(r.code, r.id);
  const ledgers = await ctx.call<any[]>("GET", `/accounting/ledgers?legalEntityId=${le}`);
  refs.ledgerId = ledgers[0]?.id ?? null;
  return refs;
}
async function refreshAccounts(ctx: DemoCtx, refs: Refs) {
  refs.acc.clear();
  for (const r of await ctx.sql<{ id: string; account_code: string }>(`SELECT id, account_code FROM accounting_accounts WHERE tenant_id = $1`, [ctx.tenantId])) refs.acc.set(r.account_code, r.id);
}
async function refreshPeriods(ctx: DemoCtx, refs: Refs) {
  refs.period.clear();
  for (const r of await ctx.sql<{ id: string; date_from: Date; status: string }>(`SELECT id, date_from, status FROM accounting_periods WHERE tenant_id = $1`, [ctx.tenantId])) {
    refs.period.set(new Date(r.date_from.getTime() - r.date_from.getTimezoneOffset() * 60000).toISOString().slice(0, 7), { id: r.id, status: r.status });
  }
}

// ---- config ---------------------------------------------------------------------------------------

async function configStep(ctx: DemoCtx, refs: Refs): Promise<void> {
  const t = ctx.tenantId;
  const first = ctx.cal.months[0];
  // 1. extra GL accounts
  for (const a of EXTRA_ACCOUNTS) {
    if (refs.acc.has(a.code)) continue;
    await ctx.call("POST", "/accounting/accounts", { legalEntityId: refs.le, coaId: refs.coa, accountCode: a.code, accountName: a.name, accountClass: a.cls, normalBalance: a.normal, accountType: null });
    made("glAccount");
  }
  await refreshAccounts(ctx, refs);
  await ctx.sql(`UPDATE accounting_accounts SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND account_code = ANY($3) AND created_at > $2`, [t, ts(ctx, ctx.cal.start, 10), EXTRA_ACCOUNTS.map((a) => a.code)]);

  // 2. workflow definitions
  const have = new Set((await ctx.sql<{ code: string }>(`SELECT code FROM workflow_definitions WHERE tenant_id = $1`, [t])).map((r) => r.code));
  await ensureWorkflow(ctx, have, "finance_transaction_approval", "Persetujuan Transaksi Kas dan Bank", "finance_transaction");
  await ensureWorkflow(ctx, have, "budget_version_approval", "Persetujuan Versi Anggaran", "budget_version");
  await ensureWorkflow(ctx, have, "tax_rule_version_approval", "Persetujuan Versi Aturan Pajak", "tax_rule_version");

  // 3. finance categories (reference data)
  const cats: any[] = await ctx.call("GET", "/config/reference-data/finance_transaction_category");
  const haveCat = new Set(cats.map((c) => c.code));
  void haveCat;
  for (const [i, [code, label]] of FINANCE_CATEGORIES.entries()) {
    if (haveCat.has(catCode(code))) continue;
    await ctx.call("POST", "/config/reference-data/finance_transaction_category", { code: catCode(code), label, sortOrder: i + 1 });
    made("financeCategory");
  }

  // 4. extra service vendors
  const sups = new Set((await ctx.call<any[]>("GET", "/suppliers")).map((s) => s.code));
  for (const s of EXTRA_SUPPLIERS) {
    if (sups.has(s.code)) continue;
    await ctx.call("POST", "/suppliers", { code: s.code, name: s.name, category: s.category, contactName: s.contactName, email: s.email, phone: s.phone, address: s.address });
    made("supplier");
  }
  await ctx.sql(`UPDATE suppliers SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND code = ANY($3) AND created_at > $2`, [t, ts(ctx, first + "-09", 10), EXTRA_SUPPLIERS.map((s) => s.code)]).catch(() => undefined);
  for (const r of await ctx.sql<{ id: string; code: string }>(`SELECT id, code FROM suppliers WHERE tenant_id = $1`, [t])) refs.sup.set(r.code, r.id);

  // 5. primary ledger
  if (!refs.ledgerId) {
    const l = await ctx.call("POST", "/accounting/ledgers", { legalEntityId: refs.le, ledgerCode: "IDR-UTAMA", ledgerName: "Buku Besar Utama (SAK Indonesia, IDR)", currency: "IDR" });
    refs.ledgerId = l.id;
    made("ledger");
  }

  // 6. tax rules
  const rules: any[] = await ctx.call("GET", `/accounting/tax-rules?legalEntityId=${refs.le}`);
  const defs: { code: string; type: string; desc: string; rate: string; basis: string; acc: string; pkp: boolean }[] = [
    { code: "PPN-KELUARAN", type: "ppn", desc: "PPN Keluaran atas penyerahan jasa katering, housekeeping dan facility (11% dari DPP)", rate: "0.110000", basis: "dpp", acc: "2430", pkp: true },
    { code: "PPN-MASUKAN", type: "ppn", desc: "PPN Masukan atas pembelian barang dan jasa kena pajak (11% dari DPP)", rate: "0.110000", basis: "dpp", acc: "1230", pkp: true },
    { code: "PPH23-JASA", type: "pph23", desc: "PPh Pasal 23 atas jasa tenaga kerja alih daya dan servis (2% dari DPP)", rate: "0.020000", basis: "dpp", acc: "2440", pkp: false },
    { code: "PPH22-IMPOR", type: "pph22", desc: "PPh Pasal 22 atas pembelian peralatan impor (2,5% dari nilai impor)", rate: "0.025000", basis: "gross", acc: "1250", pkp: false },
  ];
  for (const d of defs) {
    let rule = rules.find((r) => r.ruleCode === d.code);
    if (!rule) {
      rule = await ctx.call("POST", "/accounting/tax-rules", { legalEntityId: refs.le, ruleCode: d.code, taxType: d.type, description: d.desc });
      made("taxRule");
    }
    const versions: any[] = await ctx.call("GET", `/accounting/tax-rules/${rule.id}/versions`);
    let v = versions[0];
    if (!v) {
      v = await ctx.call("POST", `/accounting/tax-rules/${rule.id}/versions`, {
        rate: d.rate, basis: d.basis, roundingMode: "half_up", requiresPkp: d.pkp, accountId: refs.acc.get(d.acc), effectiveFrom: "2025-01-01",
      });
      made("taxRuleVersion");
    }
    if (v.status === "draft") {
      await ctx.call("POST", `/accounting/tax-rule-versions/${v.id}/actions`, { actionCode: "approve", comment: "Sesuai UU HPP dan PMK yang berlaku" });
      made("taxRuleApproved");
    }
  }
  await ctx.sql(`UPDATE finance_tax_rules SET created_at = $2 WHERE tenant_id = $1 AND created_at > $2`, [t, ts(ctx, first + "-10", 10)]).catch(() => undefined);
  await ctx.sql(`UPDATE finance_tax_rule_versions SET created_at = $2 WHERE tenant_id = $1 AND created_at > $2`, [t, ts(ctx, first + "-10", 11)]).catch(() => undefined);
  ctx.log(S, `config ready (${JSON.stringify(counts)})`);
}

// ---- ledger -----------------------------------------------------------------------------------------

function cashJournal(ev: CashEv): JournalSpec {
  if (ev.xfer) {
    return {
      num: `FIN-${ev.key}`,
      date: ev.date,
      desc: ev.desc,
      bankKey: ev.key,
      lines: [
        { acc: BANK_GL[ev.xfer.to], dr: ev.amount, desc: `${ev.desc} [${ev.key}:in]` },
        { acc: BANK_GL[ev.xfer.from], cr: ev.amount, desc: `${ev.desc} [${ev.key}:out]` },
      ],
    };
  }
  const bankLine: JLine = ev.dir === "in" ? { acc: BANK_GL[ev.bank], dr: ev.amount, desc: `${ev.desc} [${ev.key}]` } : { acc: BANK_GL[ev.bank], cr: ev.amount, desc: `${ev.desc} [${ev.key}]` };
  return { num: `FIN-${ev.key}`, date: ev.date, desc: ev.desc, bankKey: ev.key, lines: [bankLine, ...ev.counter] };
}

async function postJournalSpec(ctx: DemoCtx, refs: Refs, existing: Map<string, { id: string; status: string }>, spec: JournalSpec): Promise<void> {
  const fin = USERS.finance;
  const ex = existing.get(spec.num);
  if (ex?.status === "posted" || ex?.status === "reversed") return;
  let id = ex?.id;
  if (!id) {
    const m = monthOf(spec.date);
    const period = refs.period.get(m);
    if (!period) throw new Error(`no accounting period for ${m}`);
    const dr = spec.lines.reduce((a, l) => a + (l.dr ?? 0), 0);
    const cr = spec.lines.reduce((a, l) => a + (l.cr ?? 0), 0);
    if (dr !== cr) throw new Error(`journal ${spec.num} unbalanced: ${dr} vs ${cr}`);
    const created = await ctx.callAs(fin.email, DEMO_PASSWORD, "POST", "/accounting/journals", {
      legalEntityId: refs.le,
      journalNumber: spec.num,
      journalDate: spec.date,
      accountingDate: spec.date,
      periodId: period.id,
      description: spec.desc.slice(0, 250),
      currency: "IDR",
      lines: spec.lines.map((l, i) => {
        const accId = refs.acc.get(l.acc);
        if (!accId) throw new Error(`account ${l.acc} missing`);
        return { accountId: accId, lineNumber: i + 1, debit: rp(l.dr ?? 0), credit: rp(l.cr ?? 0), lineDescription: (l.desc ?? spec.desc).slice(0, 250), projectId: null, siteId: null };
      }),
    });
    id = created.id as string;
    made("journal");
  }
  await ctx.callAs(fin.email, DEMO_PASSWORD, "POST", `/accounting/journals/${id}/post`);
  existing.set(spec.num, { id, status: "posted" });
}

/** Give every demo journal the date it was booked and posted (the kernel stamps now()). */
async function backdateJournals(ctx: DemoCtx): Promise<void> {
  const t = ctx.tenantId;
  const sel = `(h.journal_number LIKE 'FIN-%' OR h.journal_number LIKE 'DEP-dep-demo-fin%' OR h.journal_number LIKE 'CLOSE-FY%')`;
  await ctx.sql(
    `UPDATE general_ledger_entries g
        SET posting_date = LEAST(((h.accounting_date + 1)::timestamp - interval '8 hours') AT TIME ZONE 'Asia/Jakarta', now()),
            created_at   = LEAST(((h.accounting_date + 1)::timestamp - interval '8 hours') AT TIME ZONE 'Asia/Jakarta', now())
       FROM journal_lines jl JOIN journal_headers h ON h.id = jl.journal_header_id
      WHERE g.journal_line_id = jl.id AND g.tenant_id = $1 AND ${sel}
        AND (g.posting_date AT TIME ZONE 'Asia/Jakarta')::date <> h.accounting_date`,
    [t],
  );
  await ctx.sql(
    `UPDATE journal_lines jl SET created_at = LEAST(((h.accounting_date)::timestamp + interval '9 hours 20 minutes') AT TIME ZONE 'Asia/Jakarta', now())
       FROM journal_headers h
      WHERE jl.journal_header_id = h.id AND jl.tenant_id = $1 AND ${sel} AND jl.created_at::date > h.accounting_date + 1`,
    [t],
  ).catch(() => undefined);
  await ctx.sql(
    `UPDATE journal_headers h
        SET created_at = LEAST(((h.accounting_date)::timestamp + interval '9 hours 20 minutes') AT TIME ZONE 'Asia/Jakarta', now()),
            posted_date = CASE WHEN h.posted_date IS NULL THEN NULL ELSE LEAST(((h.accounting_date + 1)::timestamp - interval '8 hours') AT TIME ZONE 'Asia/Jakarta', now()) END,
            updated_at = LEAST(((h.accounting_date + 1)::timestamp - interval '8 hours') AT TIME ZONE 'Asia/Jakarta', now())
      WHERE h.tenant_id = $1 AND ${sel} AND (h.created_at AT TIME ZONE 'Asia/Jakarta')::date > h.accounting_date`,
    [t],
  );
}

async function ledgerStep(ctx: DemoCtx, refs: Refs, world: World): Promise<void> {
  const t = ctx.tenantId;
  const rows = await ctx.sql<{ id: string; journal_number: string; status: string }>(`SELECT id, journal_number, status FROM journal_headers WHERE tenant_id = $1 AND (journal_number LIKE 'FIN-%' OR journal_number LIKE 'DEP-dep-demo-fin%')`, [t]);
  const existing = new Map(rows.map((r) => [r.journal_number, { id: r.id, status: r.status }]));
  const all: JournalSpec[] = [...world.journals, ...world.cash.map(cashJournal)];
  all.sort((a, b) => (a.date === b.date ? a.num.localeCompare(b.num) : a.date < b.date ? -1 : 1));
  let n = 0;
  for (const spec of all) {
    await postJournalSpec(ctx, refs, existing, spec);
    if (++n % 200 === 0) ctx.log(S, `ledger ${n}/${all.length}`);
  }
  // reverse the utility accruals on the first day of the next month
  const fin = USERS.finance;
  for (const a of world.accruals) {
    if (a.reverseOn > ctx.cal.today) continue;
    const row = existing.get(a.num);
    if (!row) continue;
    const revNum = `FIN-ACR-REV-${a.num.slice(-7)}`;
    const spec = world.journals.find((j) => j.num === a.num)!;
    const reversal: JournalSpec = {
      num: revNum,
      date: a.reverseOn,
      desc: `Pembalikan ${spec.desc}`,
      lines: spec.lines.map((l) => ({ acc: l.acc, dr: l.cr, cr: l.dr, desc: `Pembalikan: ${l.desc ?? ""}` })),
    };
    await postJournalSpec(ctx, refs, existing, reversal);
  }
  void fin;
  await backdateJournals(ctx);
  ctx.log(S, `ledger: ${all.length} documents checked`);
}

// ---- workflow backdating --------------------------------------------------------------------------

/** Move workflow instances of the given entity ids to the (backdated) time the entity was created. */
async function backdateWorkflow(ctx: DemoCtx, table: string, createdCol = "created_at"): Promise<void> {
  const t = ctx.tenantId;
  await ctx.sql(
    `UPDATE workflow_instances wi
        SET started_at = x.${createdCol},
            completed_at = CASE WHEN wi.completed_at IS NULL THEN NULL ELSE LEAST(x.${createdCol} + interval '3 hours', now()) END
       FROM ${table} x
      WHERE wi.tenant_id = $1 AND wi.entity_id = x.id AND x.tenant_id = $1
        AND wi.started_at > x.${createdCol} + interval '1 day'`,
    [t],
  );
  await ctx.sql(
    `UPDATE workflow_instance_assignments a
        SET assigned_at = wi.started_at,
            decided_at = CASE WHEN a.decided_at IS NULL THEN NULL ELSE LEAST(wi.started_at + interval '3 hours', now()) END
       FROM workflow_instances wi
      WHERE a.workflow_instance_id = wi.id AND wi.tenant_id = $1 AND wi.entity_type IN ('finance_transaction','budget_version','tax_rule_version')
        AND a.assigned_at > wi.started_at + interval '1 day'`,
    [t],
  );
  await ctx.sql(
    `UPDATE workflow_history h SET occurred_at = LEAST(wi.started_at + interval '3 hours', now())
       FROM workflow_instances wi
      WHERE h.workflow_instance_id = wi.id AND wi.tenant_id = $1 AND wi.entity_type IN ('finance_transaction','budget_version','tax_rule_version')
        AND h.occurred_at > wi.started_at + interval '1 day'`,
    [t],
  );
}

// ---- cash / bank ledger --------------------------------------------------------------------------

interface TxSpec {
  ref: string;
  date: string;
  dir: "income" | "expense";
  account: string;
  category: string;
  amount: number;
  desc: string;
  customerCode?: string;
  approve: boolean;
  /** "reject" instead of approve */
  reject?: boolean;
}

async function cashStep(ctx: DemoCtx, refs: Refs, world: World): Promise<void> {
  const t = ctx.tenantId;
  const fin = USERS.finance;
  const f = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(fin.email, DEMO_PASSWORD, method, url, body);
  const first = ctx.cal.months[0];
  const specs: TxSpec[] = [];
  for (const b of BANK_ACCOUNTS) {
    specs.push({ ref: `SALDO-AWAL-${b.code}`, date: `${first}-01`, dir: "income", account: b.code, category: "SALDO-AWAL", amount: openingOf(b), desc: `Saldo awal ${b.name} (migrasi pembukuan)`, approve: true });
  }
  for (const ev of world.cash) {
    if (ev.xfer) {
      specs.push({ ref: `${ev.key}:out`, date: ev.date, dir: "expense", account: BANK_CODE[ev.xfer.from], category: ev.category, amount: ev.amount, desc: ev.desc, approve: true });
      specs.push({ ref: `${ev.key}:in`, date: ev.date, dir: "income", account: BANK_CODE[ev.xfer.to], category: ev.category, amount: ev.amount, desc: ev.desc, approve: true });
    } else {
      specs.push({ ref: ev.key, date: ev.date, dir: ev.dir === "in" ? "income" : "expense", account: BANK_CODE[ev.bank], category: ev.category, amount: ev.amount, desc: ev.desc, customerCode: ev.customerCode, approve: true });
    }
  }
  // the newest requests are still waiting for approval
  const pendingFrom = Math.max(0, specs.length - 7);
  specs.forEach((sp, i) => {
    if (i >= pendingFrom && sp.date >= addDays(ctx.cal.today, -3)) sp.approve = false;
  });

  const rows = await ctx.sql<{ reference: string; id: string; applied_at: Date | null; reversed_by_transaction_id: string | null }>(
    `SELECT reference, id, applied_at, reversed_by_transaction_id FROM finance_transactions WHERE tenant_id = $1 AND reference IS NOT NULL`,
    [t],
  );
  const have = new Map(rows.map((r) => [r.reference, r]));
  let n = 0;
  const act = async (id: string, action: string, comment: string) => {
    await f("POST", `/finance/transactions/${id}/actions/${action}`, { comment });
  };
  const record = async (sp: TxSpec) => {
    const cur = have.get(sp.ref);
    if (cur) {
      if (sp.approve && !cur.applied_at) {
        await act(cur.id, "approve", "Disetujui Finance Manager");
        made("financeTxApproved");
      }
      return cur.id;
    }
    const tx = await f("POST", "/finance/transactions", {
      direction: sp.dir,
      amount: rp(sp.amount),
      transactionDate: sp.date,
      accountCode: sp.account,
      categoryCode: catCode(sp.category),
      description: sp.desc.slice(0, 240),
      reference: sp.ref,
      legalEntityId: refs.le,
      customerId: sp.customerCode ? refs.cust.get(sp.customerCode) ?? null : null,
    });
    const id = (tx.transaction?.id ?? tx.id) as string;
    made("financeTx");
    if (sp.reject) {
      await act(id, "reject", "Ditolak: melebihi batas kas kecil, ajukan melalui PO");
      made("financeTxRejected");
    } else if (sp.approve) {
      await act(id, "approve", dateComment(sp.date));
    }
    have.set(sp.ref, { reference: sp.ref, id, applied_at: sp.approve ? new Date() : null, reversed_by_transaction_id: null });
    return id;
  };
  const dateComment = (d: string) => `Disetujui, sesuai bukti transaksi ${d}`;
  for (const sp of specs) {
    await record(sp);
    if (++n % 300 === 0) ctx.log(S, `cash ledger ${n}/${specs.length}`);
  }
  // exceptions: a rejected petty-cash request, and a duplicated entry that was reversed
  await record({ ref: "EXTRA-KAS-DITOLAK-1", date: "2026-08-19", dir: "expense", account: "KAS-KECIL", category: "OPERASIONAL-UMUM", amount: 18_500_000, desc: "Permintaan kas kecil renovasi pantry kantor (melebihi batas)", approve: false, reject: true });
  const dupId = await record({ ref: "EXTRA-BBM-GANDA-1", date: "2026-06-12", dir: "expense", account: "BANK-MDR-OPS", category: "BBM-TRANSPORT", amount: 7_250_000, desc: "Top-up kartu BBM armada (tercatat ganda)", approve: true });
  const dupRow = (await ctx.sql<{ reversed_by_transaction_id: string | null }>(`SELECT reversed_by_transaction_id FROM finance_transactions WHERE id = $1`, [dupId]))[0];
  if (dupRow && !dupRow.reversed_by_transaction_id) {
    const rev = await f("POST", `/finance/transactions/${dupId}/reversal`, { reason: "Koreksi: pencatatan ganda top-up kartu BBM", transactionDate: "2026-06-13" });
    const rid = (rev.transaction?.id ?? rev.id) as string;
    await ctx.sql(`UPDATE finance_transactions SET reference = $2 WHERE id = $1`, [rid, "EXTRA-BBM-GANDA-1:rev"]);
    await act(rid, "approve", "Pembalikan disetujui");
    made("financeTxReversed");
  }
  // backdate
  await ctx.sql(
    `UPDATE finance_transactions
        SET created_at = LEAST(((transaction_date)::timestamp + interval '9 hours 40 minutes') AT TIME ZONE 'Asia/Jakarta', now()),
            updated_at = LEAST(((transaction_date)::timestamp + interval '15 hours') AT TIME ZONE 'Asia/Jakarta', now()),
            applied_at = CASE WHEN applied_at IS NULL THEN NULL ELSE LEAST(((transaction_date)::timestamp + interval '15 hours') AT TIME ZONE 'Asia/Jakarta', now()) END
      WHERE tenant_id = $1 AND reference IS NOT NULL AND (created_at AT TIME ZONE 'Asia/Jakarta')::date > transaction_date + 1`,
    [t],
  );
  await backdateWorkflow(ctx, "finance_transactions");
  await ctx.sql(`UPDATE finance_accounts SET updated_at = now() WHERE tenant_id = $1 AND false`, [t]);
  ctx.log(S, `cash ledger: ${specs.length + 2} transactions checked`);
}

// ---- AR / AP open items and allocations ------------------------------------------------------------

async function openItemStep(ctx: DemoCtx, refs: Refs, world: World): Promise<void> {
  const t = ctx.tenantId;
  const fin = USERS.finance;
  const f = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(fin.email, DEMO_PASSWORD, method, url, body);
  const rows = await ctx.sql<{ source_ref_table: string; source_ref_id: string; id: string }>(`SELECT source_ref_table, source_ref_id, id FROM finance_open_items WHERE tenant_id = $1`, [t]);
  const have = new Map(rows.map((r) => [`${r.source_ref_table}:${r.source_ref_id}`, r.id]));
  const allocKeys = new Set((await ctx.sql<{ idempotency_key: string }>(`SELECT idempotency_key FROM finance_open_item_allocations WHERE tenant_id = $1`, [t])).map((r) => r.idempotency_key));

  const item = async (o: {
    side: "AR" | "AP";
    direction: "debit" | "credit";
    kind: string;
    table: string;
    refId: string;
    party: "customer" | "supplier";
    partyId: string;
    docNo: string;
    date: string;
    due?: string | null;
    amount: number | string;
  }): Promise<string> => {
    const k = `${o.table}:${o.refId}`;
    const cur = have.get(k);
    if (cur) return cur;
    const created = await f("POST", "/accounting/open-items", {
      legalEntityId: refs.le,
      side: o.side,
      direction: o.direction,
      sourceKind: o.kind,
      sourceRefTable: o.table,
      sourceRefId: o.refId,
      partyType: o.party,
      partyId: o.partyId,
      documentNo: o.docNo,
      documentDate: o.date,
      dueDate: o.due ?? null,
      currency: "IDR",
      originalAmount: typeof o.amount === "number" ? rp(o.amount) : o.amount,
    });
    have.set(k, created.id);
    made(o.side === "AR" ? "arOpenItem" : "apOpenItem");
    return created.id as string;
  };
  const alloc = async (key: string, source: string, target: string, amount: number | string, date: string) => {
    const idem = `demo-fin:alloc:${key}`;
    if (allocKeys.has(idem)) return;
    await f("POST", "/accounting/open-items/allocate", {
      legalEntityId: refs.le,
      sourceOpenItemId: source,
      targetOpenItemId: target,
      amount: typeof amount === "number" ? rp(amount) : amount,
      allocationDate: date,
      idempotencyKey: idem,
    });
    allocKeys.add(idem);
    made("allocation");
  };

  for (const inv of world.invoices) {
    const custId = refs.cust.get(inv.custCode);
    if (!custId) continue;
    const invId = await item({ side: "AR", direction: "debit", kind: "invoice", table: "customer_invoices", refId: uuidOf(`inv:${inv.key}`), party: "customer", partyId: custId, docNo: inv.docNo, date: inv.date, due: inv.due, amount: inv.total });
    for (const [i, p] of inv.pays.entries()) {
      const rcp = await item({ side: "AR", direction: "credit", kind: "payment", table: "scm_payment_lines", refId: uuidOf(`rcp:${p.key}`), party: "customer", partyId: custId, docNo: `RCP-${inv.docNo}-${i + 1}`, date: p.date, amount: p.cash });
      await alloc(`rcp:${p.key}`, rcp, invId, p.cash, p.date);
      if (p.wh > 0) {
        const wht = await item({ side: "AR", direction: "credit", kind: "withholding", table: "scm_payment_lines", refId: uuidOf(`wht:${p.key}`), party: "customer", partyId: custId, docNo: `BP23-${inv.docNo}-${i + 1}`, date: p.date, amount: p.wh });
        await alloc(`wht:${p.key}`, wht, invId, p.wh, p.date);
      }
    }
  }
  for (const b of world.bills) {
    const supId = refs.sup.get(b.supCode);
    if (!supId) continue;
    const billId = await item({ side: "AP", direction: "debit", kind: "invoice", table: "scm_vendor_invoices", refId: uuidOf(`bill:${b.key}`), party: "supplier", partyId: supId, docNo: b.docNo, date: b.date, due: b.due, amount: b.total });
    if (b.credit) {
      const cn = await item({ side: "AP", direction: "credit", kind: "credit_note", table: "scm_vendor_invoices", refId: uuidOf(`cn:${b.credit.key}`), party: "supplier", partyId: supId, docNo: `CN-${b.docNo}`, date: b.credit.date, amount: b.credit.amount });
      await alloc(`cn:${b.credit.key}`, cn, billId, b.credit.amount, b.credit.date);
    }
    for (const [i, p] of b.pays.entries()) {
      const pay = await item({ side: "AP", direction: "credit", kind: "payment", table: "scm_payment_lines", refId: uuidOf(`pay:${p.key}`), party: "supplier", partyId: supId, docNo: `PAY-${b.docNo}-${i + 1}`, date: p.date, amount: p.cash });
      await alloc(`pay:${p.key}`, pay, billId, p.cash, p.date);
      if (p.wh > 0) {
        const wht = await item({ side: "AP", direction: "credit", kind: "withholding", table: "scm_payment_lines", refId: uuidOf(`pwht:${p.key}`), party: "supplier", partyId: supId, docNo: `BP23-${b.docNo}-${i + 1}`, date: p.date, amount: p.wh });
        await alloc(`pwht:${p.key}`, wht, billId, p.wh, p.date);
      }
    }
  }
  // work-order invoices raised by service operations are receivables too
  const cis = await ctx.sql<{ id: string; invoice_number: string; customer_id: string; total_amount: string; issued_at: Date; ar_status: string }>(
    `SELECT id, invoice_number, customer_id, total_amount, issued_at, ar_status FROM customer_invoices WHERE tenant_id = $1 AND ar_status <> 'cancelled'`,
    [t],
  );
  for (const ci of cis) {
    const date = new Date(ci.issued_at.getTime() + 7 * 3600000).toISOString().slice(0, 10);
    const invId = await item({ side: "AR", direction: "debit", kind: "invoice", table: "customer_invoices", refId: ci.id, party: "customer", partyId: ci.customer_id, docNo: ci.invoice_number, date, due: addDays(date, 30), amount: Number(ci.total_amount).toFixed(4) });
    if (ci.ar_status === "settled") {
      const pd = addDays(date, 24) > ctx.cal.today ? ctx.cal.today : addDays(date, 24);
      const rcp = await item({ side: "AR", direction: "credit", kind: "payment", table: "scm_payment_lines", refId: uuidOf(`rcp:ci:${ci.id}`), party: "customer", partyId: ci.customer_id, docNo: `RCP-${ci.invoice_number}`, date: pd, amount: Number(ci.total_amount).toFixed(4) });
      await alloc(`rcp:ci:${ci.id}`, rcp, invId, Number(ci.total_amount).toFixed(4), pd);
    }
  }
  await ctx.sql(
    `UPDATE finance_open_items SET created_at = LEAST(((document_date)::timestamp + interval '10 hours') AT TIME ZONE 'Asia/Jakarta', now())
      WHERE tenant_id = $1 AND (created_at AT TIME ZONE 'Asia/Jakarta')::date > document_date + 1`,
    [t],
  );
  await ctx.sql(
    `UPDATE finance_open_item_allocations SET created_at = LEAST(((allocation_date)::timestamp + interval '14 hours') AT TIME ZONE 'Asia/Jakarta', now())
      WHERE tenant_id = $1 AND (created_at AT TIME ZONE 'Asia/Jakarta')::date > allocation_date + 1`,
    [t],
  );
  ctx.log(S, `open items checked: ${rows.length} existing at start`);
}

// ---- tax calculations ----------------------------------------------------------------------------------

async function taxStep(ctx: DemoCtx, refs: Refs, world: World): Promise<void> {
  const t = ctx.tenantId;
  const fin = USERS.finance;
  const have = new Set((await ctx.sql<{ idempotency_key: string }>(`SELECT idempotency_key FROM finance_tax_calculations WHERE tenant_id = $1`, [t])).map((r) => r.idempotency_key));
  for (const c of world.taxCalcs) {
    if (c.basis <= 0 || c.date > ctx.cal.today) continue;
    const key = `demo-fin:tax:${c.key}`;
    if (have.has(key)) continue;
    await ctx.callAs(fin.email, DEMO_PASSWORD, "POST", "/accounting/tax-calculations", {
      legalEntityId: refs.le,
      ruleCode: c.rule,
      basisAmount: rp(c.basis),
      calculationDate: c.date,
      currency: "IDR",
      idempotencyKey: key,
    });
    have.add(key);
    made("taxCalculation");
  }
  await ctx.sql(
    `UPDATE finance_tax_calculations SET created_at = LEAST(((calculation_date)::timestamp + interval '16 hours') AT TIME ZONE 'Asia/Jakarta', now())
      WHERE tenant_id = $1 AND (created_at AT TIME ZONE 'Asia/Jakarta')::date > calculation_date + 1`,
    [t],
  );
}

// ---- fixed assets and depreciation -----------------------------------------------------------------------

async function assetStep(ctx: DemoCtx, refs: Refs, world: World): Promise<void> {
  const t = ctx.tenantId;
  const f = <T = any>(method: any, url: string, body?: unknown) => ctx.call<T>(method, url, body); // finance officers have no asset.read
  const orgs = await ctx.call<any[]>("GET", "/organization-units");
  const org = (name: string): string | null => orgs.find((o) => o.name === name)?.id ?? null;
  const BOOK = "KOMERSIAL";
  for (const a of world.assets) {
    let asset = (await ctx.sql<{ id: string }>(`SELECT id FROM assets WHERE tenant_id = $1 AND asset_tag = $2`, [t, a.tag]))[0];
    if (!asset) {
      const unit = a.category === "Kendaraan" ? org("Warehouse & Logistics") : a.category === "Peralatan Kebersihan" ? org("Facility Services") : org("Catering Operations");
      const created = await ctx.call("POST", "/assets", {
        name: a.name,
        assetTag: a.tag,
        description: a.note,
        category: a.category,
        status: "in_use",
        organizationUnitId: unit,
        acquisitionReference: `PO/${a.date.slice(0, 4)}/${a.tag.slice(-3)}`,
        acquiredAt: a.date,
      });
      asset = { id: (created.id ?? created.asset?.id ?? (await ctx.sql<{ id: string }>(`SELECT id FROM assets WHERE tenant_id = $1 AND asset_tag = $2`, [t, a.tag]))[0].id) as string };
      made("asset");
      await ctx.sql(`UPDATE assets SET created_at = $2, updated_at = $2 WHERE id = $1 AND tenant_id = $3`, [asset.id, ts(ctx, a.date, 11), t]);
    }
    let book = (await ctx.sql<{ id: string; status: string }>(`SELECT id, status FROM finance_asset_books WHERE tenant_id = $1 AND asset_id = $2 AND book_code = $3`, [t, asset.id, BOOK]))[0];
    if (!book) {
      const created = await f("POST", "/accounting/asset-books", {
        legalEntityId: refs.le,
        ledgerId: refs.ledgerId,
        assetId: asset.id,
        bookCode: BOOK,
        assetClass: a.category,
        capitalizationDate: a.date,
        inServiceDate: addDays(a.date, 3),
        acquisitionCost: rp(a.cost),
        residualValue: rp(roundK(a.cost * 0.05, 1_000_000)),
        usefulLifeMonths: a.lifeMonths,
        depreciationExpenseAccountId: refs.acc.get("6400"),
        accumulatedDepreciationAccountId: refs.acc.get("1590"),
      });
      book = { id: created.id, status: created.status ?? "draft" };
      made("assetBook");
    }
    if (book.status === "draft") {
      await f("POST", `/accounting/asset-books/${book.id}/activate`);
      made("assetBookActivated");
    }
    await ctx.sql(`UPDATE finance_asset_books SET created_at = $2, updated_at = $2 WHERE id = $1 AND tenant_id = $3 AND created_at > $2`, [book.id, ts(ctx, a.date, 14), t]);
  }
  // monthly depreciation runs for every month that has ended
  const currentMonth = monthOf(ctx.cal.today);
  for (const m of ctx.cal.months) {
    if (m >= currentMonth) continue;
    const period = refs.period.get(m);
    if (!period) continue;
    const key = `demo-fin-dep-${m}`;
    const done = await ctx.sql(`SELECT 1 FROM finance_depreciation_runs WHERE tenant_id = $1 AND idempotency_key = $2`, [t, key]);
    if (done.length > 0) continue;
    if (period.status !== "open") continue;
    const eom = workdayOnOrBefore(`${m}-${String(lastDom(m)).padStart(2, "0")}`);
    try {
      await f("POST", "/accounting/depreciation-runs", {
        legalEntityId: refs.le,
        bookCode: BOOK,
        periodId: period.id,
        idempotencyKey: key,
        journalDate: eom,
        description: `Penyusutan aset tetap ${periodCodeOf(m).periodName}`,
      });
      made("depreciationRun");
    } catch (e: any) {
      if (!/nothing left|No active asset books/.test(String(e?.message))) throw e;
    }
  }
  await ctx.sql(
    `UPDATE finance_depreciation_runs r SET created_at = LEAST(((p.date_to)::timestamp + interval '16 hours') AT TIME ZONE 'Asia/Jakarta', now())
       FROM accounting_periods p WHERE r.tenant_id = $1 AND p.id = r.period_id AND r.created_at > p.date_to + 2`,
    [t],
  );
  await ctx.sql(
    `UPDATE finance_depreciation_run_lines l SET created_at = r.created_at FROM finance_depreciation_runs r WHERE l.run_id = r.id AND l.tenant_id = $1 AND l.created_at > r.created_at + interval '1 day'`,
    [t],
  );
  await backdateJournals(ctx);
  ctx.log(S, "fixed assets and depreciation done");
}

// ---- budgets -----------------------------------------------------------------------------------------------

async function budgetStep(ctx: DemoCtx, refs: Refs, world: World): Promise<void> {
  const t = ctx.tenantId;
  const fin = USERS.finance;
  const f = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(fin.email, DEMO_PASSWORD, method, url, body);
  const me = await f("GET", "/me");
  const cc = new Map((await ctx.sql<{ code: string; id: string }>(`SELECT code, id FROM finance_cost_centers WHERE tenant_id = $1`, [t])).map((r) => [r.code, r.id]));
  const year = "2026";
  const months26 = ctx.cal.months.filter((m) => m.startsWith(year));
  const lastFull = [...months26].filter((m) => m < monthOf(ctx.cal.today)).pop()!;
  const currentMonth = monthOf(ctx.cal.today);
  const allMonths = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  const defs: { code: string; name: string; bucket: "cat" | "fac" | "ho" | "prj"; cc: string; from: string; to: string; v1: number; v2: number; pendingV3?: boolean }[] = [
    { code: "BUD-CAT", name: "Anggaran Operasional Katering FY2026", bucket: "cat", cc: "CC-CAT", from: "5100", to: "5399", v1: 0.91, v2: 1.03 },
    { code: "BUD-FAC", name: "Anggaran Tenaga Kerja dan Layanan Facility FY2026", bucket: "fac", cc: "CC-FAC", from: "5110", to: "5299", v1: 0.86, v2: 0.965 },
    { code: "BUD-HO", name: "Anggaran Umum, Administrasi dan Kantor Pusat FY2026", bucket: "ho", cc: "CC-HO", from: "6100", to: "6999", v1: 0.97, v2: 1.0, pendingV3: true },
    { code: "BUD-PRJ", name: "Anggaran Pengembangan Kapasitas dan Aset FY2026", bucket: "prj", cc: "CC-PRJ", from: "1510", to: "1530", v1: 1.1, v2: 1.1 },
  ];
  const monthSpend = (bucket: "cat" | "fac" | "ho" | "prj", m: string): number => {
    if (bucket === "prj") return world.assets.filter((a) => monthOf(a.date) === m).reduce((a, x) => a + x.cost, 0);
    return world.spend.get(m)?.[bucket] ?? 0;
  };
  const annualForecast = (bucket: "cat" | "fac" | "ho" | "prj"): { total: number; weights: Map<string, number> } => {
    const weights = new Map<string, number>();
    let total = 0;
    const level = monthSpend(bucket, lastFull);
    for (const m of allMonths) {
      let v: number;
      if (bucket === "prj") v = m <= lastFull ? monthSpend(bucket, m) : 0;
      else v = m <= lastFull ? monthSpend(bucket, m) : level * (1 + 0.025 * (allMonths.indexOf(m) - allMonths.indexOf(lastFull)));
      if (bucket === "prj" && v === 0) v = 0;
      weights.set(m, v);
      total += v;
    }
    if (bucket === "prj") {
      // planned programme for the second half: genset, truck, scrubber already bought; a plant expansion is pencilled in
      weights.set("2026-11", 150_000_000);
      weights.set("2026-12", 120_000_000);
      total += 270_000_000;
    }
    return { total, weights };
  };

  // policies
  const policies: any[] = await f("GET", `/accounting/budget-policies?legalEntityId=${refs.le}`);
  const ensurePolicy = async (effect: string, ccCode: string | null, threshold: string | null) => {
    if (policies.some((p) => p.effect === effect && (p.costCenterId ?? null) === (ccCode ? cc.get(ccCode) : null))) return;
    const p = await f("POST", "/accounting/budget-policies", { legalEntityId: refs.le, effect, costCenterId: ccCode ? cc.get(ccCode) : null, amountThreshold: threshold, effectiveFrom: "2026-01-01" });
    policies.push(p);
    made("budgetPolicy");
  };
  await ensurePolicy("advisory", "CC-CAT", null);
  await ensurePolicy("advisory", "CC-FAC", null);
  await ensurePolicy("escalation", "CC-HO", "75000000");
  await ensurePolicy("hard_stop", "CC-PRJ", null);
  await ctx.sql(`UPDATE finance_budget_policies SET created_at = $2 WHERE tenant_id = $1 AND created_at > $2`, [t, ts(ctx, "2026-01-05", 10)]);

  for (const d of defs) {
    const { total, weights } = annualForecast(d.bucket);
    let budget = (await ctx.sql<{ id: string }>(`SELECT id FROM finance_budgets WHERE tenant_id = $1 AND name = $2`, [t, d.name]))[0];
    if (!budget) {
      const created = await f("POST", "/accounting/budgets", {
        legalEntityId: refs.le,
        fiscalYearCode: `FY${year}`,
        scenario: "original",
        currency: "IDR",
        name: d.name,
        ownerUserId: me.userId,
        scope: { costCenterId: cc.get(d.cc), accountFrom: d.from, accountTo: d.to },
      });
      budget = { id: created.id };
      made("budget");
    }
    const versions = async () => ctx.sql<{ id: string; version_number: number; status: string }>(`SELECT id, version_number, status FROM finance_budget_versions WHERE budget_id = $1 ORDER BY version_number`, [budget.id]);
    const mkVersion = async (n: number, factor: number, note: string, approve: boolean) => {
      if ((await versions()).some((v) => v.version_number === n)) return;
      const ratio = factor;
      const created = await f("POST", `/accounting/budgets/${budget.id}/versions`, {
        totalAmount: rp(roundK(total * ratio, 1_000_000)) + "",
        weights: allMonths.map((m) => ({ periodCode: periodCodeOf(m).periodCode, weight: String(Math.max(1, Math.round((weights.get(m) ?? 0) / 1_000_000))) })),
        note,
      });
      made("budgetVersion");
      if (approve) {
        await f("POST", `/accounting/budget-versions/${created.id}/actions`, { actionCode: "approve", comment: "Disetujui Direksi" });
        made("budgetVersionApproved");
      }
    };
    const consume = async (m: string, kind: "actual" | "commitment", amount: number, note: string) => {
      if (amount <= 0) return;
      const key = `demo-fin:bud:${d.code}:${m}:${kind}`;
      const hit = await ctx.sql(`SELECT 1 FROM finance_budget_consumptions WHERE tenant_id = $1 AND idempotency_key = $2`, [t, key]);
      if (hit.length > 0) return;
      await f("POST", "/accounting/budget-consumptions", {
        budgetId: budget.id,
        periodCode: periodCodeOf(m).periodCode,
        amount: rp(amount),
        kind,
        costCenterId: cc.get(d.cc),
        idempotencyKey: key,
        note,
      });
      made("budgetConsumption");
    };
    await mkVersion(1, d.v1, "Anggaran awal tahun disetujui bersama target penjualan FY2026", true);
    for (const m of months26.filter((x) => x <= "2026-06" && x < currentMonth)) await consume(m, "actual", monthSpend(d.bucket, m), `Realisasi ${periodCodeOf(m).periodName} dari buku besar`);
    await mkVersion(2, d.v2, "Revisi semester II: tambahan pelanggan CUST-108 s.d. CUST-112 dan kenaikan harga bahan pangan", true);
    for (const m of months26.filter((x) => x > "2026-06" && x < currentMonth)) await consume(m, "actual", monthSpend(d.bucket, m), `Realisasi ${periodCodeOf(m).periodName} dari buku besar`);
    // the running month: actuals so far and open purchase commitments
    if (months26.includes(currentMonth)) {
      await consume(currentMonth, "actual", monthSpend(d.bucket, currentMonth), `Realisasi berjalan ${periodCodeOf(currentMonth).periodName}`);
      if (d.bucket === "cat") await consume(currentMonth, "commitment", 980_000_000, "Komitmen PO bahan pangan dan kemasan yang belum diterima");
      if (d.bucket === "fac") await consume(currentMonth, "commitment", 410_000_000, "Komitmen kontrak tenaga alih daya November");
      if (d.bucket === "prj") await consume(currentMonth, "commitment", 150_000_000, "Komitmen PO peralatan ekspansi plant Karawang");
    }
    if (d.pendingV3) await mkVersion(3, 1.07, "Usulan revisi: tambahan anggaran kendaraan operasional dan lisensi software (menunggu persetujuan)", false);
  }
  // timestamps
  const bt = ts(ctx, "2026-01-05", 10);
  await ctx.sql(`UPDATE finance_budgets SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND created_at > $2`, [t, bt]);
  await ctx.sql(
    `UPDATE finance_budget_versions v
        SET created_at = CASE v.version_number WHEN 1 THEN $2::timestamptz WHEN 2 THEN $3::timestamptz ELSE $4::timestamptz END,
            approved_at = CASE WHEN v.approved_at IS NULL THEN NULL WHEN v.version_number = 1 THEN $2::timestamptz + interval '2 days' ELSE $3::timestamptz + interval '3 days' END
      WHERE v.tenant_id = $1 AND v.created_at > $2::timestamptz + interval '1 day'`,
    [t, ts(ctx, "2026-01-06", 10), ts(ctx, "2026-07-06", 10), ts(ctx, "2026-10-20", 10)],
  );
  await ctx.sql(
    `UPDATE finance_budget_consumptions c
        SET created_at = LEAST(((CASE WHEN c.kind = 'commitment' THEN $2::date ELSE (to_date(c.period_code, 'MON-YYYY') + interval '1 month' - interval '1 day')::date END)::timestamp + interval '17 hours') AT TIME ZONE 'Asia/Jakarta', now())
      WHERE c.tenant_id = $1 AND c.created_at > now() - interval '3 hours'`,
    [t, addDays(ctx.cal.today, -2)],
  );
  await backdateWorkflow(ctx, "finance_budget_versions");
  ctx.log(S, "budgets done");
}

// ---- bank statements and reconciliation --------------------------------------------------------------------

async function reconStep(ctx: DemoCtx, refs: Refs): Promise<void> {
  const t = ctx.tenantId;
  const fin = USERS.finance;
  const f = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(fin.email, DEMO_PASSWORD, method, url, body);
  const today = ctx.cal.today;
  const currentMonth = monthOf(today);
  const lastFull = prevMonth(currentMonth);
  const banks = await ctx.sql<{ id: string; house_bank_code: string; ledger_account_id: string; bank_name: string }>(
    `SELECT id, house_bank_code, ledger_account_id, bank_name FROM finance_bank_accounts WHERE tenant_id = $1 ORDER BY house_bank_code`,
    [t],
  );
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  for (const bank of banks) {
    const entries = await ctx.sql<{ gid: string; d: string | null; jn: string; ad: string; debit: string; credit: string }>(
      `SELECT g.id AS gid, jl.line_description AS d, h.journal_number AS jn, to_char(h.accounting_date, 'YYYY-MM-DD') AS ad, g.debit::text AS debit, g.credit::text AS credit
         FROM general_ledger_entries g
         JOIN journal_lines jl ON jl.id = g.journal_line_id
         JOIN journal_headers h ON h.id = jl.journal_header_id
        WHERE g.tenant_id = $1 AND g.account_id = $2 AND h.status = 'posted'
        ORDER BY h.accounting_date, h.journal_number`,
      [t, bank.ledger_account_id],
    );
    interface L { ext: string; gid: string | null; value: string; amount: string; dir: "debit" | "credit"; ref: string; party: string }
    const lines: L[] = [];
    for (const e of entries) {
      const isIn = Number(e.debit) > 0;
      const m = monthOf(e.ad);
      let value = e.ad;
      const eom = `${m}-${String(lastDom(m)).padStart(2, "0")}`;
      // a few outgoing payments made on the last days of a month clear the bank in the first days of the next
      if (!isIn && e.ad >= addDays(eom, -2) && hashSeed(e.jn) % 6 === 0 && m < lastFull && e.jn.startsWith("FIN-PAY-")) value = workdayOnOrAfter(addDays(eom, 1 + (hashSeed(e.jn) % 3)));
      else if (isIn && hashSeed(e.jn) % 9 === 0 && e.ad < addDays(eom, -1)) value = workdayOnOrAfter(addDays(e.ad, 1));
      if (value > today) continue;
      const text = (e.d ?? e.jn).replace(/\s*\[[^\]]*\]\s*$/, "");
      lines.push({
        ext: `${bank.house_bank_code}-${e.jn}`,
        gid: e.gid,
        value,
        amount: isIn ? e.debit : e.credit,
        dir: isIn ? "credit" : "debit",
        ref: e.jn.replace(/^FIN-/, ""),
        party: text.length > 80 ? text.slice(0, 80) : text,
      });
    }
    // bank-side items not yet in the ledger (last month only)
    if (bank.house_bank_code === "BCA-REC") {
      lines.push({ ext: `${bank.house_bank_code}-XTRA-1`, gid: null, value: addDays(`${lastFull}-01`, 21), amount: "12500000.00", dir: "credit", ref: "SETORAN TUNAI", party: "Setoran tunai tanpa keterangan (menunggu konfirmasi pelanggan)" });
    }
    if (bank.house_bank_code === "MDR-OPS") {
      lines.push({ ext: `${bank.house_bank_code}-XTRA-1`, gid: null, value: addDays(`${lastFull}-01`, 27), amount: "1250000.00", dir: "debit", ref: "BIAYA PROVISI", party: "Biaya provisi dan materai kredit modal kerja (belum dijurnal)" });
    }
    const byMonth = new Map<string, L[]>();
    for (const l of lines) {
      const mm = monthOf(l.value);
      if (!byMonth.has(mm)) byMonth.set(mm, []);
      byMonth.get(mm)!.push(l);
    }
    const fileNames = new Set((await ctx.sql<{ source_file_name: string }>(`SELECT source_file_name FROM finance_bank_statement_imports WHERE tenant_id = $1 AND bank_account_id = $2`, [t, bank.id])).map((r) => r.source_file_name));
    for (const m of ctx.cal.months) {
      const rows = (byMonth.get(m) ?? []).sort((a, b) => (a.value === b.value ? a.ext.localeCompare(b.ext) : a.value < b.value ? -1 : 1));
      if (rows.length === 0) continue;
      const name = `rekening-koran-${bank.house_bank_code}-${m}${m === currentMonth ? "-sementara" : ""}.csv`;
      if (fileNames.has(name)) continue;
      const csv = [
        "external_transaction_id,value_date,booking_date,amount,direction,currency,reference,counterparty",
        ...rows.map((r) => [r.ext, r.value, r.value, r.amount, r.dir, "IDR", q(r.ref), q(r.party)].join(",")),
      ].join("\n");
      await f("POST", "/accounting/bank-statements/import", { bankAccountId: bank.id, formatProfile: "csv_v1", sourceFileName: name, content: csv });
      made("bankStatementImport");
    }
    // reconciliations
    const stmtLines = await ctx.sql<{ id: string; ext: string; value: string; amount: string; direction: string }>(
      `SELECT id, external_transaction_id AS ext, to_char(value_date, 'YYYY-MM-DD') AS value, amount::text AS amount, direction FROM finance_bank_statement_lines WHERE tenant_id = $1 AND bank_account_id = $2`,
      [t, bank.id],
    );
    const gidByExt = new Map(lines.map((l) => [l.ext, l.gid]));
    for (const m of ctx.cal.months) {
      if (m > lastFull) continue;
      const period = refs.period.get(m);
      if (!period) continue;
      let recon = (await ctx.sql<{ id: string; status: string }>(`SELECT id, status FROM finance_bank_reconciliations WHERE tenant_id = $1 AND bank_account_id = $2 AND period_id = $3`, [t, bank.id, period.id]))[0];
      if (!recon) {
        const created = await f("POST", "/accounting/bank-reconciliations", { bankAccountId: bank.id, periodId: period.id });
        recon = { id: created.id, status: "open" };
        made("bankReconciliation");
      }
      if (recon.status === "closed") continue;
      const inMonth = stmtLines.filter((l) => monthOf(l.value) === m).sort((a, b) => (a.value === b.value ? a.ext.localeCompare(b.ext) : a.value < b.value ? -1 : 1));
      const isLast = m === lastFull;
      const skipFrom = isLast ? Math.max(0, inMonth.length - 7) : inMonth.length;
      const haveMatch = new Set((await ctx.sql<{ k: string }>(`SELECT idempotency_key AS k FROM finance_bank_matches WHERE tenant_id = $1 AND reconciliation_id = $2`, [t, recon.id])).map((r) => r.k));
      for (const [i, l] of inMonth.entries()) {
        const gid = gidByExt.get(l.ext);
        if (!gid || i >= skipFrom) continue;
        const key = `demo-fin:match:${l.ext}`;
        if (haveMatch.has(key)) continue;
        await f("POST", "/accounting/bank-matches", {
          reconciliationId: recon.id,
          statementLineId: l.id,
          glEntryId: gid,
          amount: l.amount,
          matchKind: hashSeed(l.ext) % 4 === 0 ? "manual" : "confirmed",
          matchReason: hashSeed(l.ext) % 4 === 0 ? "Dicocokkan manual berdasarkan nomor referensi" : "amount_date_reference",
          idempotencyKey: key,
          note: null,
        });
        made("bankMatch");
      }
      if (!isLast) {
        const movement = inMonth.reduce((a, l) => a + (l.direction === "credit" ? Number(l.amount) : -Number(l.amount)), 0);
        await f("POST", `/accounting/bank-reconciliations/${recon.id}/close`, movement >= 0 ? { statementBalance: movement.toFixed(2) } : {});
        made("bankReconciliationClosed");
      }
    }
  }
  // one wrong match that was caught and reversed (open reconciliation of the last month)
  const bank0 = banks.find((b) => b.house_bank_code === "BCA-REC");
  if (bank0) {
    const period = refs.period.get(lastFull)!;
    const recon = (await ctx.sql<{ id: string }>(`SELECT id FROM finance_bank_reconciliations WHERE tenant_id = $1 AND bank_account_id = $2 AND period_id = $3 AND status = 'open'`, [t, bank0.id, period.id]))[0];
    if (recon) {
      const done = await ctx.sql(`SELECT 1 FROM finance_bank_matches WHERE tenant_id = $1 AND reconciliation_id = $2 AND reverses_id IS NOT NULL`, [t, recon.id]);
      if (done.length === 0) {
        const m = (await ctx.sql<{ id: string }>(`SELECT id FROM finance_bank_matches WHERE tenant_id = $1 AND reconciliation_id = $2 AND reverses_id IS NULL ORDER BY created_at LIMIT 1`, [t, recon.id]))[0];
        if (m) {
          await f("POST", `/accounting/bank-matches/${m.id}/reverse`, { idempotencyKey: "demo-fin:unmatch:1", note: "Salah pasang: nomor referensi mirip, dikembalikan untuk dicek ulang" });
          const orig = (await ctx.sql<{ statement_line_id: string; gl_entry_id: string; amount: string }>(`SELECT statement_line_id, gl_entry_id, amount::text AS amount FROM finance_bank_matches WHERE id = $1`, [m.id]))[0];
          await f("POST", "/accounting/bank-matches", { reconciliationId: recon.id, statementLineId: orig.statement_line_id, glEntryId: orig.gl_entry_id, amount: orig.amount, matchKind: "manual", matchReason: "Dicocokkan ulang setelah verifikasi bukti transfer", idempotencyKey: "demo-fin:rematch:1", note: null });
          made("bankMatchReversed");
        }
      }
    }
  }
  // timestamps: statements arrive in the first days of the next month, reconciliations close a few days later
  await ctx.sql(
    `UPDATE finance_bank_statement_imports i
        SET created_at = LEAST((to_date(substring(i.source_file_name from '[0-9]{4}-[0-9]{2}'), 'YYYY-MM') + interval '1 month' + interval '1 day' + interval '8 hours') AT TIME ZONE 'Asia/Jakarta', now())
      WHERE i.tenant_id = $1 AND i.created_at > now() - interval '6 hours'`,
    [t],
  );
  await ctx.sql(
    `UPDATE finance_bank_statement_lines l SET created_at = i.created_at FROM finance_bank_statement_imports i WHERE l.import_id = i.id AND l.tenant_id = $1 AND l.created_at > i.created_at + interval '1 hour'`,
    [t],
  );
  await ctx.sql(
    `UPDATE finance_bank_reconciliations r
        SET created_at = LEAST((p.date_to + 2 + time '09:00') AT TIME ZONE 'Asia/Jakarta', now()),
            closed_at = CASE WHEN r.closed_at IS NULL THEN NULL ELSE LEAST((p.date_to + 4 + time '15:00') AT TIME ZONE 'Asia/Jakarta', now()) END
       FROM accounting_periods p WHERE r.tenant_id = $1 AND p.id = r.period_id AND r.created_at > now() - interval '6 hours'`,
    [t],
  );
  await ctx.sql(
    `UPDATE finance_bank_matches m SET created_at = LEAST((p.date_to + 3 + time '11:00') AT TIME ZONE 'Asia/Jakarta', now())
       FROM finance_bank_reconciliations r JOIN accounting_periods p ON p.id = r.period_id
      WHERE m.reconciliation_id = r.id AND m.tenant_id = $1 AND m.created_at > now() - interval '6 hours'`,
    [t],
  );
  // The kernel measures the book side with a date window that slips by a day on servers east of UTC
  // (bank-recon.repository.pg.ts toDateStr), so restate the frozen balances from the period's own entries.
  await ctx.sql(
    `UPDATE finance_bank_reconciliations r
        SET closed_book_balance = COALESCE((SELECT sum(g.debit - g.credit) FROM general_ledger_entries g WHERE g.tenant_id = r.tenant_id AND g.account_id = ba.ledger_account_id AND g.period_id = r.period_id), 0),
            closed_statement_balance = COALESCE((SELECT sum(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END) FROM finance_bank_statement_lines l JOIN accounting_periods p2 ON p2.id = r.period_id
                                                  WHERE l.tenant_id = r.tenant_id AND l.bank_account_id = r.bank_account_id AND l.duplicate_status = 'accepted' AND l.value_date BETWEEN p2.date_from AND p2.date_to), 0),
            statement_balance = COALESCE((SELECT sum(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END) FROM finance_bank_statement_lines l JOIN accounting_periods p2 ON p2.id = r.period_id
                                           WHERE l.tenant_id = r.tenant_id AND l.bank_account_id = r.bank_account_id AND l.duplicate_status = 'accepted' AND l.value_date BETWEEN p2.date_from AND p2.date_to), 0)
       FROM finance_bank_accounts ba
      WHERE ba.id = r.bank_account_id AND r.tenant_id = $1 AND r.status = 'closed'`,
    [t],
  );
  ctx.log(S, "bank reconciliation done");
}

// ---- period close (always the very last step) ------------------------------------------------------------

async function closeStep(ctx: DemoCtx, refs: Refs): Promise<void> {
  const t = ctx.tenantId;
  const fin = USERS.finance;
  const currentMonth = monthOf(ctx.cal.today);
  // keep the last two months (previous and current) open, plus everything in the future
  const lastToClose = prevMonth(prevMonth(currentMonth));
  await refreshPeriods(ctx, refs);
  const attest = { bankReconConfirmed: true, apArConfirmed: true, depreciationConfirmed: true, accrualsConfirmed: true };
  for (const m of ctx.cal.months) {
    if (m > lastToClose) continue;
    const period = refs.period.get(m);
    if (!period || period.status !== "open") continue;
    const isYearEnd = m.endsWith("-12");
    try {
      await ctx.callAs(fin.email, DEMO_PASSWORD, "POST", `/accounting/periods/${period.id}/${isYearEnd ? "close-year-end" : "close-month-end"}`, attest);
      made(isYearEnd ? "periodClosedYearEnd" : "periodClosed");
    } catch (e: any) {
      ctx.log(S, `could not close ${m}: ${String(e?.message ?? e).slice(0, 240)}`);
    }
  }
  // closings carry the time they happened: three days after the month ended
  await ctx.sql(
    `UPDATE fiscal_closings c SET closed_at = LEAST((p.date_to + 3 + time '17:00') AT TIME ZONE 'Asia/Jakarta', now()), created_at = LEAST((p.date_to + 3 + time '17:00') AT TIME ZONE 'Asia/Jakarta', now())
       FROM accounting_periods p WHERE c.tenant_id = $1 AND p.id = c.period_id AND c.created_at > p.date_to + 5`,
    [t],
  );
  await ctx.sql(
    `UPDATE accounting_periods p SET locked_date = LEAST((p.date_to + 3 + time '17:00') AT TIME ZONE 'Asia/Jakarta', now()), updated_at = LEAST((p.date_to + 3 + time '17:00') AT TIME ZONE 'Asia/Jakarta', now())
      WHERE p.tenant_id = $1 AND p.status = 'closed' AND p.updated_at > p.date_to + 5`,
    [t],
  );
  await backdateJournals(ctx);
  await refreshPeriods(ctx, refs);
  const open = [...refs.period.entries()].filter(([, v]) => v.status === "open").map(([k]) => k).sort();
  ctx.log(S, `open periods after close: ${open.join(", ")}`);
}

export async function run(ctx: DemoCtx): Promise<void> {
  const steps = (process.env.FINANCE_STEPS ?? "config,ledger,cash,openitems,tax,assets,budget,recon,close").split(",");
  const input = await loadInput(ctx);
  const world = buildWorld(ctx, input);
  const refs = await loadRefs(ctx);
  if (steps.includes("config")) await configStep(ctx, refs);
  if (steps.includes("ledger")) await ledgerStep(ctx, refs, world);
  if (steps.includes("cash")) await cashStep(ctx, refs, world);
  if (steps.includes("openitems")) await openItemStep(ctx, refs, world);
  if (steps.includes("tax")) await taxStep(ctx, refs, world);
  if (steps.includes("assets")) await assetStep(ctx, refs, world);
  if (steps.includes("budget")) await budgetStep(ctx, refs, world);
  if (steps.includes("recon")) await reconStep(ctx, refs);
  if (steps.includes("close")) await closeStep(ctx, refs);
  ctx.log(S, `created ${JSON.stringify(counts)}`);
}
