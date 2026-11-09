/**
 * Sector "complaints-surveys": the customer-voice side of PT Sentra Layanan
 * Terpadu over twelve months.
 *
 *  A. service-quality set-up: SLA calendar / policy / rules, root-cause
 *     categories
 *  B. customer complaints driven through the real workflow (submit →
 *     acknowledge → assign → investigation → corrective action → verification
 *     → customer confirmation → closed), with a few rejected, cancelled,
 *     reopened and escalated (critical) cases, RCA findings and CAPA actions
 *  C. surveys & assessments: post-service CSAT, complaint-handling CSAT,
 *     quarterly customer NPS (public links), monthly kitchen hygiene audit and
 *     quarterly supplier rating, with scores trending up over the year
 *
 * Everything is created through the API as the people who do it; SQL only
 * moves the business timestamps to their historical dates.
 * Idempotent: complaints are found by description, surveys by code,
 * assignments by (survey, context / label).
 * Env CS_STEPS="sq,complaints,surveys" runs only some steps.
 */
import { makeRand, type DemoCtx } from "./harness.js";
import { USERS, activityFactor, customerByCode, periodCodeOf, SUPPLIERS, type CustomerSpec, type ServiceKey } from "./catalog.js";
import { HOLIDAYS, loadSites, type SiteInfo } from "./service-ops.js";
import { backdateTrail, renumberChronologically, userIdByEmail } from "./commercial.js";

const PASS = USERS.customerService.password;
const asCS = <T = any>(ctx: DemoCtx, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) =>
  ctx.callAs<T>(USERS.customerService.email, PASS, method, url, body);
