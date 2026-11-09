/**
 * Sector "service-ops": the operating core of PT Sentra Layanan Terpadu.
 *
 *  A. service definitions with checklists (catering, cleaning, facility,
 *     camp, pest control)
 *  B. catering master: finished-meal items, monthly menus, recipes with
 *     ingredient lines taken from the warehouse item catalogue
 *  C. meal plans per customer site and production batches
 *     (draft → confirmed → consumed)
 *  D. work orders for the whole year through the full lifecycle
 *     (create → assign → start → checklist → complete → verify → customer
 *     acceptance → serving log → cost items → finalize costs → invoice),
 *     with the recent ones still open or in progress
 *
 * Everything is created through the real API as the people who would do it
 * (coordinator, executors, verifier, billing). SQL is used afterwards to put
 * the business timestamps where they belong in the year.
 *
 * Idempotent: every record is looked up by its code / title / number first.
 * Env SO_STEPS="defs,catering,plans,wo" runs only some steps.
 */
import { makeRand, type DemoCtx } from "./harness.js";
import { CUSTOMERS, USERS, ITEMS, customerByCode, periodCodeOf, type CustomerSpec, type ServiceKey, type UserKey } from "./catalog.js";
import { backdateTrail, renumberChronologically, stamp, userIdByEmail } from "./commercial.js";

const PASS = USERS.coordinator.password;
const as = <T = any>(ctx: DemoCtx, who: UserKey, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) =>
  ctx.callAs<T>(USERS[who].email, PASS, method, url, body);

// ---------------------------------------------------------------------------
// Calendar helpers (Indonesian business calendar for the history window)
// ---------------------------------------------------------------------------

