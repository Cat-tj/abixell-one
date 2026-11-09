import type { DemoCtx } from "./harness.js";
import { makeRand } from "./harness.js";

/**
 * Sector "projects": six delivery projects (fit-out, renovation, facility
 * take-over, camp build, port mobilisation, central kitchen) with WBS,
 * activities, dependencies, resources, milestones, approved baselines, cost
 * ledger and monthly earned-value snapshots. Three are finished, three are in
 * progress. Everything goes through the API; SQL only backdates timestamps,
 * rewrites baseline planned cost (the API derives it from existing actuals) and
 * replays historical progress while freezing EV snapshots.
 */

const S = "projects";

type UserKey = "pm" | "coord" | "exec1" | "exec2" | "exec3" | "hse" | "purch" | "asset" | "finance";
const USER_EMAIL: Record<UserKey, string> = {
  pm: "dimas.anggara@sentra.local",
  coord: "andi.prasetyo@sentra.local",
  exec1: "slamet.riyadi@sentra.local",
  exec2: "dewi.lestari@sentra.local",
  exec3: "joko.susilo@sentra.local",
  hse: "fajar.nugroho@sentra.local",
  purch: "maya.kusuma@sentra.local",
  asset: "teguh.wibowo@sentra.local",
  finance: "bambang.hartono@sentra.local",
};

interface WbsSpec {
  code: string;
  name: string;
  parent?: string;
}
interface ActSpec {
  title: string;
  description: string;
  type: string;
  wbs: string;
  pic: UserKey;
  plan: [string, string];
  /** Original plan before a schedule revision (used by baseline v1). */
  origPlan?: [string, string];
  actualStart?: string;
  actualEnd?: string;
  /** Final progress; 100 = completed, 0 = planned. */
  prog: number;
  hold?: boolean;
  budget: number;
  after?: number[];
  res?: [string, number];
}
interface MsSpec {
  title: string;
  type: string;
  planned: string;
  status: "achieved" | "pending" | "missed";
  achievedOn?: string;
  note?: string;
}
interface ProjSpec {
  code: string;
  name: string;
  customer: string;
  contract?: string;
  start: string;
  finalStatus: "completed" | "active";
  cpi: number;
  wbs: WbsSpec[];
  acts: ActSpec[];
  milestones: MsSpec[];
  members: UserKey[];
  baselines: { name: string; notes: string; approvedOn: string; useOrig: boolean }[];
}

const RESOURCES: { code: string; name: string; type: "labor" | "equipment" | "material" | "other"; unit: string; cap: string; rate: string }[] = [
  { code: "RES-TUKANG", name: "Tim Tukang Sipil (borongan)", type: "labor", unit: "orang-hari", cap: "14", rate: "250000" },
  { code: "RES-MEP", name: "Teknisi MEP & Listrik", type: "labor", unit: "orang-hari", cap: "6", rate: "320000" },
  { code: "RES-CHEF", name: "Chef Konsultan & Tim Uji Produksi", type: "labor", unit: "orang-hari", cap: "4", rate: "450000" },
  { code: "RES-CLEAN", name: "Petugas Mobilisasi Kebersihan", type: "labor", unit: "orang-hari", cap: "40", rate: "210000" },
  { code: "RES-TRUK", name: "Truk Engkel & Pickup Logistik", type: "equipment", unit: "hari", cap: "3", rate: "700000" },
  { code: "RES-SCAFF", name: "Scaffolding & Alat Angkat", type: "equipment", unit: "hari", cap: "2", rate: "900000" },
];

