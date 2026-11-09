/**
 * Sector "commercial": the sales pipeline of PT Sentra Layanan Terpadu over
 * the last twelve months — price books (standard 2025/2026 + one per customer
 * contract), opportunities that move lead → qualified → proposal →
 * negotiation and end won / lost / cancelled / still open, and the quotations
 * behind them (submitted, approved, issued, accepted / declined, revised).
 *
 * Everything goes through the real Sales API as the sales user (and the ops
 * manager for the approval step); SQL is only used afterwards to backdate
 * timestamps and to put the right year in the document numbers.
 *
 * Idempotent: price books are found by code, opportunities by title.
 */
import type { DemoCtx } from "./harness.js";
import { CUSTOMERS, USERS, customerByCode, type ServiceKey } from "./catalog.js";

// ---------------------------------------------------------------------------
// Small helpers shared with the other two sectors of this author
// ---------------------------------------------------------------------------

export const SERVICE_CODE: Record<ServiceKey, string> = {
  CATERING: "SVC-CATERING",
  HOUSEKEEPING: "SVC-HOUSEKEEPING",
  FACILITY: "SVC-FACILITY",
  CAMP: "SVC-CAMP",
  PESTCTRL: "SVC-PESTCTRL",
};

export async function userIdByEmail(ctx: DemoCtx, email: string): Promise<string> {
  const rows = await ctx.sql<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [ctx.tenantId, email]);
  if (!rows[0]) throw new Error(`user ${email} not found`);
  return rows[0].id;
}

/** UTC+7 timestamp at a given hour on a YYYY-MM-DD date. */
export function stamp(ctx: DemoCtx, date: string, hour = 9, minute = 0): string {
  return ctx.cal.at(date, hour, minute);
}

/** Replace the "now" timestamps that audit/event/notification rows got at insert
 * with the historical time. `at` may depend on the action/event type. */
export async function backdateTrail(
  ctx: DemoCtx,
  entityIds: string[],
  at: (action: string) => string,
): Promise<void> {
  if (entityIds.length === 0) return;
  const rows = await ctx.sql<{ id: string; action: string }>(
    `SELECT id, action FROM audit_log WHERE tenant_id = $1 AND entity_id = ANY($2::uuid[])`,
    [ctx.tenantId, entityIds],
  );
  for (const r of rows) {
    await ctx.sql(`UPDATE audit_log SET created_at = $2 WHERE id = $1`, [r.id, at(r.action)]);
  }
  const ev = await ctx.sql<{ id: string; event_type: string }>(
    `SELECT id, event_type FROM domain_events WHERE tenant_id = $1 AND entity_id = ANY($2::uuid[])`,
    [ctx.tenantId, entityIds],
  );
  for (const r of ev) {
    const t = at(r.event_type);
    await ctx.sql(`UPDATE domain_events SET occurred_at = $2 WHERE id = $1`, [r.id, t]);
    const readAt = new Date(new Date(t).getTime() + 3 * 3600_000);
    const stale = Date.now() - new Date(t).getTime() > 3 * 86400_000;
    await ctx.sql(
      `UPDATE notifications SET created_at = $2, sent_at = CASE WHEN sent_at IS NULL THEN NULL ELSE $2::timestamptz END,
              read_at = $3::timestamptz
       WHERE tenant_id = $1 AND domain_event_id = $4`,
      [ctx.tenantId, t, stale ? readAt.toISOString() : null, r.id],
    );
  }
}


/** Re-issue "PREFIX-YYYY-NNNNN" document numbers so year and sequence follow
 * the row's (backdated) timestamp. `offset` leaves room for rows excluded by
 * `where` that keep their original numbers. Safe to repeat. */
export async function renumberChronologically(
  ctx: DemoCtx,
  table: string,
  col: string,
  prefix: string,
  tsCol = "created_at",
  where = "TRUE",
  offset: Record<number, number> = {},
): Promise<void> {
  const rows = await ctx.sql<{ id: string; yr: number }>(
    `SELECT id, EXTRACT(YEAR FROM ${tsCol} AT TIME ZONE 'Asia/Jakarta')::int AS yr
       FROM ${table} WHERE tenant_id = $1 AND ${where} ORDER BY ${tsCol}, id`,
    [ctx.tenantId],
  );
  const counters = new Map<number, number>();
  const plan: { id: string; num: string }[] = [];
  for (const r of rows) {
    const n = (counters.get(r.yr) ?? offset[r.yr] ?? 0) + 1;
    counters.set(r.yr, n);
    plan.push({ id: r.id, num: `${prefix}-${r.yr}-${String(n).padStart(5, "0")}` });
  }
  await ctx.sql(`UPDATE ${table} SET ${col} = 'TMP-' || id::text WHERE id = ANY($1::uuid[])`, [plan.map((p) => p.id)]);
  for (const p of plan) await ctx.sql(`UPDATE ${table} SET ${col} = $2 WHERE id = $1`, [p.id, p.num]);
}

const PASS = USERS.sales.password;
const asSales = <T = any>(ctx: DemoCtx, method: "GET" | "POST", url: string, body?: unknown) =>
  ctx.callAs<T>(USERS.sales.email, PASS, method, url, body);
const asManager = <T = any>(ctx: DemoCtx, method: "GET" | "POST", url: string, body?: unknown) =>
  ctx.callAs<T>(USERS.manager.email, PASS, method, url, body);

// ---------------------------------------------------------------------------
// Price books
// ---------------------------------------------------------------------------

type Unit = "meal" | "month" | "pax";