/** National holidays and cuti bersama inside 2025-11 … 2026-11 (catering sites are closed). */
export const HOLIDAYS = new Set([
  "2025-12-25", "2025-12-26", "2026-01-01", "2026-02-16", "2026-02-17", "2026-03-18", "2026-03-19", "2026-03-20", "2026-03-21",
  "2026-03-23", "2026-03-24", "2026-04-03", "2026-05-01", "2026-05-14", "2026-05-15", "2026-05-27", "2026-05-28", "2026-06-01",
  "2026-06-16", "2026-08-17", "2026-08-25", "2026-12-25",
]);
const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay(); // 0 = Sunday
const monthOf = (d: string) => d.slice(0, 7);
const lastDayOfMonth = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(y!, mm!, 0)).toISOString().slice(0, 10);
};
const nextMonth = (m: string) => {
  const [y, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(y!, mm!, 1)).toISOString().slice(0, 7);
};
const MONTH_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const monthLabel = (m: string) => `${MONTH_ID[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const isWorkday = (d: string, sixDay: boolean) => {
  if (HOLIDAYS.has(d)) return false;
  const w = dow(d);
  return sixDay ? w !== 0 : w !== 0 && w !== 6;
};
/** First workday on/after a date (Mon–Fri, not a holiday). */
const nextWorkday = (d: string) => {
  let x = d;
  while (!isWorkday(x, false)) x = new Date(new Date(x + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  return x;
};
const prevWorkday = (d: string) => {
  let x = d;
  while (!isWorkday(x, false)) x = new Date(new Date(x + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
  return x;
};
const addDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

const IS_OFFICE = (siteName: string) => /Kantor|Gedung Menara|Kampus|Cabang/.test(siteName);

// ---------------------------------------------------------------------------
// Bulk SQL helper
// ---------------------------------------------------------------------------

async function bulkSet(
  ctx: DemoCtx,
  table: string,
  rows: { id: string; [col: string]: unknown }[],
  cols: { name: string; type: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  const sets = cols.map((c, i) => `${c.name} = v.c${i}`).join(", ");
  const arrays = cols.map((c, i) => `$${i + 2}::${c.type}[]`).join(", ");
  const unn = cols.map((_, i) => `c${i}`).join(", ");
  await ctx.sql(
    `UPDATE ${table} t SET ${sets} FROM unnest($1::uuid[], ${arrays}) AS v(id, ${unn}) WHERE t.id = v.id`,
    [rows.map((r) => r.id), ...cols.map((c) => rows.map((r) => r[c.name]))],
  );
}

// ---------------------------------------------------------------------------
// A. Service definitions
// ---------------------------------------------------------------------------

interface DefSpec {
  code: string;
  name: string;
  description: string;
  category: string;
  checklist: { code: string; label: string; required: boolean }[];
}

const DEFINITIONS: DefSpec[] = [
  {
    code: "catering_daily_meal", name: "Katering Harian Karyawan", category: "catering",
    description: "Produksi, pengiriman, dan penyajian makan karyawan pelanggan. Satu work order = rekap layanan satu bulan untuk satu lokasi.",
    checklist: [
      { code: "menu_confirmed", label: "Menu bulanan dan rotasi dikonfirmasi dengan PIC pelanggan", required: true },
      { code: "temp_check", label: "Suhu makanan saat serah terima 60 derajat Celsius atau lebih", required: true },
      { code: "packaging_ok", label: "Kemasan bersih, tersegel, dan berlabel tanggal produksi", required: true },
      { code: "on_time", label: "Pengiriman tiba sebelum jam makan", required: true },
      { code: "qty_match", label: "Jumlah porsi sesuai pesanan dan berita acara serah terima", required: true },
      { code: "sample_kept", label: "Sampel makanan disimpan 24 jam (food sample)", required: false },
      { code: "waste_logged", label: "Sisa makanan dan retur dicatat", required: false },
    ],
  },
  {
    code: "catering_event", name: "Katering Event dan Prasmanan", category: "catering",
    description: "Katering acara (gathering, wisuda, tamu VIP) dengan prasmanan atau snack box.",
    checklist: [
      { code: "menu_agreed", label: "Menu dan jumlah tamu disetujui pelanggan", required: true },
      { code: "setup_done", label: "Penataan prasmanan, peralatan saji, dan petugas siap", required: true },
      { code: "served", label: "Penyajian selesai dan tamu terlayani", required: true },
      { code: "cleanup", label: "Pembersihan area dan pengambilan peralatan", required: false },
    ],
  },
  {
    code: "housekeeping_daily", name: "Kebersihan Harian Gedung dan Pabrik", category: "housekeeping",
    description: "Layanan kebersihan harian oleh petugas yang ditempatkan: lantai, toilet, pantry, area publik, pengelolaan sampah.",
    checklist: [
      { code: "attendance", label: "Kehadiran petugas sesuai jadwal roster", required: true },
      { code: "floor_toilet", label: "Lantai dan toilet dibersihkan dan didisinfeksi", required: true },
      { code: "waste", label: "Sampah dikumpulkan dan dibuang ke TPS", required: true },
      { code: "consumables", label: "Tisu, sabun, dan kantong sampah terisi", required: true },
      { code: "inspection_sign", label: "Form inspeksi harian ditandatangani PIC pelanggan", required: false },
    ],
  },
  {
    code: "facility_maintenance_monthly", name: "Perawatan Fasilitas Bulanan (MEP)", category: "facility",
    description: "Perawatan preventif listrik, AC, plumbing, genset, dan fasilitas gedung sesuai jadwal tahunan.",
    checklist: [
      { code: "pm_schedule", label: "Jadwal preventive maintenance bulan ini dijalankan", required: true },
      { code: "hvac_check", label: "AC dan ventilasi dicek dan dibersihkan", required: true },
      { code: "electrical", label: "Panel listrik, grounding, dan penerangan dicek", required: true },
      { code: "genset_test", label: "Uji genset dan ATS", required: false },
      { code: "report_signed", label: "Laporan perawatan diserahkan dan ditandatangani", required: true },
    ],
  },
  {
    code: "facility_corrective", name: "Perbaikan Korektif Fasilitas", category: "facility",
    description: "Perbaikan atas permintaan pelanggan: AC, listrik, plumbing, pintu, atap bocor.",
    checklist: [
      { code: "diagnosis", label: "Diagnosa kerusakan dan foto kondisi awal", required: true },
      { code: "parts_used", label: "Suku cadang yang dipakai dicatat", required: true },
      { code: "test_ok", label: "Pengujian setelah perbaikan berhasil", required: true },
      { code: "handover", label: "Serah terima kepada PIC pelanggan", required: true },
    ],
  },
  {
    code: "camp_mess_operations", name: "Operasional Camp dan Mess", category: "camp",
    description: "Pengelolaan camp pekerja: kebersihan kamar, laundry, dapur camp, dan keamanan lingkungan.",
    checklist: [
      { code: "room_turnover", label: "Kamar dibersihkan dan linen diganti sesuai jadwal", required: true },
      { code: "laundry", label: "Laundry pekerja selesai dan terdistribusi", required: true },
      { code: "kitchen_hygiene", label: "Dapur camp lolos inspeksi kebersihan", required: true },
      { code: "water_waste", label: "Air bersih dan pengelolaan limbah sesuai standar", required: true },
      { code: "occupancy_report", label: "Laporan okupansi bulanan dikirim ke pelanggan", required: false },
    ],
  },
  {
    code: "pest_control_fogging", name: "Pest Control dan Fogging Berkala", category: "pestcontrol",
    description: "Pengendalian hama terpadu: fogging, rodent control, dan perangkap lalat dengan sertifikat operator.",
    checklist: [
      { code: "survey", label: "Survei titik rawan hama dan peta bait station", required: true },
      { code: "treatment", label: "Aplikasi fogging dan penyemprotan residual", required: true },
      { code: "bait_check", label: "Bait station tikus diperiksa dan diganti", required: true },
      { code: "report_cert", label: "Laporan dan sertifikat layanan diserahkan", required: true },
    ],
  },
];

async function stepDefinitions(ctx: DemoCtx): Promise<void> {
  const have = await ctx.call<any[]>("GET", "/service-definitions");
  const codes = new Set(have.map((d) => d.code));
  const t0 = stamp(ctx, ctx.cal.start, 9);
  let made = 0;
  for (const d of DEFINITIONS) {
    if (codes.has(d.code)) continue;
    const def = await ctx.call<any>("POST", "/service-definitions", { code: d.code, name: d.name, description: d.description, category: d.category });
    let i = 1;
    for (const c of d.checklist) {
      await ctx.call("POST", `/service-definitions/${d.code}/checklist-items`, { code: c.code, label: c.label, isRequired: c.required, sortOrder: i++ });
    }
    await ctx.sql(`UPDATE service_definitions SET created_at = $2, updated_at = $2 WHERE id = $1`, [def.id, t0]);
    await ctx.sql(`UPDATE service_definition_checklist_items SET created_at = $2 WHERE service_definition_id = $1`, [def.id, t0]);
    made++;
  }
  // The pack-provided definitions were seeded at go-live as well.
  await ctx.sql(
    `UPDATE service_definitions SET created_at = LEAST(created_at, $2::timestamptz) WHERE tenant_id = $1 AND code IN
       ('housekeeping_room_cleaning','housekeeping_public_area','facility_hvac_filter','facility_routine_inspection','camp_occupancy_turnover','camp_water_wastewater')`,
    [ctx.tenantId, t0],
  );
  ctx.log("service-ops", `service definitions: ${made} created`);
}

// ---------------------------------------------------------------------------
// B. Catering master: dish items, menus, recipes
// ---------------------------------------------------------------------------

interface RecipeSpec {
  code: string;
  name: string;
  description: string;
  output: string; // item code
  outputName: string;
  effectiveFrom: string;
  /** item code -> quantity per 1 PORSI in the item's own stock unit */
  ingredients: [string, number][];
}

const PACK: [string, number][] = [["BOX-NASI", 1], ["SENDOK-GARPU", 1]];
const RECIPES: RecipeSpec[] = [
  {
    code: "RCP-NB-AYAM-GORENG", name: "Nasi Box Ayam Goreng Bumbu Kuning", description: "Nasi putih, ayam goreng bumbu kuning, tempe goreng, tumis sayur, sambal",
    output: "NASIBOX-AYAM", outputName: "Nasi box ayam (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["RICE", 0.12], ["AYAM", 0.1], ["BUMBU-RACIK", 0.005], ["MINYAK", 0.03], ["TEMPE", 0.03], ["SAYUR", 0.06], ["SAMBAL", 20], ...PACK],
  },
  {
    code: "RCP-NB-IKAN-DORI", name: "Nasi Box Ikan Dori Saus Tomat", description: "Nasi putih, fillet dori goreng tepung saus tomat, wortel buncis, lalapan",
    output: "MEAL-NB-IKAN", outputName: "Nasi box ikan dori (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["RICE", 0.12], ["IKAN-DORI", 0.09], ["SAUS-TOMAT", 0.015], ["TEPUNG", 0.015], ["MINYAK", 0.03], ["WORTEL", 0.04], ["SAYUR", 0.05], ...PACK],
  },
  {
    code: "RCP-NB-SEMUR-DAGING", name: "Nasi Box Semur Daging Sapi", description: "Nasi putih, semur daging kentang, tumis sayur, kerupuk",
    output: "MEAL-NB-DAGING", outputName: "Nasi box semur daging (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["RICE", 0.12], ["DAGING-SAPI", 0.07], ["KENTANG", 0.05], ["KECAP", 0.015], ["BAWANG-MERAH", 0.01], ["BAWANG-PUTIH", 0.005], ["SAYUR", 0.05], ["MINYAK", 0.02], ...PACK],
  },
  {
    code: "RCP-NB-LELE-SAMBAL", name: "Nasi Box Lele Goreng Sambal Terasi", description: "Nasi putih, lele goreng, tahu goreng, sambal tomat, lalapan",
    output: "MEAL-NB-LELE", outputName: "Nasi box lele goreng (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["RICE", 0.12], ["IKAN-LELE", 0.12], ["CABAI-MERAH", 0.015], ["TOMAT", 0.02], ["BAWANG-MERAH", 0.01], ["TAHU", 0.04], ["SAYUR", 0.05], ["MINYAK", 0.035], ...PACK],
  },
  {
    code: "RCP-NB-TELUR-BALADO", name: "Nasi Box Telur Balado", description: "Nasi putih, telur balado, tahu tempe bacem, sayur asem",
    output: "MEAL-NB-TELUR", outputName: "Nasi box telur balado (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["RICE", 0.12], ["TELUR", 0.07], ["CABAI-MERAH", 0.02], ["BAWANG-MERAH", 0.01], ["TAHU", 0.04], ["TEMPE", 0.03], ["SAYUR", 0.06], ["MINYAK", 0.025], ...PACK],
  },
  {
    code: "RCP-MIE-GORENG", name: "Mie Goreng Spesial dengan Telur dan Ayam", description: "Mie goreng jawa, telur mata sapi, suwiran ayam, acar",
    output: "MEAL-MIE-GORENG", outputName: "Mie goreng spesial (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["MIE-KERING", 0.1], ["TELUR", 0.05], ["AYAM", 0.04], ["SAYUR", 0.06], ["KECAP", 0.02], ["BAWANG-PUTIH", 0.005], ["MINYAK", 0.03], ...PACK],
  },
  {
    code: "RCP-SNACK-BOX", name: "Snack Box (Pisang Goreng, Risoles, Teh)", description: "Snack box rapat dan event: gorengan, kue basah, teh manis",
    output: "MEAL-SNACK-BOX", outputName: "Snack box (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["TEPUNG", 0.06], ["BUAH-PISANG", 0.08], ["GULA", 0.01], ["MINYAK", 0.03], ["TEH-CELUP", 0.01], ["BOX-SNACK", 1], ["GELAS-CUP", 1]],
  },
  {
    code: "RCP-PRASMANAN-A", name: "Prasmanan Paket A (per tamu)", description: "Nasi, ayam, daging, sayur, telur, kentang, buah, teh; untuk event dan tamu VIP",
    output: "MEAL-PRASMANAN-A", outputName: "Prasmanan paket A (per tamu)", effectiveFrom: "2025-11-01",
    ingredients: [["RICE", 0.15], ["AYAM", 0.08], ["DAGING-SAPI", 0.04], ["SAYUR", 0.08], ["TELUR", 0.03], ["SANTAN", 0.02], ["KENTANG", 0.05], ["BUAH-PISANG", 0.08], ["GULA", 0.01], ["TEH-CELUP", 0.01], ["GELAS-CUP", 1]],
  },
  {
    code: "RCP-DIET-RENDAH-GARAM", name: "Makanan Diet Rendah Garam (Pasien)", description: "Menu gizi pasien: nasi, ayam rebus, sayur kukus, buah, telur",
    output: "MEAL-DIET-RS", outputName: "Makanan diet pasien (jadi)", effectiveFrom: "2025-11-01",
    ingredients: [["RICE", 0.1], ["AYAM", 0.06], ["WORTEL", 0.05], ["KENTANG", 0.05], ["SAYUR", 0.08], ["BUAH-PISANG", 0.1], ["TELUR", 0.04], ["MINYAK", 0.01], ["GARAM", 0.001]],
  },
  {
    code: "RCP-SAHUR-RAMADAN", name: "Paket Sahur Ramadan", description: "Nasi, telur, tempe, sayur, ayam suwir, buah; dikemas untuk dibagikan sebelum subuh",
    output: "MEAL-SAHUR", outputName: "Paket sahur (jadi)", effectiveFrom: "2026-02-10",
    ingredients: [["RICE", 0.12], ["TELUR", 0.06], ["TEMPE", 0.04], ["SAYUR", 0.06], ["AYAM", 0.05], ["BUAH-PISANG", 0.1], ...PACK],
  },
  {
    code: "RCP-BUKA-PUASA", name: "Paket Buka Puasa (Takjil + Makan)", description: "Kolak pisang, gorengan, nasi ayam; dibagikan menjelang magrib",
    output: "MEAL-BUKA", outputName: "Paket buka puasa (jadi)", effectiveFrom: "2026-02-10",
    ingredients: [["BUAH-PISANG", 0.1], ["TEPUNG", 0.05], ["GULA", 0.03], ["SANTAN", 0.03], ["RICE", 0.12], ["AYAM", 0.09], ["SAYUR", 0.05], ["BOX-NASI", 1]],
  },
];

const ROTATION = ["RCP-NB-AYAM-GORENG", "RCP-NB-IKAN-DORI", "RCP-NB-SEMUR-DAGING", "RCP-NB-LELE-SAMBAL", "RCP-NB-TELUR-BALADO", "RCP-MIE-GORENG"];

const MENU_ROTATION_DESC =
  "Rotasi 4 minggu: Senin ayam goreng bumbu kuning, Selasa ikan dori saus tomat, Rabu semur daging, Kamis lele sambal terasi, Jumat telur balado, Sabtu mie goreng spesial. Buah dan teh disajikan setiap hari.";

interface MenuSpec { code: string; name: string; description: string; from: string; to: string | null; prepared: string }

function menuSpecs(ctx: DemoCtx): MenuSpec[] {
  const out: MenuSpec[] = ctx.cal.months.map((m) => ({
    code: `MENU-${m}`,
    name: `Menu Karyawan ${monthLabel(m)}`,
    description: MENU_ROTATION_DESC,
    from: `${m}-01`,
    to: lastDayOfMonth(m),
    prepared: m === ctx.cal.months[0] ? ctx.cal.start : addDays(`${m}-01`, -6),
  }));
  out.push(
    { code: "MENU-RAMADAN-2026", name: "Menu Ramadan 1447 H (Sahur dan Buka Puasa)", description: "Paket sahur dan buka puasa selama Ramadan, dikirim dua kali sehari ke camp dan pabrik.", from: "2026-02-18", to: "2026-03-19", prepared: "2026-02-10" },
    { code: "MENU-DIET-RS", name: "Menu Gizi Pasien dan Karyawan Rumah Sakit", description: "Siklus 7 hari: diet biasa, rendah garam, dan lunak sesuai instruksi ahli gizi.", from: "2025-10-01", to: null, prepared: ctx.cal.start },
    { code: "MENU-CAMP", name: "Menu Camp Pekerja (Siklus 10 Hari)", description: "Tiga kali makan sehari untuk pekerja camp: porsi besar, protein tinggi, variasi sambal.", from: "2025-06-01", to: null, prepared: ctx.cal.start },
    { code: "MENU-EVENT", name: "Menu Event dan Prasmanan", description: "Paket prasmanan A dan snack box untuk gathering, wisuda, dan tamu VIP.", from: "2025-01-01", to: null, prepared: ctx.cal.start },
  );
  return out;
}

async function stepCatering(ctx: DemoCtx): Promise<void> {
  // Finished-meal items (outputs of the recipes).
  const items = await ctx.call<any[]>("GET", "/items");
  const itemId = new Map<string, string>(items.map((x) => [x.code as string, x.id as string]));
  for (const r of RECIPES) {
    if (!itemId.has(r.output)) {
      const row = await ctx.call<any>("POST", "/items", {
        code: r.output, name: r.outputName, category: "Makanan Jadi", unitOfMeasure: "PORSI", grade: "food",
        description: `${r.name} — produk jadi dapur sentral`,
      });
      itemId.set(r.output, row.id);
      await ctx.sql(`UPDATE items SET created_at = $2, updated_at = $2 WHERE id = $1`, [row.id, stamp(ctx, ctx.cal.start, 9)]);
    }
  }

  // Recipes + ingredient lines.
  const haveRecipes = new Set((await ctx.call<any[]>("GET", "/catering/recipes")).map((x) => x.code));
  let rMade = 0;
  for (const r of RECIPES) {
    if (haveRecipes.has(r.code)) continue;
    const row = await ctx.call<any>("POST", "/catering/recipes", {
      code: r.code, name: r.name, description: r.description, outputItemId: itemId.get(r.output), outputQuantity: "1",
      outputUnitCode: "PORSI", effectiveFrom: r.effectiveFrom,
    });
    const lines = r.ingredients.map(([code, qty], i) => {
      const item = ITEMS.find((x) => x.code === code);
      if (!item || !itemId.has(code)) throw new Error(`ingredient ${code} missing`);
      return { itemId: itemId.get(code), quantity: String(qty), unitCode: item.unit, sortOrder: i + 1 };
    });
    await ctx.call("PUT", `/catering/recipes/${r.code}/ingredients`, { ingredients: lines });
    const at = stamp(ctx, r.effectiveFrom < ctx.cal.start ? ctx.cal.start : r.effectiveFrom, 10);
    await ctx.sql(`UPDATE catering_recipes SET created_at = $2, updated_at = $2 WHERE id = $1`, [row.id, at]);
    await ctx.sql(`UPDATE catering_recipe_ingredients SET created_at = $2 WHERE recipe_id = $1`, [row.id, at]);
    rMade++;
  }

  // Menus.
  const haveMenus = new Set((await ctx.call<any[]>("GET", "/catering/menus")).map((x) => x.code));
  let mMade = 0;
  for (const m of menuSpecs(ctx)) {
    if (haveMenus.has(m.code)) continue;
    const row = await ctx.call<any>("POST", "/catering/menus", { code: m.code, name: m.name, description: m.description, effectiveFrom: m.from, effectiveTo: m.to });
    const at = stamp(ctx, m.prepared, 14);
    await ctx.sql(`UPDATE catering_menus SET created_at = $2, updated_at = $2 WHERE id = $1`, [row.id, at]);
    mMade++;
  }
  ctx.log("service-ops", `catering master: ${rMade} recipes, ${mMade} menus created`);
}

// ---------------------------------------------------------------------------
// C. Meal plans and production batches
// ---------------------------------------------------------------------------

export interface SiteInfo {
  id: string;
  code: string;
  name: string;
  customer: CustomerSpec;
  customerId: string;
  dailyMeals: number;
  headcount: number;
  /** first / last day service ran at the site */
  start: string;
  sixDay: boolean;
  tag: string;
}

export async function loadSites(ctx: DemoCtx): Promise<SiteInfo[]> {
  const rows = await ctx.sql<{ site_id: string; site_code: string; customer_id: string; customer_code: string; opened: string }>(
    `SELECT s.id site_id, s.code site_code, c.id customer_id, c.code customer_code, c.created_at::date::text opened
       FROM sites s JOIN customers c ON c.id = s.customer_id WHERE s.tenant_id = $1 AND c.code LIKE 'CUST-1%'`,
    [ctx.tenantId],
  );
  const out: SiteInfo[] = [];
  for (const r of rows) {
    const cust = customerByCode(r.customer_code);
    const site = cust?.sites.find((s) => s.code === r.site_code);
    if (!cust || !site) continue;
    // service starts with the contract, but never before the history window and
    // never before the customer account existed in the system.
    const start = maxDate(maxDate(cust.contract.startDate, ctx.cal.start), r.opened);
    out.push({
      id: r.site_id, code: r.site_code, name: site.name, customer: cust, customerId: r.customer_id,
      dailyMeals: site.dailyMeals, headcount: site.headcount, start: nextWorkday(start),
      sixDay: !IS_OFFICE(site.name), tag: r.site_code.replace("SITE-", "").replace("-", ""),
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

function menuCodeFor(site: SiteInfo, date: string, mealType: string): string {
  if (mealType !== "lunch" && date >= "2026-02-18" && date <= "2026-03-19") return "MENU-RAMADAN-2026";
  if (site.customer.code === "CUST-106") return "MENU-DIET-RS";
  if (site.code === "SITE-105-A" || site.code === "SITE-110-B") return "MENU-CAMP";
  return `MENU-${monthOf(date)}`;
}

async function stepPlans(ctx: DemoCtx): Promise<void> {
  const sites = (await loadSites(ctx)).filter((s) => s.dailyMeals > 0);
  const recipeOk = new Set((await ctx.call<any[]>("GET", "/catering/recipes")).map((r) => r.code));
  for (const c of ROTATION) if (!recipeOk.has(c)) throw new Error("run the catering step first");

  // Existing plans/batches keyed to skip.
  const planRows = await ctx.sql<{ site_id: string; d: string; meal_type: string }>(
    `SELECT site_id, meal_date::text d, meal_type FROM catering_meal_plans WHERE tenant_id = $1`,
    [ctx.tenantId],
  );
  const havePlan = new Set(planRows.map((p) => `${p.site_id}|${p.d}|${p.meal_type}`));
  const batchRows = await ctx.sql<{ batch_number: string }>(`SELECT batch_number FROM catering_meal_batches WHERE tenant_id = $1`, [ctx.tenantId]);
  const haveBatch = new Set(batchRows.map((b) => b.batch_number));

  // Full cadence for the last eight weeks, Mon/Wed/Fri before that (planning
  // cycles are weekly in reality; this keeps the sector runtime sensible).
  const dense = addDays(ctx.cal.today, -56);
  const planUpdates: { id: string; created_at: string; updated_at: string }[] = [];
  const batchUpdates: { id: string; created_at: string; produced_at: string | null; updated_at: string }[] = [];
  let nPlans = 0;
  let nBatches = 0;

  const dates: string[] = [];
  for (let d = ctx.cal.start; d <= ctx.cal.today; d = addDays(d, 1)) dates.push(d);

  for (const date of dates) {
    const weekday = dow(date);
    for (const site of sites) {
      if (date < site.start) continue;
      if (!isWorkday(date, site.sixDay)) continue;
      if (date < dense && ![1, 3, 5].includes(weekday)) continue;

      const mealTypes: ("lunch" | "dinner" | "breakfast")[] = ["lunch"];
      // Ramadan: camp and factory sites with big night crews get sahur + buka.
      if (date >= "2026-02-18" && date <= "2026-03-19" && ["SITE-105-A", "SITE-110-B", "SITE-101-A"].includes(site.code)) {
        mealTypes.push("dinner", "breakfast");
      }
      for (const mealType of mealTypes) {
        const key = `${site.id}|${date}|${mealType}`;
        // Portion variance: weekday effect (Friday lower), leave and shift swaps.
        const weekdayFactor = weekday === 5 ? 0.93 : weekday === 6 ? 0.8 : 1;
        const base = mealType === "lunch" ? site.dailyMeals : Math.round(site.dailyMeals * 0.55);
        const portions = Math.max(80, Math.round(base * weekdayFactor * (0.94 + ctx.rand.next() * 0.1) / 5) * 5);
        const menuCode = menuCodeFor(site, date, mealType);

        let planId: string | undefined;
        if (!havePlan.has(key)) {
          const plan = await as<any>(ctx, "coordinator", "POST", "/catering/meal-plans", {
            menuCode, siteId: site.id, mealDate: date, mealType, plannedPortions: portions,
            notes: mealType === "lunch" && date >= "2026-02-18" && date <= "2026-03-19" ? "Ramadan: jam makan siang disesuaikan, pelanggan menyediakan area makan terpisah" : null,
          });
          planId = plan.id;
          nPlans++;
          const created = stamp(ctx, minDate(addDays(date, weekday === 1 ? -3 : -1), ctx.cal.today), 15, ctx.rand.int(0, 50));
          planUpdates.push({ id: plan.id, created_at: created, updated_at: created });
        } else {
          planId = (await ctx.sql<{ id: string }>(
            `SELECT id FROM catering_meal_plans WHERE tenant_id = $1 AND site_id = $2 AND meal_date = $3 AND meal_type = $4`,
            [ctx.tenantId, site.id, date, mealType],
          ))[0]?.id;
        }

        const batchNo = `B${date.replace(/-/g, "").slice(2)}-${site.tag}${mealType === "lunch" ? "" : mealType === "dinner" ? "D" : "S"}`;
        if (haveBatch.has(batchNo) || !planId) continue;
        const recipeCode =
          mealType === "dinner" ? "RCP-BUKA-PUASA"
          : mealType === "breakfast" ? "RCP-SAHUR-RAMADAN"
          : site.customer.code === "CUST-106" ? "RCP-DIET-RENDAH-GARAM"
          : ROTATION[(weekday - 1 + Math.floor(dates.indexOf(date) / 7)) % ROTATION.length]!;
        const batch = await as<any>(ctx, "coordinator", "POST", "/catering/meal-batches", {
          batchNumber: batchNo, recipeCode, mealPlanId: planId, outputQuantity: String(portions),
        });
        nBatches++;
        const isToday = date === ctx.cal.today;
        await as(ctx, "coordinator", "POST", `/catering/meal-batches/${batchNo}/status`, { status: "confirmed" });
        if (!isToday) await as(ctx, "coordinator", "POST", `/catering/meal-batches/${batchNo}/status`, { status: "consumed" });
        batchUpdates.push({
          id: batch.id,
          created_at: stamp(ctx, addDays(date, weekday === 1 ? -3 : -1), 16, ctx.rand.int(0, 50)),
          produced_at: stamp(ctx, date, mealType === "breakfast" ? 3 : mealType === "dinner" ? 14 : 5, ctx.rand.int(0, 45)),
          updated_at: stamp(ctx, date, isToday ? 6 : 13),
        });
      }
    }
    if (planUpdates.length >= 400) await flushPlans();
  }
  await flushPlans();

  async function flushPlans() {
    await bulkSet(ctx, "catering_meal_plans", planUpdates as any, [
      { name: "created_at", type: "timestamptz" },
      { name: "updated_at", type: "timestamptz" },
    ]);
    await bulkSet(ctx, "catering_meal_batches", batchUpdates as any, [
      { name: "created_at", type: "timestamptz" },
      { name: "produced_at", type: "timestamptz" },
      { name: "updated_at", type: "timestamptz" },
    ]);
    planUpdates.length = 0;
    batchUpdates.length = 0;
  }
  ctx.log("service-ops", `meal plans: ${nPlans} created, batches: ${nBatches} created`);
}


// ---------------------------------------------------------------------------
// D. Work orders (full lifecycle, one year)
// ---------------------------------------------------------------------------

type Stage = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // created, assigned, started, completed, verified, accepted, costed, invoiced

interface WoSpec {
  title: string;
  description: string;
  customer: CustomerSpec;
  site: SiteInfo;
  svc: ServiceKey;
  defCode: string;
  priority: "low" | "medium" | "high";
  /** period the work belongs to ("YYYY-MM") */
  month: string;
  createDate: string;
  plannedStart: string;
  plannedEnd: string;
  completeDate: string;
  /** cost basis is derived from revenue (invoice base amount, before PPN) */
  revenue: number;
  markup: number;
  portions?: number;
  executor: UserKey;
  viaToken: boolean;
  reject?: "rework" | "open";
  rejectReason?: string;
  late?: boolean;
  slow?: number; // extra days in the customer acceptance step
  /** forced last stage (exceptions: customer stalls, billing backlog) */
  cap?: Stage;
}

const SVC_LABEL: Record<ServiceKey, string> = {
  CATERING: "Katering Harian",
  HOUSEKEEPING: "Kebersihan Gedung",
  FACILITY: "Perawatan Fasilitas MEP",
  CAMP: "Operasional Camp dan Mess",
  PESTCTRL: "Pest Control dan Fogging",
};
const SVC_DEF: Record<ServiceKey, string> = {
  CATERING: "catering_daily_meal",
  HOUSEKEEPING: "housekeeping_daily",
  FACILITY: "facility_maintenance_monthly",
  CAMP: "camp_mess_operations",
  PESTCTRL: "pest_control_fogging",
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const CORRECTIVE_JOBS: [string, number, number][] = [
  ["Perbaikan AC ruang meeting lantai 3 (kompresor tidak dingin)", 2_400_000, 6_800_000],
  ["Penggantian lampu LED panel area produksi", 1_800_000, 5_200_000],
  ["Perbaikan atap bocor gudang sisi barat", 3_500_000, 12_000_000],
  ["Perbaikan pompa air booster dan penggantian pressure switch", 2_900_000, 7_400_000],
  ["Servis genset 250 kVA dan penggantian filter oli", 4_200_000, 9_800_000],
  ["Perbaikan pintu otomatis lobi dan sensor", 2_100_000, 6_500_000],
  ["Perbaikan instalasi listrik pantry (MCB sering trip)", 1_600_000, 4_300_000],
  ["Penggantian keran dan pipa toilet lantai 2 yang bocor", 1_200_000, 3_800_000],
  ["Pengecatan ulang dinding koridor dan ruang makan", 5_500_000, 14_000_000],
  ["Perbaikan cold storage dapur (suhu tidak stabil)", 3_800_000, 11_500_000],
  ["Pembersihan grease trap dapur dan saluran pembuangan", 1_900_000, 4_600_000],
  ["Pembersihan kaca eksterior gedung (gondola)", 4_500_000, 13_500_000],
];

const REJECT_REASONS = [
  "Jumlah porsi pada berita acara tidak sesuai dengan catatan kami, mohon rekonsiliasi ulang.",
  "Ada dua hari pengiriman yang terlambat lebih dari 30 menit, mohon dilampirkan penjelasan.",
  "Laporan checklist kebersihan lantai 4 belum ditandatangani PIC, mohon dilengkapi.",
  "Hasil perbaikan belum memuaskan, AC masih berbunyi keras setelah servis.",
  "Kami meminta bukti foto sebelum dan sesudah pekerjaan sebelum menyetujui.",
];

const holidayAdj = (d: string) => nextWorkday(d);

async function buildWoSpecs(ctx: DemoCtx, sites: SiteInfo[]): Promise<WoSpec[]> {
  const specs: WoSpec[] = [];
  const executors: UserKey[] = ["executor1", "executor2", "executor3"];
  const monthStart = (m: string) => `${m}-01`;

  // average planned portions per site / month / meal type (from the meal plans)
  const avg = await ctx.sql<{ site_id: string; m: string; meal_type: string; a: string }>(
    `SELECT site_id, to_char(meal_date,'YYYY-MM') m, meal_type, avg(planned_portions)::numeric(12,2)::text a
       FROM catering_meal_plans WHERE tenant_id = $1 GROUP BY 1,2,3`,
    [ctx.tenantId],
  );
  const avgMap = new Map(avg.map((r) => [`${r.site_id}|${r.m}|${r.meal_type}`, Number(r.a)]));

  const byCustomer = new Map<string, SiteInfo[]>();
  for (const s of sites) byCustomer.set(s.customer.code, [...(byCustomer.get(s.customer.code) ?? []), s]);
  // sites without meals are not returned by loadSites' filter in stepPlans, here we want all
  const allSites = await loadSites(ctx);
  for (const s of allSites) if (!byCustomer.get(s.customer.code)?.some((x) => x.id === s.id)) byCustomer.set(s.customer.code, [...(byCustomer.get(s.customer.code) ?? []), s]);

  let execIdx = 0;
  const execFor = () => executors[execIdx++ % executors.length]!;

  for (const cust of CUSTOMERS) {
    const csites = (byCustomer.get(cust.code) ?? []).sort((a, b) => a.code.localeCompare(b.code));
    if (csites.length === 0) continue;
    const nonCatering = cust.services.filter((s) => s !== "CATERING");
    const pestFee = nonCatering.includes("PESTCTRL") ? 6_500_000 : 0;
    const shared = nonCatering.filter((s) => s !== "PESTCTRL");
    const perSvcFee = shared.length > 0 ? Math.round((cust.contract.monthlyServiceFee - pestFee) / shared.length / 1000) * 1000 : 0;
    const payTerm = cust.contract.paymentTermCode;
    const slowBase = payTerm === "NET-45" ? 3 : 0;

    for (const m of ctx.cal.months) {
      const mEnd = lastDayOfMonth(m);
      for (const svc of cust.services) {
        // ---- which sites carry this service ----
        let svcSites: SiteInfo[];
        if (svc === "CATERING") svcSites = csites.filter((s) => s.dailyMeals > 0);
        else if (svc === "HOUSEKEEPING") svcSites = csites.filter((s) => s.headcount > 0);
        else if (svc === "CAMP") svcSites = csites.filter((s) => /Camp/.test(s.name)).slice(0, 1);
        else svcSites = csites.slice(0, 1);
        if (svcSites.length === 0) svcSites = csites.slice(0, 1);
        if (svc === "FACILITY") svcSites = csites.filter((s) => s.headcount > 0).slice(0, 1);
        if (svc === "FACILITY" && svcSites.length === 0) svcSites = csites.slice(0, 1);

        // PESTCTRL: quarterly (monthly at the terminal)
        if (svc === "PESTCTRL" && cust.code !== "CUST-111" && !["2025-12", "2026-03", "2026-06", "2026-09"].includes(m)) continue;

        const weights = svcSites.map((s) => (svc === "HOUSEKEEPING" ? Math.max(s.headcount, 1) : 1));
        const wsum = weights.reduce((a, b) => a + b, 0);

        svcSites.forEach((site, idx) => {
          const first = nextWorkday(maxDate(monthStart(m), site.start));
          if (first > mEnd || site.start > mEnd) return; // service not started yet in this month
          if (first > ctx.cal.today) return;
          const activeDays: string[] = [];
          for (let d = first; d <= mEnd && d <= ctx.cal.today; d = addDays(d, 1)) if (isWorkday(d, site.sixDay)) activeDays.push(d);
          const fullDays: string[] = [];
          for (let d = monthStart(m); d <= mEnd; d = addDays(d, 1)) if (isWorkday(d, site.sixDay)) fullDays.push(d);
          const prorate = fullDays.length > 0 ? Math.min(1, activeDays.length / fullDays.length) : 1;

          let revenue = 0;
          let portions: number | undefined;
          if (svc === "CATERING") {
            const lunchAvg = avgMap.get(`${site.id}|${m}|lunch`) ?? site.dailyMeals * 0.97;
            let total = lunchAvg * (m < ctx.cal.months[ctx.cal.months.length - 1]! ? fullDays.length * (m === first.slice(0, 7) ? prorate : 1) : activeDays.length);
            if (m === "2026-02" || m === "2026-03") {
              const din = avgMap.get(`${site.id}|${m}|dinner`) ?? 0;
              const bre = avgMap.get(`${site.id}|${m}|breakfast`) ?? 0;
              const ramDays = activeDays.filter((d) => d >= "2026-02-18" && d <= "2026-03-19").length;
              total += (din + bre) * ramDays;
            }
            portions = Math.round(total / 10) * 10;
            revenue = portions * cust.contract.mealPrice;
          } else if (svc === "PESTCTRL") {
            revenue = cust.code === "CUST-111" ? pestFee : Math.round(pestFee * 1.35);
          } else {
            const base = perSvcFee * (weights[idx]! / wsum);
            revenue = Math.round((base * prorate) / 1000) * 1000;
          }
          if (revenue <= 0) return;

          const title = `${SVC_LABEL[svc]} - ${site.name} - ${monthLabel(m)}`;
          const rnd = makeRand(hash(title));
          const lastWork = prevWorkday(mEnd);
          const late = rnd.chance(0.09);
          const completeDate = late ? nextWorkday(addDays(mEnd, rnd.int(1, 3))) : lastWork;
          const spec: WoSpec = {
            title,
            description:
              svc === "CATERING"
                ? `Rekap layanan katering ${monthLabel(m)} untuk ${site.name} (${cust.name}): produksi, pengiriman, dan penyajian sesuai kontrak ${cust.contract.code}.`
                : `Layanan ${SVC_LABEL[svc].toLowerCase()} ${monthLabel(m)} di ${site.name} (${cust.name}) sesuai kontrak ${cust.contract.code}.`,
            customer: cust,
            site,
            svc,
            defCode: SVC_DEF[svc],
            priority: rnd.chance(0.12) ? "high" : "medium",
            month: m,
            createDate: first,
            plannedStart: first,
            plannedEnd: mEnd,
            completeDate,
            revenue,
            markup: svc === "CATERING" ? 0.17 + rnd.next() * 0.04 : 0.21 + rnd.next() * 0.05,
            portions,
            executor: execFor(),
            viaToken: rnd.chance(0.35),
            late,
            slow: slowBase + (rnd.chance(0.15) ? rnd.int(2, 6) : 0),
          };
          specs.push(spec);
        });
      }

      // ---- ad hoc corrective jobs ----
      const hasFac = cust.services.includes("FACILITY");
      const p = hasFac ? 0.55 : cust.services.includes("HOUSEKEEPING") || cust.services.includes("CAMP") ? 0.22 : 0.1;
      const r = makeRand(hash(`${cust.code}|${m}|corrective`));
      const site0 = csites[0]!;
      if (site0.start <= mEnd && r.chance(p)) {
        const [job, lo, hi] = r.pick(CORRECTIVE_JOBS);
        const dom = r.int(3, 24);
        let d = nextWorkday(maxDate(`${m}-${String(dom).padStart(2, "0")}`, site0.start));
        if (d <= ctx.cal.today && monthOf(d) === m) {
          const site = r.pick(csites);
          const title = `${job} - ${site.name}`;
          // the same job text can recur in another month: add the month for uniqueness
          const full = `${title} (${monthLabel(m)})`;
          const done = nextWorkday(addDays(d, r.int(0, 3)));
          specs.push({
            title: full,
            description: `Permintaan perbaikan dari ${cust.contacts[0]?.name ?? "PIC"} (${cust.name}), lokasi ${site.name}.`,
            customer: cust,
            site,
            svc: "FACILITY",
            defCode: "facility_corrective",
            priority: r.chance(0.3) ? "high" : "medium",
            month: m,
            createDate: d,
            plannedStart: d,
            plannedEnd: done,
            completeDate: done,
            revenue: Math.round(r.int(lo, hi) / 1000) * 1000,
            markup: 0.24 + r.next() * 0.06,
            executor: execFor(),
            viaToken: r.chance(0.3),
            late: false,
            slow: r.chance(0.2) ? r.int(1, 5) : 0,
          });
        }
      }
    }
  }

  // ---- catering events ----
  const EVENTS: [string, string, string, number, number][] = [
    ["CUST-104", "2025-12-19", "Gathering Akhir Tahun Karyawan Bank Nusa Makmur", 300, 92000],
    ["CUST-103", "2026-01-30", "Syukuran Ulang Tahun Perusahaan Garuda Logistik", 180, 65000],
    ["CUST-109", "2026-04-25", "Wisuda dan Jamuan Tamu Kehormatan UTN", 600, 78000],
    ["CUST-105", "2026-04-18", "Peresmian Ruas Tol Seksi 2 Bandung Selatan", 450, 70000],
    ["CUST-106", "2026-05-12", "Perayaan Hari Perawat Internasional RS Harapan Sehat", 350, 58000],
    ["CUST-111", "2026-08-14", "Gathering HUT RI Terminal Tanjung Priok", 200, 72000],
    ["CUST-110", "2026-09-12", "Jamuan Tamu Direksi PT Energi Mandiri Persada", 120, 110000],
    ["CUST-102", "2026-10-24", "Family Day PT Cipta Elektronik Indonesia", 700, 62000],
  ];
  for (const [ccode, date, title, pax, price] of EVENTS) {
    const cust = customerByCode(ccode);
    const site = (byCustomer.get(ccode) ?? [])[0];
    if (!cust || !site || date < site.start || date > ctx.cal.today) continue;
    const created = nextWorkday(addDays(date, -5));
    const rnd = makeRand(hash(title));
    specs.push({
      title: `Event: ${title}`,
      description: `Katering event ${pax} tamu, prasmanan paket A dan snack box, ${site.name}.`,
      customer: cust,
      site,
      svc: "CATERING",
      defCode: "catering_event",
      priority: "high",
      month: monthOf(date),
      createDate: created,
      plannedStart: date,
      plannedEnd: date,
      completeDate: nextWorkday(addDays(date, date.slice(0, 10) === created ? 1 : 0) > date ? date : date),
      revenue: pax * price,
      markup: 0.27,
      portions: pax,
      executor: execFor(),
      viaToken: rnd.chance(0.3),
      late: false,
      slow: 0,
    });
  }

  // ---- work orders scheduled for the coming days (planned / just assigned) ----
  const UPCOMING: [string, string, string, string, number, number][] = [
    ["CUST-111", "pest_control_fogging", "Fogging dan rodent control berkala", "2026-11-06", 2, 0],
    ["CUST-104", "facility_corrective", "Pemeliharaan lift dan eskalator semester II", "2026-11-06", 4, 1],
    ["CUST-109", "housekeeping_daily", "Deep cleaning kampus menjelang wisuda Desember", "2026-11-09", 6, 0],
    ["CUST-102", "catering_event", "Katering Gathering Akhir Tahun Plant MM2100", "2026-11-05", 24, 1],
    ["CUST-110", "facility_corrective", "Penggantian filter air dan perbaikan WTP camp", "2026-11-09", 3, 0],
    ["CUST-106", "facility_corrective", "Kalibrasi dan servis chiller dapur gizi", "2026-11-06", 5, 1],
  ];
  for (const [ccode, defCode, what, created, inDays, cap] of UPCOMING) {
    const cust = customerByCode(ccode);
    const site = (byCustomer.get(ccode) ?? [])[0];
    if (!cust || !site || created > ctx.cal.today) continue;
    const planned = addDays(ctx.cal.today, inDays);
    const r = makeRand(hash(what));
    const isEvent = defCode === "catering_event";
    specs.push({
      title: `${what} - ${site.name}`,
      description: `Dijadwalkan ${planned}; menunggu penugasan dan persiapan tim. Permintaan dari ${cust.contacts[0]?.name ?? "PIC"} (${cust.name}).`,
      customer: cust,
      site,
      svc: isEvent ? "CATERING" : defCode === "pest_control_fogging" ? "PESTCTRL" : defCode === "housekeeping_daily" ? "HOUSEKEEPING" : "FACILITY",
      defCode,
      priority: r.chance(0.4) ? "high" : "medium",
      month: monthOf(planned),
      createDate: nextWorkday(created),
      plannedStart: planned,
      plannedEnd: addDays(planned, 1),
      completeDate: addDays(planned, 1),
      revenue: isEvent ? 400 * 68000 : r.int(3, 11) * 1_000_000,
      markup: 0.25,
      portions: isEvent ? 400 : undefined,
      executor: execFor(),
      viaToken: false,
      cap: cap as Stage,
    });
  }

  // ---- exceptions ----
  const pick = (title: RegExp, n = 1) => specs.filter((s) => title.test(s.title)).slice(0, n);
  // customer rejected, reworked, then accepted (old)
  const rework = [
    ...pick(/Kebersihan Gedung - Gedung Menara Sudirman - Januari 2026/),
    ...pick(/Katering Harian - Plant MM2100 - Mei 2026/),
    ...pick(/AC ruang meeting lantai 3.*Agustus 2026|AC ruang meeting lantai 3/),
  ];
  rework.forEach((s, i) => {
    s.reject = "rework";
    s.rejectReason = REJECT_REASONS[(i * 2) % REJECT_REASONS.length]!;
  });
  // still rejected right now
  for (const s of specs.filter((x) => x.month === "2026-10" && x.svc === "CATERING").slice(2, 3)) { s.reject = "open"; s.rejectReason = REJECT_REASONS[0]!; }
  for (const s of specs.filter((x) => x.month === "2026-10" && x.svc === "HOUSEKEEPING").slice(1, 2)) { s.reject = "open"; s.rejectReason = REJECT_REASONS[2]!; }
  // customer slow to sign last month's work orders / billing backlog
  const oct = specs.filter((x) => x.month === "2026-10" && x.defCode !== "facility_corrective" && !x.reject);
  oct.forEach((s, i) => {
    if (i % 6 === 1) s.cap = 4; // verified, waiting for the customer
    else if (i % 6 === 3) s.cap = 5; // accepted, cost & invoice not yet processed
  });
  specs.sort((a, b) => (a.createDate + a.title < b.createDate + b.title ? -1 : 1));
  return specs;
}

interface Timeline {
  create: number; assign: number; start: number; complete: number; verify: number; reject?: number; accept: number; serve: number; cost: number; final: number; invoice: number;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
function buildTimeline(ctx: DemoCtx, s: WoSpec): Timeline {
  const rnd = makeRand(hash(s.title + "|tl"));
  const t = (date: string, h: number, m = 0) => new Date(ctx.cal.at(date, h, m)).getTime();
  const create = t(s.createDate, rnd.int(7, 9), rnd.int(0, 59));
  const assign = create + rnd.int(20, 90) * 60_000;
  const start = Math.max(assign + 30 * 60_000, t(s.createDate, 10, rnd.int(0, 40)) + (s.defCode === "facility_corrective" ? rnd.int(0, 1) * DAY : 0));
  const complete = Math.max(start + 2 * HOUR, t(s.completeDate, rnd.int(14, 17), rnd.int(0, 59)));
  const verifyDate = nextWorkday(addDays(s.completeDate, rnd.int(1, 2)));
  const verify = Math.max(complete + 2 * HOUR, t(verifyDate, rnd.int(9, 14), rnd.int(0, 59)));
  const reject = s.reject ? verify + rnd.int(1, 2) * DAY + rnd.int(1, 5) * HOUR : undefined;
  const acceptBase = (reject ?? verify) + (s.reject ? rnd.int(3, 5) * DAY : rnd.int(1, 3) * DAY) + (s.slow ?? 0) * DAY;
  const accept = acceptBase + rnd.int(1, 6) * HOUR;
  const serve = accept + 30 * 60_000;
  const cost = accept + DAY + rnd.int(1, 4) * HOUR;
  const final = cost + rnd.int(1, 3) * HOUR;
  const invoice = final + rnd.int(1, 2) * DAY + rnd.int(0, 3) * HOUR;
  return { create, assign, start, complete, verify, reject, accept, serve, cost, final, invoice };
}

function targetStage(s: WoSpec, tl: Timeline, now: number): Stage {
  let st: Stage = 0;
  if (tl.assign <= now) st = 1;
  if (tl.start <= now) st = 2;
  if (tl.complete <= now) st = 3;
  if (tl.verify <= now) st = 4;
  if (tl.accept <= now) st = 5;
  if (tl.cost <= now && tl.final <= now) st = 6;
  if (tl.invoice <= now) st = 7;
  if (s.reject === "open" && st >= 4) st = 4;
  if (s.cap !== undefined && st > s.cap) st = s.cap;
  return st;
}

async function stepWorkOrders(ctx: DemoCtx): Promise<void> {
  const sites = await loadSites(ctx);
  const specsAll = await buildWoSpecs(ctx, sites);
  const limit = process.env.SO_WO_LIMIT ? Number(process.env.SO_WO_LIMIT) : Infinity;
  const specs = specsAll.slice(0, limit);
  const now = Math.min(Date.now(), new Date(ctx.cal.at(ctx.cal.today, 17)).getTime());

  const [le] = await ctx.sql<{ id: string }>(`SELECT id FROM legal_entities WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [ctx.tenantId]);
  if (!le) throw new Error("legal entity missing");
  const periods = new Map<string, string>();
  for (const m of ctx.cal.months) {
    const pc = periodCodeOf(m);
    const [p] = await ctx.sql<{ id: string }>(`SELECT id FROM accounting_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period_code = $3`, [ctx.tenantId, le.id, pc.periodCode]);
    if (!p) throw new Error(`accounting period ${pc.periodCode} missing`);
    periods.set(m, p.id);
  }
  const cc = new Map((await ctx.sql<{ code: string; id: string }>(`SELECT code, id FROM finance_cost_centers WHERE tenant_id = $1`, [ctx.tenantId])).map((r) => [r.code, r.id]));
  const custIds = new Map((await ctx.sql<{ code: string; id: string }>(`SELECT code, id FROM customers WHERE tenant_id = $1`, [ctx.tenantId])).map((r) => [r.code, r.id]));
  const contractIds = new Map((await ctx.sql<{ customer_id: string; id: string }>(`SELECT customer_id, id FROM contracts WHERE tenant_id = $1 ORDER BY created_at`, [ctx.tenantId])).map((r) => [r.customer_id, r.id]));
  const uid = new Map<UserKey, string>();
  for (const k of ["coordinator", "executor1", "executor2", "executor3", "verifier", "billing"] as UserKey[]) uid.set(k, await userIdByEmail(ctx, USERS[k].email));
  const have = new Map((await ctx.sql<{ title: string; id: string }>(`SELECT title, id FROM work_orders WHERE tenant_id = $1`, [ctx.tenantId])).map((r) => [r.title, r.id]));

  const stats = { created: 0, advanced: 0, byStage: new Array(8).fill(0) as number[] };
  const periodOf = (ms: number) => {
    const ym = new Date(ms + 7 * HOUR).toISOString().slice(0, 7);
    return periods.get(ym) ?? periods.get(ctx.cal.months[ctx.cal.months.length - 1]!)!;
  };

  for (const s of specs) {
    const tl = buildTimeline(ctx, s);
    const target = targetStage(s, tl, now);
    const customerId = custIds.get(s.customer.code)!;
    let woId = have.get(s.title);
    let touched = false;

    if (!woId) {
      const wo = await as<any>(ctx, "coordinator", "POST", "/work-orders", {
        customerId,
        contractId: contractIds.get(customerId) ?? null,
        siteId: s.site.id,
        serviceDefinitionCode: s.defCode,
        title: s.title,
        description: s.description,
        priority: s.priority,
        plannedStartAt: ctx.cal.at(s.plannedStart, 8),
        plannedEndAt: ctx.cal.at(s.plannedEnd, 17),
        dueAt: ctx.cal.at(addDays(s.plannedEnd, 1), 17),
      });
      woId = wo.id as string;
      have.set(s.title, woId);
      stats.created++;
      touched = true;
    }

    // ---- state-driven progression (resumable) ----
    const st = async () =>
      (
        await ctx.sql<any>(
          `SELECT w.created_at, w.assigned_to_user_id, w.started_at, w.completed_at, w.verified_at, w.customer_accepted_at, w.customer_rejected_at,
                  w.costs_finalized_at, w.serving_recorded_at, s.code AS step,
                  (SELECT count(*) FROM work_order_cost_items c WHERE c.work_order_id = w.id) AS n_costs,
                  (SELECT count(*) FROM customer_invoices i WHERE i.work_order_id = w.id) AS n_inv
             FROM work_orders w LEFT JOIN workflow_instances wi ON wi.id = w.workflow_instance_id
             LEFT JOIN workflow_steps s ON s.id = wi.current_step_id WHERE w.id = $1`,
          [woId],
        )
      )[0];
    let row = await st();
    const exec = s.executor;

    if (target >= 1 && !row.assigned_to_user_id) {
      await as(ctx, "coordinator", "POST", `/work-orders/${woId}/assign`, { assigneeUserId: uid.get(exec) });
      touched = true;
    }
    if (target >= 2 && !row.started_at) {
      await as(ctx, "executor1" === exec ? "executor1" : exec, "POST", `/work-orders/${woId}/start`);
      touched = true;
      row = await st();
    }
    if (target >= 2 && row.step === "PLANNED") {
      await as(ctx, "coordinator", "POST", `/work-orders/${woId}/actions/start`, { comment: "Pekerjaan dimulai sesuai jadwal" });
      touched = true;
    }
    if (target >= 3 && !row.completed_at) {
      const items = await ctx.sql<{ id: string; code: string; is_completed: boolean }>(
        `SELECT id, code, is_completed FROM work_order_checklist_items WHERE work_order_id = $1 ORDER BY sort_order`,
        [woId],
      );
      for (const it of items) {
        if (it.is_completed) continue;
        await as(ctx, exec, "POST", `/work-orders/${woId}/checklist/${it.id}`, { isCompleted: true, note: checklistNote(it.code, s) });
      }
      await as(ctx, exec, "POST", `/work-orders/${woId}/complete`, {
        notes: s.late ? "Pekerjaan selesai, terlambat karena penyesuaian jadwal di lokasi pelanggan." : "Pekerjaan selesai sesuai lingkup dan jadwal.",
      });
      touched = true;
      row = await st();
    }
    if (target >= 3 && row.step === "IN_PROGRESS") {
      await as(ctx, "coordinator", "POST", `/work-orders/${woId}/actions/complete`, { comment: "Eksekusi selesai" });
      touched = true;
      row = await st();
    }
    if (target >= 4 && !row.verified_at) {
      await as(ctx, "verifier", "POST", `/work-orders/${woId}/verify`, { notes: "Hasil kerja diperiksa di lokasi dan sesuai standar layanan." });
      touched = true;
      row = await st();
    }
    if (target >= 4 && row.step === "DONE") {
      await as(ctx, "coordinator", "POST", `/work-orders/${woId}/actions/verify`, { comment: "Terverifikasi oleh supervisor" });
      touched = true;
      row = await st();
    }
    if (s.reject && target >= 4 && !row.customer_rejected_at && !row.customer_accepted_at) {
      // customer rejected (reworked ones are accepted later below)
      if (tl.reject! <= now) {
        await as(ctx, "verifier", "POST", `/work-orders/${woId}/customer-reject`, { reason: s.rejectReason });
        touched = true;
        row = await st();
      }
    }
    if (target >= 5 && !row.customer_accepted_at) {
      if (s.viaToken) {
        const issued = await as<any>(ctx, "verifier", "POST", `/work-orders/${woId}/acceptance-token`, { expiresInDays: 30 });
        const r = await ctx.app.inject({
          method: "POST",
          url: `/public/work-orders/acceptance/${issued.token}/accept`,
          payload: { comment: "Diterima oleh perwakilan pelanggan melalui tautan persetujuan." },
        });
        if (r.statusCode !== 200) throw new Error(`token accept ${r.statusCode}: ${r.body}`);
      } else {
        await as(ctx, "verifier", "POST", `/work-orders/${woId}/customer-accept`, {
          comment: s.reject === "rework" ? "Perbaikan sudah sesuai, pekerjaan diterima." : "Berita acara ditandatangani PIC pelanggan.",
        });
      }
      touched = true;
      row = await st();
    }
    if (target >= 6) {
      if (s.svc === "CATERING" && s.portions && !row.serving_recorded_at) {
        const mealDate = s.defCode === "catering_event" ? s.plannedEnd : prevWorkday(lastDayOfMonth(s.month) > ctx.cal.today ? ctx.cal.today : lastDayOfMonth(s.month));
        const rr = makeRand(hash(s.title + "|srv"));
        const received = s.portions;
        const returned = Math.round(received * (0.004 + rr.next() * 0.008));
        const wasted = Math.round(received * (0.003 + rr.next() * 0.007));
        const served = received - returned - wasted;
        await as(ctx, "coordinator", "POST", `/work-orders/${woId}/serving`, {
          mealDate,
          mealType: "lunch",
          openingTime: ctx.cal.at(mealDate, 11, 30),
          closingTime: ctx.cal.at(mealDate, 13, 30),
          receivedQty: String(received),
          servedQty: String(served),
          returnedQty: String(returned),
          wastedQty: String(wasted),
          servingSupervisorUserId: uid.get(exec),
          notes: s.defCode === "catering_event" ? "Rekap penyajian event" : "Rekap penyajian bulanan (agregat seluruh hari layanan)",
        });
        touched = true;
      }
      if (Number(row.n_costs) === 0) {
        for (const c of costLines(ctx, s, cc)) await as(ctx, "coordinator", "POST", `/work-orders/${woId}/cost-items`, c);
        touched = true;
      }
      if (!row.costs_finalized_at) {
        await as(ctx, "verifier", "POST", `/work-orders/${woId}/finalize-costs`, { legalEntityId: le.id });
        touched = true;
        row = await st();
      }
    }
    if (target >= 7 && Number(row.n_inv) === 0) {
      await as(ctx, "billing", "POST", `/work-orders/${woId}/create-invoice`, {
        legalEntityId: le.id,
        markupRate: (Math.round(s.markup * 100) / 100).toFixed(2),
        isTaxable: true,
        taxRate: "0.11",
      });
      touched = true;
    }
    if (Math.abs(new Date((await st()).created_at).getTime() - tl.create) > 2000) touched = true; // crashed before backdating last time
    stats.byStage[target]!++;

    if (touched) {
      stats.advanced++;
      await backdateWo(ctx, woId!, s, tl, target, periodOf, uid);
    }
    if (stats.created > 0 && stats.created % 25 === 0 && touched) ctx.log("service-ops", `work orders processed: ${stats.created} (${s.createDate})`);
  }

  // Numbers follow business chronology.
  await renumberMine(ctx, "customer_invoices", "invoice_number", "INV-", "issued_at", `work_order_id IN (SELECT id FROM work_orders WHERE tenant_id = $1 AND customer_id NOT IN (SELECT id FROM customers WHERE tenant_id = $1 AND code NOT LIKE 'CUST-1__'))`);
  await renumberMine(ctx, "work_order_serving_logs", "serving_number", "SRV-", "recorded_at", `TRUE`);
  await repairJournalDates(ctx);
  ctx.log(
    "service-ops",
    `work orders: ${stats.created} created, ${stats.advanced} advanced; final stages created/assigned/started/completed/verified/accepted/costed/invoiced = ${stats.byStage.join("/")}`,
  );
}

