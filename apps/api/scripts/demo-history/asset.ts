/**
 * Sector "asset": a year of asset-register and maintenance history for
 * PT Sentra Layanan Terpadu.
 *
 * Assets (vans, motorcycles, kitchen and cold-chain equipment, cleaning
 * machines, AC units, genset, forklift, IT) are registered through the API,
 * moved between sites/custodians, and maintained by preventive schedules
 * (calendar or km/hour based) plus a hand-written list of breakdowns. Every
 * maintenance work order walks assign -> start -> complete -> verify through
 * the generic workflow engine, spare parts are issued from the warehouse
 * ledgers, meter readings and downtime are recorded, and reliability
 * snapshots are produced from the resulting history.
 *
 * Everything is derived deterministically (seeded per asset/schedule), then
 * replayed in date order and finally backdated with SQL. Idempotent: assets are
 * found by tag, schedules by code, work orders by their "Ref:" key, readings
 * and downtime by timestamp/reference.
 */
import { makeRand, type DemoCtx } from "./harness.js";
import { ITEMS, USERS, DEMO_PASSWORD, activityFactor, type UserKey } from "./catalog.js";

const SECTOR = "asset";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const addDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
const nextWorkday = (d: string) => (dow(d) === 0 ? addDays(d, 1) : d);
const diffDays = (a: string, b: string) => Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
const iso = (d: string, hour: number, minute = 0) =>
  new Date(`${d}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+07:00`).toISOString();
const isoPlusHours = (d: string, hour: number, minute: number, hours: number) =>
  new Date(new Date(iso(d, hour, minute)).getTime() + hours * 3600000).toISOString();
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const rngFor = (s: string) => makeRand(hash(s) || 1);
const rp = (v: number, step = 5000) => Math.round(v / step) * step;

type Org = "CATERING" | "FACILITY" | "WAREHOUSE" | "HEAD_OFFICE";
const ORG_NAME: Record<Org, string> = {
  CATERING: "Catering Operations",
  FACILITY: "Facility Services",
  WAREHOUSE: "Warehouse & Logistics",
  HEAD_OFFICE: "Head Office",
};

const count: Record<string, number> = {};
const made = (k: string, n = 1) => { count[k] = (count[k] ?? 0) + n; };

// ---------------------------------------------------------------------------
// asset catalogue
// ---------------------------------------------------------------------------

interface Move { date: string; site?: string | null; loc?: string; cust?: string | null; reason: string }
interface StatusChange { date: string; status: "idle" | "in_use"; reason: string }
interface AssetSpec {
  tag: string;
  name: string;
  category: string;
  org: Org;
  site?: string;
  loc: string;
  cust?: string; // employee number
  acquired: string;
  ref: string;
  description: string;
  status?: "idle";
  moves?: Move[];
  stat?: StatusChange[];
  retire?: { date: string; status: "retired" | "disposed"; reason: string };
  meter?: { type: "km" | "hours"; start: number; perDay: number; every: number };
}

const GO_LIVE = "2025-11-09";
const K_VEH = "Kendaraan Operasional";
const K_KIT = "Peralatan Dapur";
const K_COLD = "Peralatan Pendingin";
const K_CLN = "Peralatan Kebersihan";
const K_HVAC = "AC & HVAC";
const K_GEN = "Mesin & Genset";
const K_WH = "Peralatan Gudang";
const K_IT = "Peralatan IT";

const KITCHEN_LOC = "Dapur Pusat Cikarang";
const HO_LOC = "Kantor Pusat Jakarta";