const asMgr = <T = any>(ctx: DemoCtx, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) =>
  ctx.callAs<T>(USERS.complaintManager.email, PASS, method, url, body);

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MONTH_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const dateLabel = (d: string) => `${Number(d.slice(8))} ${MONTH_ID[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const addDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const isWorkday = (d: string) => dow(d) !== 0 && !HOLIDAYS.has(d);
const nextWorkday = (d: string) => {
  let x = d;
  while (!isWorkday(x)) x = addDays(x, 1);
  return x;
};
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Create-or-skip: a 409/duplicate response is a normal re-run. */
async function tolerant<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.status === 409 || /already exists|already/i.test(String(e?.message))) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// A. Service quality set-up
// ---------------------------------------------------------------------------

/** Business-time SLA (minutes). Wall-clock factor ~3 (11h windows, six days, holidays, weekends of customer sites). */
const SLA_MIN = {
  critical: { resp: 60, reso: 4320 },
  major: { resp: 240, reso: 7200 },
  minor: { resp: 480, reso: 10080 },
  billing: { resp: 480, reso: 7200 },
};

const RCA_CATEGORIES: { code: string; name: string; description: string }[] = [
  { code: "RC-DAPUR", name: "Proses Dapur dan Produksi", description: "Pengolahan, pematangan, porsi, dan pengemasan makanan" },
  { code: "RC-DISTRIBUSI", name: "Distribusi dan Logistik", description: "Keterlambatan kendaraan, rute, dan serah terima di lokasi pelanggan" },
  { code: "RC-SDM", name: "SDM dan Pelatihan", description: "Kehadiran, kompetensi, dan kedisiplinan petugas" },
  { code: "RC-PERALATAN", name: "Peralatan dan Fasilitas", description: "Kerusakan atau keterbatasan alat dan sarana kerja" },
  { code: "RC-PEMASOK", name: "Pemasok dan Bahan Baku", description: "Mutu dan ketepatan pengiriman bahan dari pemasok" },
  { code: "RC-ADMIN", name: "Administrasi dan Penagihan", description: "Berita acara, perhitungan porsi, dan penerbitan faktur" },
  { code: "RC-KOMUNIKASI", name: "Komunikasi dengan Pelanggan", description: "Informasi perubahan jadwal, menu, atau jumlah yang tidak sampai" },
];

async function stepServiceQuality(ctx: DemoCtx): Promise<void> {
  const cal =
    (await ctx.call<any[]>("GET", "/service-quality/calendars")).map((c) => c.calendar ?? c).find((c) => c.code === "CAL-OPS-6HARI") ??
    (await ctx.call<any>("POST", "/service-quality/calendars", {
      code: "CAL-OPS-6HARI",
      name: "Jam kerja operasional Senin-Sabtu",
      description: "Layanan pelanggan 07.00-19.00 WIB, Senin sampai Sabtu",
      timeZone: "Asia/Jakarta",
      isDefault: true,
      windows: [1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, startMinute: 420, endMinute: 1140 })),
    }));
  const calendarId = cal.id ?? cal.calendar?.id;
  const holidays = [...HOLIDAYS].filter((d) => d <= "2026-12-31").sort();
  const names: Record<string, string> = {
    "2025-12-25": "Hari Raya Natal", "2025-12-26": "Cuti Bersama Natal", "2026-01-01": "Tahun Baru Masehi", "2026-02-16": "Cuti Bersama Imlek",
    "2026-02-17": "Tahun Baru Imlek", "2026-03-18": "Cuti Bersama Idul Fitri", "2026-03-19": "Cuti Bersama Idul Fitri", "2026-03-20": "Idul Fitri 1447 H",
    "2026-03-21": "Idul Fitri 1447 H", "2026-03-23": "Cuti Bersama Idul Fitri", "2026-03-24": "Cuti Bersama Idul Fitri", "2026-04-03": "Wafat Isa Almasih",
    "2026-05-01": "Hari Buruh", "2026-05-14": "Kenaikan Isa Almasih", "2026-05-15": "Cuti Bersama", "2026-05-27": "Idul Adha 1447 H", "2026-05-28": "Cuti Bersama Idul Adha",
    "2026-06-01": "Hari Lahir Pancasila", "2026-06-16": "Tahun Baru Islam", "2026-08-17": "Hari Kemerdekaan RI", "2026-08-25": "Maulid Nabi Muhammad", "2026-12-25": "Hari Raya Natal",
  };
  let nh = 0;
  for (const d of holidays) {
    if (await tolerant(() => ctx.call("POST", `/service-quality/calendars/${calendarId}/holidays`, { holidayDate: d, name: names[d] ?? "Libur nasional" }))) nh++;
  }

  const pols = await ctx.call<any[]>("GET", "/service-quality/sla-policies");
  let policy = pols.map((p) => p.policy ?? p).find((p) => p.code === "SLA-STANDAR");
  if (!policy) {
    policy = await ctx.call<any>("POST", "/service-quality/sla-policies", {
      code: "SLA-STANDAR",
      name: "SLA Penanganan Keluhan Standar",
      description: "Waktu respon dan penyelesaian keluhan pelanggan menurut tingkat keparahan, dalam jam kerja operasional",
      calendarId,
    });
  }
  const policyId = policy.id ?? policy.policy?.id;
  const rules: [string, string | null, string | null, number, number, number][] = [
    ["R-CRITICAL", "critical", null, 60, SLA_MIN.critical.reso, 30],
    ["R-MAJOR", "major", null, 240, SLA_MIN.major.reso, 20],
    ["R-MINOR", "minor", null, 480, SLA_MIN.minor.reso, 10],
    ["R-BILLING", null, "billing", 480, SLA_MIN.billing.reso, 15],
  ];
  // the generous resolution windows replace the first draft of these rules
  for (const [code, , , , reso] of rules) await ctx.sql(`UPDATE service_sla_rules SET resolution_minutes = $2 WHERE code = $1 AND tenant_id = $3`, [code, reso, ctx.tenantId]).catch(() => undefined);
  let nr = 0;
  for (const [code, sev, cat, resp, reso, prio] of rules) {
    if (await tolerant(() => ctx.call("POST", "/service-quality/sla-rules", { policyId, code, severityCode: sev, categoryCode: cat, responseMinutes: resp, resolutionMinutes: reso, priority: prio }))) nr++;
  }

  let nc = 0;
  for (const c of RCA_CATEGORIES) {
    if (await tolerant(() => ctx.call("POST", "/service-quality/rca/categories", { code: c.code, name: c.name, description: c.description }))) nc++;
  }
  // RCA analysis methods are a tenant reference catalog with no API surface.
  for (const [i, [code, label]] of ([["five_whys", "5 Why"], ["fishbone", "Diagram Tulang Ikan (Fishbone)"], ["pareto", "Analisis Pareto"], ["fault_tree", "Fault Tree Analysis"]] as const).entries()) {
    await ctx.sql(
      `INSERT INTO tenant_reference_data_items (tenant_id, reference_data_type_id, code, label, sort_order, is_active, created_at, updated_at)
       SELECT $1, t.id, $2, $3, $4, true, $5::timestamptz, $5::timestamptz FROM reference_data_types t WHERE t.code = 'rca_analysis_method'
         AND NOT EXISTS (SELECT 1 FROM tenant_reference_data_items x WHERE x.tenant_id = $1 AND x.reference_data_type_id = t.id AND x.code = $2)`,
      [ctx.tenantId, code, label, (i + 1) * 10, ctx.cal.at(ctx.cal.start, 10)],
    );
  }
  ctx.log("complaints-surveys", `service quality set-up: ${nh} holidays, ${nr} SLA rules, ${nc} RCA categories created`);
}

// ---------------------------------------------------------------------------
// A2. Customer portal accounts (one per customer: the primary contact)
// ---------------------------------------------------------------------------

export function portalUser(c: CustomerSpec) {
  const contact = c.contacts.find((x) => x.primary) ?? c.contacts[0]!;
  return { email: contact.email, fullName: contact.name, password: PASS };
}

async function stepPortalUsers(ctx: DemoCtx): Promise<void> {
  const custRows = await ctx.sql<{ id: string; code: string; created_at: Date }>(`SELECT id, code, created_at FROM customers WHERE tenant_id = $1`, [ctx.tenantId]);
  const byCode = new Map(custRows.map((r) => [r.code, r]));
  let made = 0;
  for (const c of (await import("./catalog.js")).CUSTOMERS) {
    const cust = byCode.get(c.code);
    if (!cust) continue;
    const u = portalUser(c);
    const exists = await ctx.sql<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [ctx.tenantId, u.email]);
    if (exists[0]) continue;
    const row = await ctx.call<any>("POST", "/users", { email: u.email, fullName: u.fullName, password: u.password, roleCode: "CUSTOMER_USER", scopeType: "customer", scopeCustomerId: cust.id });
    const uid = row.id ?? row.user?.id;
    const at = new Date(cust.created_at.getTime() + 2 * DAY).toISOString();
    await ctx.sql(`UPDATE users SET created_at = $2, updated_at = $2 WHERE id = $1`, [uid, at]);
    await ctx.sql(`UPDATE user_role_assignments SET assigned_at = $2 WHERE user_id = $1`, [uid, at]).catch(() => undefined);
    made++;
  }
  ctx.log("complaints-surveys", `customer portal users: ${made} created`);
}

// ---------------------------------------------------------------------------
// B. Complaints
// ---------------------------------------------------------------------------

interface Tpl {
  cat: "service_quality" | "safety" | "billing" | "facility";
  sub: string;
  svc: ServiceKey | "ANY";
  sev: ("critical" | "major" | "minor")[]; // weighted by repetition
  channel: string[];
  text: (site: string, n: number) => string;
  root: string;
  corrective: string;
  preventive: string;
  rca: string;
}

const TEMPLATES: Tpl[] = [
  {
    cat: "service_quality", sub: "ketepatan_waktu", svc: "CATERING", sev: ["major", "minor", "minor"], channel: ["phone", "whatsapp"],
    text: (s, n) => `Pengiriman makan siang di ${s} tiba lewat dari jam makan (sekitar pukul 12.${30 + (n % 25)}). ${60 + (n % 7) * 15} karyawan shift pertama terlambat makan dan mengeluh ke HRD.`,
    root: "Kendaraan pengantar tertahan kemacetan dan antrean gerbang kawasan; slot berangkat dapur tidak memberi waktu cadangan.",
    corrective: "Jadwal berangkat dimajukan 30 menit dan satu kendaraan cadangan disiagakan di dapur sentral.",
    preventive: "Pemantauan rute harian oleh koordinator dan koordinasi izin masuk kendaraan dengan security kawasan.", rca: "RC-DISTRIBUSI",
  },
  {
    cat: "service_quality", sub: "kuantitas_porsi", svc: "CATERING", sev: ["minor", "major"], channel: ["phone", "email"],
    text: (s, n) => `Jumlah porsi yang diterima di ${s} kurang ${8 + (n % 14)} box dari pesanan harian sehingga sebagian karyawan tidak kebagian makan.`,
    root: "Penghitungan akhir porsi di area packing tidak dicocokkan dengan form pesanan terbaru dari pelanggan.",
    corrective: "Kekurangan diantar susulan dalam 45 menit dan selisih dikompensasi pada tagihan bulan berjalan.",
    preventive: "Checklist hitung ulang dua orang sebelum muat kendaraan dan rekonsiliasi pesanan jam 15.00 setiap hari.", rca: "RC-DAPUR",
  },
  {
    cat: "service_quality", sub: "kualitas_makanan", svc: "CATERING", sev: ["minor", "minor", "major"], channel: ["whatsapp", "portal", "phone"],
    text: (s, n) => `Karyawan di ${s} melaporkan ${["nasi terlalu lembek dan sudah dingin", "ayam goreng kurang matang di bagian dalam", "lauk terlalu asin dan sayur layu", "sambal basi dan berbau"][n % 4]} pada menu hari ini.`,
    root: "Waktu tunggu antara masak dan distribusi melebihi standar dan kontrol suhu serah terima tidak dicatat.",
    corrective: "Batch menu hari itu ditarik dan diganti, kepala regu dapur dibina ulang, sampel disimpan untuk uji organoleptik.",
    preventive: "Pencatatan suhu wajib di berita acara dan uji rasa oleh chef sebelum produksi dilepas ke distribusi.", rca: "RC-DAPUR",
  },
  {
    cat: "service_quality", sub: "kemasan", svc: "CATERING", sev: ["minor"], channel: ["phone", "email"],
    text: (s, n) => `Kemasan nasi box di ${s} bocor dan kuah merembes ke ${3 + (n % 8)} box lain, sebagian karyawan menolak menerima makanan.`,
    root: "Pemasok mengganti ukuran kotak tanpa pemberitahuan sehingga tutup tidak rapat; pengecekan bahan kemasan masuk tidak ketat.",
    corrective: "Kotak diganti dengan tipe sebelumnya dan seluruh stok kemasan dari pemasok diperiksa ulang.",
    preventive: "Inspeksi kemasan saat penerimaan barang dan klausul perubahan spesifikasi pada kontrak pemasok.", rca: "RC-PEMASOK",
  },
  {
    cat: "service_quality", sub: "menu", svc: "CATERING", sev: ["minor"], channel: ["email", "portal"],
    text: (s) => `Menu minggu ini di ${s} tidak sesuai rotasi yang disepakati; menu ayam muncul tiga kali berturut-turut dan karyawan merasa bosan.`,
    root: "Perubahan menu karena keterbatasan stok ikan tidak dikomunikasikan kepada PIC pelanggan.",
    corrective: "Menu dipulihkan sesuai rotasi bulan berjalan dan PIC pelanggan menerima konfirmasi tertulis.",
    preventive: "Perubahan menu wajib disetujui PIC pelanggan paling lambat H-1 melalui grup koordinasi.", rca: "RC-KOMUNIKASI",
  },
  {
    cat: "safety", sub: "benda_asing", svc: "CATERING", sev: ["critical", "major"], channel: ["phone", "phone", "email"],
    text: (s) => `Ditemukan benda asing (potongan plastik/rambut) di dalam makanan yang disajikan di ${s}. Karyawan mengunggah foto ke grup internal pelanggan dan HSE pelanggan meminta klarifikasi tertulis.`,
    root: "Penutup rambut tidak dipakai penuh oleh petugas packing dan saringan bahan tidak diperiksa setelah pergantian shift.",
    corrective: "Seluruh batch hari itu ditahan, permintaan maaf resmi disampaikan, audit higiene dapur dilakukan dalam 24 jam.",
    preventive: "Pemeriksaan APD sebelum shift, metal/foreign object check pada lini packing, dan pelatihan higiene ulang.", rca: "RC-SDM",
  },
  {
    cat: "safety", sub: "keamanan_pangan", svc: "CATERING", sev: ["critical"], channel: ["phone"],
    text: (s, n) => `Sebanyak ${5 + (n % 9)} karyawan di ${s} mengalami mual dan diare beberapa jam setelah makan siang. Klinik perusahaan pelanggan meminta data bahan baku dan sampel makanan.`,
    root: "Hasil uji lab sampel menunjukkan kontaminasi pada lauk santan yang disimpan melewati batas waktu simpan pada suhu ruang.",
    corrective: "Menu santan dihentikan sementara, seluruh karyawan terdampak ditanggung biaya berobatnya, laporan investigasi dikirim ke pelanggan.",
    preventive: "Batas waktu simpan lauk berkuah ditetapkan 4 jam, chiller ditambah, dan audit mutu pihak ketiga setiap kuartal.", rca: "RC-DAPUR",
  },
  {
    cat: "safety", sub: "apd_petugas", svc: "ANY", sev: ["minor", "major"], channel: ["email", "visit"],
    text: (s) => `Auditor K3 pelanggan menemukan petugas kami di ${s} bekerja tanpa APD lengkap (sarung tangan dan sepatu safety) saat inspeksi mendadak.`,
    root: "Distribusi APD ke petugas baru terlambat dan pengawas lapangan belum rutin melakukan pengecekan.",
    corrective: "APD dilengkapi hari itu juga dan petugas yang bersangkutan mengikuti induksi ulang K3.",
    preventive: "Checklist APD harian oleh pengawas dan stok APD cadangan di setiap lokasi.", rca: "RC-SDM",
  },
  {
    cat: "service_quality", sub: "kebersihan", svc: "HOUSEKEEPING", sev: ["minor", "major"], channel: ["phone", "whatsapp", "portal"],
    text: (s, n) => `Toilet lantai ${2 + (n % 5)} di ${s} kotor dan perlengkapan (sabun dan tisu) habis sejak pagi; beberapa penghuni gedung menyampaikan keluhan ke pengelola.`,
    root: "Satu petugas tidak masuk tanpa pengganti dan pengisian ulang perlengkapan tidak masuk checklist shift siang.",
    corrective: "Area dibersihkan segera, petugas pengganti disiagakan, perlengkapan diisi penuh dan dicek setiap 2 jam.",
    preventive: "Roster dengan petugas cadangan (floater) dan checklist pengisian ulang ditandatangani PIC gedung.", rca: "RC-SDM",
  },
  {
    cat: "service_quality", sub: "kehadiran_petugas", svc: "HOUSEKEEPING", sev: ["major", "minor"], channel: ["phone", "email"],
    text: (s, n) => `Jumlah petugas kebersihan yang hadir di ${s} hanya ${n % 3 + 4} dari ${n % 3 + 8} orang sesuai kontrak selama dua hari berturut-turut.`,
    root: "Lonjakan cuti dan izin sakit bersamaan di satu regu tanpa rencana pengganti.",
    corrective: "Petugas tambahan dari regu lain ditempatkan dan rekapitulasi kehadiran dikirim ke pelanggan.",
    preventive: "Kuota cuti per regu dibatasi dan daftar petugas cadangan disiapkan di setiap lokasi.", rca: "RC-SDM",
  },
  {
    cat: "facility", sub: "ac_pendingin", svc: "FACILITY", sev: ["minor", "major"], channel: ["phone", "portal", "whatsapp"],
    text: (s, n) => `AC di ruang ${["meeting lantai 3", "server", "kerja utama", "lobi"][n % 4]} ${s} tidak dingin dan menetes air sejak dua hari lalu; teknisi pelanggan sudah mengecek tetapi belum teratasi.`,
    root: "Filter dan evaporator tersumbat karena jadwal pembersihan berkala bergeser dan freon berkurang.",
    corrective: "Unit dicuci, freon diisi ulang, saluran drain dibersihkan, dan hasil diuji di hadapan PIC pelanggan.",
    preventive: "Jadwal perawatan AC triwulan dikunci dalam kalender preventive maintenance dengan pengingat.", rca: "RC-PERALATAN",
  },
  {
    cat: "facility", sub: "listrik", svc: "FACILITY", sev: ["major", "critical"], channel: ["phone"],
    text: (s) => `Terjadi pemadaman di area ${s} karena panel listrik trip berulang pada jam kerja dan genset tidak otomatis menyala (ATS gagal).`,
    root: "Baterai kontrol ATS lemah dan kabel panel longgar akibat getaran, tidak terdeteksi pada inspeksi bulan lalu.",
    corrective: "Baterai dan terminal kabel diganti, uji genset dengan beban penuh dilakukan dan disaksikan pelanggan.",
    preventive: "Uji ATS mingguan dengan lembar catatan dan thermografi panel setiap semester.", rca: "RC-PERALATAN",
  },
  {
    cat: "facility", sub: "atap_bocor", svc: "ANY", sev: ["minor", "major"], channel: ["email", "visit"],
    text: (s) => `Atap area ${s} bocor saat hujan deras dan air membasahi lantai kerja; pelanggan khawatir terhadap keselamatan dan peralatan.`,
    root: "Sambungan talang tersumbat daun dan sealant atap menua; pengecekan musim hujan belum dilakukan.",
    corrective: "Talang dibersihkan, titik bocor ditambal, dan lantai dikeringkan serta diberi tanda peringatan.",
    preventive: "Inspeksi atap dan talang sebelum musim hujan setiap Oktober.", rca: "RC-PERALATAN",
  },
  {
    cat: "billing", sub: "selisih_porsi", svc: "ANY", sev: ["minor", "minor", "major"], channel: ["email", "email", "portal"],
    text: (s, n) => `Faktur bulan lalu untuk ${s} mencantumkan ${150 + (n % 9) * 40} porsi lebih banyak daripada rekap berita acara harian versi pelanggan. Bagian keuangan pelanggan menahan pembayaran.`,
    root: "Rekap berita acara dibuat dari data produksi, bukan dari porsi yang diterima dan ditandatangani pelanggan.",
    corrective: "Faktur dikoreksi melalui nota kredit setelah rekonsiliasi bersama dan faktur pengganti diterbitkan.",
    preventive: "Faktur disusun dari berita acara yang ditandatangani pelanggan, dengan rekonsiliasi mingguan.", rca: "RC-ADMIN",
  },
  {
    cat: "billing", sub: "faktur_pajak", svc: "ANY", sev: ["minor"], channel: ["email"],
    text: (s) => `Faktur pajak untuk ${s} terlambat dua minggu dan NPWP penerima tertulis dengan format lama sehingga tidak dapat dikreditkan oleh pelanggan.`,
    root: "Data master pelanggan belum diperbarui setelah perubahan identitas pajak dan antrean penerbitan faktur pajak menumpuk.",
    corrective: "Faktur pajak pengganti diterbitkan dengan data benar dan master pelanggan diperbarui.",
    preventive: "Validasi NPWP saat setup pelanggan dan jadwal penerbitan faktur pajak maksimal H+3 dari faktur.", rca: "RC-ADMIN",
  },
  {
    cat: "billing", sub: "tagihan_ganda", svc: "ANY", sev: ["major"], channel: ["email", "phone"],
    text: (s) => `Pelanggan menerima dua faktur dengan nomor berbeda untuk layanan yang sama di ${s} dan menanyakan mana yang harus dibayar.`,
    root: "Faktur dibuat ulang setelah koreksi berita acara tanpa membatalkan faktur awal.",
    corrective: "Faktur ganda dibatalkan, surat klarifikasi dikirim, dan saldo piutang pelanggan direkonsiliasi.",
    preventive: "Pembatalan faktur lama menjadi langkah wajib sebelum penerbitan faktur pengganti.", rca: "RC-ADMIN",
  },
  {
    cat: "service_quality", sub: "camp", svc: "CAMP", sev: ["minor", "major"], channel: ["phone", "whatsapp"],
    text: (s, n) => `Penghuni ${s} melaporkan laundry hilang/tertukar (${3 + (n % 6)} pekerja) dan air bersih kamar mandi mati selama setengah hari.`,
    root: "Penandaan laundry per kamar tidak konsisten dan pompa air tidak punya cadangan saat motor terbakar.",
    corrective: "Pakaian ditemukan dan dikembalikan, pompa cadangan dipasang, kompensasi laundry diberikan.",
    preventive: "Penomoran laundry dengan label tahan air dan pompa cadangan terpasang permanen.", rca: "RC-PERALATAN",
  },
];

const SPECIAL_REJECT_REASONS = [
  "Keluhan terkait menu di luar lingkup kontrak (permintaan menu khusus VIP); sudah dijelaskan kepada pelanggan dan ditawarkan penawaran terpisah.",
  "Keluhan duplikat dari tiket yang sudah ditangani; digabung ke tiket sebelumnya.",
  "Setelah dicek di lokasi, kejadian bukan pada layanan kami (area dikelola pihak ketiga); informasi diteruskan ke pelanggan.",
  "Laporan tidak dapat diverifikasi dan pelapor tidak menyediakan bukti atau waktu kejadian.",
];

const REOPEN_REASONS = [
  "Pelanggan melaporkan masalah yang sama terulang dua minggu setelah penutupan; perlu investigasi ulang akar masalah.",
  "Tindakan perbaikan dinilai belum efektif oleh PIC pelanggan; hasil verifikasi lapangan tidak sesuai.",
  "Bukti baru dari pelanggan menunjukkan kejadian serupa di shift berbeda.",
];

interface ComplaintSpec {
  key: string;
  description: string;
  tpl: Tpl;
  customer: CustomerSpec;
  site: SiteInfo;
  severity: "critical" | "major" | "minor";
  priority: string;
  channel: string;
  createdDate: string;
  hour: number;
  outcome: "closed" | "rejected" | "cancelled" | "reopened_closed" | "reopened_open";
  slow: number;
  rejectReason?: string;
  reopenReason?: string;
  executorName: string;
  /** who files the ticket: the customer via portal/e-mail, or the ops manager on behalf (phone / WhatsApp / visit) */
  filer: "customer" | "manager";
  /** stop after performing this many workflow actions (recent tickets still in the queue) */
  hold?: number;
}

function planComplaints(ctx: DemoCtx, sites: SiteInfo[]): ComplaintSpec[] {
  const monthCounts: Record<string, number> = {
    "2025-11": 2, "2025-12": 3, "2026-01": 3, "2026-02": 4, "2026-03": 7, "2026-04": 4, "2026-05": 5,
    "2026-06": 5, "2026-07": 6, "2026-08": 6, "2026-09": 7, "2026-10": 7, "2026-11": 5,
  };
  const out: ComplaintSpec[] = [];
  const rnd = makeRand(77031);
  let criticalSeeded = 0;
  for (const m of ctx.cal.months) {
    const n = monthCounts[m] ?? 4;
    const active = sites.filter((s) => s.start <= `${m}-28`);
    for (let i = 0; i < n; i++) {
      const site = rnd.pick(active.filter((s) => s.start < ctx.cal.addDays(`${m}-01`, 20)).length ? active.filter((s) => s.start < ctx.cal.addDays(`${m}-01`, 20)) : active);
      const customer = site.customer;
      const candidates = TEMPLATES.filter((t) => t.svc === "ANY" || customer.services.includes(t.svc));
      // ensure the two serious food-safety stories happen at catering sites
      let tpl = rnd.pick(candidates);
      if (m === "2026-03" && i === 1 && customer.services.includes("CATERING")) tpl = TEMPLATES.find((t) => t.sub === "keamanan_pangan")!;
      if (m === "2026-07" && i === 0 && customer.services.includes("CATERING")) tpl = TEMPLATES.find((t) => t.sub === "benda_asing")!;
      let severity = rnd.pick(tpl.sev);
      if (severity === "critical") {
        if (criticalSeeded >= 4) severity = "major";
        else criticalSeeded++;
      }
      // day inside the month, never in the future, never Sunday
      let day = rnd.int(1, 28);
      let d = ctx.cal.day(m, day);
      let guard = 0;
      while ((dow(d) === 0 || HOLIDAYS.has(d)) && guard++ < 8) d = ctx.cal.day(m, ++day);
      if (d < site.start) d = nextWorkday(site.start);
      if (d > ctx.cal.today) d = ctx.cal.today;
      const nTag = hash(`${site.code}|${d}|${tpl.sub}`) % 100;
      const description = `Kejadian ${dateLabel(d)}. ${tpl.text(site.name, nTag)} (${customer.name})`;
      out.push({
        key: `${d}|${site.code}|${tpl.sub}`,
        description,
        tpl,
        customer,
        site,
        severity,
        priority: severity === "critical" ? "critical" : severity === "major" ? "high" : rnd.chance(0.3) ? "medium" : "low",
        channel: rnd.pick(tpl.channel),
        createdDate: d,
        hour: rnd.int(8, 16),
        outcome: "closed",
        slow: 0.5 + rnd.next() * 1.0,
        executorName: "",
        filer: "manager",
      });
    }
  }
  out.sort((a, b) => (a.createdDate + a.key < b.createdDate + b.key ? -1 : 1));
  // outcomes
  const old = out.filter((c) => c.createdDate <= ctx.cal.addDays(ctx.cal.today, -35));
  const pick = (arr: ComplaintSpec[], idx: number) => arr[idx % arr.length]!;
  let r = 0;
  for (const idx of [3, 14, 27, 39]) {
    const c = pick(old, idx);
    c.outcome = "rejected";
    c.rejectReason = SPECIAL_REJECT_REASONS[r++ % SPECIAL_REJECT_REASONS.length];
  }
  for (const idx of [9, 33]) pick(old, idx).outcome = "cancelled";
  r = 0;
  for (const idx of [6, 18, 30]) {
    const c = pick(old, idx);
    if (c.outcome === "closed") {
      c.outcome = "reopened_closed";
      c.reopenReason = REOPEN_REASONS[r++ % REOPEN_REASONS.length];
    }
  }
  const recent = out.filter((c) => c.createdDate >= ctx.cal.addDays(ctx.cal.today, -60) && c.createdDate <= ctx.cal.addDays(ctx.cal.today, -30) && c.outcome === "closed");
  if (recent[2]) {
    recent[2].outcome = "reopened_open";
    recent[2].reopenReason = REOPEN_REASONS[1];
  }
  // a couple of long-running investigations right now
  for (const c of out.filter((x) => x.createdDate >= ctx.cal.addDays(ctx.cal.today, -20))) c.slow = Math.max(c.slow, 1.1);
  const execNames = ["Citra Dewi", "Citra Dewi"];
  out.forEach((c, i) => {
    c.executorName = execNames[i % execNames.length]!;
    c.filer = ["portal", "email"].includes(c.channel) ? "customer" : "manager";
  });
  return out;
}

/** Tickets still moving through the queue today, one per workflow step. */
function planPipeline(ctx: DemoCtx, sites: SiteInfo[]): ComplaintSpec[] {
  const rnd = makeRand(550123);
  const slots: [number, number, string][] = [
    // [days ago, actions performed, template sub]
    [1, 1, "ketepatan_waktu"], [1, 2, "kualitas_makanan"], [2, 3, "kebersihan"], [3, 4, "ac_pendingin"], [4, 4, "kuantitas_porsi"],
    [6, 5, "selisih_porsi"], [7, 5, "kehadiran_petugas"], [9, 6, "kualitas_makanan"], [12, 7, "kemasan"], [14, 7, "listrik"],
    [8, 3, "benda_asing"], [16, 6, "apd_petugas"], [18, 8, "ketepatan_waktu"],
  ];
  const out: ComplaintSpec[] = [];
  for (const [ago, hold, sub] of slots) {
    const tpl = TEMPLATES.find((t) => t.sub === sub)!;
    const cands = sites.filter((s) => (tpl.svc === "ANY" || s.customer.services.includes(tpl.svc)) && s.start < ctx.cal.addDays(ctx.cal.today, -40));
    const site = rnd.pick(cands);
    let d = ctx.cal.addDays(ctx.cal.today, -ago);
    while (dow(d) === 0 || HOLIDAYS.has(d)) d = ctx.cal.addDays(d, -1);
    const severity = tpl.sev.includes("critical") && sub === "benda_asing" ? "critical" : rnd.pick(tpl.sev.filter((x) => x !== "critical").length ? tpl.sev.filter((x) => x !== "critical") : tpl.sev);
    const nTag = hash(`${site.code}|${d}|${tpl.sub}`) % 100;
    const channel = rnd.pick(tpl.channel);
    out.push({
      key: `${d}|${site.code}|${tpl.sub}`,
      description: `Kejadian ${dateLabel(d)}. ${tpl.text(site.name, nTag)} (${site.customer.name})`,
      tpl, customer: site.customer, site, severity,
      priority: severity === "critical" ? "critical" : severity === "major" ? "high" : "medium",
      channel, createdDate: d, hour: rnd.int(8, 15), outcome: "closed", slow: 1, executorName: "Citra Dewi",
      filer: ["portal", "email"].includes(channel) ? "customer" : "manager", hold,
    });
  }
  return out;
}

const ACTIONS = ["submit", "acknowledge", "assign", "start_investigation", "submit_corrective_action", "submit_for_verification", "verify", "confirm"] as const;

interface ComplaintTimeline {
  create: number;
  /** time of each workflow action (index = ACTIONS) */
  at: number[];
  rejectAt?: number;
  cancelAt?: number;
  reopenAt?: number;
  /** second pass after reopen: times for ACTIONS[4..7] */
  at2?: number[];
  investigationAt: number;
  closedAt?: number;
}

function buildComplaintTimeline(ctx: DemoCtx, c: ComplaintSpec): ComplaintTimeline {
  const r = makeRand(hash(c.key + "|tl"));
  const t0 = new Date(ctx.cal.at(c.createdDate, c.hour, r.int(0, 50))).getTime();
  const crit = c.severity === "critical";
  const major = c.severity === "major";
  const f = c.slow;
  const at: number[] = [];
  let t = t0;
  const step = (minMs: number, maxMs: number) => {
    t += Math.round((minMs + r.next() * (maxMs - minMs)) * f);
    // keep inside rough working hours
    const h = new Date(t + 7 * HOUR).getUTCHours();
    if (h >= 20) t += (11 + r.int(0, 2)) * HOUR;
    else if (h < 6) t += (6 - h + r.int(0, 2)) * HOUR;
    return t;
  };
  at.push(step(8 * 60_000, 40 * 60_000)); // submit
  at.push(step(crit ? 10 * 60_000 : 40 * 60_000, crit ? HOUR : major ? 3 * HOUR : 6 * HOUR)); // acknowledge
  at.push(step(30 * 60_000, crit ? 2 * HOUR : 7 * HOUR)); // assign
  at.push(step(HOUR, crit ? 6 * HOUR : 20 * HOUR)); // start investigation
  const investigationAt = step(6 * HOUR, 20 * HOUR);
  at.push(step(crit ? 0.5 * DAY : DAY, crit ? 2 * DAY : major ? 4 * DAY : 5 * DAY)); // corrective action submitted
  at.push(step(0.5 * DAY, 3 * DAY)); // for verification
  at.push(step(0.3 * DAY, 2 * DAY)); // verify (manager)
  at.push(step(0.5 * DAY, 5 * DAY)); // customer confirmation
  const tl: ComplaintTimeline = { create: t0, at, investigationAt };
  if (c.outcome === "rejected") tl.rejectAt = at[1]!;
  if (c.outcome === "cancelled") tl.cancelAt = t0 + Math.round((20 + r.next() * 100) * 60_000);
  if (c.outcome === "reopened_closed" || c.outcome === "reopened_open") {
    tl.reopenAt = at[7]! + Math.round((3 + r.next() * 9) * DAY);
    const at2: number[] = [];
    let u = tl.reopenAt + Math.round((1 + r.next() * 5) * HOUR);
    for (const [lo, hi] of [[1, 3], [0.5, 2.5], [0.3, 1.5], [0.5, 3]] as const) {
      u += Math.round((lo + r.next() * (hi - lo)) * DAY);
      const h = new Date(u + 7 * HOUR).getUTCHours();
      if (h >= 20) u += 12 * HOUR;
      at2.push(u);
    }
    tl.at2 = at2;
  }
  tl.closedAt = tl.at2 ? tl.at2[3] : at[7];
  return tl;
}

type Who = <T = any>(ctx: DemoCtx, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) => Promise<T>;
const asFiler = (c: ComplaintSpec): Who => {
  if (c.filer === "customer") {
    const u = portalUser(c.customer);
    return (ctx, method, url, body) => ctx.callAs(u.email, u.password, method, url, body);
  }
  return (ctx, method, url, body) => ctx.callAs(USERS.manager.email, USERS.manager.password, method, url, body);
};
const stepActor = (c: ComplaintSpec, action: (typeof ACTIONS)[number]): Who =>
  action === "verify" || (action === "start_investigation" && c.severity === "critical")
    ? asMgr
    : action === "submit" || action === "confirm"
      ? asFiler(c)
      : asCS;

async function stepComplaints(ctx: DemoCtx): Promise<void> {
  const sites = await loadSites(ctx);
  const specs = [...planComplaints(ctx, sites), ...planPipeline(ctx, sites)];
  const limit = process.env.CS_LIMIT ? Number(process.env.CS_LIMIT) : Infinity;
  const now = Math.min(Date.now(), new Date(ctx.cal.at(ctx.cal.today, 17)).getTime());
  const csId = await userIdByEmail(ctx, USERS.customerService.email);
  const mgrId = await userIdByEmail(ctx, USERS.complaintManager.email);
  const custIds = new Map((await ctx.sql<{ code: string; id: string }>(`SELECT code, id FROM customers WHERE tenant_id = $1`, [ctx.tenantId])).map((r) => [r.code, r.id]));
  const contractIds = new Map((await ctx.sql<{ customer_id: string; id: string }>(`SELECT customer_id, id FROM contracts WHERE tenant_id = $1 ORDER BY created_at`, [ctx.tenantId])).map((r) => [r.customer_id, r.id]));
  const contacts = new Map((await ctx.sql<{ customer_id: string; id: string }>(`SELECT DISTINCT ON (customer_id) customer_id, id FROM customer_contacts WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY customer_id, is_primary DESC, created_at`, [ctx.tenantId])).map((r) => [r.customer_id, r.id]));
  const serviceIds = new Map((await ctx.sql<{ code: string; id: string }>(`SELECT code, id FROM services WHERE tenant_id = $1`, [ctx.tenantId])).map((r) => [r.code, r.id]));
  const svcCode: Record<ServiceKey, string> = { CATERING: "SVC-CATERING", HOUSEKEEPING: "SVC-HOUSEKEEPING", FACILITY: "SVC-FACILITY", CAMP: "SVC-CAMP", PESTCTRL: "SVC-PESTCTRL" };
  const rcaCat = new Map((await ctx.call<any[]>("GET", "/service-quality/rca/categories")).map((c) => [c.code as string, c.id as string]));
  const have = new Map((await ctx.sql<{ description: string; id: string }>(`SELECT description, id FROM complaints WHERE tenant_id = $1`, [ctx.tenantId])).map((r) => [r.description, r.id]));
  const stats = { created: 0, byStatus: {} as Record<string, number>, rca: 0, capa: 0 };

  for (const c of specs.slice(0, limit)) {
    const tl = buildComplaintTimeline(ctx, c);
    let id = have.get(c.description);
    let touched = false;
    const audit: number[] = []; // intended times for the complaint's audit rows, in execution order
    const events: number[] = []; // ... and its domain events
    const wfTimes: number[] = []; // ... and the workflow's own rows (actions only)

    const customerId = custIds.get(c.customer.code)!;
    const svcPrimary: ServiceKey = (c.tpl.svc === "ANY" ? c.customer.services[0]! : c.tpl.svc) as ServiceKey;

    if (!id) {
      const row = await asFiler(c)<any>(ctx, "POST", "/complaints", {
        customerId,
        customerContactId: contacts.get(customerId) ?? null,
        contractId: contractIds.get(customerId) ?? null,
        siteId: c.site.id,
        serviceId: serviceIds.get(svcCode[svcPrimary]) ?? null,
        category: c.tpl.cat,
        subcategory: c.tpl.sub,
        description: c.description,
        priority: c.priority,
        severity: c.severity,
        source: "customer",
        channel: c.channel,
      });
      id = row.id as string;
      have.set(c.description, id);
      stats.created++;
      touched = true;
    }
    audit.push(tl.create);
    events.push(tl.create);

    // ---- drive the workflow -------------------------------------------------
    const stepCode = async () =>
      (await ctx.sql<{ code: string; status: string; created: Date }>(
        `SELECT s.code, wi.status, cp.created_at AS created FROM complaints cp JOIN workflow_instances wi ON wi.id = cp.workflow_instance_id
           JOIN workflow_steps s ON s.id = wi.current_step_id WHERE cp.id = $1`,
        [id],
      ))[0]!;
    const act = async (action: string, who: Who, at: number, comment: string) => {
      await who(ctx, "POST", `/complaints/${id}/actions/${action}`, { comment });
      audit.push(at);
      events.push(at);
      wfTimes.push(at);
      touched = true;
    };
    const PLAN_STEP: Record<string, string> = {
      DRAFT: "submit", SUBMITTED: "acknowledge", ACKNOWLEDGED: "assign", ASSIGNED: "start_investigation",
      IN_INVESTIGATION: "submit_corrective_action", CORRECTIVE_ACTION: "submit_for_verification", VERIFICATION: "verify", CUSTOMER_CONFIRMATION: "confirm",
    };
    const comment: Record<string, string> = {
      submit: "Keluhan diterima dan dicatat oleh layanan pelanggan",
      acknowledge: "Keluhan diakui, pelanggan dihubungi untuk konfirmasi kronologi",
      assign: "Ditugaskan ke penanggung jawab operasional lokasi",
      start_investigation: "Investigasi dimulai, data dan bukti dikumpulkan",
      submit_corrective_action: "Akar masalah dan tindakan perbaikan sudah ditetapkan",
      submit_for_verification: "Tindakan perbaikan selesai dilaksanakan, diajukan untuk verifikasi",
      verify: "Verifikasi lapangan sesuai: tindakan efektif",
      confirm: "Pelanggan mengonfirmasi masalah telah selesai",
    };

    // current progress from the workflow itself (resumable)
    let cur = await stepCode();
    const history = async () =>
      (await ctx.sql<{ n: string }>(`SELECT count(*)::text n FROM workflow_history h JOIN complaints cp ON cp.workflow_instance_id = h.workflow_instance_id WHERE cp.id = $1 AND h.action_code IS NOT NULL`, [id]))[0]!.n;
    const resumed = Number(await history()) > 0 && !touched;
    const target = (a: number | undefined) => a !== undefined && a <= now;

    const runInvestigation = async (at: number) => {
      await asCS(ctx, "POST", `/complaints/${id}/investigation`, {
        rootCause: c.tpl.root,
        correctiveAction: c.tpl.corrective,
        preventiveAction: c.tpl.preventive,
        correctiveActionOwnerUserId: csId,
        correctiveActionTargetDate: new Date(at + 7 * DAY).toISOString().slice(0, 10),
      });
      audit.push(at);
      touched = true;
    };

    if (cur.code === "DRAFT" && c.outcome === "cancelled") {
      if (target(tl.cancelAt)) await act("cancel", asFiler(c), tl.cancelAt!, "Dibatalkan oleh pembuat: kejadian ternyata sudah tercatat pada tiket lain");
    } else {
      for (let k = 0; k < ACTIONS.length; k++) {
        cur = await stepCode();
        if (cur.status !== "in_progress") break;
        const action = PLAN_STEP[cur.code];
        if (!action) break;
        const when = tl.at[ACTIONS.indexOf(action as any)]!;
        if (when > now) break;
        if (c.hold !== undefined && ACTIONS.indexOf(action as any) >= c.hold) break;
        if (c.outcome === "rejected" && action === "acknowledge") {
          await act("reject", asCS, tl.rejectAt!, c.rejectReason!);
          break;
        }
        if (action === "submit_corrective_action") await runInvestigation(tl.investigationAt);
        if (action === "verify") {
          await asMgr(ctx, "POST", `/complaints/${id}/verification`, { note: "Hasil investigasi dan bukti perbaikan diperiksa; tindakan dinilai memadai dan efektif." });
          audit.push(when - 20 * 60_000);
        }
        if (action === "confirm") {
          await asFiler(c)(ctx, "POST", `/complaints/${id}/customer-confirmation`, { note: "PIC pelanggan menyatakan puas dengan penyelesaian dan menyetujui penutupan tiket." });
          audit.push(when - 10 * 60_000);
        }
        await act(action, stepActor(c, action as any), when, comment[action]!);
      }
      // reopen and run the second pass
      cur = await stepCode();
      if (cur.status !== "in_progress" && cur.code === "CLOSED" && tl.reopenAt && target(tl.reopenAt)) {
        await asFiler(c)(ctx, "POST", `/complaints/${id}/reopen`, { toStepCode: "IN_INVESTIGATION", comment: c.reopenReason });
        audit.push(tl.reopenAt);
        events.push(tl.reopenAt);
        wfTimes.push(tl.reopenAt);
        touched = true;
        cur = await stepCode();
      }
      if (tl.at2 && (await history()) !== "0") {
        for (let k = 0; k < 4; k++) {
          cur = await stepCode();
          if (cur.status !== "in_progress") break;
          const action = PLAN_STEP[cur.code];
          if (!action || !["submit_corrective_action", "submit_for_verification", "verify", "confirm"].includes(action)) break;
          const when = tl.at2[["submit_corrective_action", "submit_for_verification", "verify", "confirm"].indexOf(action)]!;
          if (when > now) break;
          if (action === "submit_corrective_action") await runInvestigation(tl.reopenAt! + 2 * HOUR);
          if (action === "verify") {
            await asMgr(ctx, "POST", `/complaints/${id}/verification`, { note: "Verifikasi ulang: akar masalah kedua sudah ditangani dan bukti perbaikan diterima." });
            audit.push(when - 20 * 60_000);
          }
          if (action === "confirm") {
            await asFiler(c)(ctx, "POST", `/complaints/${id}/customer-confirmation`, { note: "PIC pelanggan mengonfirmasi perbaikan kedua berhasil." });
            audit.push(when - 10 * 60_000);
          }
          await act(action, stepActor(c, action as any), when, comment[action]!);
        }
      }
    }
    void resumed;

    cur = await stepCode();
    stats.byStatus[`${cur.code}`] = (stats.byStatus[`${cur.code}`] ?? 0) + 1;
    if (Math.abs(new Date(cur.created).getTime() - tl.create) > 2000) touched = true;
    if (process.env.CS_REBACKDATE === "1") touched = true;
    if (!touched) continue;

    await backdateComplaint(ctx, id!, c, tl, cur.code, audit, events, wfTimes, csId, mgrId, rcaCat, stats);
    if (stats.created > 0 && stats.created % 10 === 0) ctx.log("complaints-surveys", `complaints processed: ${stats.created} (${c.createdDate})`);
  }

  await renumberChronologically(ctx, "complaints", "complaint_number", "CMP", "created_at");
  ctx.log("complaints-surveys", `complaints: ${stats.created} created; end states ${JSON.stringify(stats.byStatus)}; RCA findings ${stats.rca}, CAPA actions ${stats.capa}`);
}

async function backdateComplaint(
  ctx: DemoCtx,
  id: string,
  c: ComplaintSpec,
  tl: ComplaintTimeline,
  endStep: string,
  audit: number[],
  events: number[],
  wfTimes: number[],
  csId: string,
  mgrId: string,
  rcaCat: Map<string, string>,
  stats: { rca: number; capa: number },
): Promise<void> {
  const cp = (await ctx.sql<any>(`SELECT * FROM complaints WHERE id = $1`, [id]))[0];
  const submitted = cp.submitted_at ? tl.at[0]! : null;
  const closed = ["CLOSED", "REJECTED", "CANCELLED"].includes(endStep) ? (c.outcome === "rejected" ? tl.rejectAt! : c.outcome === "cancelled" ? tl.cancelAt! : tl.closedAt!) : null;
  const last = closed ?? Math.max(...audit);
  const confirmedAt = cp.customer_confirmed_at ? (tl.at2 && tl.closedAt ? tl.closedAt : tl.at[7]!) : null;
  await ctx.sql(
    `UPDATE complaints SET created_at = $2, updated_at = $3, submitted_at = $4, closure_date = $5, verified_at = $6, customer_confirmed_at = $7 WHERE id = $1`,
    [
      id, iso(tl.create), iso(last), submitted ? iso(submitted) : null, cp.closure_date ? iso(closed ?? last) : null,
      cp.verified_at ? iso(tl.at2 ? tl.at2[2]! : tl.at[6]!) : null, confirmedAt ? iso(confirmedAt) : null,
    ],
  );

  const wi = cp.workflow_instance_id as string;
  // ---- name-based mapping of every trail row to its business time ----------
  const nth = (map: Map<string, number>, key: string) => {
    const n = map.get(key) ?? 0;
    map.set(key, n + 1);
    return n;
  };
  const roundTime = (idx: number, round: number): number => (round > 0 && tl.at2 && idx >= 4 ? tl.at2[idx - 4]! : tl.at[idx]!);
  const closingTime = tl.closedAt ?? tl.at[7]!;
  const timeOf = (name: string, occ: number): number => {
    const key = name.replace(/^complaint\./, "").replace(/^workflow\.instance\./, "");
    switch (key) {
      case "created": case "started": return tl.create;
      case "submit": case "submitted": return tl.at[0]!;
      case "acknowledge": case "acknowledged": return tl.at[1]!;
      case "assign": case "assigned": return tl.at[2]!;
      case "start_investigation": case "investigation_started": return roundTime(3, occ) === tl.at[3] ? tl.at[3]! : tl.at[3]!;
      case "investigation_updated": return occ === 0 ? tl.investigationAt : (tl.reopenAt ?? tl.create) + 2 * HOUR;
      case "submit_corrective_action": case "corrective_action_submitted": return roundTime(4, occ);
      case "submit_for_verification": case "verification_requested": return roundTime(5, occ);
      case "verify": return roundTime(6, occ);
      case "verified": { const r = Math.floor(occ / 2); return roundTime(6, r) - (occ % 2 === 0 ? 20 * 60_000 : 0); }
      case "customer_confirmation_recorded": return roundTime(7, occ) - 10 * 60_000;
      case "confirm": case "customer_confirmed": return roundTime(7, occ);
      case "completed": return closingTime;
      case "reject": case "rejected": return tl.rejectAt ?? tl.at[1]!;
      case "cancel": case "cancelled": return tl.cancelAt ?? tl.create;
      case "reopen": case "reopened": return tl.reopenAt ?? closingTime;
      default: return tl.create;
    }
  };
  const hist = await ctx.sql<{ id: string; action_code: string | null }>(`SELECT id, action_code FROM workflow_history WHERE workflow_instance_id = $1 ORDER BY occurred_at, id`, [wi]);
  const occH = new Map<string, number>();
  const histTimes: number[] = [];
  for (const h of hist) {
    const code = h.action_code ?? "started";
    const at = timeOf(code, nth(occH, code));
    histTimes.push(at);
    await ctx.sql(`UPDATE workflow_history SET occurred_at = $2 WHERE id = $1`, [h.id, iso(at)]);
  }
  await ctx.sql(`UPDATE workflow_instances SET started_at = $2, completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $3::timestamptz END WHERE id = $1`, [wi, iso(tl.create), iso(last)]);
  const asg = await ctx.sql<{ id: string }>(`SELECT id FROM workflow_instance_assignments WHERE workflow_instance_id = $1 ORDER BY assigned_at, id`, [wi]);
  const seq = histTimes.filter((_, i) => hist[i]!.action_code !== "completed");
  for (let i = 0; i < asg.length; i++) {
    const from = seq[Math.min(i, seq.length - 1)]!;
    const to = seq[Math.min(i + 1, seq.length - 1)]!;
    await ctx.sql(
      `UPDATE workflow_instance_assignments SET due_at = CASE WHEN due_at IS NULL THEN NULL ELSE $2::timestamptz + (due_at - assigned_at) END,
              decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE $3::timestamptz END, claimed_at = CASE WHEN claimed_at IS NULL THEN NULL ELSE $2::timestamptz END,
              assigned_at = $2 WHERE id = $1`,
      [asg[i]!.id, iso(from), iso(Math.max(to, from))],
    );
  }

  // audit / events / notifications (complaint + its workflow instance)
  for (const entityId of [id, wi]) {
    const occA = new Map<string, number>();
    const a = await ctx.sql<{ id: string; action: string }>(`SELECT id, action FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at, id`, [ctx.tenantId, entityId]);
    for (let i = 0; i < a.length; i++) {
      const row = a[i]!;
      const t = entityId === wi ? histTimes[Math.min(i, histTimes.length - 1)] ?? tl.create : timeOf(row.action, nth(occA, row.action));
      await ctx.sql(`UPDATE audit_log SET created_at = $2 WHERE id = $1`, [row.id, iso(t)]);
    }
    const occE = new Map<string, number>();
    const ev = await ctx.sql<{ id: string; event_type: string }>(`SELECT id, event_type FROM domain_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY occurred_at, id`, [ctx.tenantId, entityId]);
    for (const e of ev) {
      const t = timeOf(e.event_type, nth(occE, e.event_type));
      await ctx.sql(`UPDATE domain_events SET occurred_at = $2 WHERE id = $1`, [e.id, iso(t)]);
      const stale = Date.now() - t > 3 * DAY;
      await ctx.sql(
        `UPDATE notifications SET created_at = $2, sent_at = CASE WHEN sent_at IS NULL THEN NULL ELSE $2::timestamptz END, read_at = $3::timestamptz WHERE tenant_id = $1 AND domain_event_id = $4`,
        [ctx.tenantId, iso(t), stale ? iso(t + 3 * HOUR) : null, e.id],
      );
    }
  }

  // SLA projection
  const sla = (await ctx.sql<any>(`SELECT * FROM complaint_sla_targets WHERE complaint_id = $1`, [id]))[0];
  if (sla && submitted) {
    const factor = 3.0; // business minutes -> wall clock
    const key = c.tpl.cat === "billing" ? "billing" : c.severity;
    const mins = SLA_MIN[key as keyof typeof SLA_MIN];
    const respDue = submitted + mins.resp * 60_000 * factor;
    const resoDue = submitted + mins.reso * 60_000 * factor;
    const acked = (await ctx.sql(`SELECT 1 FROM workflow_history WHERE workflow_instance_id = $1 AND action_code IN ('acknowledge','reject')`, [wi])).length > 0;
    const firstResp = acked ? (c.outcome === "rejected" ? tl.rejectAt! : tl.at[1]!) : null;
    const resolvedAt = confirmedAt;
    const respBreached = firstResp ? firstResp > respDue : Date.now() > respDue;
    const finished = ["CLOSED", "REJECTED", "CANCELLED"].includes(endStep);
    const resoBreached = resolvedAt ? resolvedAt > resoDue : !finished && Date.now() > resoDue;
    await ctx.sql(
      `UPDATE complaint_sla_targets SET created_at = $2, updated_at = $3, started_at = $4, response_minutes = $11, resolution_minutes = $12, response_due_at = $5, resolution_due_at = $6,
              first_response_at = $7, resolved_at = $8, response_breached = $9, resolution_breached = $10 WHERE id = $1`,
      [sla.id, iso(submitted), iso(last), iso(submitted), iso(respDue), iso(resoDue), firstResp ? iso(firstResp) : null, resolvedAt ? iso(resolvedAt) : null, respBreached, resoBreached, mins.resp, mins.reso],
    );
  }

  // RCA + CAPA for investigated complaints
  if (!["REJECTED", "CANCELLED", "DRAFT", "SUBMITTED", "ACKNOWLEDGED", "ASSIGNED"].includes(endStep) || (endStep === "ASSIGNED" && false)) {
    const hasRca = (await ctx.sql(`SELECT 1 FROM complaint_rca_findings WHERE complaint_id = $1`, [id])).length > 0;
    let findingId: string | null = null;
    const invAt = tl.investigationAt <= Date.now() ? tl.investigationAt : tl.at[3]!;
    if (!hasRca && ["CORRECTIVE_ACTION", "VERIFICATION", "CUSTOMER_CONFIRMATION", "CLOSED"].includes(endStep)) {
      const catId = rcaCat.get(c.tpl.rca);
      if (catId) {
        const f = await ctx.call<any>("POST", `/service-quality/complaints/${id}/rca/findings`, {
          rootCauseCategoryId: catId,
          analysisMethodCode: hash(c.key) % 2 === 0 ? "five_whys" : "fishbone",
          statement: c.tpl.root,
          evidenceSummary: "Foto lokasi, berita acara harian, wawancara petugas, dan catatan pelanggan.",
          isPrimary: true,
          identifiedBy: "Citra Dewi",
        });
        findingId = f.id;
        stats.rca++;
        await ctx.sql(`UPDATE complaint_rca_findings SET identified_at = $2, created_at = $2, updated_at = $2 WHERE id = $1`, [f.id, iso(invAt + 2 * HOUR)]);
      }
    } else if (hasRca) {
      findingId = (await ctx.sql<{ id: string }>(`SELECT id FROM complaint_rca_findings WHERE complaint_id = $1 LIMIT 1`, [id]))[0]!.id;
    }
    const hasCapa = (await ctx.sql(`SELECT 1 FROM complaint_capa_actions WHERE complaint_id = $1`, [id])).length > 0;
    if (!hasCapa && (c.severity !== "minor" || hash(c.key) % 3 === 0) && ["CORRECTIVE_ACTION", "VERIFICATION", "CUSTOMER_CONFIRMATION", "CLOSED"].includes(endStep)) {
      const kinds: ["corrective" | "preventive", string, string][] = [
        ["corrective", `Perbaikan: ${c.tpl.sub.replace(/_/g, " ")}`, c.tpl.corrective],
        ["preventive", `Pencegahan: ${c.tpl.sub.replace(/_/g, " ")}`, c.tpl.preventive],
      ];
      for (const [type, title, description] of kinds) {
        const due = new Date(invAt + (type === "corrective" ? 5 : 14) * DAY).toISOString().slice(0, 10);
        const a2 = await ctx.call<any>("POST", "/service-quality/capa/actions", {
          complaintId: id, rcaFindingId: findingId, actionType: type, title, description, ownerUserId: type === "corrective" ? csId : mgrId, dueDate: due,
        });
        stats.capa++;
        const doneAt = invAt + (type === "corrective" ? 3 : 9) * DAY;
        const finished = doneAt <= Date.now() - DAY && endStep === "CLOSED";
        const verifiedAt = doneAt + 4 * DAY;
        if (finished) {
          await ctx.call("PATCH", `/service-quality/capa/actions/${a2.id}/status`, { status: "in_progress" });
          await ctx.call("PATCH", `/service-quality/capa/actions/${a2.id}/status`, { status: "completed", completionNote: type === "corrective" ? "Tindakan perbaikan dilaksanakan dan dibuktikan dengan dokumentasi." : "Prosedur dan pelatihan pencegahan sudah diterapkan di semua lokasi." });
          if (verifiedAt <= Date.now() - DAY) {
            await ctx.call("POST", `/service-quality/capa/actions/${a2.id}/verify`, { verdict: hash(c.key + type) % 11 === 0 ? "ineffective" : "effective", note: "Hasil pemantauan 30 hari: tidak ada kejadian serupa." });
          }
        } else if (doneAt <= Date.now()) {
          await ctx.call("PATCH", `/service-quality/capa/actions/${a2.id}/status`, { status: "in_progress" });
        }
        await ctx.sql(
          `UPDATE complaint_capa_actions SET created_at = $2, updated_at = $3,
                  completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE $4::timestamptz END, verified_at = CASE WHEN verified_at IS NULL THEN NULL ELSE $5::timestamptz END WHERE id = $1`,
          [a2.id, iso(invAt + 3 * HOUR), iso(finished ? verifiedAt : invAt + 3 * HOUR), iso(doneAt), iso(verifiedAt)],
        );
        await backdateTrail(ctx, [a2.id], (act) => iso(act.includes("verif") ? verifiedAt : act.includes("complet") ? doneAt : invAt + 3 * HOUR));
      }
      await renumberChronologically(ctx, "complaint_capa_actions", "action_number", "CAPA", "created_at");
    }
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C. Surveys and assessments
// ---------------------------------------------------------------------------

interface QSpec {
  code: string;
  text: string;
  type: "rating" | "single_choice" | "long_text" | "short_text";
  min?: number;
  max?: number;
  required?: boolean;
  weight?: number;
  options?: { code: string; label: string; score: number }[];
}
interface SectionSpec {
  code: string;
  title: string;
  weight?: number;
  questions: QSpec[];
}
interface SurveySpec {
  code: string;
  name: string;
  description: string;
  scoring: "sum" | "weighted_average" | "percentage" | "nps";
  sections: SectionSpec[];
}

const R5 = (code: string, text: string, weight = 1): QSpec => ({ code, text, type: "rating", min: 1, max: 5, required: true, weight });
const AUDIT_OPTS = [
  { code: "sesuai", label: "Sesuai standar", score: 2 },
  { code: "sebagian", label: "Sebagian sesuai", score: 1 },
  { code: "tidak", label: "Tidak sesuai", score: 0 },
];
const AUDIT_Q = (code: string, text: string): QSpec => ({ code, text, type: "single_choice", required: true, options: AUDIT_OPTS });

const SURVEYS: SurveySpec[] = [
  {
    code: "CSAT-LAYANAN",
    name: "Survei Kepuasan Pelanggan Pasca Layanan",
    description: "Dikirim ke PIC pelanggan setelah berita acara layanan bulanan diterima. Skala 1 (sangat tidak puas) sampai 5 (sangat puas).",
    scoring: "weighted_average",
    sections: [
      { code: "kualitas", title: "Kualitas Layanan", weight: 3, questions: [
        R5("ketepatan_waktu", "Ketepatan waktu layanan sesuai jadwal", 1.2), R5("kualitas_hasil", "Kualitas hasil pekerjaan / makanan yang diterima", 1.5),
        R5("kebersihan", "Kebersihan dan higiene petugas serta peralatan", 1.3), R5("keramahan", "Sikap dan keramahan petugas di lokasi"), R5("responsivitas", "Kecepatan respon tim terhadap permintaan dan keluhan"),
      ] },
      { code: "umum", title: "Kepuasan Keseluruhan", weight: 2, questions: [
        R5("kepuasan_umum", "Secara keseluruhan, seberapa puas Anda dengan layanan bulan ini?", 2),
        { code: "perpanjang", text: "Apakah Anda berniat memperpanjang kontrak layanan?", type: "single_choice", required: true, options: [
          { code: "ya", label: "Ya, pasti", score: 5 }, { code: "mungkin", label: "Mungkin, tergantung evaluasi", score: 3 }, { code: "tidak", label: "Tidak", score: 1 } ] },
      ] },
      { code: "masukan", title: "Masukan", questions: [{ code: "komentar", text: "Saran atau komentar untuk perbaikan layanan", type: "long_text" }] },
    ],
  },
  {
    code: "CSAT-KELUHAN",
    name: "Survei Kepuasan Penanganan Keluhan",
    description: "Dikirim setelah tiket keluhan ditutup, untuk menilai kecepatan dan kualitas penanganan.",
    scoring: "weighted_average",
    sections: [
      { code: "penanganan", title: "Penanganan Keluhan", questions: [
        R5("kecepatan_respon", "Kecepatan tim merespon keluhan Anda", 1.2), R5("kualitas_solusi", "Kualitas solusi dan tindakan perbaikan", 1.6),
        R5("komunikasi", "Kejelasan komunikasi selama proses penanganan"), R5("kepuasan_akhir", "Kepuasan akhir terhadap penyelesaian keluhan", 2),
        { code: "komentar", text: "Komentar tambahan", type: "long_text" },
      ] },
    ],
  },
  {
    code: "NPS-PELANGGAN",
    name: "Net Promoter Score Pelanggan Korporat",
    description: "Survei triwulanan melalui tautan publik yang dikirim ke PIC dan pengguna layanan pelanggan. Responden anonim.",
    scoring: "nps",
    sections: [
      { code: "nps", title: "Rekomendasi", questions: [
        { code: "nps", text: "Seberapa besar kemungkinan Anda merekomendasikan PT Sentra Layanan Terpadu kepada rekan atau perusahaan lain?", type: "rating", min: 0, max: 10, required: true },
        { code: "alasan", text: "Apa alasan utama skor Anda?", type: "long_text" },
      ] },
    ],
  },
  {
    code: "AUDIT-HIGIENE-DAPUR",
    name: "Audit Higiene dan Sanitasi Dapur Bulanan",
    description: "Penilaian internal oleh petugas K3 untuk dapur dan titik layanan: higiene personal, sanitasi, penyimpanan, dan keamanan pangan.",
    scoring: "percentage",
    sections: [
      { code: "lokasi", title: "Lokasi", questions: [{ code: "lokasi", text: "Lokasi dapur / titik layanan yang diaudit", type: "short_text", required: true }] },
      { code: "personal", title: "Higiene Personal", questions: [
        AUDIT_Q("penutup_rambut", "Penutup rambut, masker, dan celemek dipakai lengkap"), AUDIT_Q("cuci_tangan", "Fasilitas dan praktik cuci tangan sebelum bekerja"),
        AUDIT_Q("kesehatan", "Petugas sehat dan kartu kesehatan berlaku"),
      ] },
      { code: "sanitasi", title: "Sanitasi dan Penyimpanan", questions: [
        AUDIT_Q("suhu_chiller", "Suhu chiller dan freezer sesuai (maks 5 dan -18 derajat Celsius)"), AUDIT_Q("fifo_label", "Penyimpanan FIFO, label tanggal, dan tidak ada bahan kedaluwarsa"),
        AUDIT_Q("pemisahan", "Pemisahan bahan mentah dan matang, talenan dan pisau berwarna"), AUDIT_Q("alat_bersih", "Peralatan masak dan wadah bersih dan kering"),
        AUDIT_Q("air_limbah", "Air bersih memadai, saluran limbah dan grease trap bersih"), AUDIT_Q("hama", "Bebas tanda hama dan catatan pest control terkini"),
      ] },
      { code: "keamanan", title: "Keamanan Pangan", questions: [
        AUDIT_Q("sampel", "Sampel makanan 24 jam tersimpan dan tercatat"), AUDIT_Q("suhu_sajian", "Suhu penyajian dan waktu tunggu sesuai standar"),
        { code: "temuan", text: "Temuan dan tindak lanjut yang diminta", type: "long_text" },
      ] },
    ],
  },
  {
    code: "PENILAIAN-PEMASOK",
    name: "Penilaian Kinerja Pemasok Triwulanan",
    description: "Evaluasi pemasok utama bahan makanan dan perlengkapan oleh tim pengadaan berdasarkan penerimaan barang dan keluhan dapur.",
    scoring: "weighted_average",
    sections: [
      { code: "identitas", title: "Pemasok", questions: [{ code: "pemasok", text: "Nama pemasok yang dinilai", type: "short_text", required: true }] },
      { code: "kinerja", title: "Kinerja", questions: [
        R5("mutu_barang", "Mutu barang yang diterima (sesuai spesifikasi)", 2), R5("ketepatan_kirim", "Ketepatan jadwal dan jumlah pengiriman", 1.5),
        R5("harga", "Daya saing harga dan stabilitas harga"), R5("dokumen", "Kelengkapan dokumen (faktur, COA, sertifikat halal)"), R5("layanan", "Responsivitas dan penanganan retur", 0.5),
        { code: "rekomendasi", text: "Rekomendasi tindak lanjut", type: "single_choice", required: true, options: [
          { code: "utama", label: "Pertahankan sebagai pemasok utama", score: 5 }, { code: "pertahankan", label: "Pertahankan", score: 4 },
          { code: "evaluasi", label: "Perlu evaluasi dan pembinaan", score: 2 }, { code: "hentikan", label: "Pertimbangkan dihentikan", score: 0 } ] },
        { code: "catatan", text: "Catatan evaluasi", type: "long_text" },
      ] },
    ],
  },
];

interface SurveyRefs {
  versionId: string;
  q: Map<string, string>;
  opt: Map<string, string>; // `${qcode}.${optcode}` -> option id
}

async function ensureSurvey(ctx: DemoCtx, spec: SurveySpec): Promise<SurveyRefs> {
  const exists = (await ctx.sql(`SELECT 1 FROM survey_definitions WHERE tenant_id = $1 AND code = $2`, [ctx.tenantId, spec.code])).length > 0;
  if (!exists) {
    const created = await ctx.call<any>("POST", "/surveys", { code: spec.code, name: spec.name, description: spec.description, scoringModel: spec.scoring, defaultLocale: "id-ID" });
    const versionId = (created.version?.id ?? created.versionId) as string;
    let sectionOrder = 1;
    for (const sec of spec.sections) {
      const section = await ctx.call<any>("POST", `/survey-versions/${versionId}/sections`, { code: sec.code, title: sec.title, sortOrder: sectionOrder++, weight: sec.weight ?? 1 });
      let qo = 1;
      for (const q of sec.questions) {
        const row = await ctx.call<any>("POST", `/survey-versions/${versionId}/questions`, {
          sectionId: section.id, code: q.code, text: q.text, questionType: q.type, isRequired: q.required ?? false, sortOrder: qo++, weight: q.weight ?? 1,
          config: q.type === "rating" ? { min: q.min ?? 1, max: q.max ?? 5 } : {},
        });
        let oo = 1;
        for (const o of q.options ?? []) await ctx.call("POST", `/survey-questions/${row.id}/options`, { code: o.code, label: o.label, score: o.score, sortOrder: oo++ });
      }
    }
    await ctx.call("POST", `/surveys/${spec.code}/versions/1/publish`);
    const at = ctx.cal.at(ctx.cal.start, 9);
    await ctx.sql(`UPDATE survey_definitions SET created_at = $2, updated_at = $2 WHERE tenant_id = $1 AND code = $3`, [ctx.tenantId, at, spec.code]);
    await ctx.sql(
      `UPDATE survey_versions SET created_at = $2, published_at = $2 WHERE survey_definition_id = (SELECT id FROM survey_definitions WHERE tenant_id = $1 AND code = $3)`,
      [ctx.tenantId, at, spec.code],
    );
  }
  const v = (await ctx.sql<{ id: string }>(
    `SELECT v.id FROM survey_versions v JOIN survey_definitions d ON d.id = v.survey_definition_id WHERE d.tenant_id = $1 AND d.code = $2 AND v.status = 'published' ORDER BY v.version_number DESC LIMIT 1`,
    [ctx.tenantId, spec.code],
  ))[0]!;
  const qs = await ctx.sql<{ id: string; code: string }>(`SELECT id, code FROM survey_questions WHERE survey_version_id = $1`, [v.id]);
  const os = await ctx.sql<{ id: string; code: string; qcode: string }>(
    `SELECT o.id, o.code, q.code AS qcode FROM survey_question_options o JOIN survey_questions q ON q.id = o.survey_question_id WHERE q.survey_version_id = $1`,
    [v.id],
  );
  return { versionId: v.id, q: new Map(qs.map((q) => [q.code, q.id])), opt: new Map(os.map((o) => [`${o.qcode}.${o.code}`, o.id])) };
}

interface Ans {
  rating?: Record<string, number>;
  text?: Record<string, string>;
  choice?: Record<string, string>;
}
function toAnswers(refs: SurveyRefs, a: Ans) {
  const out: { questionId: string; valueNumeric?: number; valueText?: string; optionIds?: string[] }[] = [];
  for (const [k, v] of Object.entries(a.rating ?? {})) out.push({ questionId: refs.q.get(k)!, valueNumeric: v });
  for (const [k, v] of Object.entries(a.text ?? {})) out.push({ questionId: refs.q.get(k)!, valueText: v });
  for (const [k, v] of Object.entries(a.choice ?? {})) out.push({ questionId: refs.q.get(k)!, optionIds: [refs.opt.get(`${k}.${v}`)!] });
  return out;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const monthsSince = (ctx: DemoCtx, ms: number) => {
  const a = ctx.cal.start;
  const d = new Date(ms + 7 * HOUR);
  return (d.getUTCFullYear() - Number(a.slice(0, 4))) * 12 + d.getUTCMonth() - (Number(a.slice(5, 7)) - 1) + d.getUTCDate() / 31;
};
/** Mean satisfaction (1-5) trending up over the year, with the Ramadan crunch and a per-customer offset. */
function satisfactionMean(ctx: DemoCtx, ms: number, bias: number): number {
  const t = monthsSince(ctx, ms);
  let m = 3.85 + 0.62 * clamp(t / 12, 0, 1.05) + bias;
  const ym = new Date(ms + 7 * HOUR).toISOString().slice(0, 7);
  if (ym === "2026-03") m -= 0.3;
  if (ym === "2025-12") m -= 0.1;
  return m;
}

async function backdateAssignment(ctx: DemoCtx, id: string, createdMs: number, submittedMs: number | null): Promise<void> {
  await ctx.sql(`UPDATE survey_assignments SET created_at = $2, submitted_at = $3 WHERE id = $1`, [id, iso(createdMs), submittedMs ? iso(submittedMs) : null]);
  if (submittedMs) {
    const ans = await ctx.sql<{ id: string }>(`SELECT id FROM survey_answers WHERE survey_assignment_id = $1 ORDER BY id`, [id]);
    for (let i = 0; i < ans.length; i++) {
      const t = submittedMs - (ans.length - i) * 25_000;
      await ctx.sql(`UPDATE survey_answers SET answered_at = $2, updated_at = $2 WHERE id = $1`, [ans[i]!.id, iso(t)]);
    }
    await ctx.sql(`UPDATE survey_section_scores SET created_at = $2 WHERE survey_assignment_id = $1`, [id, iso(submittedMs)]);
  }
  await backdateTrail(ctx, [id], (action) => iso(action.includes("submit") ? submittedMs ?? createdMs : createdMs));
}

async function respond(ctx: DemoCtx, email: string, pw: string, assignmentId: string, answers: ReturnType<typeof toAnswers>): Promise<void> {
  await ctx.callAs(email, pw, "POST", `/survey-assignments/${assignmentId}/answers`, { answers });
  await ctx.callAs(email, pw, "POST", `/survey-assignments/${assignmentId}/submit`);
}

const POS_COMMENTS = [
  "Layanan konsisten dan tim responsif. Pertahankan.", "Makanan enak dan tepat waktu, karyawan puas.", "Petugas ramah dan area selalu bersih.",
  "Koordinasi dengan koordinator lapangan sangat membantu.", "Laporan bulanan rapi dan mudah dicek.",
];
const NEU_COMMENTS = [
  "Secara umum baik, namun variasi menu perlu ditambah.", "Mohon ketepatan waktu pengiriman di hari Senin lebih diperhatikan.",
  "Kebersihan sudah baik, tolong tingkatkan pengawasan di shift sore.", "Sebaiknya ada laporan mingguan singkat, bukan hanya bulanan.",
];
const NEG_COMMENTS = [
  "Beberapa kali terlambat dan tidak ada pemberitahuan sebelumnya.", "Kualitas makanan menurun dibanding bulan lalu, mohon dievaluasi.",
  "Jumlah petugas sering kurang dari kontrak.", "Penanganan keluhan lambat, harus kami ingatkan berulang kali.",
];
const commentFor = (score: number, r: ReturnType<typeof makeRand>) => (score >= 4.2 ? r.pick(POS_COMMENTS) : score >= 3.3 ? r.pick(NEU_COMMENTS) : r.pick(NEG_COMMENTS));

async function ensureSurveyRespondRole(ctx: DemoCtx): Promise<void> {
  // Internal assessors (K3, purchasing, complaint handlers) need the respond permission.
  const n = await ctx.sql(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE r.tenant_id = $1 AND r.code IN ('HSE_OFFICER','PURCHASING_OPS') AND p.code = 'survey.respond'
        AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id)
     RETURNING role_id`,
    [ctx.tenantId],
  );
  if (n.length) ctx.log("complaints-surveys", `granted survey.respond to ${n.length} internal assessor role(s)`);
}