/** The dev API's scheduler posts outbox events within seconds. A journal that
 * was claimed in the instant between the API call and the backdating gets
 * today's date; move such journals (and their GL lines and balances) to the
 * event's business date. Idempotent. */
async function repairJournalDates(ctx: DemoCtx): Promise<void> {
  const bad = await ctx.sql<{ id: string; legal_entity_id: string; old_period: string; d: string }>(
    `SELECT j.id, j.legal_entity_id, j.period_id AS old_period, (e.effective_at AT TIME ZONE 'UTC')::date::text AS d
       FROM journal_headers j JOIN scm_accounting_ready_events e ON e.tenant_id = j.tenant_id AND e.idempotency_key = j.idempotency_key
      WHERE j.tenant_id = $1 AND e.event_type IN ('work_order.cost_accumulated','work_order.invoiced','work_order.invoice_tax')
        AND j.accounting_date <> (e.effective_at AT TIME ZONE 'UTC')::date`,
    [ctx.tenantId],
  );
  for (const j of bad) {
    const pc = periodCodeOf(j.d.slice(0, 7)).periodCode;
    const [np] = await ctx.sql<{ id: string }>(`SELECT id FROM accounting_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period_code = $3`, [ctx.tenantId, j.legal_entity_id, pc]);
    if (!np) continue;
    await ctx.sql(`UPDATE journal_headers SET journal_date = $2::date, accounting_date = $2::date, period_id = $3 WHERE id = $1`, [j.id, j.d, np.id]);
    const accs = await ctx.sql<{ account_id: string }>(`SELECT DISTINCT account_id FROM journal_lines WHERE journal_header_id = $1`, [j.id]);
    await ctx.sql(
      `UPDATE general_ledger_entries SET posting_date = $2::date, period_id = $3 WHERE journal_line_id IN (SELECT id FROM journal_lines WHERE journal_header_id = $1)`,
      [j.id, j.d, np.id],
    );
    for (const a of accs) {
      for (const period of [j.old_period, np.id]) {
        await ctx.sql(
          `INSERT INTO gl_balances (tenant_id, account_id, period_id, opening_balance, debit_total, credit_total, closing_balance, last_refreshed)
           SELECT $1, $2, $3, 0, COALESCE(SUM(g.debit),0), COALESCE(SUM(g.credit),0),
                  CASE WHEN aa.normal_balance = 'debit' THEN COALESCE(SUM(g.debit),0) - COALESCE(SUM(g.credit),0) ELSE COALESCE(SUM(g.credit),0) - COALESCE(SUM(g.debit),0) END, now()
             FROM accounting_accounts aa LEFT JOIN general_ledger_entries g ON g.account_id = aa.id AND g.period_id = $3 AND g.tenant_id = $1
            WHERE aa.id = $2 GROUP BY aa.normal_balance
           ON CONFLICT (tenant_id, account_id, period_id) DO UPDATE SET debit_total = EXCLUDED.debit_total, credit_total = EXCLUDED.credit_total,
             closing_balance = EXCLUDED.closing_balance, last_refreshed = now()`,
          [ctx.tenantId, a.account_id, period],
        );
      }
    }
  }
  if (bad.length > 0) ctx.log("service-ops", `moved ${bad.length} early-posted work order journal(s) to their business date`);
}