const ASSETS: AssetSpec[] = [
  // --- Vehicles -----------------------------------------------------------------------------
  { tag: "VAN-01", name: "Daihatsu Gran Max Box B 9021 KXA", category: K_VEH, org: "WAREHOUSE", loc: "Pool kendaraan Cikarang", cust: "EMP-0014", acquired: "2022-03-14", ref: "Faktur PT Astra Daihatsu Motor No. AD/2022/03/1187", description: "Mobil boks distribusi makanan ke site pelanggan area Bekasi-Karawang.", meter: { type: "km", start: 78400, perDay: 62, every: 14 } },
  { tag: "VAN-02", name: "Daihatsu Gran Max Box B 9144 KXB", category: K_VEH, org: "WAREHOUSE", loc: "Pool kendaraan Cikarang", cust: "EMP-0015", acquired: "2023-02-20", ref: "Faktur PT Astra Daihatsu Motor No. AD/2023/02/0452", description: "Mobil boks distribusi makanan area Jakarta Utara-Tangerang.", meter: { type: "km", start: 52300, perDay: 58, every: 14 } },
  { tag: "VAN-03", name: "Suzuki Carry Box Pendingin B 9310 KXC", category: K_VEH, org: "WAREHOUSE", loc: "Pool kendaraan Cikarang", cust: "EMP-0014", acquired: "2024-01-10", ref: "Faktur PT Suzuki Indomobil Sales No. SIS/24/01/0093", description: "Mobil boks berpendingin (cold chain) untuk pengiriman protein dan makanan siap saji jarak jauh.", meter: { type: "km", start: 33100, perDay: 70, every: 14 }, moves: [{ date: "2026-04-06", cust: "EMP-0019", reason: "Pergantian pengemudi unit boks pendingin" }] },
  { tag: "VAN-04", name: "Mitsubishi L300 Box B 9402 KXD", category: K_VEH, org: "WAREHOUSE", loc: "Pool kendaraan Cikarang", cust: "EMP-0024", acquired: "2021-08-02", ref: "Faktur PT Mitsubishi Krama Yudha Sales No. KY/21/08/2210", description: "Mobil boks cadangan dan pengangkut bahan baku dari pemasok ke gudang.", meter: { type: "km", start: 118900, perDay: 45, every: 14 } },
  { tag: "VAN-05", name: "Toyota Hiace Commuter B 7733 KXE", category: K_VEH, org: "HEAD_OFFICE", loc: "Pool kendaraan Kantor Pusat", cust: "EMP-0019", acquired: "2026-05-18", ref: "Faktur PT Toyota Astra Motor No. TAM/26/05/0771 (kontrak antar-jemput Plant Karawang)", description: "Kendaraan antar-jemput karyawan site Karawang, unit baru.", meter: { type: "km", start: 14, perDay: 52, every: 14 } },
  { tag: "VAN-X1", name: "Suzuki APV Blind Van B 9009 KXZ", category: K_VEH, org: "WAREHOUSE", loc: "Pool kendaraan Cikarang", cust: "EMP-0015", acquired: "2016-05-10", ref: "Faktur PT Suzuki Indomobil Sales No. SIS/16/05/0561", description: "Mobil operasional lama, sering masuk bengkel.", meter: { type: "km", start: 141200, perDay: 30, every: 14 }, retire: { date: "2026-08-28", status: "disposed", reason: "Dijual melalui lelang internal karena biaya perawatan melebihi nilai ekonomis" } },
  { tag: "MTR-01", name: "Honda Vario 125 B 3318 UKA", category: K_VEH, org: "CATERING", loc: "Dapur Pusat Cikarang", cust: "EMP-0016", acquired: "2023-09-11", ref: "Faktur Mitra Motor Honda Cikarang No. MM/23/09/0412", description: "Motor kurir dan QC lapangan.", meter: { type: "km", start: 21300, perDay: 28, every: 30 } },
  { tag: "MTR-02", name: "Honda Beat B 3402 UKB", category: K_VEH, org: "CATERING", loc: "Dapur Pusat Cikarang", cust: "EMP-0006", acquired: "2022-06-20", ref: "Faktur Mitra Motor Honda Cikarang No. MM/22/06/0288", description: "Motor kurir pesanan mendesak.", meter: { type: "km", start: 34800, perDay: 25, every: 30 } },
  { tag: "MTR-03", name: "Yamaha NMAX B 3519 UKC", category: K_VEH, org: "FACILITY", loc: "Kantor Pusat Jakarta", cust: "EMP-0022", acquired: "2024-04-08", ref: "Faktur Yamaha Mataram Sakti Jakarta No. YM/24/04/1019", description: "Motor supervisor cleaning untuk inspeksi site.", meter: { type: "km", start: 12400, perDay: 30, every: 30 } },
  { tag: "MTR-04", name: "Honda Vario 125 B 3604 UKD", category: K_VEH, org: "CATERING", loc: "Dapur Pusat Cikarang", acquired: "2026-06-15", ref: "Faktur Mitra Motor Honda Cikarang No. MM/26/06/0155", description: "Motor kurir tambahan untuk kenaikan volume pesanan.", meter: { type: "km", start: 8, perDay: 22, every: 30 }, stat: [{ date: "2026-10-01", status: "idle", reason: "Menjadi unit cadangan setelah rute kurir digabung" }] },

  // --- Kitchen equipment ------------------------------------------------------------------------
  { tag: "RC-01", name: "Rice Cooker Gas Industri 60 Liter #1", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Nasi`, cust: "EMP-0005", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Rice cooker gas kapasitas 60 liter untuk produksi nasi harian." },
  { tag: "RC-02", name: "Rice Cooker Gas Industri 60 Liter #2", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Nasi`, cust: "EMP-0005", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Rice cooker gas kapasitas 60 liter untuk produksi nasi harian." },
  { tag: "RC-03", name: "Rice Cooker Gas Industri 60 Liter #3", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Nasi`, cust: "EMP-0005", acquired: "2023-05-22", ref: "Invoice CV Karya Dapur Prima No. 0231/2023", description: "Rice cooker gas kapasitas 60 liter untuk produksi nasi harian." },
  { tag: "RC-04", name: "Rice Cooker Gas Industri 60 Liter #4", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Nasi`, cust: "EMP-0005", acquired: "2024-03-04", ref: "Invoice CV Karya Dapur Prima No. 0119/2024", description: "Rice cooker gas kapasitas 60 liter untuk produksi nasi harian." },
  { tag: "RC-05", name: "Rice Cooker Gas Industri 80 Liter #5", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Nasi`, cust: "EMP-0005", acquired: "2026-02-23", ref: "Invoice CV Karya Dapur Prima No. 0044/2026 (penambahan kapasitas Ramadan)", description: "Rice cooker gas kapasitas 80 liter, tambahan kapasitas untuk lonjakan pesanan Ramadan." },
  { tag: "RC-X1", name: "Rice Cooker Gas 40 Liter (lama)", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Gudang alat`, cust: "EMP-0005", acquired: "2019-08-12", ref: "Invoice Toko Sumber Rejeki Dapur No. 5521/2019", description: "Rice cooker lama, dipakai sebagai cadangan.", retire: { date: "2026-02-10", status: "retired", reason: "Tabung dan burner korosi, biaya perbaikan melebihi nilai unit" } },
  { tag: "KMP-01", name: "Kompor Gas 3 Tungku Hock #1", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Masak`, cust: "EMP-0005", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Kompor gas stainless 3 tungku untuk lauk dan sayur." },
  { tag: "KMP-02", name: "Kompor Gas 3 Tungku Hock #2", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Masak`, cust: "EMP-0005", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Kompor gas stainless 3 tungku untuk lauk dan sayur." },
  { tag: "KMP-03", name: "Kompor Gas 3 Tungku Hock #3", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Masak`, cust: "EMP-0007", acquired: "2023-05-22", ref: "Invoice CV Karya Dapur Prima No. 0231/2023", description: "Kompor gas stainless 3 tungku untuk lauk dan sayur." },
  { tag: "KMP-04", name: "Kompor Wok Burner 2 Tungku", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Masak`, cust: "EMP-0007", acquired: "2024-03-04", ref: "Invoice CV Karya Dapur Prima No. 0119/2024", description: "Kompor wok bertekanan tinggi untuk tumisan dan nasi goreng." },
  { tag: "OVN-01", name: "Oven Gas Rak 10 Tray", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Panggang`, cust: "EMP-0008", acquired: "2023-01-16", ref: "Invoice PT Prima Boga Peralatan No. PBP/23/0034", description: "Oven gas 10 tray untuk ayam panggang, snack dan kue." },
  { tag: "MXR-01", name: "Planetary Mixer 40 Liter", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Persiapan`, cust: "EMP-0008", acquired: "2023-01-16", ref: "Invoice PT Prima Boga Peralatan No. PBP/23/0034", description: "Mixer adonan dan perkedel kapasitas 40 liter." },
  { tag: "GRN-01", name: "Meat Grinder Stainless", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Persiapan`, cust: "EMP-0009", acquired: "2022-07-05", ref: "Invoice CV Karya Dapur Prima No. 0302/2022", description: "Penggiling daging stainless untuk produksi bakso dan perkedel." },
  { tag: "SLC-01", name: "Slicer Daging Semi Otomatis", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Persiapan`, cust: "EMP-0009", acquired: "2024-08-12", ref: "Invoice PT Prima Boga Peralatan No. PBP/24/0187", description: "Pengiris daging dan sayuran semi otomatis." },
  { tag: "VCS-01", name: "Vacuum Sealer Chamber", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Packing`, cust: "EMP-0016", acquired: "2024-08-12", ref: "Invoice PT Prima Boga Peralatan No. PBP/24/0187", description: "Vacuum sealer untuk bumbu marinasi dan protein beku." },
  { tag: "PKG-01", name: "Mesin Cup Sealer Otomatis #1", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Packing`, cust: "EMP-0012", acquired: "2023-09-18", ref: "Invoice CV Mitra Kemas Mesin No. MKM/23/0213", description: "Mesin sealer gelas/cup untuk minuman dan puding." },
  { tag: "PKG-02", name: "Mesin Cup Sealer Otomatis #2", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Packing`, cust: "EMP-0013", acquired: "2026-01-19", ref: "Invoice CV Mitra Kemas Mesin No. MKM/26/0012", description: "Mesin sealer cup kedua untuk menambah kapasitas packing." },
  { tag: "DWS-01", name: "Mesin Cuci Piring Conveyor", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Pencucian`, cust: "EMP-0010", acquired: "2022-09-26", ref: "Invoice PT Prima Boga Peralatan No. PBP/22/0291", description: "Mesin cuci tray dan peralatan makan tipe conveyor." },
  { tag: "EXH-01", name: "Exhaust Hood Dapur dan Blower", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Masak`, cust: "EMP-0005", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Hood stainless dan blower pembuangan asap area masak." },
  { tag: "TMB-01", name: "Timbangan Digital 30 kg #1", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Persiapan`, cust: "EMP-0016", acquired: "2023-01-16", ref: "Invoice Toko Timbangan Jaya No. TJ/23/0021", description: "Timbangan porsi dan penerimaan bahan." },
  { tag: "TMB-02", name: "Timbangan Digital 30 kg #2", category: K_KIT, org: "CATERING", loc: `${KITCHEN_LOC} - Area Packing`, cust: "EMP-0012", acquired: "2023-01-16", ref: "Invoice Toko Timbangan Jaya No. TJ/23/0021", description: "Timbangan porsi di lini packing." },
  { tag: "TMB-03", name: "Timbangan Lantai 300 kg", category: K_KIT, org: "WAREHOUSE", loc: "Gudang Pangan - Area Penerimaan", cust: "EMP-0036", acquired: "2022-03-01", ref: "Invoice Toko Timbangan Jaya No. TJ/22/0102", description: "Timbangan penerimaan barang gudang." },

  // --- Cold chain ---------------------------------------------------------------------------------
  { tag: "FRZ-01", name: "Chest Freezer 500 Liter #1", category: K_COLD, org: "CATERING", loc: `${KITCHEN_LOC} - Ruang Beku`, cust: "EMP-0016", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Freezer penyimpanan ayam, daging dan seafood." },
  { tag: "FRZ-02", name: "Chest Freezer 500 Liter #2", category: K_COLD, org: "CATERING", loc: `${KITCHEN_LOC} - Ruang Beku`, cust: "EMP-0016", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Freezer penyimpanan ayam, daging dan seafood." },
  { tag: "FRZ-03", name: "Chest Freezer 500 Liter #3", category: K_COLD, org: "WAREHOUSE", loc: "Gudang Pangan - Ruang Beku", cust: "EMP-0036", acquired: "2023-11-06", ref: "Invoice PT Prima Boga Peralatan No. PBP/23/0301", description: "Freezer gudang untuk stok protein beku." },
  { tag: "CHL-01", name: "Chiller Upright 2 Pintu #1", category: K_COLD, org: "CATERING", loc: `${KITCHEN_LOC} - Ruang Sayur`, cust: "EMP-0016", acquired: "2022-02-14", ref: "Invoice CV Karya Dapur Prima No. 0087/2022", description: "Chiller sayur dan buah." },
  { tag: "CHL-02", name: "Chiller Upright 2 Pintu #2", category: K_COLD, org: "WAREHOUSE", loc: "Gudang Pangan - Ruang Dingin", cust: "EMP-0036", acquired: "2023-11-06", ref: "Invoice PT Prima Boga Peralatan No. PBP/23/0301", description: "Chiller gudang untuk telur, susu dan bahan segar." },
  { tag: "BLC-01", name: "Blast Chiller 5 Tray", category: K_COLD, org: "CATERING", loc: `${KITCHEN_LOC} - Area Packing`, cust: "EMP-0016", acquired: "2026-03-02", ref: "Invoice PT Prima Boga Peralatan No. PBP/26/0057 (standar keamanan pangan kontrak rumah sakit)", description: "Blast chiller untuk mendinginkan makanan matang sebelum dikemas dan dikirim." },

  // --- Cleaning machines (placed at customer sites) -----------------------------------------------
  { tag: "FS-01", name: "Floor Scrubber Nilfisk SC450 #1", category: K_CLN, org: "FACILITY", site: "SITE-101-A", loc: "Pabrik Cikarang - Area produksi", cust: "EMP-0022", acquired: "2023-07-10", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/23/0114", description: "Mesin scrubber lantai baterai untuk area produksi pabrik." },
  { tag: "FS-02", name: "Floor Scrubber Nilfisk SC450 #2", category: K_CLN, org: "FACILITY", site: "SITE-103-A", loc: "Gudang Batuceper", cust: "EMP-0022", acquired: "2023-07-10", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/23/0114", description: "Mesin scrubber lantai baterai untuk area gudang.", moves: [{ date: "2026-06-22", site: "SITE-108-A", loc: "Pabrik Rungkut - Area produksi", reason: "Dipindahkan ke kontrak kebersihan Pabrik Rungkut yang baru dimulai" }] },
  { tag: "FS-03", name: "Floor Scrubber Tennant T300 #3", category: K_CLN, org: "FACILITY", site: "SITE-104-A", loc: "Menara Sudirman - Lobi dan basement", cust: "EMP-0022", acquired: "2024-05-20", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/24/0207", description: "Mesin scrubber untuk lobi dan basement gedung perkantoran." },
  { tag: "FS-04", name: "Floor Scrubber Tennant T300 #4", category: K_CLN, org: "FACILITY", site: "SITE-112-A", loc: "Plant Karawang - Area produksi", cust: "EMP-0022", acquired: "2026-07-06", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/26/0098 (kontrak Plant Karawang)", description: "Mesin scrubber baru untuk kontrak kebersihan Plant Karawang." },
  { tag: "VCI-01", name: "Vacuum Industri Basah-Kering 80 Liter #1", category: K_CLN, org: "FACILITY", site: "SITE-102-A", loc: "Plant MM2100", cust: "EMP-0022", acquired: "2023-07-10", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/23/0114", description: "Penghisap debu dan air untuk area pabrik." },
  { tag: "VCI-02", name: "Vacuum Industri Basah-Kering 80 Liter #2", category: K_CLN, org: "FACILITY", site: "SITE-106-A", loc: "RS Harapan Sehat Dago", cust: "EMP-0022", acquired: "2024-05-20", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/24/0207", description: "Penghisap debu dan air untuk area rumah sakit.", moves: [{ date: "2026-03-12", site: "SITE-105-A", loc: "Camp Proyek Tol Bandung Selatan", reason: "Dipindahkan untuk pembersihan awal camp proyek" }] },
  { tag: "VCI-03", name: "Vacuum Industri Basah-Kering 80 Liter #3", category: K_CLN, org: "FACILITY", site: "SITE-110-A", loc: "Kantor Kuningan", cust: "EMP-0022", acquired: "2025-02-10", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/25/0036", description: "Penghisap debu untuk area perkantoran." },
  { tag: "HPW-01", name: "Mesin Cuci Tekanan Tinggi 150 Bar #1", category: K_CLN, org: "FACILITY", loc: "Kantor Pusat Jakarta - Gudang alat", cust: "EMP-0022", acquired: "2023-07-10", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/23/0114", description: "High pressure washer untuk dek, parkir dan kendaraan." },
  { tag: "HPW-02", name: "Mesin Cuci Tekanan Tinggi 150 Bar #2", category: K_CLN, org: "FACILITY", site: "SITE-111-A", loc: "Terminal Tanjung Priok", cust: "EMP-0022", acquired: "2025-03-18", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/25/0071", description: "High pressure washer untuk area terminal." },
  { tag: "POL-01", name: "Mesin Poles Lantai Single Disc", category: K_CLN, org: "FACILITY", site: "SITE-109-A", loc: "Kampus Dago", cust: "EMP-0022", acquired: "2024-05-20", ref: "Invoice PT Kebersihan Prima Indonesia No. KPI/24/0207", description: "Mesin poles lantai marmer dan granit." },

  // --- AC, genset, warehouse -------------------------------------------------------------------------
  { tag: "AC-HO-01", name: "AC Split 2 PK Daikin - Ruang Direksi", category: K_HVAC, org: "HEAD_OFFICE", loc: `${HO_LOC} - Ruang Direksi`, cust: "EMP-0029", acquired: "2022-01-17", ref: "Invoice PT Dingin Sejuk Teknik No. DST/22/0009", description: "AC split 2 PK ruang direksi." },
  { tag: "AC-HO-02", name: "AC Split 2 PK Daikin - Ruang Rapat", category: K_HVAC, org: "HEAD_OFFICE", loc: `${HO_LOC} - Ruang Rapat`, cust: "EMP-0029", acquired: "2022-01-17", ref: "Invoice PT Dingin Sejuk Teknik No. DST/22/0009", description: "AC split 2 PK ruang rapat." },
  { tag: "AC-HO-03", name: "AC Split 1,5 PK Daikin - Ruang Finance", category: K_HVAC, org: "HEAD_OFFICE", loc: `${HO_LOC} - Ruang Finance`, cust: "EMP-0029", acquired: "2022-01-17", ref: "Invoice PT Dingin Sejuk Teknik No. DST/22/0009", description: "AC split 1,5 PK ruang finance dan akuntansi." },
  { tag: "AC-HO-04", name: "AC Split 1,5 PK Daikin - Ruang Operasional", category: K_HVAC, org: "HEAD_OFFICE", loc: `${HO_LOC} - Ruang Operasional`, cust: "EMP-0029", acquired: "2023-04-10", ref: "Invoice PT Dingin Sejuk Teknik No. DST/23/0041", description: "AC split 1,5 PK ruang operasional dan HR." },
  { tag: "AC-DPR-01", name: "AC Cassette 3 PK - Ruang Packing", category: K_HVAC, org: "CATERING", loc: `${KITCHEN_LOC} - Area Packing`, cust: "EMP-0029", acquired: "2022-03-07", ref: "Invoice PT Dingin Sejuk Teknik No. DST/22/0058", description: "AC cassette ruang packing makanan matang." },
  { tag: "AC-DPR-02", name: "AC Cassette 3 PK - Ruang Persiapan", category: K_HVAC, org: "CATERING", loc: `${KITCHEN_LOC} - Area Persiapan`, cust: "EMP-0029", acquired: "2022-03-07", ref: "Invoice PT Dingin Sejuk Teknik No. DST/22/0058", description: "AC cassette ruang persiapan bahan." },
  { tag: "AC-GDG-01", name: "AC Split 2 PK - Kantor Gudang", category: K_HVAC, org: "WAREHOUSE", loc: "Gudang Pangan - Kantor", cust: "EMP-0029", acquired: "2023-11-20", ref: "Invoice PT Dingin Sejuk Teknik No. DST/23/0129", description: "AC kantor gudang dan ruang administrasi." },
  { tag: "AC-SRV-01", name: "AC Precision Ruang Server 2 PK", category: K_HVAC, org: "HEAD_OFFICE", loc: `${HO_LOC} - Ruang Server`, cust: "EMP-0029", acquired: "2024-02-12", ref: "Invoice PT Dingin Sejuk Teknik No. DST/24/0022", description: "AC ruang server beroperasi 24 jam." },
  { tag: "GEN-01", name: "Genset Perkins 100 kVA Silent + ATS", category: K_GEN, org: "WAREHOUSE", loc: "Dapur Pusat Cikarang - Rumah genset", cust: "EMP-0028", acquired: "2022-02-28", ref: "Invoice PT Daya Mesin Utama No. DMU/22/0033", description: "Genset cadangan dapur pusat dan gudang pangan dengan panel ATS.", meter: { type: "hours", start: 3412, perDay: 1.4, every: 30 } },
  { tag: "GEN-02", name: "Genset Portabel Honda 5 kVA", category: K_GEN, org: "FACILITY", loc: "Kantor Pusat Jakarta - Gudang alat", cust: "EMP-0028", acquired: "2024-09-23", ref: "Invoice PT Daya Mesin Utama No. DMU/24/0121", description: "Genset portabel untuk event dan site tanpa listrik.", status: "idle", moves: [{ date: "2026-09-10", site: "SITE-110-B", loc: "Camp Cilegon", reason: "Dikirim sebagai cadangan listrik camp saat pemeliharaan PLN" }] },
  { tag: "FLT-01", name: "Forklift Elektrik 2,5 Ton", category: K_WH, org: "WAREHOUSE", loc: "Gudang Pangan - Area penerimaan", cust: "EMP-0036", acquired: "2022-03-01", ref: "Invoice PT Alat Berat Sentosa No. ABS/22/0014", description: "Forklift elektrik untuk bongkar muat dan penataan pallet.", meter: { type: "hours", start: 5230, perDay: 5.2, every: 30 } },
  { tag: "PLT-01", name: "Hand Pallet Jack 2,5 Ton #1", category: K_WH, org: "WAREHOUSE", loc: "Gudang Pangan", cust: "EMP-0036", acquired: "2022-03-01", ref: "Invoice PT Alat Berat Sentosa No. ABS/22/0014", description: "Pallet jack manual." },
  { tag: "PLT-02", name: "Hand Pallet Jack 2,5 Ton #2", category: K_WH, org: "WAREHOUSE", loc: "Gudang Umum", cust: "EMP-0045", acquired: "2026-08-10", ref: "Invoice PT Alat Berat Sentosa No. ABS/26/0071", description: "Pallet jack manual gudang umum.", status: "idle" },

  // --- IT --------------------------------------------------------------------------------------------------
  { tag: "LPT-01", name: "Laptop Lenovo ThinkPad E14 - Finance", category: K_IT, org: "FINANCE" as Org, loc: `${HO_LOC} - Ruang Finance`, cust: "EMP-0032", acquired: "2023-03-06", ref: "PO IT-2023-011 / PT Datascrip", description: "Laptop kerja akuntan." },
  { tag: "LPT-02", name: "Laptop Lenovo ThinkPad E14 - Billing", category: K_IT, org: "FINANCE" as Org, loc: `${HO_LOC} - Ruang Finance`, cust: "EMP-0033", acquired: "2023-03-06", ref: "PO IT-2023-011 / PT Datascrip", description: "Laptop kerja penagihan." },
  { tag: "LPT-03", name: "Laptop ASUS Vivobook 14 - Procurement", category: K_IT, org: "PROCUREMENT" as Org, loc: `${HO_LOC} - Ruang Operasional`, cust: "EMP-0027", acquired: "2023-08-14", ref: "PO IT-2023-029 / PT Datascrip", description: "Laptop pengadaan." },
  { tag: "LPT-04", name: "Laptop ASUS Vivobook 14 - HR", category: K_IT, org: "HR" as Org, loc: `${HO_LOC} - Ruang HR`, cust: "EMP-0035", acquired: "2024-01-22", ref: "PO IT-2024-004 / PT Datascrip", description: "Laptop staf HR." },
  { tag: "LPT-05", name: "Laptop Lenovo ThinkPad E14 - Sales", category: K_IT, org: "SALES" as Org, loc: `${HO_LOC} - Ruang Sales`, cust: "EMP-0043", acquired: "2026-06-01", ref: "PO IT-2026-017 / PT Datascrip", description: "Laptop eksekutif penjualan baru." },
  { tag: "LPT-06", name: "Laptop Lenovo ThinkPad E14 - Site Engineer", category: K_IT, org: "PROJECTS" as Org, loc: "Kantor Proyek", cust: "EMP-0041", acquired: "2026-02-02", ref: "PO IT-2026-003 / PT Datascrip", description: "Laptop site engineer proyek." },
  { tag: "LPT-X1", name: "Laptop Acer Aspire 5 (lama)", category: K_IT, org: "HEAD_OFFICE", loc: `${HO_LOC} - Gudang IT`, acquired: "2019-10-08", ref: "PO IT-2019-044 / CV Mega Komputer", description: "Laptop lama, layar rusak.", retire: { date: "2026-07-15", status: "disposed", reason: "Habis masa pakai, dihapus dari register dan didaur ulang vendor e-waste" } },
  { tag: "PRN-01", name: "Printer Multifungsi Epson L6290", category: K_IT, org: "HEAD_OFFICE", loc: `${HO_LOC} - Ruang Operasional`, acquired: "2023-03-06", ref: "PO IT-2023-011 / PT Datascrip", description: "Printer multifungsi kantor pusat." },
  { tag: "NAS-01", name: "NAS Synology DS923+ 16 TB", category: K_IT, org: "HEAD_OFFICE", loc: `${HO_LOC} - Ruang Server`, cust: "EMP-0029", acquired: "2024-02-12", ref: "PO IT-2024-007 / PT Datascrip", description: "Penyimpanan jaringan dan cadangan data perusahaan." },
  { tag: "CCTV-01", name: "Paket CCTV 16 Kanal + DVR", category: K_IT, org: "WAREHOUSE", loc: "Gudang Pangan dan Dapur Pusat", cust: "EMP-0024", acquired: "2026-09-14", ref: "Invoice CV Sentra Keamanan Digital No. SKD/26/0066", description: "CCTV area penerimaan gudang, dapur dan loading dock." },
];

// organisation keys that are not one of the four physical units resolve to their own units
const ORG_NAME_EXTRA: Record<string, string> = {
  FINANCE: "Finance & Accounting",
  PROCUREMENT: "Procurement",
  HR: "Human Capital",
  SALES: "Business Development",
  PROJECTS: "Project Management",
};
const orgNameOf = (o: string) => ORG_NAME[o as Org] ?? ORG_NAME_EXTRA[o];

const createdOn = (a: AssetSpec) => (a.acquired < GO_LIVE ? GO_LIVE : a.acquired);

// ---------------------------------------------------------------------------
// preventive schedules
// ---------------------------------------------------------------------------

interface SchedSpec {
  code: string;
  tag: string;
  title: string;
  description: string;
  freq: { kind: "calendar"; days: number } | { kind: "meter"; type: "km" | "hours"; interval: number };
  costRange: [number, number];
  downH: number;
  assignee: UserKey;
  parts?: { code: string; qty: number; every: number }[]; // every n-th cycle
  notes: string[];
}

const NOTE_OK = [
  "Pekerjaan selesai sesuai checklist PM, kondisi unit baik.",
  "Pemeriksaan dan pembersihan selesai, tidak ada temuan berarti.",
  "PM selesai, unit diuji coba dan berfungsi normal.",
  "Servis selesai, ditemukan keausan ringan, dicatat untuk pemantauan siklus berikutnya.",
];

function buildSchedules(): SchedSpec[] {
  const out: SchedSpec[] = [];
  const add = (s: SchedSpec) => out.push(s);
  for (const t of ["VAN-01", "VAN-02", "VAN-03", "VAN-04", "VAN-05", "VAN-X1"]) {
    add({ code: `PM-${t}-KM`, tag: t, title: "Servis berkala 5.000 km", description: "Ganti oli mesin dan filter, cek rem, kopling, aki, ban dan sistem pendingin.", freq: { kind: "meter", type: "km", interval: 5000 }, costRange: [t === "VAN-X1" ? 1400000 : 900000, t === "VAN-X1" ? 2400000 : 1450000], downH: 5, assignee: "warehouse", notes: [...NOTE_OK, "Servis di bengkel resmi selesai, kendaraan sudah diambil."] });
    add({ code: `PM-${t}-KIR`, tag: t, title: "Uji KIR dan cek kelaikan kendaraan", description: "Persiapan uji berkala KIR, cek lampu, klakson, rem dan emisi.", freq: { kind: "calendar", days: 180 }, costRange: [350000, 650000], downH: 6, assignee: "warehouse", notes: ["Uji KIR lulus, buku uji diperbarui.", "Uji KIR lulus setelah perbaikan lampu rem."] });
  }
  for (const t of ["MTR-01", "MTR-02", "MTR-03", "MTR-04"]) {
    add({ code: `PM-${t}-KM`, tag: t, title: "Servis berkala 3.000 km", description: "Ganti oli, cek busi, rantai, kampas rem dan filter udara.", freq: { kind: "meter", type: "km", interval: 3000 }, costRange: [180000, 260000], downH: 3, assignee: "warehouse", notes: NOTE_OK });
  }
  for (const t of ["RC-01", "RC-02", "RC-03", "RC-04", "RC-05"]) {
    add({ code: `PM-${t}`, tag: t, title: "Servis rice cooker: burner, thermostat, packing", description: "Bersihkan burner, cek thermostat, katup gas dan packing tutup.", freq: { kind: "calendar", days: 90 }, costRange: [120000, 220000], downH: 3, assignee: "coordinator", notes: NOTE_OK });
  }
  for (const t of ["KMP-01", "KMP-02", "KMP-03", "KMP-04"]) {
    add({ code: `PM-${t}`, tag: t, title: "Pembersihan burner dan cek selang regulator", description: "Bersihkan burner, cek selang gas, regulator dan kebocoran.", freq: { kind: "calendar", days: 45 }, costRange: [80000, 150000], downH: 2, assignee: "coordinator", notes: NOTE_OK });
  }
  add({ code: "PM-OVN-01", tag: "OVN-01", title: "Servis oven gas: thermostat dan ignitor", description: "Kalibrasi thermostat, cek ignitor, pintu dan packing.", freq: { kind: "calendar", days: 120 }, costRange: [250000, 450000], downH: 4, assignee: "coordinator", notes: NOTE_OK });
  add({ code: "PM-MXR-01", tag: "MXR-01", title: "Servis mixer: gearbox dan grease", description: "Cek gearbox, tambah grease food-grade, cek pengunci bowl.", freq: { kind: "calendar", days: 120 }, costRange: [200000, 350000], downH: 3, assignee: "coordinator", notes: NOTE_OK });
  add({ code: "PM-DWS-01", tag: "DWS-01", title: "Servis mesin cuci piring: pompa dan nozzle", description: "Descaling, bersihkan nozzle, cek pompa dan pemanas.", freq: { kind: "calendar", days: 60 }, costRange: [300000, 500000], downH: 4, assignee: "coordinator", notes: NOTE_OK });
  add({ code: "PM-EXH-01", tag: "EXH-01", title: "Servis exhaust: belt, bearing, filter grease", description: "Cuci filter grease, cek belt dan bearing blower.", freq: { kind: "calendar", days: 60 }, costRange: [200000, 380000], downH: 3, assignee: "coordinator", parts: [{ code: "SPR-VBELT", qty: 1, every: 3 }], notes: NOTE_OK });
  for (const t of ["PKG-01", "PKG-02", "GRN-01", "SLC-01", "VCS-01"]) {
    add({ code: `PM-${t}`, tag: t, title: "Servis berkala mesin produksi", description: "Pelumasan, pengecekan heater/pisau dan pengaman mesin.", freq: { kind: "calendar", days: 120 }, costRange: [120000, 240000], downH: 2, assignee: "coordinator", notes: NOTE_OK });
  }
  for (const t of ["FRZ-01", "FRZ-02", "FRZ-03", "CHL-01", "CHL-02"]) {
    add({ code: `PM-${t}`, tag: t, title: "Servis pendingin: kondensor, pintu, suhu", description: "Bersihkan kondensor, cek packing pintu, defrost dan verifikasi suhu.", freq: { kind: "calendar", days: 90 }, costRange: [200000, 340000], downH: 2, assignee: "assetOfficer", notes: [...NOTE_OK, "Suhu ruang pendingin terverifikasi sesuai standar (<= -18 C / 0-5 C)."] });
  }
  add({ code: "PM-BLC-01", tag: "BLC-01", title: "Servis blast chiller dan kalibrasi sensor suhu", description: "Kalibrasi sensor, bersihkan evaporator dan cek siklus pendinginan.", freq: { kind: "calendar", days: 90 }, costRange: [350000, 600000], downH: 3, assignee: "assetOfficer", notes: NOTE_OK });
  for (const t of ["FS-01", "FS-02", "FS-03", "FS-04"]) {
    add({ code: `PM-${t}`, tag: t, title: "Servis scrubber: sikat, squeegee, baterai", description: "Ganti sikat bila aus, cek squeegee, air baterai dan charger.", freq: { kind: "calendar", days: 90 }, costRange: [250000, 450000], downH: 3, assignee: "assetOfficer", notes: NOTE_OK });
  }
  for (const t of ["VCI-01", "VCI-02", "VCI-03", "HPW-01", "HPW-02", "POL-01"]) {
    add({ code: `PM-${t}`, tag: t, title: "Servis mesin kebersihan semester", description: "Cek motor, kabel, filter, selang dan seal pompa.", freq: { kind: "calendar", days: 180 }, costRange: [150000, 300000], downH: 2, assignee: "assetOfficer", notes: NOTE_OK });
  }
  for (const t of ["AC-HO-01", "AC-HO-02", "AC-HO-03", "AC-HO-04", "AC-DPR-01", "AC-DPR-02", "AC-GDG-01", "AC-SRV-01"]) {
    add({ code: `PM-${t}`, tag: t, title: "Cuci AC dan cek freon", description: "Cuci indoor/outdoor, cek tekanan freon, drain dan kapasitor.", freq: { kind: "calendar", days: t === "AC-SRV-01" ? 60 : 90 }, costRange: [150000, 250000], downH: 1.5, assignee: "assetOfficer", parts: [{ code: "SPR-FILTER-AC", qty: 1, every: 2 }], notes: NOTE_OK });
  }
  add({ code: "PM-GEN-01-HR", tag: "GEN-01", title: "Servis genset 250 jam (oli, filter, coolant)", description: "Ganti oli dan filter oli/solar/udara, cek coolant, aki dan ATS.", freq: { kind: "meter", type: "hours", interval: 250 }, costRange: [1500000, 2400000], downH: 4, assignee: "assetOfficer", parts: [{ code: "SPR-OLI-GENSET", qty: 1, every: 1 }], notes: NOTE_OK });
  add({ code: "PM-GEN-01-TEST", tag: "GEN-01", title: "Tes pemanasan genset dan uji beban bulanan", description: "Pemanasan 30 menit dengan beban 50 persen dan uji perpindahan ATS.", freq: { kind: "calendar", days: 30 }, costRange: [0, 120000], downH: 1, assignee: "assetOfficer", notes: ["Tes beban normal, ATS berpindah dalam 10 detik.", "Tes selesai, tegangan dan frekuensi stabil.", "Tes pemanasan selesai, bahan bakar solar diisi ulang."] });
  add({ code: "PM-GEN-02", tag: "GEN-02", title: "Servis genset portabel dan tes start", description: "Cek busi, filter udara, karburator dan tes start.", freq: { kind: "calendar", days: 120 }, costRange: [120000, 250000], downH: 2, assignee: "assetOfficer", notes: NOTE_OK });
  add({ code: "PM-FLT-01-HR", tag: "FLT-01", title: "Servis forklift 500 jam", description: "Cek baterai, hidrolik, rantai mast, garpu dan rem.", freq: { kind: "meter", type: "hours", interval: 500 }, costRange: [900000, 1600000], downH: 6, assignee: "warehouse", notes: NOTE_OK });
  return out;
}

// ---------------------------------------------------------------------------
// breakdowns / corrective work
// ---------------------------------------------------------------------------

type Stage = "open" | "assigned" | "started" | "completed" | "verified" | "cancelled";
interface Incident {
  id: string;
  tag: string;
  date: string;
  hour: number;
  type: "corrective" | "emergency";
  prio: "low" | "medium" | "high" | "critical";
  title: string;
  desc: string;
  downH: number;
  cost: number;
  parts?: { code: string; qty: number }[];
  stage?: Stage;
  assignee: UserKey;
  reason?: "breakdown" | "power_failure" | "operator_error" | "other";
  notes: string;
  cancel?: string;
}

const INCIDENTS: Incident[] = [
  { id: "INC-001", tag: "VAN-04", date: "2025-11-19", hour: 8, type: "corrective", prio: "high", title: "Kampas rem depan aus, rem berdecit", desc: "Pengemudi melaporkan rem depan berdecit dan jarak pengereman bertambah.", downH: 6, cost: 1450000, assignee: "warehouse", notes: "Kampas rem depan dan piringan dibubut, rem diuji di jalan." },
  { id: "INC-002", tag: "FRZ-02", date: "2025-11-27", hour: 6, type: "emergency", prio: "critical", title: "Freezer tidak dingin, kompresor trip", desc: "Suhu freezer naik ke -4 C saat pagi. Stok ayam dipindahkan ke FRZ-01 dan FRZ-03.", downH: 20, cost: 3850000, parts: [{ code: "SPR-MCB", qty: 1 }], assignee: "assetOfficer", notes: "MCB kompresor diganti dan relay start diperbaiki, suhu kembali -18 C setelah 6 jam." },
  { id: "INC-003", tag: "RC-02", date: "2025-12-09", hour: 5, type: "corrective", prio: "medium", title: "Api burner rice cooker kecil, pilot padam", desc: "Pilot burner sering padam saat produksi nasi pagi.", downH: 3, cost: 380000, assignee: "coordinator", notes: "Termokopel diganti dan nozzle burner dibersihkan." },
  { id: "INC-004", tag: "AC-DPR-01", date: "2025-12-16", hour: 9, type: "corrective", prio: "medium", title: "AC ruang packing menetes, drain tersumbat", desc: "Air menetes ke meja packing dari unit cassette.", downH: 4, cost: 275000, parts: [{ code: "SPR-FILTER-AC", qty: 1 }], assignee: "assetOfficer", notes: "Drain dibersihkan, filter diganti, unit diuji 1 jam tanpa tetesan." },
  { id: "INC-005", tag: "VAN-X1", date: "2026-01-08", hour: 10, type: "emergency", prio: "high", title: "Mesin overheat di tol, radiator bocor", desc: "Kendaraan berhenti di KM 28 tol Jakarta-Cikampek, derek ke bengkel.", downH: 52, cost: 4200000, assignee: "warehouse", notes: "Radiator dan selang diganti, head gasket dicek. Biaya derek ditanggung perusahaan." },
  { id: "INC-006", tag: "DWS-01", date: "2026-01-21", hour: 7, type: "corrective", prio: "high", title: "Pompa wash mesin cuci piring tidak menyala", desc: "Motor pompa wash berbunyi dengkur lalu mati. Pencucian dilakukan manual.", downH: 30, cost: 5600000, assignee: "coordinator", notes: "Motor pompa digulung ulang, seal dan bearing diganti oleh teknisi rekanan." },
  { id: "INC-007", tag: "GEN-01", date: "2026-02-04", hour: 18, type: "emergency", prio: "critical", title: "Genset gagal start saat listrik PLN padam", desc: "ATS tidak memindahkan beban saat PLN padam, freezer dapur mati selama 40 menit sampai genset dinyalakan manual.", downH: 9, cost: 2750000, parts: [{ code: "SPR-MCB", qty: 2 }, { code: "SPR-OLI-GENSET", qty: 1 }], reason: "power_failure", assignee: "assetOfficer", notes: "Kontaktor ATS dan MCB diganti, aki dan oli diperbarui, tes start 5 kali berhasil." },
  { id: "INC-008", tag: "KMP-03", date: "2026-02-12", hour: 6, type: "corrective", prio: "medium", title: "Regulator gas bocor ringan", desc: "Tercium bau gas di dekat kompor 3, produksi dihentikan sementara oleh chef.", downH: 2, cost: 450000, assignee: "coordinator", notes: "Regulator dan selang diganti, sambungan diuji sabun, tidak ada kebocoran." },
  { id: "INC-009", tag: "EXH-01", date: "2026-02-26", hour: 8, type: "corrective", prio: "medium", title: "Kipas exhaust berisik, belt putus", desc: "Belt blower exhaust putus, asap tidak tersedot optimal.", downH: 5, cost: 320000, parts: [{ code: "SPR-VBELT", qty: 2 }], assignee: "coordinator", notes: "Dua belt dan bearing diganti, aliran udara normal." },
  { id: "INC-010", tag: "FRZ-03", date: "2026-03-10", hour: 7, type: "corrective", prio: "high", title: "Pintu freezer tidak rapat, packing karet robek", desc: "Es menumpuk di pinggir pintu saat puncak pesanan Ramadan.", downH: 6, cost: 650000, assignee: "assetOfficer", notes: "Packing karet pintu diganti dan engsel disetel, defrost dilakukan." },
  { id: "INC-011", tag: "RC-05", date: "2026-03-17", hour: 5, type: "emergency", prio: "high", title: "Kebocoran gas di sambungan rice cooker", desc: "Kebocoran terdeteksi saat persiapan sahur, unit dimatikan dan area diamankan.", downH: 4, cost: 900000, assignee: "coordinator", notes: "Sambungan diganti dan diuji tekanan, HSE melakukan inspeksi sebelum dipakai kembali." },
  { id: "INC-012", tag: "VAN-02", date: "2026-03-24", hour: 6, type: "corrective", prio: "high", title: "Aki soak, mobil sulit start", desc: "Mobil gagal start saat akan memuat pesanan sahur.", downH: 3, cost: 1250000, assignee: "warehouse", notes: "Aki dan terminal diganti, alternator dicek normal." },
  { id: "INC-013", tag: "FS-01", date: "2026-04-14", hour: 10, type: "corrective", prio: "medium", title: "Sikat scrubber tidak berputar", desc: "Motor sikat berhenti saat dipakai di area produksi.", downH: 24, cost: 1850000, assignee: "assetOfficer", notes: "Motor sikat diganti dan kabel yang terkelupas diperbaiki." },
  { id: "INC-014", tag: "AC-HO-02", date: "2026-04-28", hour: 11, type: "corrective", prio: "low", title: "AC ruang rapat kurang dingin", desc: "Ruangan tidak mencapai 24 C pada jam rapat.", downH: 3, cost: 560000, parts: [{ code: "SPR-FILTER-AC", qty: 1 }], assignee: "assetOfficer", notes: "Freon ditambah dan kebocoran sambungan flare diperbaiki." },
  { id: "INC-015", tag: "CHL-01", date: "2026-05-06", hour: 6, type: "corrective", prio: "high", title: "Chiller sayur suhu naik di atas 8 C", desc: "Pengecekan suhu pagi menunjukkan 11 C. Sayur dipindah ke chiller gudang.", downH: 10, cost: 1150000, assignee: "assetOfficer", notes: "Thermostat digital diganti dan kalibrasi suhu dilakukan." },
  { id: "INC-016", tag: "MTR-02", date: "2026-05-27", hour: 14, type: "corrective", prio: "low", title: "Ban belakang bocor halus, rantai kendur", desc: "Kurir melaporkan ban kempis di tengah pengantaran.", downH: 2, cost: 220000, assignee: "warehouse", notes: "Ban dalam ditambal dan rantai disetel." },
  { id: "INC-017", tag: "FLT-01", date: "2026-06-03", hour: 9, type: "corrective", prio: "high", title: "Forklift tidak mampu angkat penuh, selang hidrolik bocor", desc: "Garpu turun perlahan saat membawa pallet beras.", downH: 16, cost: 2300000, assignee: "warehouse", notes: "Selang hidrolik dan seal silinder diganti, oli hidrolik diisi ulang." },
  { id: "INC-018", tag: "VAN-03", date: "2026-06-18", hour: 5, type: "emergency", prio: "high", title: "Unit pendingin boks tidak dingin", desc: "Suhu boks 14 C pada pengiriman protein ke Bandung, pengiriman terlambat 3 jam karena unit diganti ke VAN-04.", downH: 40, cost: 6500000, assignee: "warehouse", notes: "Kompresor unit pendingin diganti dan freon diisi ulang. Pelanggan diinformasikan." },
  { id: "INC-019", tag: "AC-SRV-01", date: "2026-07-02", hour: 13, type: "emergency", prio: "critical", title: "AC ruang server mati, suhu ruangan naik", desc: "Suhu ruang server mencapai 33 C. Server non-kritis dimatikan sementara.", downH: 7, cost: 1980000, parts: [{ code: "SPR-FILTER-AC", qty: 1 }], assignee: "assetOfficer", notes: "Kapasitor dan kontaktor diganti, unit kembali normal dengan suhu 22 C." },
  { id: "INC-020", tag: "KMP-01", date: "2026-07-14", hour: 6, type: "corrective", prio: "medium", title: "Nyala api kompor tidak merata", desc: "Dua tungku menyala kuning dan lemah.", downH: 2, cost: 300000, assignee: "coordinator", notes: "Burner dibongkar dan dibersihkan dari sisa minyak." },
  { id: "INC-021", tag: "HPW-01", date: "2026-07-29", hour: 10, type: "corrective", prio: "medium", title: "Mesin cuci tekanan bocor di seal pompa", desc: "Tekanan turun dan air merembes dari rumah pompa.", downH: 18, cost: 1100000, assignee: "assetOfficer", notes: "Seal dan piston pompa diganti." },
  { id: "INC-022", tag: "OVN-01", date: "2026-08-11", hour: 7, type: "corrective", prio: "high", title: "Oven gas suhu tidak stabil", desc: "Suhu bergerak 40 C dari setpoint, hasil panggang tidak seragam.", downH: 14, cost: 2450000, assignee: "coordinator", notes: "Thermostat dan sensor suhu diganti, kalibrasi dilakukan." },
  { id: "INC-023", tag: "RC-04", date: "2026-08-19", hour: 5, type: "corrective", prio: "medium", title: "Katup gas rice cooker macet", desc: "Pengaturan api tidak responsif.", downH: 3, cost: 520000, assignee: "coordinator", notes: "Katup gas diganti." },
  { id: "INC-024", tag: "GEN-01", date: "2026-09-03", hour: 9, type: "corrective", prio: "high", title: "Selang radiator genset bocor", desc: "Ditemukan rembesan coolant saat tes bulanan.", downH: 6, cost: 1350000, parts: [{ code: "SPR-OLI-GENSET", qty: 1 }], assignee: "assetOfficer", notes: "Selang radiator diganti, coolant dan oli diperbarui." },
  { id: "INC-025", tag: "MXR-01", date: "2026-09-15", hour: 8, type: "corrective", prio: "medium", title: "Gearbox mixer berisik", desc: "Suara kasar saat adonan berat.", downH: 8, cost: 1700000, assignee: "coordinator", notes: "Gearbox dibongkar, grease baru dan bearing diganti." },
  { id: "INC-026", tag: "AC-GDG-01", date: "2026-09-24", hour: 10, type: "corrective", prio: "medium", title: "AC kantor gudang tidak dingin, kapasitor rusak", desc: "Kompresor tidak jalan, kipas outdoor berputar lemah.", downH: 4, cost: 640000, parts: [{ code: "SPR-MCB", qty: 1 }], assignee: "assetOfficer", notes: "Kapasitor kompresor dan MCB diganti." },
  { id: "INC-027", tag: "VAN-01", date: "2026-10-08", hour: 7, type: "corrective", prio: "medium", title: "Kopling terasa berat", desc: "Pengemudi melaporkan kopling keras dan selip di tanjakan.", downH: 5, cost: 1950000, assignee: "warehouse", notes: "Plat kopling dan bearing release diganti." },
  { id: "INC-028", tag: "LPT-03", date: "2026-10-13", hour: 11, type: "corrective", prio: "low", title: "Keyboard laptop rusak", desc: "Beberapa tombol tidak berfungsi.", downH: 24, cost: 450000, assignee: "assetOfficer", notes: "Keyboard diganti oleh vendor, data tidak terpengaruh." },
  { id: "INC-029", tag: "FS-03", date: "2026-10-22", hour: 9, type: "corrective", prio: "medium", title: "Baterai scrubber tidak menahan daya", desc: "Mesin hanya bekerja 40 menit per pengisian.", downH: 20, cost: 3200000, assignee: "assetOfficer", notes: "Satu set baterai deep-cycle diganti, charger dicek." },
  { id: "INC-030", tag: "MTR-03", date: "2026-10-30", hour: 15, type: "corrective", prio: "low", title: "Lampu depan mati dan aki lemah", desc: "Lampu utama padam saat inspeksi sore.", downH: 2, cost: 180000, assignee: "warehouse", notes: "Bohlam dan aki diganti." },
  { id: "INC-031", tag: "KMP-02", date: "2026-03-30", hour: 9, type: "corrective", prio: "low", title: "Laporan penggantian kompor (duplikat)", desc: "Permintaan penggantian kompor 2 yang ternyata sudah tercakup pada PM burner.", downH: 0, cost: 0, stage: "cancelled", assignee: "coordinator", notes: "", cancel: "Duplikat laporan, sudah ditangani pada PM burner" },
  { id: "INC-032", tag: "AC-DPR-02", date: "2026-11-02", hour: 9, type: "corrective", prio: "medium", title: "AC ruang persiapan menetes", desc: "Tetesan air dari panel indoor di atas meja persiapan.", downH: 3, cost: 290000, assignee: "assetOfficer", notes: "Pipa drain dibersihkan dan kemiringan dikoreksi." },
  { id: "INC-033", tag: "FRZ-01", date: "2026-11-04", hour: 6, type: "emergency", prio: "critical", title: "Compressor freezer berisik dan suhu naik", desc: "Suhu freezer -9 C dan kompresor bergetar. Stok ayam dipindah sebagian ke FRZ-03.", downH: 0, cost: 4200000, parts: [{ code: "SPR-MCB", qty: 1 }], stage: "started", assignee: "assetOfficer", notes: "" },
  { id: "INC-034", tag: "VAN-02", date: "2026-11-06", hour: 8, type: "corrective", prio: "medium", title: "AC kabin mobil tidak dingin", desc: "Pengemudi melaporkan AC kabin hanya menghembus udara biasa.", downH: 0, cost: 850000, stage: "assigned", assignee: "warehouse", notes: "" },
  { id: "INC-035", tag: "RC-03", date: "2026-11-07", hour: 5, type: "corrective", prio: "medium", title: "Timer dan thermostat rice cooker error", desc: "Nasi kadang terlalu lembek karena suhu tidak terbaca.", downH: 3, cost: 480000, stage: "completed", assignee: "coordinator", notes: "Sensor suhu dan kabel diganti, uji masak 3 kali berhasil." },
  { id: "INC-036", tag: "FS-02", date: "2026-11-08", hour: 10, type: "corrective", prio: "low", title: "Squeegee scrubber sobek", desc: "Sisa air di lantai setelah scrubbing di Pabrik Rungkut.", downH: 0, cost: 350000, stage: "open", assignee: "assetOfficer", notes: "" },
  { id: "INC-037", tag: "AC-SRV-01", date: "2026-11-09", hour: 8, type: "corrective", prio: "high", title: "Alarm suhu ruang server berbunyi sporadis", desc: "Alarm suhu tinggi berbunyi tiga kali dalam semalam, suhu sempat 29 C.", downH: 0, cost: 750000, stage: "open", assignee: "assetOfficer", notes: "" },
  { id: "INC-038", tag: "GEN-01", date: "2026-11-05", hour: 10, type: "corrective", prio: "medium", title: "Aki starter genset lemah", desc: "Pada tes bulanan genset butuh dua kali percobaan start.", downH: 0, cost: 1150000, stage: "assigned", assignee: "assetOfficer", notes: "" },
  { id: "INC-039", tag: "HPW-02", date: "2026-11-03", hour: 13, type: "corrective", prio: "medium", title: "Selang tekanan tinggi bocor di sambungan", desc: "Rembesan air di sambungan selang saat dipakai di Terminal Tanjung Priok.", downH: 0, cost: 420000, stage: "started", assignee: "assetOfficer", notes: "" },
  { id: "INC-040", tag: "PKG-01", date: "2026-11-05", hour: 7, type: "corrective", prio: "low", title: "Heater sealer cup tidak panas merata", desc: "Segel cup beberapa kali bocor pada sisi kiri.", downH: 2, cost: 380000, stage: "completed", assignee: "coordinator", notes: "Elemen heater dan thermocouple diganti, uji segel 200 cup tanpa kebocoran." },
];

// standalone downtime (no work order)
const EXTRA_DOWNTIME: { key: string; tag: string; date: string; hour: number; hours: number; reason: "power_failure" | "operator_error" | "other"; notes: string }[] = [
  { key: "DT-X01", tag: "FRZ-01", date: "2025-12-23", hour: 14, hours: 3, reason: "power_failure", notes: "Listrik PLN padam di kawasan industri Cikarang, genset menyala setelah 25 menit." },
  { key: "DT-X02", tag: "AC-DPR-01", date: "2026-02-04", hour: 18, hours: 2.5, reason: "power_failure", notes: "Pemadaman PLN bersamaan dengan gangguan ATS genset." },
  { key: "DT-X03", tag: "FRZ-03", date: "2026-04-09", hour: 16, hours: 4, reason: "operator_error", notes: "Pintu freezer tidak tertutup rapat setelah bongkar muat sore, suhu naik ke -6 C." },
  { key: "DT-X04", tag: "CHL-02", date: "2026-06-30", hour: 12, hours: 1.5, reason: "power_failure", notes: "Pemadaman PLN terjadwal di area gudang." },
  { key: "DT-X05", tag: "DWS-01", date: "2026-08-04", hour: 9, hours: 2, reason: "operator_error", notes: "Filter tray tersumbat sisa nasi karena prosedur pra-bilas dilewati." },
  { key: "DT-X06", tag: "FLT-01", date: "2026-09-29", hour: 8, hours: 5, reason: "other", notes: "Forklift tidak dapat dipakai karena baterai habis dan charger gudang sedang dipindahkan." },
];

// ---------------------------------------------------------------------------
// derived plan
// ---------------------------------------------------------------------------

interface WoSpec {
  key: string; // "Ref:" key
  tag: string;
  scheduleCode?: string;
  type: "preventive" | "corrective" | "emergency";
  prio: "low" | "medium" | "high" | "critical";
  title: string;
  desc: string;
  est: number;
  actual: number;
  downH: number;
  downReason: "breakdown" | "scheduled_maintenance" | "power_failure" | "operator_error" | "other";
  meterAtComplete?: number;
  parts: { code: string; qty: number }[];
  assignee: UserKey;
  stage: Stage;
  date: string; // creation day
  createdAt: string;
  assignedAt: string;
  startedAt: string;
  completedAt: string;
  verifiedAt: string;
  completionNotes: string;
  verifyNotes: string;
  cancel?: string;
  breakdownStart?: string;
}

const VERIFY_NOTES = [
  "Hasil pekerjaan diperiksa dan diterima, unit berfungsi normal.",
  "Verifikasi di lapangan selesai, laporan servis dilampirkan.",
  "Diterima. Unit kembali beroperasi.",
  "Pekerjaan sesuai, tidak ada keluhan lanjutan dari pengguna.",
];

function stageAt(today: string, due: string, exec: string, rng: ReturnType<typeof makeRand>, verifyDate: string): Stage {
  void due;
  if (exec > today) return rng.chance(0.5) ? "open" : "assigned";
  const age = diffDays(exec, today);
  let st: Stage = "verified";
  if (age === 0) st = rng.chance(0.5) ? "started" : "completed";
  else if (age === 1) st = rng.chance(0.5) ? "completed" : "verified";
  else if (age === 2) st = rng.chance(0.25) ? "completed" : "verified";
  if (st === "verified" && verifyDate > today) st = "completed";
  return st;
}

interface Plan {
  assets: AssetSpec[];
  scheds: SchedSpec[];
  schedFirstDue: Map<string, string>;
  schedNextMeter: Map<string, number>;
  wos: WoSpec[];
  readings: { tag: string; type: "km" | "hours"; date: string; value: number }[];
  kmAt: Map<string, Map<string, number>>;
}

function buildPlan(today: string): Plan {
  const assets = [...ASSETS];
  const byTag = new Map(assets.map((a) => [a.tag, a]));
  const scheds = buildSchedules().filter((s) => byTag.has(s.tag));
  const kmAt = new Map<string, Map<string, number>>();
  const readings: Plan["readings"] = [];

  // meter series
  for (const a of assets) {
    if (!a.meter) continue;
    const r = rngFor("meter:" + a.tag);
    const m = new Map<string, number>();
    let v = a.meter.start;
    let d = createdOn(a);
    const end = a.retire ? a.retire.date : today;
    while (d <= end) {
      m.set(d, Math.round(v));
      const f = activityFactor(d.slice(0, 7));
      const df = dow(d) === 0 ? 0.08 : dow(d) === 6 ? 0.7 : 1.05;
      v += a.meter.perDay * f * df * (0.75 + r.next() * 0.5);
      d = addDays(d, 1);
    }
    kmAt.set(a.tag, m);
    // regular readings
    let rd = nextWorkday(addDays(createdOn(a), 3 + (hash(a.tag) % a.meter.every)));
    while (rd <= end) {
      readings.push({ tag: a.tag, type: a.meter.type, date: rd, value: m.get(rd) ?? Math.round(v) });
      rd = nextWorkday(addDays(rd, a.meter.every));
    }
  }

  const schedFirstDue = new Map<string, string>();
  const schedNextMeter = new Map<string, number>();
  const wos: WoSpec[] = [];
  const assigneeFor = (k: UserKey) => k;

  const mkTimeline = (rng: ReturnType<typeof makeRand>, due: string, exec: string, stage: Stage, durH: number, immediate = false) => {
    const createdAt = iso(due, 7, rng.int(0, 40));
    const assignedAt = new Date(new Date(createdAt).getTime() + rng.int(20, 90) * 60000).toISOString();
    const startedAt = iso(exec, 8, rng.int(10, 59));
    const completedAt = isoPlusHours(exec, 8, 30, Math.max(0.75, durH + 0.5));
    let vd = exec;
    if (!immediate || rng.chance(0.4)) vd = nextWorkday(addDays(exec, 1));
    const verifiedAt = iso(vd, vd === exec ? 17 : 9, rng.int(5, 55));
    void stage;
    return { createdAt, assignedAt, startedAt, completedAt, verifiedAt, verifyDate: vd };
  };

  for (const s of scheds) {
    const a = byTag.get(s.tag)!;
    const r = rngFor("sched:" + s.code);
    const end = a.retire ? addDays(a.retire.date, -2) : today;
    let cycle = 0;
    const partsCounter = new Map<string, number>();
    const emit = (due: string, exec: string, meter?: number) => {
      cycle++;
      const key = `${s.code}/${String(cycle).padStart(2, "0")}`;
      const durH = s.downH;
      const preTl = mkTimeline(r, due, exec, "verified", durH, durH <= 2);
      const stage = stageAt(today, due, exec, r, preTl.verifyDate);
      const cost = rp(r.int(s.costRange[0], s.costRange[1]), s.costRange[1] > 600000 ? 25000 : 5000);
      const parts: { code: string; qty: number }[] = [];
      for (const p of s.parts ?? []) {
        const n = (partsCounter.get(p.code) ?? 0) + 1;
        partsCounter.set(p.code, n);
        if (n % p.every === 0 || p.every === 1) parts.push({ code: p.code, qty: p.qty });
      }
      const noteCompleted = r.pick(s.notes);
      wos.push({
        key, tag: s.tag, scheduleCode: s.code, type: "preventive", prio: "low",
        title: `${s.title} - ${a.tag}`,
        desc: `${s.description} Aset: ${a.name}. Ref: ${key}`,
        est: cost > 0 ? rp(cost * (0.92 + r.next() * 0.2), 5000) : 0,
        actual: cost, downH: durH, downReason: "scheduled_maintenance", meterAtComplete: meter, parts,
        assignee: assigneeFor(s.assignee), stage, date: due,
        createdAt: preTl.createdAt, assignedAt: preTl.assignedAt, startedAt: preTl.startedAt, completedAt: preTl.completedAt, verifiedAt: preTl.verifiedAt,
        completionNotes: noteCompleted, verifyNotes: r.pick(VERIFY_NOTES),
      });
      return stage;
    };

    if (s.freq.kind === "calendar") {
      const interval = s.freq.days;
      let due = nextWorkday(addDays(createdOn(a), 4 + (hash(s.code) % Math.max(5, interval - 10))));
      schedFirstDue.set(s.code, due);
      while (due <= end) {
        const lag = r.pick([0, 0, 0, 1, 1, 2, 3, 5]);
        const exec = nextWorkday(addDays(due, lag));
        emit(due, exec);
        due = nextWorkday(addDays(exec, interval + r.int(-2, 2)));
      }
    } else {
      const series = kmAt.get(s.tag)!;
      const startV = series.get(createdOn(a)) ?? 0;
      // a recent service happened before the first day of history
      let lastService = Math.max(0, startV - r.int(Math.round(s.freq.interval * 0.3), Math.round(s.freq.interval * 0.8)));
      if (startV < s.freq.interval) lastService = 0;
      schedNextMeter.set(s.code, lastService + s.freq.interval);
      let day = createdOn(a);
      let firstDue = true;
      while (day <= end) {
        const v = series.get(day) ?? 0;
        if (v >= lastService + s.freq.interval) {
          if (firstDue) { schedFirstDue.set(s.code, day); firstDue = false; }
          const lag = r.pick([0, 1, 1, 2, 3, 4]);
          const exec = nextWorkday(addDays(day, lag));
          const vExec = series.get(exec > end ? end : exec) ?? v;
          const stage = emit(day, exec, vExec);
          lastService = vExec;
          void stage;
          day = addDays(exec, 1);
          continue;
        }
        day = addDays(day, 1);
      }
      if (!schedFirstDue.has(s.code)) schedFirstDue.set(s.code, addDays(today, 20));
    }
  }

  // breakdowns
  for (const inc of INCIDENTS) {
    const a = byTag.get(inc.tag);
    if (!a) continue;
    if (inc.date < createdOn(a)) continue;
    if (a.retire && inc.date > a.retire.date) continue;
    const r = rngFor("inc:" + inc.id);
    const stage: Stage = inc.stage ?? "verified";
    const created = iso(inc.date, inc.hour, r.int(0, 30));
    const assignedAt = new Date(new Date(created).getTime() + r.int(10, 45) * 60000).toISOString();
    const startedAt = new Date(new Date(created).getTime() + r.int(1, 4) * 3600000 + (inc.prio === "low" ? 20 * 3600000 : 0)).toISOString();
    const dh = Math.max(1, inc.downH);
    const completedAt = new Date(new Date(startedAt).getTime() + Math.min(dh, 72) * 3600000 * 0.9 + 30 * 60000).toISOString();
    const completedDate = completedAt.slice(0, 10) > today ? today : completedAt.slice(0, 10);
    const vDate = nextWorkday(addDays(completedDate, 1));
    const verifiedAt = iso(vDate, 9, r.int(5, 55));
    const meter = a.meter ? kmAt.get(a.tag)?.get(completedDate > (a.retire?.date ?? today) ? (a.retire?.date ?? today) : completedDate) : undefined;
    wos.push({
      key: inc.id, tag: inc.tag, type: inc.type, prio: inc.prio,
      title: `${inc.title} - ${inc.tag}`,
      desc: `${inc.desc} Aset: ${a.name}. Ref: ${inc.id}`,
      est: inc.cost > 0 ? rp(inc.cost * (0.85 + r.next() * 0.3), 5000) : 0,
      actual: inc.cost, downH: inc.downH, downReason: inc.reason ?? "breakdown", meterAtComplete: meter, parts: inc.parts ?? [],
      assignee: inc.assignee, stage, date: inc.date,
      createdAt: created, assignedAt, startedAt, completedAt, verifiedAt,
      completionNotes: inc.notes, verifyNotes: r.pick(VERIFY_NOTES), cancel: inc.cancel, breakdownStart: created,
    });
  }

  wos.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.key < y.key ? -1 : 1));
  return { assets, scheds, schedFirstDue, schedNextMeter, wos, readings, kmAt };
}

// ---------------------------------------------------------------------------
// workflow definition
// ---------------------------------------------------------------------------

async function ensureWorkOrderWorkflow(ctx: DemoCtx): Promise<void> {
  const ex = await ctx.sql(`SELECT 1 FROM workflow_definitions WHERE tenant_id = $1 AND code = 'asset_maintenance_work_order'`, [ctx.tenantId]);
  if (ex.length) return;
  await ctx.call("POST", "/workflow/definitions", { code: "asset_maintenance_work_order", name: "Siklus Work Order Perawatan Aset", entityType: "asset_maintenance_work_order", description: "Work order perawatan: Open, In Progress, Completed, lalu Verified" });
  const base = "/workflow/definitions/asset_maintenance_work_order/versions/1";
  const steps: { code: string; name: string; type: "task" | "approval" | "end"; initial?: boolean; terminal?: "approved" | "rejected" }[] = [
    { code: "OPEN", name: "Open", type: "task", initial: true },
    { code: "IN_PROGRESS", name: "In Progress", type: "task" },
    { code: "COMPLETED", name: "Completed", type: "approval" },
    { code: "VERIFIED", name: "Verified", type: "end", terminal: "approved" },
    { code: "CANCELLED", name: "Cancelled", type: "end", terminal: "rejected" },
  ];
  for (const s of steps) {
    await ctx.call("POST", `${base}/steps`, { code: s.code, name: s.name, stepType: s.type, ...(s.initial ? { isInitial: true } : {}), ...(s.terminal ? { isTerminal: true, terminalStatus: s.terminal } : {}) });
  }
  const transitions: [string, string, string, string][] = [
    ["OPEN", "IN_PROGRESS", "start", "Mulai"],
    ["OPEN", "CANCELLED", "cancel", "Batalkan"],
    ["IN_PROGRESS", "COMPLETED", "complete", "Selesai"],
    ["IN_PROGRESS", "CANCELLED", "cancel", "Batalkan"],
    ["COMPLETED", "VERIFIED", "verify", "Verifikasi"],
    ["COMPLETED", "IN_PROGRESS", "reject", "Kembalikan untuk perbaikan"],
  ];
  for (const [from, to, action, name] of transitions) {
    await ctx.call("POST", `${base}/transitions`, { fromStepCode: from, toStepCode: to, actionCode: action, name });
  }
  for (const step of ["OPEN", "IN_PROGRESS", "COMPLETED"]) {
    await ctx.call("POST", `${base}/assignment-rules`, { stepCode: step, assignmentType: "role", roleCode: "ASSET_OFFICER", organizationUnitStrategy: "tenant" });
  }
  await ctx.call("POST", `${base}/publish`);
  made("workflowDefinition");
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function run(ctx: DemoCtx): Promise<void> {
  const t = ctx.tenantId;
  const log = (m: string) => ctx.log(SECTOR, m);
  const today = ctx.cal.today;
  const errors: string[] = [];
  const callAs = <T = any>(key: UserKey, method: any, url: string, body?: unknown): Promise<T> =>
    ctx.callAs<T>(USERS[key].email, DEMO_PASSWORD, method, url, body);
  const ao = <T = any>(method: any, url: string, body?: unknown) => callAs<T>("assetOfficer", method, url, body);

  await ensureWorkOrderWorkflow(ctx);

  // lookups ---------------------------------------------------------------------------------------
  const userId: Record<string, string> = {};
  for (const k of ["assetOfficer", "warehouse", "coordinator"] as UserKey[]) userId[k] = (await callAs(k, "GET", "/me")).userId;
  const orgs = await ctx.call<any[]>("GET", "/organization-units");
  const orgId = (name: string) => orgs.find((o) => o.name === name)?.id as string | undefined;
  const emps = await ctx.call<any[]>("GET", "/employees");
  const empId = new Map<string, string>(emps.map((e) => [e.employeeNumber, e.id]));
  const siteRows = await ctx.sql(`SELECT id, code FROM sites WHERE tenant_id = $1`, [t]);
  const siteId = new Map<string, string>(siteRows.map((r) => [r.code, r.id]));
  const items = await ctx.call<any[]>("GET", "/items");
  const itemId = new Map<string, string>(items.map((x) => [x.code, x.id]));
  const whList = await ctx.call<any[]>("GET", "/wms/warehouses");
  const whId = (code: string) => whList.find((w) => w.code === code).id as string;
  const locRows = await ctx.sql(`SELECT l.id, l.code, w.code AS wh FROM scm_warehouse_locations l JOIN scm_warehouses w ON w.id = l.warehouse_id WHERE l.tenant_id = $1`, [t]).catch(() => [] as any[]);
  let locId = new Map<string, string>();
  for (const r of locRows) locId.set(`${r.wh}:${r.code}`, r.id);
  if (locId.size === 0) {
    for (const w of whList) {
      const locs = await ctx.call<any[]>("GET", `/wms/warehouse-locations?warehouseId=${w.id}`);
      for (const l of locs) locId.set(`${w.code}:${l.code}`, l.id);
    }
  }
  const itemSpec = new Map(ITEMS.map((i) => [i.code, i]));

  const plan = buildPlan(today);
  const spec = new Map(plan.assets.map((a) => [a.tag, a]));
  log(`plan: ${plan.assets.length} assets, ${plan.scheds.length} schedules, ${plan.wos.length} work orders, ${plan.readings.length} meter readings`);

  // 1. assets (in creation order so asset numbers follow the calendar) ------------------------------
  const assetRows = new Map<string, { id: string; status: string }>();
  const refresh = async () => {
    for (const r of await ctx.sql(`SELECT id, asset_tag, status FROM assets WHERE tenant_id = $1 AND asset_tag IS NOT NULL`, [t])) assetRows.set(r.asset_tag, { id: r.id, status: r.status });
  };
  await refresh();
  const ordered = [...plan.assets].sort((a, b) => (createdOn(a) < createdOn(b) ? -1 : createdOn(a) > createdOn(b) ? 1 : a.tag < b.tag ? -1 : 1));
  for (const a of ordered) {
    if (assetRows.has(a.tag)) continue;
    if (createdOn(a) > today) continue;
    try {
      const view = await ao("POST", "/assets", {
        name: a.name, assetTag: a.tag, description: a.description, category: a.category, status: a.status ?? "in_use",
        organizationUnitId: orgId(orgNameOf(a.org)) ?? null,
        custodianEmployeeId: a.cust ? empId.get(a.cust) ?? null : null,
        siteId: a.site ? siteId.get(a.site) ?? null : null,
        locationDetail: a.loc, acquisitionReference: a.ref, acquiredAt: a.acquired,
      });
      assetRows.set(a.tag, { id: view.asset.id, status: view.asset.status });
      made("asset");
    } catch (e: any) { errors.push(`asset ${a.tag}: ${String(e.message).slice(0, 250)}`); log(`! asset ${a.tag}: ${String(e.message).slice(0, 200)}`); }
  }

  // 2. schedules -----------------------------------------------------------------------------------------
  const schedRows = new Map<string, string>();
  const loadScheds = async () => { for (const r of await ctx.sql(`SELECT id, schedule_code FROM asset_maintenance_schedules WHERE tenant_id = $1`, [t])) schedRows.set(r.schedule_code, r.id); };
  await loadScheds();
  for (const s of plan.scheds) {
    if (schedRows.has(s.code)) continue;
    const ar = assetRows.get(s.tag);
    if (!ar) continue;
    try {
      const first = plan.schedFirstDue.get(s.code)!;
      const body: any = { assetId: ar.id, scheduleCode: s.code, title: `${s.title} - ${s.tag}`, description: s.description, frequencyType: s.freq.kind };
      if (s.freq.kind === "calendar") { body.intervalDays = s.freq.days; body.nextDueDate = first; }
      else { body.meterInterval = s.freq.interval; body.meterType = s.freq.type; body.nextDueMeter = plan.schedNextMeter.get(s.code); }
      const row = await ao("POST", "/assets/schedules", body);
      schedRows.set(s.code, row.id);
      made("maintenanceSchedule");
    } catch (e: any) { errors.push(`schedule ${s.code}: ${String(e.message).slice(0, 250)}`); log(`! schedule ${s.code}: ${String(e.message).slice(0, 200)}`); }
  }

  // 3. event replay -------------------------------------------------------------------------------------------
  interface Ev { date: string; prio: number; seq: number; label: string; run: () => Promise<void> }
  const events: Ev[] = [];
  let seq = 0;
  const push = (date: string, prio: number, label: string, fn: () => Promise<void>) => {
    if (date > today) return;
    events.push({ date, prio, seq: seq++, label, run: async () => { try { await fn(); } catch (e: any) { const m = `${label}: ${String(e?.message ?? e).slice(0, 300)}`; errors.push(m); log(`! ${m}`); } } });
  };

  // 3a. movements, status changes and retirements
  for (const a of plan.assets) {
    for (const m of a.moves ?? []) {
      push(m.date, 1, `move ${a.tag} ${m.date}`, async () => {
        const ar = assetRows.get(a.tag);
        if (!ar) return;
        const dup = await ctx.sql(`SELECT 1 FROM asset_movements WHERE asset_id = $1 AND movement_type = 'transfer' AND effective_date = $2::date AND reason = $3`, [ar.id, m.date, m.reason]);
        if (dup.length) return;
        const body: any = { reason: m.reason, effectiveDate: m.date };
        if ("site" in m) body.siteId = m.site ? siteId.get(m.site) ?? null : null;
        if (m.loc) body.locationDetail = m.loc;
        if ("cust" in m) body.custodianEmployeeId = m.cust ? empId.get(m.cust) ?? null : null;
        await ao("POST", `/assets/${ar.id}/movements`, body);
        made("assetMovement");
      });
    }
    for (const sc of a.stat ?? []) {
      push(sc.date, 1, `status ${a.tag} ${sc.date}`, async () => {
        const ar = assetRows.get(a.tag);
        if (!ar) return;
        const dup = await ctx.sql(`SELECT 1 FROM asset_movements WHERE asset_id = $1 AND movement_type = 'status_change' AND effective_date = $2::date AND reason = $3`, [ar.id, sc.date, sc.reason]);
        if (dup.length) return;
        await ao("POST", `/assets/${ar.id}/status`, { status: sc.status, reason: sc.reason, effectiveDate: sc.date });
        made("assetStatusChange");
      });
    }
    if (a.retire) {
      push(a.retire.date, 9, `retire ${a.tag}`, async () => {
        const ar = assetRows.get(a.tag);
        if (!ar) return;
        const cur = (await ctx.sql(`SELECT status FROM assets WHERE id = $1`, [ar.id]))[0];
        if (cur && (cur.status === "retired" || cur.status === "disposed")) return;
        await ao("POST", `/assets/${ar.id}/retirement`, { status: a.retire!.status, reason: a.retire!.reason, effectiveDate: a.retire!.date });
        made(a.retire!.status === "disposed" ? "assetDisposed" : "assetRetired");
      });
    }
  }

  // 3b. meter readings (monotonic per asset: events are replayed in date order)
  for (const rd of plan.readings) {
    push(rd.date, 3, `meter ${rd.tag} ${rd.date}`, async () => {
      const ar = assetRows.get(rd.tag);
      if (!ar) return;
      const at = iso(rd.date, 17, 0);
      const dup = await ctx.sql(`SELECT 1 FROM asset_meter_readings WHERE asset_id = $1 AND reading_type = $2 AND reading_date = $3::timestamptz`, [ar.id, rd.type, at]);
      if (dup.length) return;
      const note = rd.type === "km" ? "Pencatatan odometer rutin dua mingguan" : "Pencatatan hour meter rutin bulanan";
      await ao("POST", `/assets/${ar.id}/meter-readings`, { readingType: rd.type, readingValue: rd.value, readingDate: at, notes: note });
      made("meterReading");
    });
  }

  // 3c. standalone downtime
  for (const d of EXTRA_DOWNTIME) {
    push(d.date, 4, `downtime ${d.key}`, async () => {
      const ar = assetRows.get(d.tag);
      if (!ar) return;
      const note = `${d.notes} Ref: ${d.key}`;
      const dup = await ctx.sql(`SELECT 1 FROM asset_downtime_records WHERE asset_id = $1 AND notes = $2`, [ar.id, note]);
      if (dup.length) return;
      const start = iso(d.date, d.hour, 0);
      await ao("POST", `/assets/${ar.id}/downtime`, { startTime: start, endTime: new Date(new Date(start).getTime() + d.hours * 3600000).toISOString(), reasonCategory: d.reason, notes: note });
      made("downtime.standalone");
    });
  }

  // 3d. maintenance work orders
  const coreStock = async (code: string) => Number((await ctx.sql(`SELECT quantity::float8 AS q FROM stock_balances WHERE tenant_id = $1 AND item_id = $2`, [t, itemId.get(code)]))[0]?.q ?? 0);
  const issueKeys = new Set<string>((await ctx.sql(`SELECT note FROM stock_movements WHERE tenant_id = $1 AND note LIKE '%[k:ast-%'`, [t])).map((r) => /\[k:([^\]]+)\]/.exec(r.note)?.[1] ?? ""));
  const wmsKeys = new Set<string>((await ctx.sql(`SELECT notes FROM scm_advanced_stock_movements WHERE tenant_id = $1 AND notes LIKE '%[k:ast-%'`, [t])).map((r) => /\[k:([^\]]+)\]/.exec(r.notes)?.[1] ?? ""));

  for (const w of plan.wos) {
    push(w.date, 5, `WO ${w.key}`, async () => {
      const ar = assetRows.get(w.tag);
      if (!ar) throw new Error("asset missing");
      // find or create
      let row = (await ctx.sql(`SELECT id, order_number, assigned_at, started_at, completed_at, verified_at, workflow_instance_id FROM asset_maintenance_work_orders WHERE tenant_id = $1 AND description LIKE $2`, [t, `%Ref: ${w.key}`]))[0];
      if (!row) {
        const body: any = { assetId: ar.id, maintenanceType: w.type, priority: w.prio, title: w.title, description: w.desc, costEstimate: w.est > 0 ? w.est : null };
        if (w.scheduleCode && schedRows.has(w.scheduleCode)) body.scheduleId = schedRows.get(w.scheduleCode);
        await ao("POST", "/assets/work-orders", body);
        made(`workOrder.${w.type}`);
        row = (await ctx.sql(`SELECT id, order_number, assigned_at, started_at, completed_at, verified_at, workflow_instance_id FROM asset_maintenance_work_orders WHERE tenant_id = $1 AND description LIKE $2`, [t, `%Ref: ${w.key}`]))[0];
      }
      const id = row.id as string;
      const want = (s: Stage) => ["assigned", "started", "completed", "verified"].indexOf(w.stage) >= ["assigned", "started", "completed", "verified"].indexOf(s);

      if (w.stage === "cancelled") {
        const done = (await ctx.sql(`SELECT i.status FROM workflow_instances i WHERE i.id = $1`, [row.workflow_instance_id]))[0];
        if (done && done.status === "in_progress") { await ao("POST", `/assets/work-orders/${id}/act`, { actionCode: "cancel", comment: w.cancel }); made("workOrder.cancelled"); }
        return;
      }
      if (want("assigned") && !row.assigned_at) { await ao("POST", `/assets/work-orders/${id}/assign`, { assignedToUserId: userId[w.assignee] }); }

      // spare parts: recorded on the order and issued from stock (core + warehouse ledgers)
      if (want("started")) {
        for (const p of w.parts) {
          const hasPart = await ctx.sql(`SELECT 1 FROM asset_maintenance_parts WHERE maintenance_work_order_id = $1 AND item_id = $2`, [id, itemId.get(p.code)]);
          const sp = itemSpec.get(p.code)!;
          if (hasPart.length === 0 && !row.completed_at) {
            await ao("POST", `/assets/work-orders/${id}/parts`, { itemId: itemId.get(p.code), quantity: p.qty, unitCost: sp.unitCost, notes: `Pemakaian untuk ${w.key}` });
            made("sparePart");
          }
          const key = `ast-${w.key}:${p.code}`;
          const ref = row.order_number as string;
          const at = w.startedAt > new Date().toISOString() ? iso(today, 9) : w.startedAt;
          if (!issueKeys.has(key) || !wmsKeys.has(key)) {
            const bal = await coreStock(p.code);
            if (bal - p.qty < sp.minQty) { made("sparePart.noStockIssue"); issueKeys.add(key); wmsKeys.add(key); continue; }
            if (!wmsKeys.has(key)) {
              await callAs("warehouse", "POST", "/wms/movements", {
                itemId: itemId.get(p.code), warehouseId: whId("WH-GEN"), locationId: locId.get(`WH-GEN:${sp.location}`) ?? locId.get(`GENERAL:${sp.location}`),
                movementType: "out", quantity: p.qty, unitCost: sp.unitCost, referenceType: "maintenance_issue", referenceNumber: ref,
                notes: `Pemakaian suku cadang perawatan aset ${w.tag} [k:${key}]`, occurredAt: at,
              });
              wmsKeys.add(key); made("stockIssue.wms");
            }
            if (!issueKeys.has(key)) {
              const r = await callAs("warehouse", "POST", "/stock/goods-out", { itemCode: p.code, quantity: p.qty, reference: ref, note: `Pemakaian suku cadang perawatan aset ${w.tag} [k:${key}]` });
              await ctx.sql(`UPDATE stock_movements SET occurred_at = $2::timestamptz, created_at = $2::timestamptz WHERE id = $1`, [r.movement.id, at]);
              issueKeys.add(key); made("stockIssue.core");
            }
          }
        }
      }
      if (want("started") && !row.started_at) { await ao("POST", `/assets/work-orders/${id}/start`); }
      if (want("completed") && !row.completed_at) {
        const body: any = { completionNotes: w.completionNotes, actualCost: w.actual, downtimeHours: w.downH };
        if (w.meterAtComplete != null) body.currentMeterReading = w.meterAtComplete;
        await ao("POST", `/assets/work-orders/${id}/complete`, body);
      }
      if (want("verified") && !row.verified_at) { await ao("POST", `/assets/work-orders/${id}/verify`, { verificationNotes: w.verifyNotes }); }

      // downtime for this order
      if (w.downH > 0 || w.stage === "started") {
        const note = `${w.downReason === "scheduled_maintenance" ? "Downtime terjadwal untuk " : "Downtime akibat "}${w.title}. Ref: ${w.key}`;
        const dup = await ctx.sql(`SELECT 1 FROM asset_downtime_records WHERE asset_id = $1 AND notes = $2`, [ar.id, note]);
        if (dup.length === 0 && (w.type !== "preventive" || ["FRZ", "CHL", "VAN", "GEN", "FLT", "DWS", "OVN", "BLC"].some((p) => w.tag.startsWith(p)))) {
          const start = w.type === "preventive" ? w.startedAt : (w.breakdownStart ?? w.createdAt);
          const open = w.stage === "started" || w.stage === "assigned" || w.stage === "open";
          const endMs = new Date(start).getTime() + Math.max(0.5, w.downH) * 3600000;
          const body: any = { maintenanceWorkOrderId: id, startTime: start, reasonCategory: w.downReason, notes: note };
          if (!open) body.endTime = new Date(Math.min(endMs, Date.now() - 60000)).toISOString();
          await ao("POST", `/assets/${ar.id}/downtime`, body);
          made(`downtime.${w.downReason}`);
        }
      }
    });
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.prio - b.prio || a.seq - b.seq));
  log(`replaying ${events.length} events`);
  const t0 = Date.now();
  let n = 0;
  for (const e of events) {
    await e.run();
    n++;
    if (n % 300 === 0) log(`  ... ${n}/${events.length} (${Math.round((Date.now() - t0) / 1000)}s) up to ${e.date}`);
  }
  await refresh();

  // 4. backdating -----------------------------------------------------------------------------------------------
  await backdate(ctx, plan, assetRows, schedRows, log);

  // 5. reliability snapshots (computed from the recorded history) -----------------------------------------------
  await snapshots(ctx, plan, assetRows, ao, log);

  // 6. keep valuation layers consistent with what is on hand after the spare-part issues --------------------------
  try {
    const layers = await ctx.sql(
      `SELECT l.id, l.item_id, l.original_quantity::float8 AS orig, l.remaining_quantity::float8 AS rem FROM scm_valuation_layers l JOIN items i ON i.id = l.item_id
        WHERE l.tenant_id = $1 AND l.stock_condition = 'unrestricted' AND i.code LIKE 'SPR-%' ORDER BY l.item_id, l.received_date DESC, l.created_at DESC`, [t]);
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
        if (Math.abs(keep - l.rem) > 1e-9) { await ctx.call("POST", "/wms/valuation-layers/consume", { layerId: l.id, remainingQuantity: keep }); changed++; }
      }
    }
    if (changed) made("valuationLayerConsumed", changed);
  } catch (e: any) { errors.push(`fifo: ${e.message}`); log(`! fifo: ${String(e.message).slice(0, 200)}`); }

  log(`summary: ${JSON.stringify(count)}`);
  if (errors.length) log(`total event errors: ${errors.length}`);
}

// ---------------------------------------------------------------------------
// backdating
// ---------------------------------------------------------------------------

async function backdate(
  ctx: DemoCtx,
  plan: Plan,
  assetRows: Map<string, { id: string; status: string }>,
  schedRows: Map<string, string>,
  log: (m: string) => void,
): Promise<void> {
  const t = ctx.tenantId;
  const today = ctx.cal.today;

  // assets and their ledger
  for (const a of plan.assets) {
    const ar = assetRows.get(a.tag);
    if (!ar) continue;
    const created = iso(createdOn(a), 9, 15);
    await ctx.sql(`UPDATE assets SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1`, [ar.id, created]);
    const mv = await ctx.sql(`SELECT id, effective_date::text AS d FROM asset_movements WHERE asset_id = $1`, [ar.id]);
    for (const m of mv) {
      const ts = iso(m.d ?? createdOn(a), 10, 0);
      await ctx.sql(`UPDATE asset_movements SET created_at = $2::timestamptz, applied_at = CASE WHEN applied_at IS NULL THEN NULL ELSE $2::timestamptz END WHERE id = $1`, [m.id, ts]);
    }
    if (mv.length) {
      const last = mv.map((m: any) => m.d as string).sort().pop()!;
      await ctx.sql(`UPDATE assets SET updated_at = $2::timestamptz, retired_at = CASE WHEN retired_at IS NULL THEN NULL ELSE $2::timestamptz END WHERE id = $1`, [ar.id, iso(last, 10, 0)]);
    }
    // audit trail follows the business dates
    const aud = await ctx.sql(`SELECT id FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at, id`, [t, ar.id]);
    const first = new Date(created).getTime();
    const lastTs = mv.length ? new Date(iso(mv.map((m: any) => m.d as string).sort().pop()!, 10, 0)).getTime() : first;
    for (let i = 0; i < aud.length; i++) {
      const ts = new Date(first + ((lastTs - first) * i) / Math.max(1, aud.length - 1) + (i === 0 ? 0 : 60000)).toISOString();
      await ctx.sql(`UPDATE audit_log SET created_at = $2::timestamptz WHERE id = $1`, [aud[i].id, ts]);
    }
  }

  // schedules: creation, last performed, next due
  for (const [code, id] of schedRows) {
    const s = plan.scheds.find((x) => x.code === code);
    const a = s ? plan.assets.find((x) => x.tag === s.tag) : undefined;
    await ctx.sql(`UPDATE asset_maintenance_schedules SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1`, [id, iso(a ? createdOn(a) : GO_LIVE, 9, 30)]);
  }

  // work orders
  const byKey = new Map(plan.wos.map((w) => [w.key, w]));
  const rows = await ctx.sql(`SELECT id, description, assigned_at, started_at, completed_at, verified_at, workflow_instance_id, schedule_id FROM asset_maintenance_work_orders WHERE tenant_id = $1 AND description LIKE '%Ref: %'`, [t]);
  for (const r of rows) {
    const key = /Ref: (\S+)$/.exec(r.description)?.[1];
    const w = key ? byKey.get(key) : undefined;
    if (!w) continue;
    const last = r.verified_at ? w.verifiedAt : r.completed_at ? w.completedAt : r.started_at ? w.startedAt : r.assigned_at ? w.assignedAt : w.createdAt;
    await ctx.sql(
      `UPDATE asset_maintenance_work_orders SET created_at = $2::timestamptz,
              assigned_at = CASE WHEN assigned_at IS NULL THEN NULL ELSE $3::timestamptz END,
              started_at = CASE WHEN started_at IS NULL THEN NULL ELSE $4::timestamptz END,
              completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $5::timestamptz END,
              verified_at = CASE WHEN verified_at IS NULL THEN NULL ELSE $6::timestamptz END,
              updated_at = $7::timestamptz
        WHERE id = $1`, [r.id, w.createdAt, w.assignedAt, w.startedAt, w.completedAt, w.verifiedAt, last]);
    await ctx.sql(`UPDATE asset_maintenance_parts SET recorded_at = $2::timestamptz WHERE maintenance_work_order_id = $1`, [r.id, w.startedAt > new Date().toISOString() ? w.createdAt : w.startedAt]);
    if (r.workflow_instance_id) {
      const completed = (await ctx.sql(`SELECT completed_at FROM workflow_instances WHERE id = $1`, [r.workflow_instance_id]))[0]?.completed_at;
      await ctx.sql(`UPDATE workflow_instances SET started_at = $2::timestamptz, completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $3::timestamptz END WHERE id = $1`, [r.workflow_instance_id, w.createdAt, last]);
      void completed;
      await spread(ctx, `SELECT id FROM workflow_history WHERE workflow_instance_id = $1 ORDER BY occurred_at, id`, [r.workflow_instance_id], "workflow_history", "occurred_at", w.createdAt, last);
      await spread(ctx, `SELECT id FROM workflow_instance_assignments WHERE workflow_instance_id = $1 ORDER BY assigned_at, id`, [r.workflow_instance_id], "workflow_instance_assignments", "assigned_at", w.createdAt, last);
      await ctx.sql(
        `UPDATE workflow_instance_assignments SET decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE assigned_at + interval '2 hours' END WHERE workflow_instance_id = $1`, [r.workflow_instance_id]);
    }
    await spread(ctx, `SELECT id FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at, id`, [t, r.id], "audit_log", "created_at", w.createdAt, last);
    // the downtime / meter side effects of this order
    await ctx.sql(`UPDATE asset_downtime_records SET created_at = start_time WHERE maintenance_work_order_id = $1`, [r.id]);
  }
  await ctx.sql(`UPDATE asset_downtime_records SET created_at = start_time WHERE tenant_id = $1 AND created_at > start_time`, [t]);

  // events, notifications and outbox rows written by the API follow the business timeline of their entity
  await ctx.sql(
    `WITH ev AS (
       SELECT d.id, d.entity_id, row_number() OVER (PARTITION BY d.entity_id ORDER BY d.occurred_at, d.id) AS rn, count(*) OVER (PARTITION BY d.entity_id) AS cnt
         FROM domain_events d WHERE d.tenant_id = $1 AND d.entity_type = 'asset_maintenance_work_order'),
     tl AS (SELECT w.id, w.created_at AS s, COALESCE(w.verified_at, w.completed_at, w.started_at, w.assigned_at, w.created_at) AS e FROM asset_maintenance_work_orders w WHERE w.tenant_id = $1)
     UPDATE domain_events d SET occurred_at = tl.s + (ev.rn - 1) * ((GREATEST(tl.e, tl.s + interval '1 hour') - tl.s) / ev.cnt)
       FROM ev JOIN tl ON tl.id = ev.entity_id WHERE d.id = ev.id`, [t]);
  await ctx.sql(
    `WITH ev AS (
       SELECT d.id, d.entity_id, row_number() OVER (PARTITION BY d.entity_id ORDER BY d.occurred_at, d.id) AS rn, count(*) OVER (PARTITION BY d.entity_id) AS cnt
         FROM domain_events d WHERE d.tenant_id = $1 AND d.entity_type = 'asset'),
     tl AS (SELECT a.id, a.created_at AS s, GREATEST(a.updated_at, a.created_at) AS e FROM assets a WHERE a.tenant_id = $1)
     UPDATE domain_events d SET occurred_at = tl.s + (ev.rn - 1) * ((GREATEST(tl.e, tl.s + interval '1 hour') - tl.s) / ev.cnt)
       FROM ev JOIN tl ON tl.id = ev.entity_id WHERE d.id = ev.id`, [t]);
  await ctx.sql(
    `UPDATE notifications n SET created_at = d.occurred_at + interval '30 seconds',
            sent_at = CASE WHEN n.sent_at IS NULL THEN NULL ELSE d.occurred_at + interval '30 seconds' END,
            read_at = CASE WHEN d.occurred_at < now() - interval '4 days' THEN COALESCE(n.read_at, d.occurred_at + interval '3 hours') ELSE n.read_at END
       FROM domain_events d WHERE d.id = n.domain_event_id AND d.tenant_id = $1 AND d.entity_type IN ('asset_maintenance_work_order', 'asset')`, [t]);
  await ctx.sql(
    `UPDATE integration_outbox_deliveries o SET created_at = d.occurred_at, updated_at = d.occurred_at, next_attempt_at = d.occurred_at,
            completed_at = CASE WHEN o.completed_at IS NULL THEN NULL ELSE d.occurred_at + interval '1 minute' END
       FROM domain_events d WHERE d.id = o.domain_event_id AND d.tenant_id = $1 AND d.entity_type IN ('asset_maintenance_work_order', 'asset')`, [t]);
  await ctx.sql(
    `UPDATE integration_event_log l SET created_at = wi.started_at + (random() * interval '6 hours')
       FROM workflow_instances wi JOIN asset_maintenance_work_orders w ON w.workflow_instance_id = wi.id
      WHERE l.tenant_id = $1 AND l.created_at > now() - interval '1 day' AND (l.payload->>'workflowInstanceId') = wi.id::text`, [t]);
  await ctx.sql(`UPDATE asset_meter_readings SET created_at = reading_date WHERE tenant_id = $1 AND created_at > reading_date`, [t]);

  // years in numbers follow the business date
  await ctx.sql(`UPDATE asset_maintenance_work_orders SET order_number = replace(order_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND created_at < '2026-01-01' AND order_number LIKE '%-2026-%'`, [t]);
  await ctx.sql(`UPDATE assets SET asset_number = replace(asset_number, '-2026-', '-2025-') WHERE tenant_id = $1 AND created_at < '2026-01-01' AND asset_number LIKE '%-2026-%'`, [t]);

  // schedule state after the replayed history
  await ctx.sql(
    `UPDATE asset_maintenance_schedules s SET
        last_performed_at = x.last_done,
        next_due_date = CASE WHEN s.frequency_type = 'calendar' AND s.interval_days IS NOT NULL THEN ((x.last_done AT TIME ZONE 'Asia/Jakarta')::date + s.interval_days) ELSE s.next_due_date END,
        updated_at = x.last_done
      FROM (SELECT schedule_id, max(completed_at) AS last_done FROM asset_maintenance_work_orders WHERE tenant_id = $1 AND schedule_id IS NOT NULL AND completed_at IS NOT NULL GROUP BY schedule_id) x
     WHERE s.id = x.schedule_id AND s.tenant_id = $1`, [t]);
  await ctx.sql(
    `UPDATE asset_maintenance_schedules s SET is_active = false FROM assets a WHERE a.id = s.asset_id AND s.tenant_id = $1 AND a.status IN ('retired', 'disposed')`, [t]);
  void today;
  log("backdating done");
}

async function spread(ctx: DemoCtx, selectSql: string, params: unknown[], table: string, col: string, from: string, to: string): Promise<void> {
  const rows = await ctx.sql(selectSql, params);
  const a = new Date(from).getTime();
  const b = Math.max(new Date(to).getTime(), a + 60000);
  for (let i = 0; i < rows.length; i++) {
    const ts = new Date(a + ((b - a) * i) / Math.max(1, rows.length - 1)).toISOString();
    await ctx.sql(`UPDATE ${table} SET ${col} = $2::timestamptz WHERE id = $1`, [rows[i].id, ts]);
  }
}

// ---------------------------------------------------------------------------
// reliability snapshots
// ---------------------------------------------------------------------------

async function snapshots(
  ctx: DemoCtx,
  plan: Plan,
  assetRows: Map<string, { id: string; status: string }>,
  ao: <T = any>(method: any, url: string, body?: unknown) => Promise<T>,
  log: (m: string) => void,
): Promise<void> {
  const t = ctx.tenantId;
  const today = ctx.cal.today;
  const tags = new Set<string>();
  for (const w of plan.wos) if (w.type !== "preventive") tags.add(w.tag);
  for (const a of plan.assets) if (a.meter || a.category === K_COLD) tags.add(a.tag);
  const dates = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"];
  let created = 0;
  for (const tag of tags) {
    const a = plan.assets.find((x) => x.tag === tag)!;
    const ar = assetRows.get(tag);
    if (!ar) continue;
    for (const d of dates) {
      if (d > today || d < addDays(createdOn(a), 45)) continue;
      if (a.retire && d > a.retire.date) continue;
      const ex = await ctx.sql(`SELECT 1 FROM asset_predictive_snapshots WHERE asset_id = $1 AND analysis_date = $2::date`, [ar.id, d]);
      if (ex.length) continue;
      const m = await ao<any>("GET", `/assets/${ar.id}/reliability?periodStart=${addDays(d, -90)}&periodEnd=${d}`);
      let health = 100;
      if (m.availabilityPct < 95) health -= 20;
      if (m.availabilityPct < 85) health -= 25;
      if (m.correctiveFailureCount >= 3) health -= 25;
      else if (m.correctiveFailureCount >= 1) health -= 10;
      if (m.mttrHours > 12) health -= 15;
      health = Math.max(10, Math.min(100, health));
      let rec = "Asset operating within optimal reliability parameters. Maintain routine schedule.";
      let pfd: string | null = null;
      let conf = 90;
      if (health < 50) { rec = "Immediate overhaul and critical component replacement advised. High failure probability."; pfd = addDays(d, 7); conf = 85; }
      else if (health < 75) { rec = "Perform scheduled preventive inspection and lube cycle within 14 days."; pfd = addDays(d, 21); conf = 75; }
      await ctx.sql(
        `INSERT INTO asset_predictive_snapshots (tenant_id, asset_id, analysis_date, mtbf_hours, mttr_hours, availability_pct, health_score, predicted_failure_date, confidence_pct, recommendation, created_at)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8::date,$9,$10,$11::timestamptz)`,
        [t, ar.id, d, m.mtbfHours, m.mttrHours, m.availabilityPct, health, pfd, conf, rec, iso(d, 6, 0)]);
      created++;
    }
    const todayEx = await ctx.sql(`SELECT 1 FROM asset_predictive_snapshots WHERE asset_id = $1 AND analysis_date = $2::date`, [ar.id, today]);
    if (todayEx.length === 0 && ar.status !== "disposed" && ar.status !== "retired") {
      try { await ao("POST", `/assets/${ar.id}/predictive-snapshots`); created++; } catch { /* ignore */ }
    }
  }
  if (created) made("predictiveSnapshot", created);
  log("reliability snapshots done");
}