const PROJECTS: ProjSpec[] = [
  {
    code: "PRJ-S01",
    name: "Fit-out Dapur Sentral Pabrik Cikarang",
    customer: "CUST-101",
    contract: "CTR-2025-101",
    start: "2025-11-10",
    finalStatus: "completed",
    cpi: 1.06,
    members: ["pm", "coord", "hse", "purch", "exec1"],
    wbs: [
      { code: "1", name: "Persiapan & Desain" },
      { code: "2", name: "Pekerjaan Sipil & MEP" },
      { code: "3", name: "Pengadaan & Instalasi Peralatan" },
      { code: "4", name: "Komisioning & Serah Terima" },
    ],
    acts: [
      { title: "Survei lokasi & gambar kerja desain dapur", description: "Pengukuran ruang, layout aliran bahan dan gambar kerja kapasitas 650 porsi per hari.", type: "DESAIN", wbs: "1", pic: "pm", plan: ["2025-11-10", "2025-11-21"], actualStart: "2025-11-10", actualEnd: "2025-11-24", prog: 100, budget: 45_000_000 },
      { title: "Perizinan SLHS & izin instalasi gas", description: "Pengurusan sertifikat laik higiene sanitasi dan izin instalasi LPG ke dinas terkait.", type: "PERIZINAN", wbs: "1", pic: "hse", plan: ["2025-11-17", "2025-12-12"], actualStart: "2025-11-20", actualEnd: "2025-12-19", prog: 100, budget: 25_000_000, after: [0] },
      { title: "Pembongkaran & pekerjaan sipil lantai dan dinding", description: "Bongkar partisi lama, epoxy lantai anti-slip, keramik dinding, floor drain.", type: "SIPIL", wbs: "2", pic: "exec1", plan: ["2025-11-24", "2025-12-19"], actualStart: "2025-11-27", actualEnd: "2025-12-26", prog: 100, budget: 310_000_000, after: [0], res: ["RES-TUKANG", 120] },
      { title: "Instalasi MEP (listrik, air bersih, gas LPG, exhaust)", description: "Panel listrik 3 fasa, jaringan air bersih, pipa gas LPG, hood dan exhaust fan.", type: "MEP", wbs: "2", pic: "exec2", plan: ["2025-12-15", "2026-01-16"], actualStart: "2025-12-22", actualEnd: "2026-01-27", prog: 100, budget: 385_000_000, after: [2], res: ["RES-MEP", 90] },
      { title: "Pengadaan peralatan dapur stainless", description: "Kompor industri, steamer nasi, chiller, meja stainless, rak dan peralatan cuci.", type: "PENGADAAN", wbs: "3", pic: "purch", plan: ["2025-12-01", "2026-01-16"], actualStart: "2025-12-05", actualEnd: "2026-01-22", prog: 100, budget: 640_000_000, after: [0] },
      { title: "Pemasangan peralatan & uji coba", description: "Penempatan, leveling, sambungan utilitas dan uji nyala seluruh peralatan.", type: "INSTALASI", wbs: "3", pic: "exec1", plan: ["2026-01-19", "2026-02-06"], actualStart: "2026-01-28", actualEnd: "2026-02-13", prog: 100, budget: 120_000_000, after: [3, 4], res: ["RES-TRUK", 12] },
      { title: "Pelatihan tim dapur & uji produksi 3 hari", description: "Pelatihan SOP higiene, uji produksi 650 porsi dan tasting oleh perwakilan klien.", type: "PELATIHAN", wbs: "4", pic: "coord", plan: ["2026-02-09", "2026-02-13"], actualStart: "2026-02-16", actualEnd: "2026-02-20", prog: 100, budget: 35_000_000, after: [5], res: ["RES-CHEF", 15] },
      { title: "Inspeksi HSE & serah terima (BAST)", description: "Inspeksi akhir K3, punch list dan penandatanganan BAST bersama GA klien.", type: "SERAH_TERIMA", wbs: "4", pic: "hse", plan: ["2026-02-16", "2026-02-20"], actualStart: "2026-02-23", actualEnd: "2026-03-02", prog: 100, budget: 30_000_000, after: [6] },
    ],
    milestones: [
      { title: "Desain & layout disetujui klien", type: "APPROVAL", planned: "2025-11-21", status: "achieved", achievedOn: "2025-11-24", note: "Disetujui GA PT Mitra Baja setelah revisi posisi chiller." },
      { title: "Izin SLHS & instalasi gas terbit", type: "PERIZINAN", planned: "2025-12-12", status: "achieved", achievedOn: "2025-12-19" },
      { title: "Pekerjaan sipil dan MEP selesai", type: "KONSTRUKSI", planned: "2026-01-16", status: "achieved", achievedOn: "2026-01-27", note: "Terlambat 11 hari karena pasokan panel listrik tertahan di pabrikan." },
      { title: "Produksi perdana 650 porsi", type: "OPERASI", planned: "2026-02-13", status: "achieved", achievedOn: "2026-02-20" },
      { title: "Serah terima (BAST) ditandatangani", type: "HANDOVER", planned: "2026-02-20", status: "achieved", achievedOn: "2026-03-02", note: "BAST ditandatangani 10 hari setelah rencana." },
    ],
    baselines: [{ name: "Baseline Awal", notes: "Jadwal dan anggaran sesuai penawaran yang disetujui klien.", approvedOn: "2025-11-17", useOrig: false }],
  },
  {
    code: "PRJ-S03",
    name: "Onboarding Facility Takeover Gedung Bank Nusa Makmur",
    customer: "CUST-104",
    start: "2026-01-12",
    finalStatus: "completed",
    cpi: 1.02,
    members: ["pm", "coord", "hse", "purch"],
    wbs: [
      { code: "1", name: "Asesmen & Persiapan" },
      { code: "2", name: "Mobilisasi Tim & Peralatan" },
      { code: "3", name: "Pelatihan & Takeover" },
    ],
    acts: [
      { title: "Due diligence & audit kondisi gedung", description: "Audit kondisi lantai, sanitasi, peralatan existing dan kontrak vendor lama.", type: "ASESMEN", wbs: "1", pic: "coord", plan: ["2026-01-12", "2026-01-23"], actualStart: "2026-01-12", actualEnd: "2026-01-24", prog: 100, budget: 35_000_000 },
      { title: "Rekrutmen & seragam 85 petugas", description: "Seleksi, medical check, kontrak dan pengadaan seragam serta APD petugas.", type: "REKRUTMEN", wbs: "2", pic: "pm", plan: ["2026-01-19", "2026-02-13"], actualStart: "2026-01-20", actualEnd: "2026-02-18", prog: 100, budget: 95_000_000, after: [0] },
      { title: "Pengadaan mesin & alat cleaning", description: "Scrubber dryer, vacuum industri, polisher, trolley dan bahan kimia awal.", type: "PENGADAAN", wbs: "2", pic: "purch", plan: ["2026-01-26", "2026-03-06"], actualStart: "2026-02-02", actualEnd: "2026-03-10", prog: 100, budget: 160_000_000, after: [0] },
      { title: "Penyusunan SOP & jadwal kerja per lantai", description: "SOP pembersihan area publik, ruang vault dan toilet; matriks jadwal harian.", type: "DOKUMEN", wbs: "1", pic: "coord", plan: ["2026-02-09", "2026-02-27"], actualStart: "2026-02-09", actualEnd: "2026-03-03", prog: 100, budget: 25_000_000, after: [0] },
      { title: "Pelatihan petugas & uji kompetensi", description: "Pelatihan K3, penggunaan mesin dan etika di lingkungan perbankan.", type: "PELATIHAN", wbs: "3", pic: "hse", plan: ["2026-03-02", "2026-03-20"], actualStart: "2026-03-09", actualEnd: "2026-03-26", prog: 100, budget: 45_000_000, after: [1, 3] },
      { title: "Takeover bertahap per lantai", description: "Pilot 10 lantai, evaluasi, lalu takeover penuh 28 lantai dan serah terima operasional.", type: "TAKEOVER", wbs: "3", pic: "pm", plan: ["2026-03-16", "2026-04-03"], actualStart: "2026-03-23", actualEnd: "2026-04-07", prog: 100, budget: 60_000_000, after: [2, 4], res: ["RES-CLEAN", 160] },
    ],
    milestones: [
      { title: "Laporan audit kondisi gedung diterima klien", type: "DELIVERABLE", planned: "2026-01-23", status: "achieved", achievedOn: "2026-01-26" },
      { title: "85 petugas siap bertugas", type: "MOBILISASI", planned: "2026-02-13", status: "achieved", achievedOn: "2026-02-18" },
      { title: "Pilot takeover 10 lantai lulus evaluasi", type: "PILOT", planned: "2026-03-27", status: "achieved", achievedOn: "2026-03-30" },
      { title: "Takeover penuh 28 lantai", type: "HANDOVER", planned: "2026-04-03", status: "achieved", achievedOn: "2026-04-07", note: "Mundur 4 hari akibat libur Idul Fitri dan penyesuaian akses lantai vault." },
    ],
    baselines: [{ name: "Baseline Awal", notes: "Rencana takeover 12 minggu sesuai kontrak.", approvedOn: "2026-01-16", useOrig: false }],
  },
  {
    code: "PRJ-S02",
    name: "Renovasi Kantin & Dapur Utama Kampus UTN",
    customer: "CUST-109",
    contract: "CTR-2026-109",
    start: "2026-02-02",
    finalStatus: "completed",
    cpi: 0.97,
    members: ["pm", "coord", "hse", "purch", "asset"],
    wbs: [
      { code: "1", name: "Desain & Persiapan" },
      { code: "2", name: "Konstruksi & MEP" },
      { code: "3", name: "Peralatan & Finishing" },
      { code: "4", name: "Peluncuran" },
    ],
    acts: [
      { title: "Survei & desain interior kantin", description: "Konsep food court 6 gerai, kapasitas 600 kursi dan alur dapur utama.", type: "DESAIN", wbs: "1", pic: "pm", plan: ["2026-02-02", "2026-02-20"], actualStart: "2026-02-02", actualEnd: "2026-02-24", prog: 100, budget: 40_000_000 },
      { title: "Pembongkaran & pekerjaan sipil", description: "Bongkar kantin lama, struktur mezanin, lantai dan plafon.", type: "SIPIL", wbs: "2", pic: "exec2", plan: ["2026-02-23", "2026-03-27"], actualStart: "2026-02-26", actualEnd: "2026-04-03", prog: 100, budget: 260_000_000, after: [0], res: ["RES-TUKANG", 140] },
      { title: "Instalasi MEP dapur & exhaust", description: "Listrik, air, gas, grease trap dan exhaust dapur utama.", type: "MEP", wbs: "2", pic: "exec3", plan: ["2026-03-23", "2026-04-24"], actualStart: "2026-04-06", actualEnd: "2026-05-08", prog: 100, budget: 230_000_000, after: [1], res: ["RES-MEP", 80] },
      { title: "Pengadaan peralatan & furnitur food court", description: "Etalase gerai, meja kursi, peralatan dapur utama kapasitas 2.000 porsi.", type: "PENGADAAN", wbs: "3", pic: "purch", plan: ["2026-04-06", "2026-05-15"], actualStart: "2026-04-13", actualEnd: "2026-05-22", prog: 100, budget: 310_000_000, after: [0] },
      { title: "Finishing, branding & signage", description: "Pengecatan, mural, papan menu digital dan signage gerai.", type: "FINISHING", wbs: "3", pic: "exec1", plan: ["2026-05-11", "2026-05-29"], actualStart: "2026-05-18", actualEnd: "2026-05-30", prog: 100, budget: 85_000_000, after: [2, 3] },
      { title: "Uji coba & soft opening", description: "Operasional uji coba satu minggu dengan mahasiswa dan staf.", type: "UJI_COBA", wbs: "4", pic: "coord", plan: ["2026-05-25", "2026-06-02"], actualStart: "2026-05-30", actualEnd: "2026-06-03", prog: 100, budget: 30_000_000, after: [4] },
      { title: "Serah terima & pelatihan pengelola", description: "BAST, penyerahan manual peralatan dan pelatihan tim kantin.", type: "SERAH_TERIMA", wbs: "4", pic: "hse", plan: ["2026-06-03", "2026-06-05"], actualStart: "2026-06-03", actualEnd: "2026-06-05", prog: 100, budget: 25_000_000, after: [5] },
    ],
    milestones: [
      { title: "Desain interior disetujui rektorat", type: "APPROVAL", planned: "2026-02-20", status: "achieved", achievedOn: "2026-02-24" },
      { title: "Struktur dan sipil selesai", type: "KONSTRUKSI", planned: "2026-03-27", status: "achieved", achievedOn: "2026-04-03", note: "Terlambat satu minggu karena penyesuaian jam kerja selama Ramadan." },
      { title: "Peralatan terpasang", type: "INSTALASI", planned: "2026-05-15", status: "achieved", achievedOn: "2026-05-22" },
      { title: "Kantin dibuka untuk umum", type: "LAUNCH", planned: "2026-06-05", status: "achieved", achievedOn: "2026-06-05", note: "Tepat waktu; dibuka bersamaan dengan awal semester pendek." },
    ],
    baselines: [{ name: "Baseline Awal", notes: "Rencana renovasi 18 minggu di luar masa ujian.", approvedOn: "2026-02-06", useOrig: false }],
  },
  {
    code: "PRJ-S04",
    name: "Camp Management & Dapur Lapangan Proyek Tol Bandung Selatan",
    customer: "CUST-105",
    contract: "CTR-2025-105",
    start: "2026-03-02",
    finalStatus: "active",
    cpi: 1.04,
    members: ["pm", "coord", "hse", "purch", "asset", "exec1"],
    wbs: [
      { code: "1", name: "Studi & Perizinan" },
      { code: "2", name: "Konstruksi Camp" },
      { code: "2.1", name: "Pekerjaan Tanah & Struktur", parent: "2" },
      { code: "2.2", name: "Bangunan & MEP", parent: "2" },
      { code: "3", name: "Dapur & Fasilitas Penunjang" },
      { code: "4", name: "Operasi Awal & Serah Terima" },
    ],
    acts: [
      { title: "Survei lokasi camp & topografi", description: "Pemetaan lahan 2,4 hektar, uji tanah dan akses jalan kerja.", type: "SURVEI", wbs: "1", pic: "pm", plan: ["2026-03-02", "2026-03-13"], actualStart: "2026-03-02", actualEnd: "2026-03-14", prog: 100, budget: 60_000_000 },
      { title: "Perizinan & koordinasi kontraktor utama", description: "Izin lokasi, koordinasi dengan kontraktor utama tol dan warga sekitar.", type: "PERIZINAN", wbs: "1", pic: "coord", plan: ["2026-03-09", "2026-04-03"], actualStart: "2026-03-12", actualEnd: "2026-04-10", prog: 100, budget: 35_000_000, after: [0] },
      { title: "Pematangan lahan & pondasi bangunan camp", description: "Cut and fill, pemadatan, pondasi tapak untuk barak dan dapur.", type: "SIPIL", wbs: "2.1", pic: "exec1", plan: ["2026-04-06", "2026-05-29"], origPlan: ["2026-03-30", "2026-05-08"], actualStart: "2026-04-06", actualEnd: "2026-05-29", prog: 100, budget: 520_000_000, after: [1], res: ["RES-TUKANG", 260] },
      { title: "Pembangunan barak modular 120 kamar", description: "Rangka baja ringan dan panel modular, 120 kamar dengan sanitasi komunal.", type: "BANGUNAN", wbs: "2.2", pic: "exec2", plan: ["2026-06-01", "2026-08-28"], origPlan: ["2026-05-11", "2026-07-31"], actualStart: "2026-06-01", actualEnd: "2026-08-28", prog: 100, budget: 880_000_000, after: [2], res: ["RES-SCAFF", 60] },
      { title: "Instalasi MEP, genset & IPAL", description: "Genset 250 kVA, jaringan listrik, air bersih dan IPAL kapasitas 40 m3.", type: "MEP", wbs: "2.2", pic: "exec3", plan: ["2026-07-06", "2026-09-25"], origPlan: ["2026-06-22", "2026-09-04"], actualStart: "2026-07-06", actualEnd: "2026-09-25", prog: 100, budget: 360_000_000, after: [2], res: ["RES-MEP", 150] },
      { title: "Pembangunan dapur lapangan & ruang makan", description: "Dapur kapasitas 1.800 porsi, cold storage dan ruang makan 300 kursi.", type: "BANGUNAN", wbs: "3", pic: "exec1", plan: ["2026-07-20", "2026-10-09"], origPlan: ["2026-07-06", "2026-09-25"], actualStart: "2026-07-20", actualEnd: "2026-10-09", prog: 100, budget: 410_000_000, after: [2] },
      { title: "Pengadaan peralatan dapur & furnitur camp", description: "Peralatan dapur, tempat tidur, lemari dan perlengkapan laundry.", type: "PENGADAAN", wbs: "3", pic: "purch", plan: ["2026-09-14", "2026-11-13"], origPlan: ["2026-09-07", "2026-10-30"], actualStart: "2026-09-14", prog: 80, budget: 290_000_000, after: [5], res: ["RES-TRUK", 20] },
      { title: "Uji coba operasi katering & housekeeping 2 minggu", description: "Operasi percontohan di blok A, evaluasi menu dan jadwal kebersihan.", type: "UJI_COBA", wbs: "4", pic: "coord", plan: ["2026-11-02", "2026-11-20"], actualStart: "2026-11-02", prog: 35, budget: 55_000_000, after: [4, 5] },
      { title: "Inspeksi K3 & serah terima camp", description: "Inspeksi K3, punch list dan BAST ke manajemen proyek tol.", type: "SERAH_TERIMA", wbs: "4", pic: "hse", plan: ["2026-11-23", "2026-12-04"], prog: 0, budget: 40_000_000, after: [6, 7] },
      { title: "Pelatihan tim camp & demobilisasi kontraktor", description: "Pelatihan operasional tim camp dan penutupan area kerja kontraktor.", type: "PELATIHAN", wbs: "4", pic: "coord", plan: ["2026-12-07", "2026-12-18"], prog: 0, budget: 30_000_000, after: [8] },
    ],
    milestones: [
      { title: "Izin lokasi camp terbit", type: "PERIZINAN", planned: "2026-04-03", status: "achieved", achievedOn: "2026-04-10" },
      { title: "Pondasi dan pematangan lahan selesai", type: "KONSTRUKSI", planned: "2026-05-08", status: "achieved", achievedOn: "2026-05-29", note: "Hujan deras April-Mei menunda pemadatan tiga minggu." },
      { title: "Barak 120 kamar selesai", type: "KONSTRUKSI", planned: "2026-07-31", status: "achieved", achievedOn: "2026-08-28" },
      { title: "Dapur lapangan siap uji coba", type: "OPERASI", planned: "2026-10-09", status: "achieved", achievedOn: "2026-10-09" },
      { title: "Uji coba operasi 2 minggu selesai", type: "OPERASI", planned: "2026-11-20", status: "pending" },
      { title: "Serah terima camp ke proyek tol", type: "HANDOVER", planned: "2026-12-04", status: "pending" },
    ],
    baselines: [
      { name: "Baseline Awal", notes: "Jadwal sesuai kontrak CTR-2025-105: selesai 18 Desember 2026 tanpa kompresi.", approvedOn: "2026-03-09", useOrig: true },
      { name: "Revisi 1 - Addendum Jadwal Cuaca", notes: "Penyesuaian jadwal akibat curah hujan tinggi dan keterlambatan akses material; disetujui klien lewat addendum.", approvedOn: "2026-06-15", useOrig: false },
    ],
  },
  {
    code: "PRJ-S05",
    name: "Mobilisasi Layanan Terminal Tanjung Priok",
    customer: "CUST-111",
    contract: "CTR-2026-111",
    start: "2026-07-06",
    finalStatus: "active",
    cpi: 0.98,
    members: ["pm", "coord", "hse", "purch", "exec2"],
    wbs: [
      { code: "1", name: "Asesmen & Rekrutmen" },
      { code: "2", name: "Pelatihan & Pengadaan" },
      { code: "3", name: "Infrastruktur Layanan" },
      { code: "4", name: "Go-live" },
    ],
    acts: [
      { title: "Asesmen lokasi & rencana mobilisasi", description: "Kunjungan area terminal, zona kerja, kebutuhan APD pelabuhan dan akses keamanan.", type: "ASESMEN", wbs: "1", pic: "pm", plan: ["2026-07-06", "2026-07-17"], actualStart: "2026-07-06", actualEnd: "2026-07-17", prog: 100, budget: 40_000_000 },
      { title: "Rekrutmen & seleksi 62 petugas", description: "Rekrutmen petugas kebersihan, pest control dan juru masak; pengurusan kartu akses pelabuhan.", type: "REKRUTMEN", wbs: "1", pic: "coord", plan: ["2026-07-13", "2026-08-07"], actualStart: "2026-07-14", actualEnd: "2026-08-14", prog: 100, budget: 85_000_000, after: [0] },
      { title: "Pelatihan K3 pelabuhan & induksi", description: "Induksi keselamatan area pelabuhan, bahaya kendaraan berat dan prosedur darurat.", type: "PELATIHAN", wbs: "2", pic: "hse", plan: ["2026-08-10", "2026-08-28"], actualStart: "2026-08-17", actualEnd: "2026-09-04", prog: 100, budget: 70_000_000, after: [1] },
      { title: "Pengadaan alat kebersihan & APD", description: "Mesin pembersih, alat semprot, APD lengkap dan bahan kimia.", type: "PENGADAAN", wbs: "2", pic: "purch", plan: ["2026-08-03", "2026-09-11"], actualStart: "2026-08-10", actualEnd: "2026-09-18", prog: 100, budget: 215_000_000, after: [0] },
      { title: "Pengadaan kendaraan operasional & alat pest control", description: "Dua pickup, fogging machine dan perangkap tikus untuk area dermaga.", type: "PENGADAAN", wbs: "2", pic: "asset", plan: ["2026-09-07", "2026-10-09"], actualStart: "2026-09-14", actualEnd: "2026-10-16", prog: 100, budget: 140_000_000, after: [3] },
      { title: "Pembangunan pos kerja & dapur satelit", description: "Pos koordinasi di tiga zona dan dapur satelit untuk makan shift malam.", type: "BANGUNAN", wbs: "3", pic: "exec2", plan: ["2026-09-14", "2026-11-06"], actualStart: "2026-09-21", prog: 70, budget: 120_000_000, after: [3], res: ["RES-TUKANG", 90] },
      { title: "Soft launch layanan (shift bertahap)", description: "Operasional bertahap zona 1 sampai 3 dengan pengawasan supervisor.", type: "OPERASI", wbs: "3", pic: "coord", plan: ["2026-11-02", "2026-11-20"], actualStart: "2026-11-03", prog: 30, budget: 50_000_000, after: [2, 4], res: ["RES-CLEAN", 120] },
      { title: "Go-live penuh & evaluasi 30 hari", description: "Operasi penuh seluruh zona dan evaluasi KPI bersama manajemen terminal.", type: "GO_LIVE", wbs: "4", pic: "pm", plan: ["2026-11-23", "2026-12-11"], prog: 0, budget: 40_000_000, after: [5, 6] },
    ],
    milestones: [
      { title: "Rencana mobilisasi disetujui terminal", type: "APPROVAL", planned: "2026-07-17", status: "achieved", achievedOn: "2026-07-20" },
      { title: "62 petugas lolos induksi K3", type: "MOBILISASI", planned: "2026-08-28", status: "achieved", achievedOn: "2026-09-04", note: "Dua gelombang induksi karena jadwal kapal sandar." },
      { title: "Peralatan dan kendaraan siap", type: "INSTALASI", planned: "2026-10-09", status: "achieved", achievedOn: "2026-10-16" },
      { title: "Soft launch zona 1 sampai 3", type: "OPERASI", planned: "2026-11-20", status: "pending" },
      { title: "Go-live penuh", type: "LAUNCH", planned: "2026-12-11", status: "pending" },
    ],
    baselines: [{ name: "Baseline Awal", notes: "Rencana mobilisasi 22 minggu sesuai kontrak CTR-2026-111.", approvedOn: "2026-07-10", useOrig: false }],
  },
  {
    code: "PRJ-S06",
    name: "Pembangunan Central Kitchen Plant Karawang",
    customer: "CUST-112",
    contract: "CTR-2026-112",
    start: "2026-10-05",
    finalStatus: "active",
    cpi: 1.0,
    members: ["pm", "coord", "hse", "purch"],
    wbs: [
      { code: "1", name: "Studi & Desain" },
      { code: "2", name: "Perizinan & Tender" },
      { code: "3", name: "Konstruksi" },
      { code: "4", name: "Komisioning" },
    ],
    acts: [
      { title: "Studi kelayakan & konsep layout", description: "Kebutuhan 1.500 porsi per hari, lokasi lahan 1.800 m2 dan alur logistik bahan.", type: "STUDI", wbs: "1", pic: "pm", plan: ["2026-10-05", "2026-10-23"], actualStart: "2026-10-05", actualEnd: "2026-10-26", prog: 100, budget: 75_000_000 },
      { title: "Desain detail arsitektur & MEP", description: "Gambar kerja arsitektur, struktur, MEP dan layout peralatan.", type: "DESAIN", wbs: "1", pic: "pm", plan: ["2026-10-19", "2026-11-20"], actualStart: "2026-10-27", prog: 45, budget: 110_000_000, after: [0] },
      { title: "Perizinan PBG & SLHS", description: "PBG dan sertifikasi higiene; menunggu verifikasi lapangan dinas.", type: "PERIZINAN", wbs: "2", pic: "hse", plan: ["2026-11-02", "2026-12-18"], actualStart: "2026-11-02", prog: 10, hold: true, budget: 45_000_000, after: [0] },
      { title: "Tender kontraktor sipil & MEP", description: "Prakualifikasi, klarifikasi harga dan negosiasi tiga peserta.", type: "TENDER", wbs: "2", pic: "purch", plan: ["2026-11-16", "2026-12-11"], prog: 0, budget: 30_000_000, after: [1] },
      { title: "Pekerjaan sipil & struktur", description: "Pondasi, struktur baja dan atap bangunan central kitchen.", type: "SIPIL", wbs: "3", pic: "exec1", plan: ["2026-12-14", "2027-01-29"], prog: 0, budget: 640_000_000, after: [2, 3] },
      { title: "Instalasi MEP & peralatan produksi", description: "Utilitas, blast chiller, line produksi dan sistem exhaust.", type: "MEP", wbs: "3", pic: "exec2", plan: ["2027-01-11", "2027-02-12"], prog: 0, budget: 420_000_000, after: [4] },
      { title: "Komisioning & serah terima", description: "Uji produksi, audit HACCP dan BAST internal.", type: "SERAH_TERIMA", wbs: "4", pic: "coord", plan: ["2027-02-15", "2027-02-26"], prog: 0, budget: 45_000_000, after: [5] },
    ],
    milestones: [
      { title: "Konsep layout disetujui klien", type: "APPROVAL", planned: "2026-10-23", status: "achieved", achievedOn: "2026-10-26" },
      { title: "Desain detail selesai", type: "DESAIN", planned: "2026-11-20", status: "pending" },
      { title: "PBG dan SLHS terbit", type: "PERIZINAN", planned: "2026-12-18", status: "pending" },
      { title: "Groundbreaking", type: "KONSTRUKSI", planned: "2026-12-14", status: "pending" },
      { title: "Central kitchen beroperasi", type: "LAUNCH", planned: "2027-02-26", status: "pending" },
    ],
    baselines: [{ name: "Baseline Awal", notes: "Rencana 21 minggu dengan perizinan paralel desain.", approvedOn: "2026-10-12", useOrig: false }],
  },
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const dayNum = (d: string) => Math.floor(new Date(d + "T00:00:00Z").getTime() / 86400000);
const roundK = (n: number) => Math.round(n / 1000) * 1000;
const money = (n: number) => String(Math.round(n));

function progressAt(a: ActSpec, d: string, today: string): number {
  if (!a.actualStart || d < a.actualStart) return 0;
  if (a.prog === 0) return 0;
  if (a.actualEnd) {
    if (d >= a.actualEnd) return 100;
    const f = (dayNum(d) - dayNum(a.actualStart)) / Math.max(1, dayNum(a.actualEnd) - dayNum(a.actualStart));
    return Math.min(99, Math.max(0, Math.floor(f * 100)));
  }
  const f = (dayNum(d) - dayNum(a.actualStart)) / Math.max(1, dayNum(today) - dayNum(a.actualStart));
  return Math.min(a.prog, Math.max(0, Math.round(a.prog * f)));
}

const statusOf = (p: number): string => (p >= 100 ? "completed" : p > 0 ? "in_progress" : "planned");

export async function run(ctx: DemoCtx): Promise<void> {
  const { cal } = ctx;
  const today = cal.today;
  const clamp = (d: string) => (d > today ? today : d);
  const tid = ctx.tenantId;
  const counts = { projects: 0, wbs: 0, activities: 0, deps: 0, assigns: 0, milestones: 0, costs: 0, baselines: 0, snaps: 0, members: 0, resources: 0 };

  // users
  const users: Record<string, string> = {};
  for (const [k, email] of Object.entries(USER_EMAIL)) {
    const r = await ctx.sql<{ id: string }>(`SELECT id FROM users WHERE tenant_id=$1 AND email=$2`, [tid, email]);
    if (!r[0]) throw new Error(`user ${email} missing - run foundation first`);
    users[k] = r[0].id;
  }

  // resources (global to tenant)
  const existingRes: any[] = await ctx.call("GET", "/project-delivery/resources?activeOnly=false");
  const resId = new Map<string, string>(existingRes.map((r) => [r.code, r.id]));
  for (const r of RESOURCES) {
    if (resId.has(r.code)) continue;
    const created = await ctx.call("POST", "/project-delivery/resources", {
      code: r.code,
      name: r.name,
      resourceType: r.type,
      unit: r.unit,
      capacityPerDay: r.cap,
      costRate: r.rate,
    });
    resId.set(r.code, created.id);
    counts.resources++;
    await ctx.sql(`UPDATE project_resources SET created_at=$2, updated_at=$2 WHERE id=$1 AND tenant_id=$3`, [created.id, cal.at(cal.start, 9), tid]).catch(() => {});
  }

  for (const spec of PROJECTS) {
    const rng = makeRand(hash(spec.code));
    const cust = await ctx.sql<{ id: string }>(`SELECT id FROM customers WHERE tenant_id=$1 AND code=$2`, [tid, spec.customer]);
    if (!cust[0]) throw new Error(`customer ${spec.customer} missing`);
    const contract = spec.contract
      ? (await ctx.sql<{ id: string }>(`SELECT id FROM contracts WHERE tenant_id=$1 AND code=$2`, [tid, spec.contract]))[0]
      : undefined;

    // ---- project ----
    let proj = (await ctx.sql<{ id: string }>(`SELECT id FROM projects WHERE tenant_id=$1 AND customer_id=$2 AND code=$3`, [tid, cust[0].id, spec.code]))[0];
    if (!proj) {
      const created = await ctx.call("POST", "/projects", {
        customerId: cust[0].id,
        contractId: contract?.id ?? null,
        code: spec.code,
        name: spec.name,
        status: "active",
      });
      proj = { id: created.id };
      counts.projects++;
    }
    const pid = proj.id;
    const endDate = spec.finalStatus === "completed" ? spec.acts.reduce((m, a) => ((a.actualEnd ?? "") > m ? a.actualEnd! : m), "") : today;
    if (spec.finalStatus === "completed") {
      const cur = await ctx.sql<{ status: string }>(`SELECT status FROM projects WHERE id=$1`, [pid]);
      if (cur[0]?.status !== "completed") await ctx.call("PATCH", `/projects/${pid}`, { status: "completed" });
    }
    await ctx.sql(
      `UPDATE projects SET created_at=$2, updated_at=$3 WHERE id=$1 AND tenant_id=$4`,
      [pid, cal.at(cal.addDays(spec.start, -7), 10), cal.at(clamp(spec.finalStatus === "completed" ? endDate : cal.addDays(today, -2)), 15), tid],
    );

    // ---- members (SQL: no API) ----
    for (const m of spec.members) {
      const r = await ctx.sql(
        `INSERT INTO project_members (tenant_id, project_id, user_id, role_code, granted_by, granted_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, user_id) DO NOTHING RETURNING id`,
        [tid, pid, users[m], m === "pm" ? "project_manager" : m === "hse" ? "hse_officer" : "member", ctx.adminUserId, cal.at(cal.addDays(spec.start, -5), 10)],
      );
      counts.members += r.length;
    }

    // ---- WBS ----
    const flatten = (nodes: any[], acc: Map<string, string>) => {
      for (const n of nodes) {
        acc.set(n.code, n.id);
        flatten(n.children ?? [], acc);
      }
      return acc;
    };
    let wbsId = flatten(await ctx.call("GET", `/project-delivery/projects/${pid}/wbs`), new Map());
    for (const [i, w] of spec.wbs.entries()) {
      if (wbsId.has(w.code)) continue;
      const created = await ctx.call("POST", `/project-delivery/projects/${pid}/wbs`, {
        parentId: w.parent ? wbsId.get(w.parent) : null,
        code: w.code,
        name: w.name,
        sortOrder: i,
      });
      wbsId.set(w.code, created.id);
      counts.wbs++;
    }
    await ctx.sql(`UPDATE project_wbs_nodes SET created_at=$2, updated_at=$2 WHERE project_id=$1 AND tenant_id=$3`, [pid, cal.at(cal.addDays(spec.start, -4), 11), tid]);

    // ---- activities ----
    const detail = await ctx.call("GET", `/project-delivery/projects/${pid}`);
    const actId = new Map<string, string>((detail.activities as any[]).map((a) => [a.title, a.id]));
    for (const a of spec.acts) {
      if (actId.has(a.title)) continue;
      const status = a.hold ? "on_hold" : statusOf(a.prog);
      const created = await ctx.call("POST", `/project-delivery/projects/${pid}/activities`, {
        title: a.title,
        description: a.description,
        activityTypeCode: a.type,
        picUserId: users[a.pic],
        plannedStartDate: a.plan[0],
        plannedEndDate: a.plan[1],
        actualStartDate: a.actualStart ?? null,
        actualEndDate: a.actualEnd ?? null,
        status,
        progressPercent: a.prog,
      });
      actId.set(a.title, created.id);
      counts.activities++;
    }
    // WBS assignment + backdate
    for (const a of spec.acts) {
      const id = actId.get(a.title)!;
      const node = wbsId.get(a.wbs)!;
      const cur = await ctx.sql<{ wbs_node_id: string | null }>(`SELECT wbs_node_id FROM project_delivery_activities WHERE id=$1`, [id]);
      if (cur[0]?.wbs_node_id !== node) await ctx.call("PUT", `/project-delivery/activities/${id}/wbs-node`, { wbsNodeId: node });
      const created = cal.at(cal.addDays(spec.start, -3 + rng.int(0, 2)), 11);
      const updatedDay = clamp(a.actualEnd ?? cal.addDays(today, -rng.int(0, 6)));
      await ctx.sql(`UPDATE project_delivery_activities SET created_at=$2, updated_at=$3 WHERE id=$1 AND tenant_id=$4`, [id, created, cal.at(updatedDay, 16), tid]);
    }

    // ---- dependencies ----
    const deps: any[] = await ctx.call("GET", `/project-delivery/projects/${pid}/dependencies`);
    const depKey = new Set(deps.map((d) => `${d.predecessorActivityId}>${d.successorActivityId}`));
    for (const [i, a] of spec.acts.entries()) {
      for (const p of a.after ?? []) {
        const pred = actId.get(spec.acts[p].title)!;
        const succ = actId.get(a.title)!;
        if (depKey.has(`${pred}>${succ}`)) continue;
        await ctx.call("POST", `/project-delivery/projects/${pid}/dependencies`, {
          predecessorActivityId: pred,
          successorActivityId: succ,
          dependencyType: "FS",
          lagDays: 0,
        });
        counts.deps++;
        void i;
      }
    }
    await ctx.sql(`UPDATE project_activity_dependencies SET created_at=$2 WHERE project_id=$1 AND tenant_id=$3`, [pid, cal.at(cal.addDays(spec.start, -2), 12), tid]).catch(() => {});

    // ---- resource assignments ----
    const asgCount = Number((await ctx.sql(`SELECT count(*)::int AS n FROM project_resource_assignments WHERE project_id=$1`, [pid]))[0].n);
    if (asgCount === 0) {
      for (const a of spec.acts) {
        if (!a.res) continue;
        const [rc, units] = a.res;
        await ctx.call("POST", `/project-delivery/projects/${pid}/resource-assignments`, {
          activityId: actId.get(a.title),
          resourceId: resId.get(rc),
          plannedUnits: String(units),
          startDate: a.actualStart ?? a.plan[0],
          endDate: a.actualEnd ?? a.plan[1],
        });
        counts.assigns++;
      }
      await ctx.sql(`UPDATE project_resource_assignments SET created_at=$2 WHERE project_id=$1 AND tenant_id=$3`, [pid, cal.at(cal.addDays(spec.start, -1), 12), tid]).catch(() => {});
    }

    // ---- milestones ----
    const ms: any[] = (await ctx.call("GET", `/project-delivery/projects/${pid}`)).milestones;
    const msId = new Map<string, any>(ms.map((m) => [m.title, m]));
    for (const m of spec.milestones) {
      let row = msId.get(m.title);
      if (!row) {
        row = await ctx.call("POST", `/project-delivery/projects/${pid}/milestones`, {
          title: m.title,
          milestoneTypeCode: m.type,
          plannedDate: m.planned,
          description: m.note && m.status === "pending" ? m.note : null,
        });
        counts.milestones++;
      }
      if (m.status !== "pending" && row.status !== m.status) {
        await ctx.call("PATCH", `/project-delivery/milestones/${row.id}`, { status: m.status, achievementNote: m.note ?? null });
      }
      const achievedAt = m.achievedOn ? cal.at(clamp(m.achievedOn), 14) : null;
      await ctx.sql(
        `UPDATE project_delivery_milestones SET created_at=$2, updated_at=$3, achieved_at=COALESCE($4::timestamptz, achieved_at) WHERE id=$1 AND tenant_id=$5`,
        [row.id, cal.at(cal.addDays(spec.start, -3), 11), achievedAt ?? cal.at(clamp(cal.addDays(today, -rng.int(1, 6))), 15), achievedAt, tid],
      );
    }

    // ---- baselines (BAC rewritten by SQL: API derives it from existing actuals) ----
    let baselines: any[] = await ctx.call("GET", `/project-delivery/projects/${pid}/baselines`);
    for (const b of spec.baselines) {
      let row = baselines.find((x) => x.name === b.name);
      if (!row) {
        row = await ctx.call("POST", `/project-delivery/projects/${pid}/baselines`, { name: b.name, notes: b.notes });
        await ctx.call("POST", `/project-delivery/baselines/${row.id}/approve`);
        counts.baselines++;
      }
      for (const a of spec.acts) {
        const id = actId.get(a.title)!;
        const plan = b.useOrig && a.origPlan ? a.origPlan : a.plan;
        await ctx.sql(
          `UPDATE project_baseline_lines SET planned_cost=$3, planned_start=$4, planned_finish=$5 WHERE baseline_id=$1 AND activity_id=$2 AND tenant_id=$6`,
          [row.id, id, money(a.budget), plan[0], plan[1], tid],
        );
      }
      await ctx.sql(
        `UPDATE project_baselines SET created_at=$2, updated_at=$3, approved_at=CASE WHEN status='approved' THEN $3::timestamptz ELSE approved_at END WHERE id=$1 AND tenant_id=$4`,
        [row.id, cal.at(cal.addDays(b.approvedOn, -3), 10), cal.at(b.approvedOn, 15), tid],
      );
      // superseded baselines keep their own approval time
      if (spec.baselines.length > 1 && b !== spec.baselines[spec.baselines.length - 1]) {
        await ctx.sql(`UPDATE project_baselines SET approved_at=$2 WHERE id=$1 AND tenant_id=$3`, [row.id, cal.at(b.approvedOn, 15), tid]);
      }
    }

    // ---- cost ledger ----
    const haveKeys = new Set((await ctx.sql<{ idempotency_key: string }>(`SELECT idempotency_key FROM project_cost_entries WHERE project_id=$1`, [pid])).map((r) => r.idempotency_key));
    const label: Record<string, string> = {
      SIPIL: "material dan upah borongan",
      MEP: "material MEP dan upah teknisi",
      PENGADAAN: "pembelian peralatan",
      DESAIN: "jasa konsultan desain",
      BANGUNAN: "material dan tenaga kerja konstruksi",
    };
    const addCost = async (key: string, actTitle: string | null, type: "actual" | "commitment" | "adjustment", amount: number, date: string, note: string) => {
      const k = `demo-prj:${spec.code}:${key}`;
      if (haveKeys.has(k)) return;
      await ctx.call("POST", `/project-delivery/projects/${pid}/cost-entries`, {
        activityId: actTitle ? actId.get(actTitle) : null,
        entryType: type,
        amount: money(amount),
        currency: "IDR",
        entryDate: date,
        sourceDocumentType: null,
        idempotencyKey: k,
        note,
      });
      haveKeys.add(k);
      counts.costs++;
    };
    for (const [ai, a] of spec.acts.entries()) {
      if (!a.actualStart || a.prog === 0) {
        // upcoming work with a near start has a purchase commitment already
        if (a.prog === 0 && a.plan[0] <= cal.addDays(today, 35) && a.budget >= 100_000_000) {
          await addCost(`${ai}:c`, a.title, "commitment", roundK(a.budget * 0.4), clamp(cal.addDays(today, -rng.int(2, 9))), `Komitmen PO/SPK awal untuk ${a.title.toLowerCase()}`);
        }
        continue;
      }
      const s = a.actualStart;
      const effEnd = a.actualEnd ?? cal.addDays(today, -2);
      const span = Math.max(1, dayNum(effEnd) - dayNum(s));
      const n = Math.min(4, Math.max(1, Math.ceil(span / 14)));
      const total = a.budget * (a.prog / 100) * spec.cpi * (0.97 + rng.next() * 0.06);
      const weights = Array.from({ length: n }, () => 0.7 + rng.next() * 0.6);
      const wsum = weights.reduce((x, y) => x + y, 0);
      for (let i = 0; i < n; i++) {
        const frac = (i + 1) / n;
        const date = clamp(cal.addDays(s, Math.round(span * frac) - (i === n - 1 && !a.actualEnd ? 0 : 0)));
        const amt = roundK((total * weights[i]) / wsum);
        const kind = label[a.type] ?? "biaya pelaksanaan";
        await addCost(`${ai}:${i + 1}`, a.title, "actual", amt, date, n === 1 ? `Pembayaran ${kind} - ${a.title}` : `Termin ${i + 1}/${n} ${kind} - ${a.title}`);
      }
      if (a.prog < 100 && a.budget >= 100_000_000) {
        await addCost(`${ai}:c`, a.title, "commitment", roundK(a.budget * (1 - a.prog / 100) * 0.5), clamp(cal.addDays(today, -rng.int(3, 12))), `Komitmen SPK sisa pekerjaan - ${a.title}`);
      }
    }
    if (spec.code === "PRJ-S02") {
      await addCost("vo1", spec.acts[1].title, "adjustment", 27_500_000, "2026-03-20", "Pekerjaan tambah (VO-01): perkuatan struktur mezanin atas temuan lapangan");
    }
    if (spec.code === "PRJ-S01") {
      await addCost("vo1", spec.acts[3].title, "adjustment", 18_000_000, "2026-01-14", "Biaya percepatan pengiriman panel listrik (air freight)");
    }
    if (spec.code === "PRJ-S03") {
      // duplicated payment recorded by mistake, then reversed
      await addCost("dup", spec.acts[2].title, "actual", 18_500_000, "2026-02-20", "Pembayaran uang muka vendor mesin (tercatat dua kali)");
      const dup = (await ctx.sql<{ id: string }>(`SELECT id FROM project_cost_entries WHERE project_id=$1 AND idempotency_key=$2`, [pid, `demo-prj:${spec.code}:dup`]))[0];
      const has = await ctx.sql(`SELECT 1 FROM project_cost_entries WHERE reverses_id=$1`, [dup.id]);
      if (has.length === 0) {
        const rev = await ctx.call("POST", `/project-delivery/cost-entries/${dup.id}/reverse`, { note: "Koreksi: duplikat pencatatan uang muka vendor mesin" });
        await ctx.sql(`UPDATE project_cost_entries SET entry_date='2026-02-23', created_at=$2 WHERE id=$1`, [rev.id, cal.at("2026-02-23", 10)]);
        counts.costs++;
      }
    }
    // backdate entries by entry date
    await ctx.sql(
      `UPDATE project_cost_entries SET created_at = entry_date::timestamp + interval '10 hours' - interval '7 hours'
        WHERE project_id=$1 AND tenant_id=$2`,
      [pid, tid],
    );

    // ---- earned-value snapshots (replay historical progress, then restore) ----
    const existingSnaps: any[] = await ctx.call("GET", `/project-delivery/projects/${pid}/earned-value-snapshots`);
    const haveSnap = new Set(existingSnaps.map((s) => String(s.asOfDate).slice(0, 10)));
    const dates: string[] = [];
    const startMonth = spec.start.slice(0, 7);
    for (const mk of cal.months) {
      if (mk < startMonth) continue;
      const [y, m] = mk.split("-").map(Number);
      const eom = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const d = eom >= today ? today : eom;
      if (d < cal.addDays(spec.start, 14)) continue;
      if (spec.finalStatus === "completed" && d > cal.addDays(endDate, 31)) continue;
      dates.push(d);
    }
    const missing = dates.filter((d) => !haveSnap.has(d));
    if (missing.length > 0) {
      const saved = await ctx.sql<{ id: string; status: string; progress_percent: number }>(
        `SELECT id, status, progress_percent FROM project_delivery_activities WHERE project_id=$1 AND tenant_id=$2`,
        [pid, tid],
      );
      try {
        for (const d of missing) {
          const isFinal = d === today;
          if (!isFinal) {
            for (const a of spec.acts) {
              const p = progressAt(a, d, today);
              await ctx.sql(`UPDATE project_delivery_activities SET progress_percent=$2, status=$3 WHERE id=$1`, [actId.get(a.title), p, statusOf(p)]);
            }
          } else {
            for (const sv of saved) await ctx.sql(`UPDATE project_delivery_activities SET progress_percent=$2, status=$3 WHERE id=$1`, [sv.id, sv.progress_percent, sv.status]);
          }
          const pm = progressAt(spec.acts[0], d, today);
          void pm;
          const snap = await ctx.call("POST", `/project-delivery/projects/${pid}/earned-value-snapshots`, {
            asOfDate: d,
            notes: isFinal ? "Laporan EV per tanggal terbaru" : `Laporan EV bulanan ${d.slice(0, 7)}`,
          });
          await ctx.sql(`UPDATE project_earned_value_snapshots SET created_at=$2 WHERE id=$1 AND tenant_id=$3`, [snap.id, cal.at(cal.addDays(d, d === today ? 0 : 1), 9), tid]);
          counts.snaps++;
        }
      } finally {
        for (const sv of saved) {
          await ctx.sql(`UPDATE project_delivery_activities SET progress_percent=$2, status=$3 WHERE id=$1`, [sv.id, sv.progress_percent, sv.status]);
        }
        // restore updated_at that the status rewrite did not touch (no trigger), nothing else to do
      }
    }
    ctx.log(S, `${spec.code} ${spec.name}: ok`);
  }

  const total = await ctx.sql(
    `SELECT (SELECT count(*) FROM projects WHERE tenant_id=$1 AND code LIKE 'PRJ-S%') AS projects,
            (SELECT count(*) FROM project_delivery_activities WHERE tenant_id=$1) AS activities,
            (SELECT count(*) FROM project_delivery_milestones WHERE tenant_id=$1) AS milestones,
            (SELECT count(*) FROM project_cost_entries WHERE tenant_id=$1) AS costs,
            (SELECT count(*) FROM project_earned_value_snapshots WHERE tenant_id=$1) AS snaps`,
    [tid],
  );
  ctx.log(S, `created this run ${JSON.stringify(counts)}; totals ${JSON.stringify(total[0])}`);
}