const STD_PRICES: Record<ServiceKey, { unit: Unit; p2026: number; minQty?: number }[]> = {
  CATERING: [
    { unit: "meal", p2026: 28500 },
    { unit: "meal", p2026: 26500, minQty: 15000 }, // volume tier
  ],
  HOUSEKEEPING: [{ unit: "pax", p2026: 5900000 }],
  FACILITY: [{ unit: "month", p2026: 48000000 }],
  CAMP: [{ unit: "month", p2026: 92000000 }],
  PESTCTRL: [{ unit: "month", p2026: 8500000 }],
};

async function ensurePriceBooks(ctx: DemoCtx, serviceIds: Record<string, string>): Promise<void> {
  const existing = await asSales<any[]>(ctx, "GET", "/sales/price-books");
  const have = new Set(existing.map((b) => b.code));
  const customers = await ctx.call<any[]>("GET", "/customers");
  const custId = (code: string) => customers.find((c) => c.code === code)?.id as string;
  let created = 0;

  const build = async (
    book: { code: string; name: string; description: string; effectiveFrom: string; effectiveTo?: string; customerId?: string },
    entries: { service: ServiceKey; unit: Unit; price: number; minQty?: number }[],
  ) => {
    if (have.has(book.code)) return;
    const b = await ctx.call<any>("POST", "/sales/price-books", {
      code: book.code,
      name: book.name,
      description: book.description,
      currencyCode: "IDR",
      customerId: book.customerId ?? null,
      effectiveFrom: book.effectiveFrom,
      effectiveTo: book.effectiveTo ?? null,
    });
    for (const e of entries) {
      await ctx.call("POST", `/sales/price-books/${b.id}/entries`, {
        serviceId: serviceIds[SERVICE_CODE[e.service]],
        unitCode: e.unit,
        unitPrice: e.price,
        ...(e.minQty ? { minQuantity: e.minQty } : {}),
      });
    }
    const at = stamp(ctx, book.effectiveFrom < ctx.cal.start ? ctx.cal.start : book.effectiveFrom, 10);
    await ctx.sql(`UPDATE sales_price_books SET created_at = $2, updated_at = $2 WHERE id = $1`, [b.id, at]);
    await ctx.sql(`UPDATE sales_price_book_entries SET created_at = $2, updated_at = $2 WHERE price_book_id = $1`, [b.id, at]);
    await backdateTrail(ctx, [b.id], () => at);
    created++;
  };

  // Standard list prices: last year's book (about 4% cheaper) and this year's.
  const stdEntries = (factor: number) =>
    (Object.keys(STD_PRICES) as ServiceKey[]).flatMap((svc) =>
      STD_PRICES[svc].map((e) => ({
        service: svc,
        unit: e.unit,
        price: Math.round((e.p2026 * factor) / 500) * 500,
        minQty: e.minQty,
      })),
    );
  await build(
    { code: "PB-STD-2025", name: "Daftar Harga Standar 2025", description: "Harga jual standar layanan Sentra tahun 2025", effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" },
    stdEntries(0.96),
  );
  await build(
    { code: "PB-STD-2026", name: "Daftar Harga Standar 2026", description: "Harga jual standar layanan Sentra tahun 2026 (naik rata-rata 4% karena UMK dan harga bahan pangan)", effectiveFrom: "2026-01-01" },
    stdEntries(1),
  );

  // One contract-specific book per customer.
  for (const c of CUSTOMERS) {
    const ct = c.contract;
    const nonCatering = c.services.filter((s) => s !== "CATERING");
    const entries: { service: ServiceKey; unit: Unit; price: number }[] = [];
    if (c.services.includes("CATERING") && ct.mealPrice > 0) entries.push({ service: "CATERING", unit: "meal", price: ct.mealPrice });
    for (const s of nonCatering) {
      const share = ct.monthlyServiceFee / Math.max(nonCatering.length, 1);
      entries.push({ service: s, unit: "month", price: Math.round(share / 1000) * 1000 });
    }
    await build(
      {
        code: `PB-${c.code}`,
        name: `Harga Kontrak ${c.name}`,
        description: `Harga sesuai kontrak ${ct.code}`,
        effectiveFrom: ct.startDate,
        customerId: custId(c.code),
      },
      entries,
    );
  }
  ctx.log("commercial", `price books: ${created} created, ${have.size} already existed`);
}

// ---------------------------------------------------------------------------
// Pipeline definition
// ---------------------------------------------------------------------------

type Stage = "lead" | "qualified" | "proposal" | "negotiation";
type Outcome = "won" | "lost" | "cancelled" | "open";
type QuoteFlow =
  | "none" // no quotation yet
  | "draft" // one draft being prepared
  | "issued" // v1 issued, customer still thinking
  | "accepted" // v1 issued then accepted
  | "declined" // v1 issued then declined (lost)
  | "revised-won" // v1 declined on price, v2 issued and accepted
  | "revised-open"; // v1 declined, v2 in approval

interface Line {
  svc: ServiceKey;
  unit: Unit;
  qty: number;
  price: number;
  /** true = leave unitPrice out so the price book resolves it. */
  fromBook?: boolean;
  desc?: string;
}

interface OppSpec {
  title: string;
  customer: string; // customers.code
  site?: string;
  description: string;
  source: "referral" | "tender" | "existing_client";
  created: string;
  /** Dates each later stage was reached. */
  qualified?: string;
  proposal?: string;
  negotiation?: string;
  outcome: Outcome;
  closed?: string;
  reason?: string;
  flow: QuoteFlow;
  lines: Line[];
  expectedClose: string;
  note?: string;
}

const PROSPECTS: { code: string; name: string; city: string; industry: string; contact: string }[] = [
  { code: "PRS-001", name: "PT Kharisma Plastik Utama", city: "Cikarang", industry: "Manufaktur plastik", contact: "Yudi Hartanto" },
  { code: "PRS-002", name: "RSU Bunda Kasih", city: "Tangerang", industry: "Rumah sakit", contact: "dr. Maria Sulistyo" },
  { code: "PRS-003", name: "PT Logam Prima Sejahtera", city: "Surabaya", industry: "Pengecoran logam", contact: "Eko Prabowo" },
  { code: "PRS-004", name: "Hotel Grand Taman Sari", city: "Bandung", industry: "Perhotelan", contact: "Veronica Halim" },
  { code: "PRS-005", name: "PT Sumber Alam Pangan", city: "Jakarta Timur", industry: "Pengolahan makanan", contact: "Fendi Kusnadi" },
  { code: "PRS-006", name: "SMA Plus Taruna Bangsa", city: "Bogor", industry: "Pendidikan asrama", contact: "Drs. Nanang Sutrisno" },
  { code: "PRS-007", name: "PT Cahaya Mekar Tekstil", city: "Bandung", industry: "Tekstil", contact: "Lilis Setiawati" },
  { code: "PRS-008", name: "PT Samudra Biru Perikanan", city: "Jakarta Utara", industry: "Perikanan & cold storage", contact: "Hartono Wijaya" },
  { code: "PRS-009", name: "PT Aero Servis Nusantara", city: "Tangerang", industry: "Jasa bandara & kargo", contact: "Mutiara Anggraini" },
];

const WD = 26; // catering working days per month

function pipeline(): OppSpec[] {
  const cust = (code: string) => customerByCode(code)!;
  const meals = (code: string, siteIdx: number, months: number) => cust(code).sites[siteIdx]!.dailyMeals * WD * months;

  return [
    // ---- Won: the six customers that signed during the year ------------------
    {
      title: "Katering karyawan Pabrik Majalaya (800 porsi/hari)", customer: "CUST-107", site: "SITE-107-A",
      description: "Penawaran katering makan siang untuk 800 karyawan pabrik tekstil, 6 hari kerja per minggu, kontrak 24 bulan.",
      source: "referral", created: "2025-11-10", qualified: "2025-11-11", proposal: "2025-11-12", negotiation: "2025-11-13",
      outcome: "won", closed: "2025-11-14", reason: "Harga dan menu rotasi 4 minggu sesuai kebutuhan; kontrak ditandatangani", flow: "accepted",
      lines: [{ svc: "CATERING", unit: "meal", qty: meals("CUST-107", 0, 24), price: 22500, fromBook: true, desc: "Makan siang karyawan (nasi, lauk, sayur, buah)" }],
      expectedClose: "2025-11-20",
    },
    {
      title: "Katering & cleaning Pabrik Rungkut dan Gudang Margomulyo", customer: "CUST-108", site: "SITE-108-A",
      description: "Tender pengadaan katering dan jasa kebersihan dua lokasi di Surabaya. Pemenang dipilih setelah presentasi dan tasting menu.",
      source: "tender", created: "2025-11-24", qualified: "2025-12-02", proposal: "2025-12-15", negotiation: "2026-01-05",
      outcome: "won", closed: "2026-01-14", reason: "Menang tender, skor teknis tertinggi; kontrak 24 bulan efektif 1 Februari 2026", flow: "revised-won",
      lines: [
        { svc: "CATERING", unit: "meal", qty: meals("CUST-108", 0, 24) + meals("CUST-108", 1, 24), price: 25000, fromBook: true },
        { svc: "HOUSEKEEPING", unit: "month", qty: 24, price: 34000000, fromBook: true, desc: "13 petugas kebersihan + peralatan dan bahan kimia" },
      ],
      expectedClose: "2026-01-20",
    },
    {
      title: "Pengelolaan kampus dan kantin Universitas Teknologi Nusantara", customer: "CUST-109", site: "SITE-109-A",
      description: "Paket housekeeping, perawatan fasilitas, dan kantin kampus Dago. Melibatkan panitia pengadaan universitas.",
      source: "tender", created: "2025-12-08", qualified: "2025-12-17", proposal: "2026-01-12", negotiation: "2026-01-28",
      outcome: "won", closed: "2026-02-10", reason: "Penawaran terintegrasi lebih murah 7% dari tiga vendor terpisah; ditandatangani rektorat", flow: "revised-won",
      lines: [
        { svc: "HOUSEKEEPING", unit: "month", qty: 24, price: 59000000, fromBook: true },
        { svc: "FACILITY", unit: "month", qty: 24, price: 59000000, fromBook: true },
        { svc: "CATERING", unit: "meal", qty: meals("CUST-109", 0, 24), price: 19500, fromBook: true, desc: "Kantin kampus (subsidi mahasiswa)" },
      ],
      expectedClose: "2026-02-15",
    },
    {
      title: "Camp, katering, dan facility Camp Cilegon serta Kantor Kuningan", customer: "CUST-110", site: "SITE-110-B",
      description: "Pengelolaan camp pekerja, dapur camp, dan perawatan fasilitas kantor untuk kontraktor jasa migas.",
      source: "referral", created: "2026-01-26", qualified: "2026-02-09", proposal: "2026-03-02", negotiation: "2026-03-23",
      outcome: "won", closed: "2026-04-14", reason: "Referensi dari proyek camp Bandung Selatan; kontrak 24 bulan efektif 1 Mei 2026", flow: "accepted",
      lines: [
        { svc: "CAMP", unit: "month", qty: 24, price: 72500000, fromBook: true },
        { svc: "FACILITY", unit: "month", qty: 24, price: 72500000, fromBook: true },
        { svc: "CATERING", unit: "meal", qty: meals("CUST-110", 0, 24) + meals("CUST-110", 1, 24), price: 33000, fromBook: true },
      ],
      expectedClose: "2026-04-15",
    },
    {
      title: "Cleaning, pest control, dan katering Terminal Tanjung Priok", customer: "CUST-111", site: "SITE-111-A",
      description: "Layanan terpadu area terminal peti kemas: kebersihan 16 petugas, pest control berkala, katering shift.",
      source: "tender", created: "2026-03-30", qualified: "2026-04-14", proposal: "2026-05-04", negotiation: "2026-05-26",
      outcome: "won", closed: "2026-06-12", reason: "Memenuhi persyaratan HSE terminal dan harga paling kompetitif", flow: "accepted",
      lines: [
        { svc: "HOUSEKEEPING", unit: "month", qty: 24, price: 44000000, fromBook: true },
        { svc: "PESTCTRL", unit: "month", qty: 24, price: 44000000, fromBook: true },
        { svc: "CATERING", unit: "meal", qty: meals("CUST-111", 0, 24), price: 27500, fromBook: true },
      ],
      expectedClose: "2026-06-15",
    },
    {
      title: "Katering dan cleaning Plant Karawang (1.100 porsi/hari)", customer: "CUST-112", site: "SITE-112-A",
      description: "Pabrik otomotif baru di KIIC Karawang. Volume terbesar sejauh ini; kapasitas dapur Cikarang diperluas.",
      source: "referral", created: "2026-05-18", qualified: "2026-06-03", proposal: "2026-06-22", negotiation: "2026-07-20",
      outcome: "won", closed: "2026-08-14", reason: "Setelah pilot tasting 2 minggu, menu disetujui GA dan dewan direksi pabrik", flow: "revised-won",
      lines: [
        { svc: "CATERING", unit: "meal", qty: meals("CUST-112", 0, 24), price: 25500, fromBook: true },
        { svc: "HOUSEKEEPING", unit: "month", qty: 24, price: 21000000, fromBook: true },
      ],
      expectedClose: "2026-08-20",
    },

    // ---- Won: expansions with existing customers ----------------------------
    {
      title: "Penambahan shift malam katering Pabrik Cikarang (+250 porsi)", customer: "CUST-101", site: "SITE-101-A",
      description: "Pabrik menambah shift ketiga; GA meminta makan malam dan snack tengah malam.",
      source: "existing_client", created: "2025-12-02", qualified: "2025-12-04", proposal: "2025-12-08", negotiation: "2025-12-15",
      outcome: "won", closed: "2025-12-19", reason: "Addendum kontrak CTR-2025-101 disetujui", flow: "accepted",
      lines: [{ svc: "CATERING", unit: "meal", qty: 250 * WD * 12, price: 25500, desc: "Makan malam + snack shift 3" }],
      expectedClose: "2025-12-20",
    },
    {
      title: "Layanan cleaning tambahan Kantor Cengkareng", customer: "CUST-103", site: "SITE-103-B",
      description: "Tambahan 3 petugas kebersihan untuk gedung kantor baru di komplek pergudangan Kosambi.",
      source: "existing_client", created: "2026-01-12", qualified: "2026-01-14", proposal: "2026-01-21", negotiation: "2026-01-30",
      outcome: "won", closed: "2026-02-06", reason: "Disetujui Facility Manager, ditambahkan ke kontrak berjalan", flow: "accepted",
      lines: [{ svc: "HOUSEKEEPING", unit: "pax", qty: 3 * 12, price: 5600000, desc: "3 petugas kebersihan, 12 bulan" }],
      expectedClose: "2026-02-10",
    },
    {
      title: "Paket katering Ramadan dan Lebaran Camp Tol Bandung Selatan", customer: "CUST-105", site: "SITE-105-A",
      description: "Menu sahur dan buka puasa untuk pekerja proyek, plus parsel Lebaran untuk 380 pekerja.",
      source: "existing_client", created: "2026-01-20", qualified: "2026-01-22", proposal: "2026-01-28", negotiation: "2026-02-09",
      outcome: "won", closed: "2026-02-18", reason: "Disetujui Project Director menjelang Ramadan", flow: "accepted",
      lines: [
        { svc: "CATERING", unit: "meal", qty: 380 * 30 * 2, price: 34000, desc: "Sahur + buka puasa selama Ramadan" },
        { svc: "CATERING", unit: "meal", qty: 380, price: 125000, desc: "Parsel Lebaran" },
      ],
      expectedClose: "2026-02-20",
    },
    {
      title: "Add-on pest control dan fogging Gedung Menara Sudirman", customer: "CUST-104", site: "SITE-104-A",
      description: "Bank meminta pengendalian hama berkala di dapur karyawan dan area parkir basement setelah audit internal.",
      source: "existing_client", created: "2026-02-02", qualified: "2026-02-04", proposal: "2026-02-12", negotiation: "2026-02-23",
      outcome: "won", closed: "2026-03-04", reason: "Disetujui, masuk addendum kontrak facility", flow: "accepted",
      lines: [{ svc: "PESTCTRL", unit: "month", qty: 10, price: 9500000, desc: "Fogging bulanan + rodent control" }],
      expectedClose: "2026-03-05",
    },
    {
      title: "Housekeeping area rawat inap tambahan RS Harapan Sehat", customer: "CUST-106", site: "SITE-106-A",
      description: "RS membuka sayap rawat inap baru lantai 5-6; butuh 6 petugas cleaning bersertifikat infeksi nosokomial.",
      source: "existing_client", created: "2026-04-06", qualified: "2026-04-08", proposal: "2026-04-16", negotiation: "2026-05-04",
      outcome: "won", closed: "2026-05-12", reason: "Disetujui Wadir Penunjang; mulai Juni 2026", flow: "accepted",
      lines: [{ svc: "HOUSEKEEPING", unit: "pax", qty: 6 * 12, price: 6400000, desc: "6 petugas cleaning rumah sakit, 12 bulan" }],
      expectedClose: "2026-05-15",
    },
    {
      title: "Katering gathering tahunan PT Mitra Baja 2026", customer: "CUST-101", site: "SITE-101-A",
      description: "Prasmanan untuk acara gathering 1.500 karyawan dan keluarga di Pabrik Cikarang.",
      source: "existing_client", created: "2026-10-05", qualified: "2026-10-06", proposal: "2026-10-09", negotiation: "2026-10-16",
      outcome: "won", closed: "2026-10-22", reason: "Disetujui GA dan HRD, acara 14 November 2026", flow: "accepted",
      lines: [{ svc: "CATERING", unit: "pax", qty: 1500, price: 85000, desc: "Prasmanan + dessert + minuman" }],
      expectedClose: "2026-10-25",
    },
    {
      title: "Katering acara wisuda UTN Desember 2026", customer: "CUST-109", site: "SITE-109-A",
      description: "Catering VIP dan snack box untuk wisuda 2.400 orang.",
      source: "existing_client", created: "2026-09-22", qualified: "2026-09-23", proposal: "2026-09-29", negotiation: "2026-10-12",
      outcome: "won", closed: "2026-10-30", reason: "Disetujui Wakil Rektor II", flow: "accepted",
      lines: [
        { svc: "CATERING", unit: "pax", qty: 2400, price: 48000, desc: "Snack box wisudawan dan tamu" },
        { svc: "CATERING", unit: "pax", qty: 200, price: 145000, desc: "Prasmanan VIP" },
      ],
      expectedClose: "2026-11-01",
    },

    // ---- Lost / cancelled ----------------------------------------------------
    {
      title: "Katering 1.200 karyawan PT Kharisma Plastik Utama", customer: "PRS-001",
      description: "Tender katering pabrik plastik Cikarang; tiga vendor diundang.",
      source: "tender", created: "2025-11-12", qualified: "2025-11-20", proposal: "2025-12-03", negotiation: "2025-12-22",
      outcome: "lost", closed: "2026-01-09", reason: "Kalah harga: vendor lain menawar Rp 21.000 per porsi", flow: "declined",
      lines: [{ svc: "CATERING", unit: "meal", qty: 1200 * WD * 12, price: 23500 }],
      expectedClose: "2026-01-05",
    },
    {
      title: "Gizi pasien dan cleaning RSU Bunda Kasih", customer: "PRS-002",
      description: "Penawaran instalasi gizi dan housekeeping rumah sakit tipe C.",
      source: "referral", created: "2025-12-15", qualified: "2026-01-06", proposal: "2026-01-26", negotiation: "2026-02-12",
      outcome: "lost", closed: "2026-02-27", reason: "Rumah sakit memilih vendor lama yang sudah mengelola dapur gizi", flow: "declined",
      lines: [
        { svc: "CATERING", unit: "meal", qty: 220 * 30 * 12, price: 34500 },
        { svc: "HOUSEKEEPING", unit: "pax", qty: 8 * 12, price: 6000000 },
      ],
      expectedClose: "2026-02-20",
    },
    {
      title: "Facility management pabrik PT Logam Prima Sejahtera", customer: "PRS-003",
      description: "Perawatan MEP, boiler, dan utilitas pabrik pengecoran di Surabaya.",
      source: "referral", created: "2026-01-05", qualified: "2026-01-19", proposal: "2026-02-09", negotiation: "2026-03-02",
      outcome: "lost", closed: "2026-03-20", reason: "Anggaran perawatan dibekukan oleh manajemen pusat", flow: "declined",
      lines: [{ svc: "FACILITY", unit: "month", qty: 12, price: 61000000 }],
      expectedClose: "2026-03-15",
    },
    {
      title: "Housekeeping area publik Hotel Grand Taman Sari", customer: "PRS-004",
      description: "Penawaran housekeeping lobi, restoran, dan area publik hotel bintang 4.",
      source: "referral", created: "2026-02-10", qualified: "2026-02-18", proposal: "2026-03-10",
      outcome: "cancelled", closed: "2026-04-02", reason: "Hotel membatalkan rencana outsourcing housekeeping", flow: "issued",
      lines: [{ svc: "HOUSEKEEPING", unit: "pax", qty: 14 * 12, price: 5800000 }],
      expectedClose: "2026-04-10",
    },
    {
      title: "Katering kantor pusat PT Sumber Alam Pangan", customer: "PRS-005",
      description: "Katering 300 karyawan kantor pusat di Jakarta Timur.",
      source: "tender", created: "2026-04-20", qualified: "2026-05-04", proposal: "2026-05-20", negotiation: "2026-06-04",
      outcome: "lost", closed: "2026-06-18", reason: "Perusahaan memutuskan membangun dapur sendiri", flow: "declined",
      lines: [{ svc: "CATERING", unit: "meal", qty: 300 * WD * 12, price: 29500 }],
      expectedClose: "2026-06-15",
    },
    {
      title: "Katering asrama siswa SMA Plus Taruna Bangsa", customer: "PRS-006",
      description: "Makan 3x sehari untuk 420 siswa asrama, anggaran terbatas dari yayasan.",
      source: "referral", created: "2026-06-02", qualified: "2026-06-16", proposal: "2026-07-01", negotiation: "2026-07-14",
      outcome: "lost", closed: "2026-07-28", reason: "Harga di atas plafon yayasan (Rp 16.000 per porsi)", flow: "declined",
      lines: [{ svc: "CATERING", unit: "meal", qty: 420 * 3 * 30 * 12, price: 17500 }],
      expectedClose: "2026-07-25",
    },

    // ---- Still open: the current pipeline ------------------------------------
    {
      title: "Perpanjangan kontrak katering Plant MM2100 2027-2029", customer: "CUST-102", site: "SITE-102-A",
      description: "Kontrak berakhir 31 Desember 2026. Cipta Elektronik meminta evaluasi harga dan penambahan menu diet.",
      source: "existing_client", created: "2026-09-01", qualified: "2026-09-03", proposal: "2026-09-21", negotiation: "2026-10-19",
      outcome: "open", flow: "revised-open",
      lines: [{ svc: "CATERING", unit: "meal", qty: meals("CUST-102", 0, 24), price: 26800 }],
      expectedClose: "2026-12-10",
    },
    {
      title: "Perpanjangan kontrak Facility Services Bank Nusa Makmur 2027-2028", customer: "CUST-104", site: "SITE-104-A",
      description: "Kontrak 2024-2026 berakhir Desember 2026. Bank membuka tender ulang dan mengundang dua kompetitor.",
      source: "existing_client", created: "2026-08-24", qualified: "2026-08-26", proposal: "2026-09-28", negotiation: "2026-10-26",
      outcome: "open", flow: "issued",
      lines: [
        { svc: "HOUSEKEEPING", unit: "month", qty: 24, price: 112000000 },
        { svc: "FACILITY", unit: "month", qty: 24, price: 112000000 },
      ],
      expectedClose: "2026-12-15",
    },
    {
      title: "Maintenance MEP Camp Cilegon fase 2", customer: "CUST-110", site: "SITE-110-B",
      description: "Penambahan lingkup perawatan genset, STP, dan jaringan listrik untuk perluasan camp 120 bed.",
      source: "existing_client", created: "2026-10-12", qualified: "2026-10-14", proposal: "2026-11-02",
      outcome: "open", flow: "issued",
      lines: [{ svc: "FACILITY", unit: "month", qty: 18, price: 38000000 }],
      expectedClose: "2026-12-20",
    },
    {
      title: "Pest control reguler Terminal Tanjung Priok area gudang", customer: "CUST-111", site: "SITE-111-A",
      description: "Perluasan layanan pest control ke gudang CFS dan kantin pekerja.",
      source: "existing_client", created: "2026-10-27", qualified: "2026-11-03",
      outcome: "open", flow: "none",
      lines: [{ svc: "PESTCTRL", unit: "month", qty: 12, price: 7500000 }],
      expectedClose: "2027-01-15",
    },
    {
      title: "Perluasan katering Plant Karawang shift 3 (+300 porsi)", customer: "CUST-112", site: "SITE-112-A",
      description: "Pabrik menambah shift malam mulai Januari 2027.",
      source: "existing_client", created: "2026-11-04",
      outcome: "open", flow: "none",
      lines: [{ svc: "CATERING", unit: "meal", qty: 300 * WD * 12, price: 26500 }],
      expectedClose: "2027-01-05",
    },
    {
      title: "Katering 900 porsi PT Cahaya Mekar Tekstil", customer: "PRS-007",
      description: "Pabrik tekstil Bandung meminta penawaran katering baru; dua vendor sudah tasting.",
      source: "referral", created: "2026-09-14", qualified: "2026-09-24", proposal: "2026-10-08", negotiation: "2026-11-02",
      outcome: "open", flow: "revised-open",
      lines: [{ svc: "CATERING", unit: "meal", qty: 900 * WD * 24, price: 23000 }],
      expectedClose: "2026-11-30",
    },
    {
      title: "Camp dan katering cold storage Muara Baru", customer: "PRS-008",
      description: "Perikanan memerlukan camp pekerja dan dapur untuk 150 karyawan shift.",
      source: "referral", created: "2026-10-02", qualified: "2026-10-15", proposal: "2026-11-05",
      outcome: "open", flow: "draft",
      lines: [
        { svc: "CAMP", unit: "month", qty: 24, price: 86000000 },
        { svc: "CATERING", unit: "meal", qty: 150 * 3 * 30 * 24, price: 21000 },
      ],
      expectedClose: "2027-01-20",
    },
    {
      title: "Cleaning terminal kargo PT Aero Servis Nusantara", customer: "PRS-009",
      description: "Permintaan penawaran cleaning area kargo dan perkantoran bandara.",
      source: "tender", created: "2026-11-03",
      outcome: "open", flow: "none",
      lines: [{ svc: "HOUSEKEEPING", unit: "pax", qty: 20 * 24, price: 6100000 }],
      expectedClose: "2027-02-28",
    },
  ];
}

const PROB: Record<string, number> = { lead: 10, qualified: 25, proposal: 50, negotiation: 75 };

// ---------------------------------------------------------------------------

export async function run(ctx: DemoCtx): Promise<void> {
  const services = await ctx.call<any[]>("GET", "/services");
  const serviceIds: Record<string, string> = Object.fromEntries(services.map((s) => [s.code, s.id]));
  const salesId = await userIdByEmail(ctx, USERS.sales.email);
  const managerId = await userIdByEmail(ctx, USERS.manager.email);

  await ensurePriceBooks(ctx, serviceIds);

  // Prospect accounts (customers that have not signed): needed because every
  // opportunity belongs to a customer. They carry status "prospect".
  const bdUnit = (await ctx.sql<{ id: string }>(`SELECT id FROM organization_units WHERE tenant_id = $1 AND name = 'Business Development'`, [ctx.tenantId]))[0]?.id ?? null;
  let customers = await ctx.call<any[]>("GET", "/customers");
  const prospectOpenDate: Record<string, string> = {};
  for (const p of PROSPECTS) {
    if (customers.some((c) => c.code === p.code)) continue;
    await ctx.call("POST", "/customers", {
      code: p.code,
      name: p.name,
      status: "prospect",
      ownerOrganizationUnitId: bdUnit,
      notes: `Calon pelanggan, ${p.industry}, ${p.city}. PIC: ${p.contact}.`,
    });
    ctx.log("commercial", `prospect ${p.code} ${p.name}`);
  }
  customers = await ctx.call<any[]>("GET", "/customers");

  const specs = pipeline();
  const existing = await asSales<any[]>(ctx, "GET", "/sales/opportunities");
  const have = new Set(existing.map((o) => o.title));
  const stats = { opps: 0, quotes: 0 };

  for (const s of specs) {
    // Prospect account opening date = the first opportunity date.
    if (s.customer.startsWith("PRS-")) {
      const c = customers.find((x) => x.code === s.customer)!;
      const at = stamp(ctx, s.created, 9);
      await ctx.sql(`UPDATE customers SET created_at = LEAST(created_at, $2::timestamptz), updated_at = LEAST(updated_at, $2::timestamptz) WHERE id = $1 AND tenant_id = $3`, [c.id, at, ctx.tenantId]);
      prospectOpenDate[s.customer] = s.created;
    }
    if (have.has(s.title)) continue;

    const customer = customers.find((c) => c.code === s.customer);
    if (!customer) throw new Error(`customer ${s.customer} missing`);
    let siteId: string | null = null;
    if (s.site) {
      siteId = (await ctx.sql<{ id: string }>(`SELECT id FROM sites WHERE tenant_id = $1 AND code = $2`, [ctx.tenantId, s.site]))[0]?.id ?? null;
    }
    const contactRows = await ctx.sql<{ id: string }>(
      `SELECT id FROM customer_contacts WHERE tenant_id = $1 AND customer_id = $2 AND deleted_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1`,
      [ctx.tenantId, customer.id],
    );
    const totalValue = s.lines.reduce((sum, l) => sum + l.qty * l.price, 0);
    const lastStage: Stage = s.negotiation ? "negotiation" : s.proposal ? "proposal" : s.qualified ? "qualified" : "lead";

    const opp = await asSales<any>(ctx, "POST", "/sales/opportunities", {
      customerId: customer.id,
      siteId,
      customerContactId: contactRows[0]?.id ?? null,
      title: s.title,
      description: s.description,
      stageCode: "lead",
      sourceCode: s.source,
      currencyCode: "IDR",
      estimatedValue: Math.round(totalValue),
      probabilityPercent: PROB.lead,
      expectedCloseDate: s.expectedClose,
      ownerUserId: salesId,
    });
    stats.opps++;

    const history: { stage: Stage | "closed"; date: string; outcome: string }[] = [{ stage: "lead", date: s.created, outcome: "open" }];
    const stageChange = async (stage: Stage, date: string, note: string) => {
      await asSales(ctx, "POST", `/sales/opportunities/${opp.id}/stage`, { stageCode: stage, outcome: "open", note });
      history.push({ stage, date, outcome: "open" });
    };

    const quotes: { id: string; created: string; issued?: string; decided?: string; validUntil?: string }[] = [];
    const makeQuote = async (date: string, opts: { revision?: number; supersedes?: string; title: string; discount?: number; priceFactor?: number }) => {
      const lines = s.lines.map((l) => {
        const price = Math.round((l.price * (opts.priceFactor ?? 1)) / 100) * 100;
        return {
          serviceId: serviceIds[SERVICE_CODE[l.svc]],
          description: l.desc ?? null,
          unitCode: l.unit,
          quantity: l.qty,
          ...(l.fromBook && !opts.priceFactor ? {} : { unitPrice: price }),
        };
      });
      const subtotal = s.lines.reduce((sum, l) => sum + l.qty * Math.round((l.price * (opts.priceFactor ?? 1)) / 100) * 100, 0);
      const validUntil = ctx.cal.addDays(date, 31);
      const q = await asSales<any>(ctx, "POST", "/sales/quotations", {
        opportunityId: opp.id,
        title: opts.title,
        notes: "Harga belum termasuk PPN. Pembayaran sesuai termin kontrak. Penawaran berlaku 30 hari sejak diterbitkan.",
        validUntil,
        taxAmount: Math.round(subtotal * 0.11),
        supersedesQuotationId: opts.supersedes ?? null,
        lines,
      });
      stats.quotes++;
      const rec: { id: string; created: string; issued?: string; decided?: string; validUntil?: string } = { id: q.quotation.id, created: date, validUntil };
      quotes.push(rec);
      return rec;
    };
    const submitAndIssue = async (rec: (typeof quotes)[number], issueDate: string) => {
      await asSales(ctx, "POST", `/sales/quotations/${rec.id}/submit`);
      await asManager(ctx, "POST", `/sales/quotations/${rec.id}/approval`, { decision: "issued" });
      rec.issued = issueDate;
    };
    const decide = async (rec: (typeof quotes)[number], decision: "accepted" | "declined", date: string, note: string) => {
      await asSales(ctx, "POST", `/sales/quotations/${rec.id}/customer-decision`, { decision, note });
      rec.decided = date;
    };

    const proposalDate = s.proposal ?? s.created;
    // Stage progression with quotations created when "proposal" is reached.
    if (s.qualified) await stageChange("qualified", s.qualified, "Kebutuhan dan anggaran dikonfirmasi saat kunjungan lokasi");
    if (s.proposal) {
      await stageChange("proposal", s.proposal, "Penawaran disusun berdasarkan survei lokasi dan jumlah karyawan");
      if (s.flow !== "none") {
        const q1 = await makeQuote(proposalDate, { title: `Penawaran ${s.title}` });
        if (s.flow !== "draft") {
          await submitAndIssue(q1, ctx.cal.addDays(proposalDate, 1));
        }
        if (s.flow === "accepted") {
          // decided at the closing date below
        }
      }
    }
    if (s.negotiation) {
      await stageChange("negotiation", s.negotiation, "Negosiasi harga dan lingkup dengan pihak pengadaan pelanggan");
      if (s.flow === "revised-won" || s.flow === "revised-open") {
        const q1 = quotes[0]!;
        const d1 = ctx.cal.addDays(s.negotiation, -2);
        await decide(q1, "declined", d1, "Harga perlu direvisi, mohon penawaran ulang dengan potongan volume");
        const revDate = ctx.cal.addDays(s.negotiation, 1);
        const q2 = await makeQuote(revDate, { title: `Penawaran revisi ${s.title}`, supersedes: q1.id, priceFactor: 0.965 });
        if (s.flow === "revised-won") await submitAndIssue(q2, ctx.cal.addDays(revDate, 1));
        else {
          // second revision sits in approval
          await asSales(ctx, "POST", `/sales/quotations/${q2.id}/submit`);
        }
      }
    }

    // Close the opportunity.
    let finalOutcome: Outcome = s.outcome;
    if (s.outcome === "open") {
      // update the probability to match the stage reached
      await ctx.sql(`UPDATE sales_opportunities SET probability_percent = $2 WHERE id = $1`, [opp.id, PROB[lastStage]]);
    } else {
      const closed = s.closed!;
      const lastQuote = quotes[quotes.length - 1];
      if (s.outcome === "won" && lastQuote) {
        await decide(lastQuote, "accepted", ctx.cal.addDays(closed, -1), "Disetujui dan kontrak ditandatangani");
      } else if (s.outcome === "lost" && lastQuote?.issued) {
        await decide(lastQuote, "declined", ctx.cal.addDays(closed, -2), s.reason ?? "Ditolak pelanggan");
      }
      await asSales(ctx, "POST", `/sales/opportunities/${opp.id}/stage`, {
        stageCode: lastStage,
        outcome: finalOutcome,
        outcomeReason: s.reason,
        note: s.reason,
      });
      history.push({ stage: "closed", date: closed, outcome: finalOutcome });
      await ctx.sql(`UPDATE sales_opportunities SET probability_percent = $2 WHERE id = $1`, [opp.id, finalOutcome === "won" ? 100 : 0]);
    }

    // ---- backdate -----------------------------------------------------------
    const lastDate = s.closed ?? history[history.length - 1]!.date;
    await ctx.sql(
      `UPDATE sales_opportunities SET created_at = $2, updated_at = $3, closed_at = $4 WHERE id = $1`,
      [opp.id, stamp(ctx, s.created, 9, 30), stamp(ctx, lastDate, 15), s.closed ? stamp(ctx, s.closed, 15) : null],
    );
    const hrows = await ctx.sql<{ id: string }>(
      `SELECT id FROM sales_opportunity_stage_history WHERE tenant_id = $1 AND opportunity_id = $2 ORDER BY changed_at, id`,
      [ctx.tenantId, opp.id],
    );
    for (let i = 0; i < hrows.length; i++) {
      await ctx.sql(`UPDATE sales_opportunity_stage_history SET changed_at = $2 WHERE id = $1`, [hrows[i]!.id, stamp(ctx, history[i]!.date, 10 + (i % 5))]);
    }
    for (const q of quotes) {
      const issued = q.issued ? stamp(ctx, q.issued, 11) : null;
      const decided = q.decided ? stamp(ctx, q.decided, 14) : null;
      const updated = decided ?? issued ?? stamp(ctx, q.created, 16);
      await ctx.sql(
        `UPDATE sales_quotations SET created_at = $2, updated_at = $3, issued_at = $4, customer_decided_at = $5 WHERE id = $1`,
        [q.id, stamp(ctx, q.created, 13), updated, issued, decided],
      );
      await ctx.sql(`UPDATE sales_quotation_lines SET created_at = $2 WHERE quotation_id = $1`, [q.id, stamp(ctx, q.created, 13)]);
    }
    const trailAt = (rowQuotes: typeof quotes) => (action: string) => {
      if (action.includes("opportunity.created")) return stamp(ctx, s.created, 9, 30);
      if (action.includes("opportunity.stage_changed")) return stamp(ctx, lastDate, 15);
      if (action.includes("opportunity.won") || action.includes("opportunity.lost")) return stamp(ctx, lastDate, 15);
      if (action.includes("quotation.created")) return stamp(ctx, rowQuotes[0]?.created ?? s.created, 13);
      if (action.includes("submitted")) return stamp(ctx, rowQuotes[0]?.created ?? s.created, 14);
      if (action.includes("issued")) return stamp(ctx, rowQuotes[0]?.issued ?? s.created, 11);
      return stamp(ctx, lastDate, 14);
    };
    await backdateTrail(ctx, [opp.id], trailAt(quotes));
    for (const q of quotes) await backdateTrail(ctx, [q.id], trailAt([q]));

    ctx.log("commercial", `${s.outcome.padEnd(9)} ${s.title}`);
    void managerId;
  }

  // Document numbers follow the (backdated) creation date: year token + running
  // sequence in chronological order, per year.
  await renumberChronologically(ctx, "sales_opportunities", "opportunity_number", "OPP", "created_at", `title NOT LIKE 'Uji katering%'`, { 2026: 2 });
  await renumberChronologically(ctx, "sales_quotations", "quotation_number", "QTN", "created_at");

  const summary = await ctx.sql<{ outcome: string; n: string }>(
    `SELECT outcome, count(*)::text n FROM sales_opportunities WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`,
    [ctx.tenantId],
  );
  ctx.log("commercial", `created ${stats.opps} opportunities, ${stats.quotes} quotations; pipeline: ${summary.map((r) => `${r.outcome}=${r.n}`).join(" ")}`);
}