function checklistNote(code: string, s: WoSpec): string | null {
  const r = makeRand(hash(s.title + code));
  switch (code) {
    case "temp_check": return `Suhu rata-rata saat serah terima ${r.int(63, 74)} derajat Celsius`;
    case "on_time": return s.late ? "Terdapat keterlambatan pada beberapa hari akibat kemacetan tol" : null;
    case "qty_match": return "Sesuai berita acara serah terima harian";
    case "sample_kept": return "Food sample disimpan di chiller 24 jam";
    case "attendance": return `Kehadiran petugas ${r.int(95, 100)} persen`;
    case "parts_used": return "Suku cadang tercatat di form servis";
    default: return null;
  }
}

function costLines(ctx: DemoCtx, s: WoSpec, cc: Map<string, string>) {
  const basis = Math.round(s.revenue / (1 + s.markup));
  const ccId = cc.get(s.svc === "CATERING" ? "CC-CAT" : "CC-FAC") ?? null;
  const split =
    s.svc === "CATERING" ? { material: 0.52, labor: 0.34, overhead: 0.14 }
    : s.defCode === "facility_corrective" ? { material: 0.45, labor: 0.45, overhead: 0.1 }
    : { material: 0.16, labor: 0.74, overhead: 0.1 };
  const qty = s.portions ?? Math.max(1, Math.round(s.revenue / 350_000));
  const lines: { costType: string; description: string; quantity: string; unitCost: string; costCenterId: string | null }[] = [];
  const mk = (costType: string, description: string, amount: number, q: number) => {
    // whole-hundred rupiah unit costs: cost x (1 + markup) and its PPN then stay at <= 2 decimals,
    // which the accounting consumer insists on (it rejects 4-decimal amounts).
    const unit = Math.max(100, Math.round(amount / q / 100) * 100);
    lines.push({ costType, description, quantity: String(q), unitCost: unit.toFixed(2), costCenterId: ccId });
  };
  if (s.svc === "CATERING") {
    mk("material", s.defCode === "catering_event" ? "Bahan makanan dan minuman event" : "Bahan makanan (beras, protein, sayur, bumbu)", basis * split.material * 0.82, qty);
    mk("material", "Kemasan nasi box, sendok garpu, dan gelas", basis * split.material * 0.18, qty);
    mk("labor", "Tenaga dapur dan distribusi", basis * split.labor, Math.max(1, Math.round(qty / 38)));
    mk("overhead", "Gas, listrik dapur, BBM kendaraan, dan penyusutan peralatan", basis * split.overhead, 1);
  } else {
    mk("labor", s.svc === "HOUSEKEEPING" ? "Tenaga kebersihan ditempatkan (orang-bulan)" : "Tenaga teknisi dan operator", basis * split.labor, Math.max(1, Math.round(s.site.headcount || 4)));
    mk("material", s.svc === "PESTCTRL" ? "Bahan kimia dan bait station" : "Bahan habis pakai dan suku cadang", basis * split.material, Math.max(1, Math.round(qty / 3)));
    mk("overhead", "Peralatan, transport, dan supervisi", basis * split.overhead, 1);
  }
  return lines;
}