async function stepSurveys(ctx: DemoCtx): Promise<void> {
  await ensureSurveyRespondRole(ctx);
  const refs = new Map<string, SurveyRefs>();
  for (const sp of SURVEYS) refs.set(sp.code, await ensureSurvey(ctx, sp));
  const now = Math.min(Date.now(), new Date(ctx.cal.at(ctx.cal.today, 17)).getTime());
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  const custByCode = new Map((await ctx.sql<{ code: string; id: string }>(`SELECT code, id FROM customers WHERE tenant_id = $1`, [ctx.tenantId])).map((r) => [r.code, r.id]));
  const { CUSTOMERS } = await import("./catalog.js");
  const portal = new Map<string, { email: string; pw: string; userId: string; custCode: string }>();
  for (const c of CUSTOMERS) {
    const u = portalUser(c);
    const uid = (await ctx.sql<{ id: string }>(`SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [ctx.tenantId, u.email]))[0]?.id;
    if (uid) portal.set(custByCode.get(c.code)!, { email: u.email, pw: u.password, userId: uid, custCode: c.code });
  }

  // ---- 1. post-service CSAT, one per customer per month, context = accepted work order ----------
  {
    const R = refs.get("CSAT-LAYANAN")!;
    const wos = await ctx.sql<{ id: string; customer_id: string; accepted: Date; ym: string }>(
      `SELECT DISTINCT ON (w.customer_id, to_char(w.customer_accepted_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM'))
              w.id, w.customer_id, w.customer_accepted_at AS accepted, to_char(w.customer_accepted_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM') AS ym
         FROM work_orders w JOIN service_definitions sd ON sd.id = w.service_definition_id
        WHERE w.tenant_id = $1 AND w.customer_accepted_at IS NOT NULL AND sd.code IN ('catering_daily_meal','housekeeping_daily','camp_mess_operations','facility_maintenance_monthly')
          AND w.customer_id = ANY($2::uuid[])
        ORDER BY w.customer_id, to_char(w.customer_accepted_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM'), w.created_at`,
      [ctx.tenantId, [...portal.keys()]],
    );
    const have = new Set((await ctx.sql<{ cid: string }>(`SELECT context_entity_id AS cid FROM survey_assignments WHERE tenant_id = $1 AND survey_version_id = $2`, [ctx.tenantId, R.versionId])).map((r) => r.cid));
    const complaintMonths = new Set((await ctx.sql<{ k: string }>(
      `SELECT customer_id::text || '|' || to_char(created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM') AS k FROM complaints WHERE tenant_id = $1 AND severity IN ('major','critical')`, [ctx.tenantId])).map((r) => r.k));
    for (const w of wos) {
      if (have.has(w.id)) continue;
      const user = portal.get(w.customer_id)!;
      const rr = makeRand(hash(w.id + "|csat"));
      const acceptedMs = w.accepted.getTime();
      const createdMs = acceptedMs + 4 * HOUR;
      const delay = (1 + rr.next() * 5) * DAY + rr.int(1, 8) * HOUR;
      const submitMs = createdMs + delay;
      const answerIt = submitMs <= now && !rr.chance(0.1); // some customers never reply
      const asg = await ctx.call<any>("POST", "/survey-assignments", {
        surveyVersionId: R.versionId, respondentUserId: user.userId, contextEntityType: "work_order", contextEntityId: w.id,
        dueAt: iso(createdMs + 14 * DAY),
      });
      bump("csat_assigned");
      if (answerIt) {
        const bias = ((hash(user.custCode) % 50) / 100 - 0.25) - (complaintMonths.has(`${w.customer_id}|${w.ym}`) ? 0.7 : 0);
        const mean = satisfactionMean(ctx, submitMs, bias);
        const item = () => clamp(Math.round(mean + (rr.next() - 0.5) * 1.3), 1, 5);
        const rating = { ketepatan_waktu: item(), kualitas_hasil: item(), kebersihan: item(), keramahan: item(), responsivitas: item() } as Record<string, number>;
        const overall = clamp(Math.round(Object.values(rating).reduce((a, b) => a + b, 0) / 5 + (rr.next() - 0.5) * 0.6), 1, 5);
        rating.kepuasan_umum = overall;
        const choice = { perpanjang: overall >= 4 ? "ya" : overall === 3 ? "mungkin" : "tidak" };
        const text: Record<string, string> = rr.chance(0.7) ? { komentar: commentFor(mean, rr) } : {};
        await respond(ctx, user.email, user.pw, asg.id, toAnswers(R, { rating, choice, text }));
        await backdateAssignment(ctx, asg.id, createdMs, submitMs);
        bump("csat_submitted");
      } else {
        await backdateAssignment(ctx, asg.id, createdMs, null);
      }
    }
  }

  // ---- 2. complaint-handling CSAT, context = closed complaint --------------------------------
  {
    const R = refs.get("CSAT-KELUHAN")!;
    const done = await ctx.sql<{ id: string; customer_id: string; confirmed: Date; severity: string; n: number }>(
      `SELECT id, customer_id, customer_confirmed_at AS confirmed, severity, row_number() OVER (ORDER BY customer_confirmed_at)::int n
         FROM complaints WHERE tenant_id = $1 AND customer_confirmed_at IS NOT NULL ORDER BY customer_confirmed_at`,
      [ctx.tenantId],
    );
    const have = new Set((await ctx.sql<{ cid: string }>(`SELECT context_entity_id AS cid FROM survey_assignments WHERE tenant_id = $1 AND survey_version_id = $2`, [ctx.tenantId, R.versionId])).map((r) => r.cid));
    for (const cp of done) {
      if (have.has(cp.id)) continue;
      const user = portal.get(cp.customer_id);
      if (!user) continue;
      const rr = makeRand(hash(cp.id + "|csatk"));
      const createdMs = cp.confirmed.getTime() + 2 * HOUR;
      const submitMs = createdMs + (0.5 + rr.next() * 3.5) * DAY;
      const respondIt = submitMs <= now && rr.chance(0.78);
      const asg = await ctx.call<any>("POST", "/survey-assignments", {
        surveyVersionId: R.versionId, respondentUserId: user.userId, contextEntityType: "complaint", contextEntityId: cp.id, dueAt: iso(createdMs + 10 * DAY),
      });
      bump("csat_keluhan_assigned");
      if (respondIt) {
        const mean = satisfactionMean(ctx, submitMs, -0.2 - (cp.severity === "critical" ? 0.5 : 0) + (rr.next() - 0.5) * 0.3);
        const item = () => clamp(Math.round(mean + (rr.next() - 0.5) * 1.4), 1, 5);
        const rating = { kecepatan_respon: item(), kualitas_solusi: item(), komunikasi: item(), kepuasan_akhir: item() };
        const text: Record<string, string> = rr.chance(0.6) ? { komentar: commentFor(mean, rr) } : {};
        await respond(ctx, user.email, user.pw, asg.id, toAnswers(R, { rating, text }));
        await backdateAssignment(ctx, asg.id, createdMs, submitMs);
        bump("csat_keluhan_submitted");
      } else {
        await backdateAssignment(ctx, asg.id, createdMs, null);
      }
    }
  }

  // ---- 3. quarterly NPS through public links -------------------------------------------------
  {
    const R = refs.get("NPS-PELANGGAN")!;
    const waves = [
      { label: "NPS Triwulan IV 2025", start: "2025-12-15", end: "2026-01-09", n: 14, promoter: 0.36, passive: 0.34, open: false },
      { label: "NPS Triwulan I 2026", start: "2026-03-30", end: "2026-04-14", n: 19, promoter: 0.42, passive: 0.33, open: false },
      { label: "NPS Triwulan II 2026", start: "2026-06-22", end: "2026-07-07", n: 23, promoter: 0.5, passive: 0.3, open: false },
      { label: "NPS Triwulan III 2026", start: "2026-09-21", end: "2026-10-06", n: 26, promoter: 0.58, passive: 0.28, open: false },
      { label: "NPS Triwulan IV 2026 (berlangsung)", start: "2026-11-02", end: "2026-11-30", n: 9, promoter: 0.6, passive: 0.27, open: true },
    ];
    const PROMO = ["Layanan konsisten, tim cepat tanggap.", "Menu bervariasi dan petugas profesional.", "Kontrak berjalan lancar, laporan transparan.", "Sudah bertahun-tahun andal dan tepat waktu."];
    const PASS_T = ["Baik, tetapi masih ada keterlambatan sesekali.", "Cukup puas, harga bisa lebih kompetitif.", "Layanan memadai, komunikasi perubahan jadwal perlu diperbaiki."];
    const DETR = ["Sering terlambat dan keluhan lambat ditangani.", "Kualitas makanan tidak konsisten.", "Jumlah petugas kebersihan kurang dari yang dijanjikan."];
    for (const [wi, wave] of waves.entries()) {
      if (new Date(ctx.cal.at(wave.start, 9)).getTime() > now) continue;
      let tok = (await ctx.sql<{ id: string }>(`SELECT id FROM survey_distribution_tokens WHERE tenant_id = $1 AND survey_version_id = $2 AND recipient_label = $3`, [ctx.tenantId, R.versionId, wave.label]))[0];
      let raw: string | null = null;
      if (!tok) {
        const t = await ctx.call<any>("POST", `/survey-versions/${R.versionId}/distribution-tokens`, { channel: "link", recipientLabel: wave.label, maxUses: null, metadata: { wave: wi + 1 } });
        raw = t.rawToken as string;
        tok = { id: t.token.id };
        await ctx.sql(`UPDATE survey_distribution_tokens SET created_at = $2 WHERE id = $1`, [tok.id, ctx.cal.at(wave.start, 8)]);
      }
      const existing = (await ctx.sql<{ n: number }>(`SELECT count(*)::int n FROM survey_assignments WHERE distribution_token_id = $1`, [tok.id]))[0]!.n;
      if (existing < wave.n && !raw) {
        // the raw token is only known at creation: top-up needs a fresh link
        const t = await ctx.call<any>("POST", `/survey-versions/${R.versionId}/distribution-tokens`, { channel: "link", recipientLabel: wave.label + " (susulan)", maxUses: null });
        raw = t.rawToken as string;
        tok = { id: t.token.id };
        await ctx.sql(`UPDATE survey_distribution_tokens SET created_at = $2 WHERE id = $1`, [tok.id, ctx.cal.at(wave.start, 8)]);
      }
      const startMs = new Date(ctx.cal.at(wave.start, 9)).getTime();
      const endMs = Math.min(new Date(ctx.cal.at(wave.end, 17)).getTime(), now);
      for (let i = existing; i < wave.n && raw; i++) {
        const rr = makeRand(hash(`${wave.label}|${i}`));
        const submitMs = startMs + Math.pow(rr.next(), 1.6) * (endMs - startMs);
        const roll = rr.next();
        const score = roll < wave.promoter ? rr.pick([9, 9, 10, 10, 10]) : roll < wave.promoter + wave.passive ? rr.pick([7, 8, 8]) : rr.pick([3, 4, 5, 6, 6]);
        const reason = score >= 9 ? rr.pick(PROMO) : score >= 7 ? rr.pick(PASS_T) : rr.pick(DETR);
        const r = await ctx.app.inject({
          method: "POST",
          url: `/public/surveys/${raw}/submit`,
          payload: { answers: toAnswers(R, { rating: { nps: score }, text: { alasan: reason } }) },
        });
        if (r.statusCode !== 201) throw new Error(`public NPS submit ${r.statusCode}: ${r.body}`);
        const aid = (r.json() as { assignmentId: string }).assignmentId;
        await backdateAssignment(ctx, aid, submitMs - 4 * 60_000, submitMs);
        bump("nps_submitted");
      }
      if (tok) {
        await ctx.sql(
          `UPDATE survey_distribution_tokens SET expires_at = $2, revoked_at = $3 WHERE id IN (SELECT id FROM survey_distribution_tokens WHERE tenant_id = $4 AND survey_version_id = $5 AND recipient_label LIKE $6)`,
          [ctx.cal.at(addDays(wave.end, 14), 23), wave.open ? null : ctx.cal.at(addDays(wave.end, 1), 9), ctx.tenantId, R.versionId, wave.label + "%"],
        ).catch(() => undefined);
        if (wave.open) await ctx.sql(`UPDATE survey_distribution_tokens SET expires_at = NULL, revoked_at = NULL WHERE tenant_id = $1 AND survey_version_id = $2 AND recipient_label LIKE $3`, [ctx.tenantId, R.versionId, wave.label + "%"]);
      }
    }
  }

  // ---- 4. monthly kitchen hygiene audit by the K3 officer ----------------------------------
  {
    const R = refs.get("AUDIT-HIGIENE-DAPUR")!;
    const hse = USERS.hse;
    const hseId = await userIdByEmail(ctx, hse.email);
    const sites = (await loadSites(ctx)).filter((s) => s.dailyMeals >= 240).sort((a, b) => b.dailyMeals - a.dailyMeals).slice(0, 8);
    const have = new Set((await ctx.sql<{ k: string }>(
      `SELECT to_char(a.created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM') || '|' || sa.value_text AS k FROM survey_assignments a
         JOIN survey_answers sa ON sa.survey_assignment_id = a.id AND sa.survey_question_id = $2 WHERE a.tenant_id = $1 AND a.survey_version_id = $3`,
      [ctx.tenantId, R.q.get("lokasi"), R.versionId])).map((r) => r.k));
    const items = ["penutup_rambut", "cuci_tangan", "kesehatan", "suhu_chiller", "fifo_label", "pemisahan", "alat_bersih", "air_limbah", "hama", "sampel", "suhu_sajian"];
    for (const m of ctx.cal.months) {
      for (const site of sites) {
        if (site.start > ctx.cal.day(m, 20)) continue;
        const name = `${site.customer.name} - ${site.name}`;
        if (have.has(`${m}|${name}`)) continue;
        const rr = makeRand(hash(`${m}|${site.code}|audit`));
        const dom = rr.int(4, 24);
        const auditDate = ctx.cal.day(m, dom);
        const submitMs = new Date(ctx.cal.at(auditDate, rr.int(9, 15), rr.int(0, 59))).getTime();
        if (submitMs > now) continue;
        const createdMs = new Date(ctx.cal.at(ctx.cal.day(m, 1), 8)).getTime();
        const asg = await ctx.call<any>("POST", "/survey-assignments", { surveyVersionId: R.versionId, respondentUserId: hseId, dueAt: iso(new Date(ctx.cal.at(ctx.cal.day(m, 28), 17)).getTime()) });
        const t = monthsSince(ctx, submitMs);
        let quality = 0.80 + 0.12 * clamp(t / 12, 0, 1) + ((hash(site.code) % 8) - 4) / 100 + (m === "2026-03" ? -0.05 : 0);
        const choice: Record<string, string> = {};
        const findings: string[] = [];
        for (const it of items) {
          const roll = rr.next();
          const v = roll < quality ? "sesuai" : roll < quality + (1 - quality) * 0.75 ? "sebagian" : "tidak";
          choice[it] = v;
          if (v !== "sesuai") findings.push(it.replace(/_/g, " "));
        }
        const text = { lokasi: name, temuan: findings.length ? `Perbaikan diminta: ${findings.slice(0, 3).join(", ")}. Tindak lanjut dipantau pada audit bulan berikutnya.` : "Tidak ada temuan. Pertahankan praktik yang berjalan." };
        await respond(ctx, hse.email, hse.password, asg.id, toAnswers(R, { choice, text }));
        await backdateAssignment(ctx, asg.id, createdMs, submitMs);
        bump("audit_submitted");
      }
    }
  }

  // ---- 5. quarterly supplier rating by purchasing --------------------------------------------
  {
    const R = refs.get("PENILAIAN-PEMASOK")!;
    const buyer = USERS.purchasing;
    const buyerId = await userIdByEmail(ctx, buyer.email);
    const quarters = ["2025-12", "2026-03", "2026-06", "2026-09"];
    const have = new Set((await ctx.sql<{ k: string }>(
      `SELECT to_char(a.created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM') || '|' || sa.value_text AS k FROM survey_assignments a
         JOIN survey_answers sa ON sa.survey_assignment_id = a.id AND sa.survey_question_id = $2 WHERE a.tenant_id = $1 AND a.survey_version_id = $3`,
      [ctx.tenantId, R.q.get("pemasok"), R.versionId])).map((r) => r.k));
    for (const q of quarters) {
      for (const sup of SUPPLIERS.slice(0, 10)) {
        if (have.has(`${q}|${sup.name}`)) continue;
        const rr = makeRand(hash(`${q}|${sup.code}|sup`));
        const submitMs = new Date(ctx.cal.at(ctx.cal.day(q, rr.int(18, 27)), rr.int(9, 16), rr.int(0, 59))).getTime();
        if (submitMs > now) continue;
        const createdMs = new Date(ctx.cal.at(ctx.cal.day(q, 15), 8)).getTime();
        const asg = await ctx.call<any>("POST", "/survey-assignments", { surveyVersionId: R.versionId, respondentUserId: buyerId, dueAt: iso(new Date(ctx.cal.at(ctx.cal.day(q, 30), 17)).getTime()) });
        const base = 3.9 + ((hash(sup.code) % 9) - 4) / 10 + 0.35 * clamp(monthsSince(ctx, submitMs) / 12, 0, 1);
        const item = () => clamp(Math.round(base + (rr.next() - 0.5) * 1.2), 1, 5);
        const rating = { mutu_barang: item(), ketepatan_kirim: item(), harga: item(), dokumen: item(), layanan: item() };
        const avg = Object.values(rating).reduce((a, b) => a + b, 0) / 5;
        const choice = { rekomendasi: avg >= 4.4 ? "utama" : avg >= 3.6 ? "pertahankan" : avg >= 2.8 ? "evaluasi" : "hentikan" };
        const text = { pemasok: sup.name, catatan: avg >= 4.4 ? "Kinerja sangat baik, tidak ada penolakan barang pada periode ini." : avg >= 3.6 ? "Kinerja baik, ada keterlambatan kecil yang sudah dikomunikasikan." : "Terdapat beberapa penolakan barang; dijadwalkan pertemuan pembinaan." };
        await respond(ctx, buyer.email, buyer.password, asg.id, toAnswers(R, { rating, choice, text }));
        await backdateAssignment(ctx, asg.id, createdMs, submitMs);
        bump("supplier_submitted");
      }
    }
  }
  ctx.log("complaints-surveys", `surveys: ${SURVEYS.length} definitions published; created ${JSON.stringify(stats)}`);
}

// ---------------------------------------------------------------------------

export async function run(ctx: DemoCtx): Promise<void> {
  const steps = new Set((process.env.CS_STEPS ?? "sq,complaints,surveys").split(",").map((s) => s.trim()));
  if (steps.has("sq")) await stepServiceQuality(ctx);
  if (steps.has("portal") || steps.has("complaints") || steps.has("surveys")) await stepPortalUsers(ctx);
  if (steps.has("complaints")) await stepComplaints(ctx);
  if (steps.has("surveys")) await stepSurveys(ctx);
  void customerByCode; void activityFactor; void periodCodeOf;
}