async function backdateWo(
  ctx: DemoCtx,
  woId: string,
  s: WoSpec,
  tl: Timeline,
  target: Stage,
  periodOf: (ms: number) => string,
  uid: Map<UserKey, string>,
): Promise<void> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const sets: string[] = [`created_at = $2`];
  const vals: unknown[] = [woId, iso(tl.create)];
  const add = (col: string, ms: number) => { vals.push(iso(ms)); sets.push(`${col} = $${vals.length}`); };
  const rejected = !!s.reject && target >= 4 && tl.reject !== undefined;
  const last = target >= 7 ? tl.invoice : target >= 6 ? tl.final : target >= 5 ? tl.accept : target >= 4 ? (rejected ? tl.reject! : tl.verify) : target >= 3 ? tl.complete : target >= 2 ? tl.start : target >= 1 ? tl.assign : tl.create;
  add("updated_at", last);
  if (target >= 1) add("assigned_at", tl.assign);
  if (target >= 2) add("started_at", tl.start);
  if (target >= 3) add("completed_at", tl.complete);
  if (target >= 4) add("verified_at", tl.verify);
  if (rejected && target < 5) add("customer_rejected_at", tl.reject!);
  if (target >= 5) add("customer_accepted_at", tl.accept);
  if (target >= 6) add("costs_finalized_at", tl.final);
  if (target >= 6 && s.svc === "CATERING" && s.portions) add("serving_recorded_at", tl.serve);
  await ctx.sql(`UPDATE work_orders SET ${sets.join(", ")} WHERE id = $1`, vals);

  // checklist completion times spread between start and completion
  if (target >= 3) {
    const items = await ctx.sql<{ id: string }>(`SELECT id FROM work_order_checklist_items WHERE work_order_id = $1 ORDER BY sort_order`, [woId]);
    for (let i = 0; i < items.length; i++) {
      const at = tl.start + ((tl.complete - tl.start) * (i + 1)) / (items.length + 1);
      await ctx.sql(`UPDATE work_order_checklist_items SET completed_at = $2 WHERE id = $1 AND is_completed`, [items[i]!.id, iso(at)]);
    }
  }
  await ctx.sql(`UPDATE work_order_cost_items SET created_at = $2, recorded_at = $2, updated_at = $2 WHERE work_order_id = $1`, [woId, iso(tl.cost)]);
  await ctx.sql(`UPDATE work_order_serving_logs SET created_at = $2, recorded_at = $2, updated_at = $2 WHERE work_order_id = $1`, [woId, iso(tl.serve)]);
  await ctx.sql(
    `UPDATE work_order_acceptance_tokens SET created_at = $2, used_at = CASE WHEN used_at IS NULL THEN NULL ELSE $3::timestamptz END,
            expires_at = $2::timestamptz + interval '30 days' WHERE work_order_id = $1`,
    [woId, iso(tl.verify + 3 * HOUR), iso(tl.accept)],
  );

  // invoice + accounting outbox events
  let invoiceId: string | undefined;
  if (target >= 7) {
    invoiceId = (await ctx.sql<{ id: string }>(`SELECT id FROM customer_invoices WHERE work_order_id = $1`, [woId]))[0]?.id;
    if (invoiceId) {
      await ctx.sql(`UPDATE customer_invoices SET issued_at = $2, created_at = $2, updated_at = $2, period_id = $3 WHERE id = $1`, [invoiceId, iso(tl.invoice), periodOf(tl.invoice)]);
    }
  }
  const evs = await ctx.sql<{ id: string; idempotency_key: string }>(
    `SELECT id, idempotency_key FROM scm_accounting_ready_events WHERE tenant_id = $1 AND source_document_id = ANY($2::uuid[])`,
    [ctx.tenantId, [woId, ...(invoiceId ? [invoiceId] : [])]],
  );
  if (evs.length > 0) {
    // The accounting outbox is append-only by trigger. The demo history must put
    // the facts on the business date, so the immutability trigger is lifted for
    // this one transaction (DDL is transactional: it is re-enabled before commit
    // and no other session ever sees it disabled).
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE scm_accounting_ready_events DISABLE TRIGGER trg_scm_accounting_ready_events_immutable_facts");
      for (const e of evs) {
        const k = e.idempotency_key;
        const at = k.startsWith("wo-accept") ? tl.accept : k.startsWith("wo-cost") ? tl.final : tl.invoice;
        await client.query(
          `UPDATE scm_accounting_ready_events SET effective_at = $2, created_at = $2,
                  payload = CASE WHEN payload ? 'periodId' THEN jsonb_set(payload, '{periodId}', to_jsonb($3::text)) ELSE payload END WHERE id = $1`,
          [e.id, iso(at), periodOf(at)],
        );
        await client.query(`UPDATE scm_accounting_ready_event_state_transitions SET occurred_at = $2 WHERE accounting_event_id = $1`, [e.id, iso(at)]);
      }
      await client.query("ALTER TABLE scm_accounting_ready_events ENABLE TRIGGER trg_scm_accounting_ready_events_immutable_facts");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // workflow trail
  const wi = (await ctx.sql<{ id: string }>(`SELECT workflow_instance_id AS id FROM work_orders WHERE id = $1`, [woId]))[0]?.id;
  if (wi) {
    await ctx.sql(`UPDATE workflow_instances SET started_at = $2, completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $3::timestamptz END WHERE id = $1`, [wi, iso(tl.create), iso(tl.verify)]);
    const hist = await ctx.sql<{ id: string; action_code: string | null }>(`SELECT id, action_code FROM workflow_history WHERE workflow_instance_id = $1`, [wi]);
    for (const h of hist) {
      const at = h.action_code === "start" ? tl.start : h.action_code === "complete" ? tl.complete : h.action_code === "verify" ? tl.verify : tl.create;
      await ctx.sql(`UPDATE workflow_history SET occurred_at = $2 WHERE id = $1`, [h.id, iso(at)]);
    }
    const asg = await ctx.sql<{ id: string; code: string }>(
      `SELECT a.id, st.code FROM workflow_instance_assignments a JOIN workflow_steps st ON st.id = a.step_id WHERE a.workflow_instance_id = $1`,
      [wi],
    );
    for (const a of asg) {
      const [from, to] = a.code === "PLANNED" ? [tl.create, tl.start] : a.code === "IN_PROGRESS" ? [tl.start, tl.complete] : [tl.complete, tl.verify];
      await ctx.sql(
        `UPDATE workflow_instance_assignments SET due_at = CASE WHEN due_at IS NULL THEN NULL ELSE $2::timestamptz + (due_at - assigned_at) END,
                decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE $3::timestamptz END,
                claimed_at = CASE WHEN claimed_at IS NULL THEN NULL ELSE $3::timestamptz END, assigned_at = $2 WHERE id = $1`,
        [a.id, iso(from), iso(to)],
      );
    }
  }

  // audit log, domain events, notifications
  const ids = [woId, ...(invoiceId ? [invoiceId] : []), ...(wi ? [wi] : [])];
  await backdateTrail(ctx, ids, (action) => {
    const a = action.toLowerCase();
    let ms = tl.create;
    if (a.includes("assigned")) ms = tl.assign;
    else if (a.includes("started") && !a.includes("workflow")) ms = tl.start;
    else if (a.includes("completed")) ms = tl.complete;
    else if (a.includes("verified")) ms = tl.verify;
    else if (a.includes("acceptance_token")) ms = tl.verify + 3 * HOUR;
    else if (a.includes("customer_rejected") || a.includes("rejected")) ms = tl.reject ?? tl.verify;
    else if (a.includes("customer_accepted") || a.includes("accepted")) ms = tl.accept;
    else if (a.includes("serving")) ms = tl.serve;
    else if (a.includes("cost_item")) ms = tl.cost;
    else if (a.includes("costs_finalized") || a.includes("cost_accumulated")) ms = tl.final;
    else if (a.includes("invoice")) ms = tl.invoice;
    return iso(ms);
  });
  void uid;
}

/** Re-number the documents created by this sector (those matching `where`)
 * 1..n in business-date order, keeping numbers of pre-existing rows. */
async function renumberMine(ctx: DemoCtx, table: string, col: string, prefix: string, tsCol: string, where: string): Promise<void> {
  const mine = await ctx.sql<{ id: string; num: string }>(`SELECT id, ${col} AS num FROM ${table} WHERE tenant_id = $1 AND ${where} ORDER BY ${tsCol}, id`, [ctx.tenantId]);
  const others = await ctx.sql<{ num: string }>(`SELECT ${col} AS num FROM ${table} WHERE tenant_id = $1 AND NOT (${where})`, [ctx.tenantId]);
  const used = others.map((o) => Number(o.num.replace(prefix, ""))).filter((n) => Number.isFinite(n));
  const startAt = (used.length ? Math.max(...used) : 0) + 1;
  const want = mine.map((r, i) => `${prefix}${String(startAt + i).padStart(5, "0")}`);
  if (mine.every((r, i) => r.num === want[i])) return;
  await ctx.sql(`UPDATE ${table} SET ${col} = 'TMP-' || id::text WHERE id = ANY($1::uuid[])`, [mine.map((m) => m.id)]);
  for (let i = 0; i < mine.length; i++) await ctx.sql(`UPDATE ${table} SET ${col} = $2 WHERE id = $1`, [mine[i]!.id, want[i]]);
}

// ---------------------------------------------------------------------------

export async function run(ctx: DemoCtx): Promise<void> {
  const steps = new Set((process.env.SO_STEPS ?? "defs,catering,plans,wo").split(",").map((s) => s.trim()));
  if (steps.has("defs")) await stepDefinitions(ctx);
  if (steps.has("catering")) await stepCatering(ctx);
  if (steps.has("plans")) await stepPlans(ctx);
  if (steps.has("wo")) await stepWorkOrders(ctx);
  void renumberChronologically; void holidayAdj; void minDate;
}
