/**
 * Sector "hse": one year of Health, Safety & Environment history for
 * PT Sentra Layanan Terpadu.
 *
 *  - reference data (categories / severities), record + permit lifecycles
 *  - incidents and observations across the year (near miss, first aid, lost
 *    time injury, property damage, food safety, fire, environment, unsafe
 *    conditions / acts, good practices) with persons involved, follow-ups
 *    (closed / open / overdue) and a Workflow lifecycle per record
 *  - investigations (5-Why / Fishbone) with root causes and contributing factors
 *  - CAPAs raised from investigations, audit findings and monitoring breaches
 *  - 5x5 risk matrix + JSA / HIRA risk assessments
 *  - permits to work (hot work, height, confined space, LOTO, excavation)
 *  - inspection / audit programmes with scheduled and completed occurrences
 *  - environmental / food-safety monitoring points with readings
 *  - monthly safety KPI snapshots (TRIR-style rates, CAPA closure rate)
 *
 * Everything goes through the real API as the HSE officer / operations
 * manager; SQL only backdates timestamps and registers the two reference-data
 * types the HSE module reads but no migration creates. Idempotent: each block
 * looks its records up by natural key (title + date) before creating.
 */
import type { DemoCtx } from "./harness.js";
import { makeRand } from "./harness.js";
import { EMPLOYEES, ORG_UNITS, USERS, type OrgKey, type UserKey } from "./catalog.js";
import { backdateEntities, ensureWorkflow, renumberYear, type WfStep } from "./workforce.js";

const S = "hse";
const rnd = makeRand(20261109 ^ 0x5eed);

type Id = string;
const counts: Record<string, number> = {};
const made = (k: string, n = 1) => {
  if (n > 0) counts[k] = (counts[k] ?? 0) + n;
};
const pad = (n: number) => String(n).padStart(2, "0");
const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const dayDiff = (a: string, b: string) => Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);

// ---------------------------------------------------------------------------
// reference data
// ---------------------------------------------------------------------------
const CATEGORIES: [string, string][] = [
  ["near_miss", "Nyaris Celaka (Near Miss)"],
  ["first_aid", "Cedera Ringan (P3K)"],
  ["lost_time_injury", "Cedera Hilang Waktu Kerja"],
  ["property_damage", "Kerusakan Properti / Peralatan"],
  ["food_safety", "Keamanan Pangan"],
  ["fire", "Kebakaran / Percikan Api"],
  ["environment", "Lingkungan (Tumpahan / Limbah)"],
  ["unsafe_condition", "Kondisi Tidak Aman"],
  ["unsafe_act", "Tindakan Tidak Aman"],
  ["good_practice", "Praktik Baik"],
];
const SEVERITIES: [string, string][] = [
  ["info", "Informasi / Observasi"],
  ["minor", "Ringan"],
  ["moderate", "Sedang"],
  ["major", "Berat"],
  ["lti", "Hilang Waktu Kerja (LTI)"],
];

type Fate = "closed" | "followup" | "review" | "new" | "cancelled";

interface Tpl {
  type: "incident" | "observation";
  cat: string;
  sev: string;
  org: OrgKey;
  mode: "kitchen" | "client_cat" | "client_fac" | "warehouse" | "fixed";
  site?: string;
  project?: string;
  areas: string[];
  title: string;
  desc: string;
  action?: string;
  who?: string[];
  inv?: { framework: "5WHY" | "FISHBONE"; findings: string; root: string; factors: [string, string, boolean][] };
  capa?: { title: string; desc: string; type: "corrective" | "preventive"; actions: string[] };
  fu: [string, string, number][];
  lostDays?: number;
}

const FAC_SITES = ["SITE-104-A", "SITE-110-A", "SITE-110-B", "SITE-112-A", "SITE-106-A", "SITE-111-A", "SITE-103-A", "SITE-108-A", "SITE-102-A"];
const CAT_SITES = ["SITE-101-A", "SITE-102-A", "SITE-107-A", "SITE-108-A", "SITE-109-A", "SITE-112-A"];

const INCIDENTS: Tpl[] = [
  {
    type: "incident", cat: "near_miss", sev: "minor", org: "CATERING", mode: "kitchen",
    areas: ["Area penggorengan", "Area cuci peralatan", "Jalur troli menuju loading dock"],
    title: "Nyaris terpeleset akibat lantai licin berminyak",
    desc: "Pekerja hampir terpeleset karena tumpahan minyak goreng yang belum dibersihkan. Tidak ada cedera dan tidak ada kerusakan.",
    action: "Lantai segera dibersihkan dan dipasang tanda 'Lantai Licin'.",
    who: ["COOK", "KITCHEN-HELP"],
    fu: [["Pasang matras anti-slip di area penggorengan", "Matras karet anti-slip di seluruh stasiun goreng dan cuci.", 14], ["Briefing 5 menit pembersihan tumpahan segera", "Dimasukkan ke briefing awal shift dapur.", 7]],
  },
  {
    type: "incident", cat: "near_miss", sev: "moderate", org: "CATERING", mode: "kitchen",
    areas: ["Stasiun masak lantai 1", "Gudang LPG dapur"],
    title: "Regulator tabung LPG 12 kg berbau gas saat dinyalakan",
    desc: "Tercium bau gas dari sambungan regulator saat kompor dinyalakan. Tidak ada api maupun ledakan.",
    action: "Kompor dimatikan, tabung dipindahkan ke area terbuka, ventilasi dibuka dan pemasok LPG dihubungi.",
    who: ["COOK"],
    inv: { framework: "FISHBONE", findings: "Karet seal regulator getas dan selang melewati masa pakai 3 tahun.", root: "Tidak ada jadwal penggantian berkala regulator dan selang LPG.", factors: [["Peralatan", "Seal regulator getas karena usia pakai", false], ["Metode", "Tidak ada jadwal penggantian berkala komponen LPG", true], ["Manusia", "Uji sabun sebelum menyalakan kompor tidak dilakukan", false]] },
    capa: { title: "Penggantian berkala regulator & selang LPG", desc: "Menetapkan masa pakai maksimal 24 bulan dan uji kebocoran bulanan.", type: "preventive", actions: ["Ganti seluruh regulator dan selang LPG dapur", "Susun jadwal uji kebocoran bulanan dengan larutan sabun"] },
    fu: [["Ganti regulator dan selang", "Pengadaan regulator SNI baru.", 3], ["Uji kebocoran seluruh titik LPG", "Dilakukan oleh teknisi bersertifikat.", 10]],
  },
  {
    type: "incident", cat: "near_miss", sev: "minor", org: "WAREHOUSE", mode: "warehouse",
    areas: ["Lorong rak B", "Area bongkar muat"],
    title: "Forklift nyaris menyenggol pekerja di lorong rak",
    desc: "Forklift berbelok di ujung lorong dan nyaris mengenai staf gudang yang sedang menghitung stok.",
    action: "Operasi forklift dihentikan sementara, dilakukan toolbox meeting.",
    who: ["WH-STAFF", "WH-HEAD"],
    fu: [["Pasang cermin cembung dan marka jalur pejalan kaki", "Di semua tikungan lorong rak.", 21]],
  },
  {
    type: "incident", cat: "near_miss", sev: "minor", org: "FACILITY", mode: "client_fac",
    areas: ["Area pantry", "Ruang rapat lantai 3", "Lobi utama"],
    title: "Tangga lipat bergeser saat teknisi membersihkan plafon",
    desc: "Tangga lipat bergeser di lantai licin, teknisi sempat berpegangan pada rangka plafon. Tidak ada cedera.",
    action: "Pekerjaan dihentikan; tangga diganti dengan platform kerja yang stabil.",
    who: ["CLEANER", "TECH-AC"],
    fu: [["Gunakan platform kerja/scaffold rolling untuk pekerjaan plafon", "Pengadaan 2 unit scaffold rolling.", 14]],
  },
  {
    type: "incident", cat: "first_aid", sev: "minor", org: "CATERING", mode: "kitchen",
    areas: ["Stasiun penggorengan", "Area oven"],
    title: "Luka bakar ringan di punggung tangan akibat cipratan minyak panas",
    desc: "Juru masak terkena cipratan minyak panas saat menggoreng ayam. Luka bakar derajat 1 seluas kurang dari 2 cm.",
    action: "Dibilas air mengalir 15 menit, diberi salep luka bakar dan perban oleh petugas P3K. Kembali bekerja.",
    who: ["COOK"],
    fu: [["Sediakan sarung tangan tahan panas di setiap stasiun goreng", "Termasuk apron tahan cipratan.", 10], ["Refresh pelatihan P3K luka bakar", "Peserta: seluruh tim dapur.", 30]],
  },
  {
    type: "incident", cat: "first_aid", sev: "minor", org: "CATERING", mode: "kitchen",
    areas: ["Area persiapan sayur", "Area potong daging"],
    title: "Jari tersayat pisau saat memotong bahan",
    desc: "Asisten dapur tersayat ujung jari saat memotong sayuran. Luka 1 cm, pendarahan ringan.",
    action: "Luka dibersihkan dan diplester kedap air, pekerja memakai sarung tangan sekali pakai sisa shift.",
    who: ["KITCHEN-HELP", "COOK"],
    fu: [["Gunakan sarung tangan anti-sayat (cut-resistant glove)", "Untuk semua stasiun potong.", 14]],
  },
  {
    type: "incident", cat: "first_aid", sev: "minor", org: "FACILITY", mode: "client_fac",
    areas: ["Toilet lantai 2", "Ruang janitor"],
    title: "Cipratan cairan pembersih mengenai mata petugas kebersihan",
    desc: "Saat mengencerkan cairan pembersih konsentrat, cairan memercik ke mata kiri petugas.",
    action: "Mata dibilas dengan eyewash selama 15 menit, kondisi membaik, tidak perlu rujukan medis.",
    who: ["CLEANER"],
    fu: [["Wajibkan kacamata pelindung saat mengencerkan bahan kimia", "Pembagian kacamata ke semua petugas.", 7], ["Ganti dengan sistem dilusi tertutup", "Dispenser dilusi otomatis.", 30]],
  },
  {
    type: "incident", cat: "first_aid", sev: "minor", org: "WAREHOUSE", mode: "warehouse",
    areas: ["Area bongkar muat", "Dock 2"],
    title: "Kaki terjepit roda troli saat bongkar muat",
    desc: "Staf gudang terjepit roda troli bermuatan galon di punggung kaki. Memar tanpa patah.",
    action: "Dikompres es, diperiksa klinik perusahaan, boleh bekerja ringan.",
    who: ["WH-STAFF"],
    fu: [["Wajib sepatu safety berbaja untuk area bongkar muat", "Pengadaan sepatu safety.", 7]],
  },
  {
    type: "incident", cat: "property_damage", sev: "moderate", org: "CATERING", mode: "kitchen",
    areas: ["Pintu gerbang loading dock", "Area parkir armada"],
    title: "Mobil boks pengantar menyenggol pagar area loading dock",
    desc: "Saat mundur ke dock, mobil boks menyenggol pagar besi hingga penyok. Tidak ada korban.",
    action: "Area diberi pembatas, dokumentasi foto dan laporan ke koordinator armada.",
    who: ["DRIVER"],
    inv: { framework: "5WHY", findings: "Spion kiri tidak dilipat dan tidak ada juru parkir saat mundur.", root: "Tidak ada prosedur wajib juru parkir (spotter) saat kendaraan mundur ke dock.", factors: [["Metode", "Tidak ada prosedur spotter saat mundur", true], ["Lingkungan", "Area dock sempit dan penerangan kurang", false]] },
    capa: { title: "Prosedur spotter saat kendaraan mundur ke dock", desc: "Wajibkan spotter dan perbaiki pencahayaan dock.", type: "corrective", actions: ["Terbitkan SOP mundur kendaraan dengan spotter", "Tambah lampu LED di area dock"] },
    fu: [["Perbaikan pagar loading dock", "Dilas dan dicat ulang.", 14], ["Pelatihan defensive driving", "Peserta seluruh driver.", 45]],
  },
  {
    type: "incident", cat: "property_damage", sev: "minor", org: "WAREHOUSE", mode: "warehouse",
    areas: ["Rak pallet C", "Zona penyimpanan kering"],
    title: "Rak pallet penyok tertabrak forklift",
    desc: "Kaki rak pallet bagian bawah tertabrak forklift saat manuver, rak miring sekitar 3 derajat.",
    action: "Pallet di rak dipindahkan, rak dipasang penopang sementara.",
    who: ["WH-STAFF"],
    fu: [["Pasang pelindung kaki rak (column guard)", "Semua rak di lorong utama.", 30]],
  },
  {
    type: "incident", cat: "property_damage", sev: "moderate", org: "CATERING", mode: "kitchen",
    areas: ["Area cuci piring"],
    title: "Mesin pencuci piring korsleting, dapur berhenti 1 hari",
    desc: "Mesin pencuci piring mengeluarkan percikan dan MCB turun. Penggunaan dialihkan ke cuci manual selama perbaikan.",
    action: "Listrik mesin diputus, teknisi MEP memeriksa dan mengganti kontaktor.",
    who: ["TECH-MEP", "KITCHEN-HELP"],
    inv: { framework: "5WHY", findings: "Kabel power mesin terkelupas dan terendam genangan air.", root: "Tidak ada inspeksi berkala kabel dan grounding mesin di area basah.", factors: [["Peralatan", "Kabel terkelupas di area basah", false], ["Metode", "Tidak ada inspeksi grounding berkala", true]] },
    capa: { title: "Inspeksi berkala kelistrikan peralatan area basah", desc: "Cek grounding dan isolasi kabel tiap bulan.", type: "preventive", actions: ["Susun checklist inspeksi listrik peralatan dapur", "Periksa seluruh kabel dan grounding di area basah"] },
    fu: [["Periksa seluruh instalasi listrik dapur", "Pemeriksaan oleh teknisi MEP.", 14]],
  },
  {
    type: "incident", cat: "food_safety", sev: "moderate", org: "CATERING", mode: "kitchen",
    areas: ["Ruang chiller bahan baku", "Cold storage dapur"],
    title: "Suhu chiller bahan baku terbaca 9°C, melebihi batas 5°C",
    desc: "Pengecekan suhu rutin menunjukkan chiller bahan baku protein mencapai 9°C selama sekitar 3 jam.",
    action: "Bahan dipindah ke chiller cadangan, bahan berisiko dibuang, teknisi dipanggil.",
    who: ["QC-OFFICER", "COOK"],
    inv: { framework: "5WHY", findings: "Kondensor chiller berdebu tebal dan pintu sering terbuka saat penerimaan barang.", root: "Perawatan preventif kondensor chiller tidak dijadwalkan.", factors: [["Peralatan", "Kondensor kotor mengurangi pendinginan", false], ["Metode", "Perawatan preventif chiller tidak terjadwal", true], ["Manusia", "Pintu dibiarkan terbuka saat penerimaan barang", false]] },
    capa: { title: "Perawatan preventif chiller dan alarm suhu otomatis", desc: "Servis kuartalan dan alarm suhu terhubung ke ponsel supervisor.", type: "preventive", actions: ["Kontrak servis kuartalan chiller dan freezer", "Pasang alarm suhu otomatis dengan notifikasi"] },
    fu: [["Servis kompresor dan kalibrasi termometer", "Vendor refrigerasi.", 7], ["Pasang alarm suhu otomatis", "Di chiller dan freezer.", 30]],
  },
  {
    type: "incident", cat: "food_safety", sev: "minor", org: "CATERING", mode: "kitchen",
    areas: ["Area packing", "Lini pengemasan"],
    title: "Ditemukan rambut pada lauk di boks makan pelanggan",
    desc: "Pelanggan melaporkan helai rambut pada lauk. Penelusuran ke batch produksi pagi.",
    action: "Batch ditelusuri, permintaan maaf ke pelanggan, boks pengganti dikirim.",
    who: ["PACKER", "QC-OFFICER"],
    fu: [["Wajibkan hairnet dan penutup kepala di area packing", "Termasuk pengunjung.", 7], ["Inspeksi kebersihan APD pre-packing", "Dilakukan QC sebelum lini jalan.", 14]],
  },
  {
    type: "incident", cat: "food_safety", sev: "minor", org: "CATERING", mode: "warehouse",
    areas: ["Area penerimaan barang"],
    title: "Kiriman ayam dari pemasok tiba bersuhu 11°C",
    desc: "Saat penerimaan, suhu inti ayam beku/dingin terukur 11°C, di atas batas penerimaan 4°C.",
    action: "Lot ditolak dan dikembalikan ke pemasok, tercatat dalam laporan penerimaan.",
    who: ["WH-STAFF", "QC-OFFICER"],
    fu: [["Kirim notifikasi ketidaksesuaian ke pemasok dan minta evaluasi rantai dingin", "Evaluasi kendaraan berpendingin pemasok.", 7]],
  },
  {
    type: "incident", cat: "food_safety", sev: "minor", org: "CATERING", mode: "kitchen",
    areas: ["Area persiapan protein"],
    title: "Indikasi kontaminasi silang: talenan sayur dipakai untuk ayam mentah",
    desc: "Saat inspeksi, ditemukan talenan sayur dipakai memotong ayam mentah tanpa dicuci.",
    action: "Talenan dicuci sanitasi, bahan sayur yang tersentuh dibuang.",
    who: ["COOK", "KITCHEN-HELP"],
    fu: [["Terapkan talenan berkode warna", "Merah protein, hijau sayur, biru ikan.", 14]],
  },
  {
    type: "incident", cat: "fire", sev: "minor", org: "FACILITY", mode: "client_fac",
    areas: ["Pantry lantai 4", "Ruang panel"],
    title: "Percikan api pada stop kontak di area pantry klien",
    desc: "Stop kontak overload memercikkan api kecil saat dispenser dan microwave dipakai bersamaan.",
    action: "Listrik pantry diputus dari MCB, api padam sendiri, APAR disiapkan.",
    who: ["TECH-MEP"],
    inv: { framework: "5WHY", findings: "Kabel terminal bertumpuk dan beban melebihi kapasitas stop kontak.", root: "Penggunaan terminal kabel bertingkat tanpa perhitungan beban.", factors: [["Peralatan", "Stop kontak kapasitas rendah", false], ["Manusia", "Beban melebihi kapasitas dari penggunaan bersamaan", true]] },
    capa: { title: "Penataan beban listrik pantry dan penggantian stop kontak", desc: "Hitung beban dan pasang jalur listrik terpisah.", type: "corrective", actions: ["Ganti stop kontak dan pasang MCB khusus pantry", "Edukasi pengguna pantry tentang batas beban"] },
    fu: [["Ganti stop kontak dan periksa MCB", "Oleh teknisi MEP.", 3], ["Thermografi panel listrik", "Pemeriksaan titik panas.", 30]],
  },
  {
    type: "incident", cat: "environment", sev: "minor", org: "CATERING", mode: "kitchen",
    areas: ["Area parkir belakang", "Area penampungan limbah"],
    title: "Tumpahan minyak jelantah saat pengambilan oleh vendor",
    desc: "Jerigen minyak jelantah bocor saat dipindah ke kendaraan vendor, sekitar 10 liter tumpah ke area paving.",
    action: "Diserap dengan pasir dan absorbent, limbah padat dikemas sebagai limbah B3.",
    who: ["KITCHEN-HELP"],
    fu: [["Sediakan spill kit di area penampungan limbah", "Berisi absorbent, sarung tangan, kantong limbah.", 14]],
  },
  {
    type: "incident", cat: "near_miss", sev: "minor", org: "CATERING", mode: "client_cat",
    areas: ["Jalur akses kawasan industri"],
    title: "Hampir terjadi tabrakan saat pengantaran box makan (rem mendadak)",
    desc: "Mobil pengantar harus mengerem mendadak karena kendaraan lain memotong jalur. Muatan sempat bergeser, tidak ada kerusakan.",
    action: "Muatan diperiksa ulang, driver diberi briefing singkat.",
    who: ["DRIVER"],
    fu: [["Briefing rute dan batas kecepatan kawasan industri", "Sertakan titik rawan.", 7]],
  },
];

const OBSERVATIONS: Tpl[] = [
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Pantry dapur", "Ruang istirahat karyawan"], title: "APAR di area pantry kedaluwarsa (segel tidak lengkap)", desc: "Tanda tera pada APAR 3 kg sudah lewat masa uji.", action: "Dilaporkan ke Asset Officer untuk pengisian ulang.", fu: [["Isi ulang atau ganti APAR kedaluwarsa", "Seluruh APAR dapur dicek ulang.", 10, ]] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Lorong menuju pintu darurat", "Area packing"], title: "Jalur evakuasi terhalang tumpukan boks kemasan", desc: "Tumpukan boks kemasan menutup sebagian jalur menuju pintu darurat.", action: "Boks dipindahkan seketika.", fu: [["Kosongkan jalur evakuasi dan cat garis larangan menaruh barang", "Marka kuning di lantai.", 3]] },
  { type: "observation", cat: "unsafe_act", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Area produksi", "Lini packing"], title: "Karyawan tidak memakai penutup kepala di area produksi", desc: "Saat walkthrough ditemukan pekerja tanpa hairnet di area produksi.", action: "Ditegur langsung dan hairnet diberikan.", fu: [["Briefing ulang kewajiban APD higienis", "Seluruh shift.", 5]] },
  { type: "observation", cat: "unsafe_act", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Area oven", "Stasiun panggang"], title: "Pekerja tidak memakai sarung tangan tahan panas saat mengangkat tray", desc: "Tray panas dari oven diangkat dengan lap basah.", action: "Pekerja diingatkan, sarung tangan disediakan.", fu: [["Tambah sarung tangan tahan panas di stasiun oven", "Minimal 4 pasang.", 7]] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "WAREHOUSE", mode: "warehouse", areas: ["Tangga gudang", "Koridor belakang"], title: "Lampu darurat di tangga gudang tidak menyala", desc: "Uji lampu darurat gagal, baterai habis.", action: "Dilaporkan ke teknisi MEP.", fu: [["Ganti baterai atau unit lampu darurat", "Semua titik dicek.", 7]] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Lorong dapur", "Area persiapan"], title: "Kabel ekstensi menjuntai melintasi lorong dapur", desc: "Kabel ekstensi mixer melintang di jalur jalan, berisiko tersandung.", fu: [["Rapikan kabel dengan cable tray/ceiling drop", "Pasang stop kontak tambahan.", 7]] },
  { type: "observation", cat: "good_practice", sev: "info", org: "CATERING", mode: "kitchen", areas: ["Ruang chiller"], title: "Praktik baik: tim dapur mencatat suhu chiller setiap 2 jam", desc: "Pencatatan suhu lengkap dan tertib selama satu pekan, dijadikan contoh bagi shift lain.", fu: [] },
  { type: "observation", cat: "good_practice", sev: "info", org: "CATERING", mode: "kitchen", areas: ["Area armada"], title: "Praktik baik: driver melakukan P2H kendaraan sebelum berangkat", desc: "Seluruh item pemeriksaan harian kendaraan terisi dan ditandatangani.", fu: [] },
  { type: "observation", cat: "unsafe_act", sev: "minor", org: "WAREHOUSE", mode: "warehouse", areas: ["Area galon dan beras"], title: "Pengangkatan beban berat tanpa teknik angkat yang benar", desc: "Karung beras 25 kg diangkat dengan punggung membungkuk.", action: "Diberi contoh teknik angkat yang benar.", fu: [["Pelatihan manual handling untuk staf gudang", "Sesi 1 jam.", 21]] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Area cuci peralatan"], title: "Lantai area cuci tergenang karena saluran buntu", desc: "Air tidak mengalir ke saluran, lantai licin dan berbau.", fu: [["Bersihkan saluran dan grease trap", "Dijadwalkan mingguan.", 5]] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Gudang LPG"], title: "Tabung LPG tidak diikat dengan rantai pengaman", desc: "Dua tabung berdiri tanpa rantai pengaman.", action: "Tabung diikat sementara.", fu: [["Pasang rantai pengaman pada semua tabung LPG", "Termasuk tabung cadangan.", 5]] },
  { type: "observation", cat: "unsafe_act", sev: "moderate", org: "FACILITY", mode: "client_fac", areas: ["Atap gedung", "Area AC outdoor"], title: "Teknisi AC bekerja di ketinggian tanpa full body harness", desc: "Servis unit AC outdoor di tepi atap tanpa harness.", action: "Pekerjaan dihentikan sampai APD lengkap.", fu: [["Briefing dan cek APD kerja ketinggian sebelum pekerjaan", "Checklist wajib diisi.", 3]] },
  { type: "observation", cat: "good_practice", sev: "info", org: "FACILITY", mode: "client_fac", areas: ["Seluruh lantai"], title: "Praktik baik: petugas kebersihan memasang tanda lantai basah secara konsisten", desc: "Tidak ada lantai basah tanpa tanda pada inspeksi tiga hari berturut-turut.", fu: [] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "FACILITY", mode: "client_fac", areas: ["Pos satpam", "Pantry"], title: "Isi kotak P3K sebagian kosong", desc: "Plester, kasa steril dan antiseptik habis.", fu: [["Lengkapi isi kotak P3K dan jadwalkan pengecekan bulanan", "Daftar isi standar.", 7]] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "CATERING", mode: "kitchen", areas: ["Hood dapur utama"], title: "Exhaust hood dapur berlemak tebal", desc: "Filter dan saluran hood penuh lemak, meningkatkan risiko kebakaran.", fu: [["Jadwalkan pembersihan hood tiap 2 minggu", "Vendor pembersihan hood.", 14]] },
  { type: "observation", cat: "unsafe_act", sev: "minor", org: "CATERING", mode: "client_cat", areas: ["Jalur pengantaran"], title: "Menggunakan ponsel saat mengemudi kendaraan operasional", desc: "Terpantau dari laporan klien: driver memegang ponsel saat berkendara.", action: "Driver ditegur dan briefing ulang.", fu: [["Terapkan larangan ponsel saat mengemudi dan tempelkan stiker pengingat", "Sanksi sesuai peraturan perusahaan.", 7]] },
  { type: "observation", cat: "unsafe_condition", sev: "minor", org: "PROJECTS", mode: "fixed", site: "SITE-105-A", project: "PRJ-S04", areas: ["Area genset camp"], title: "Genset camp tanpa pagar pengaman dan tanda bahaya", desc: "Genset 40 kVA di Camp Tol Bandung Selatan dapat dijangkau tanpa penghalang.", fu: [["Pasang pagar pengaman dan rambu bahaya listrik di genset camp", "Pagar besi dan tanda peringatan.", 10]] },
  { type: "observation", cat: "unsafe_act", sev: "minor", org: "PROJECTS", mode: "fixed", site: "SITE-112-A", project: "PRJ-S06", areas: ["Area fit-out dapur"], title: "Pekerja proyek tidak memakai helm di area fit-out", desc: "Pekerja subkontraktor tidak memakai helm saat pemasangan rangka plafon.", action: "Ditegur oleh Site Engineer.", fu: [["Pemeriksaan APD pagi di pintu masuk proyek", "Oleh Site Engineer.", 3]] },
  { type: "observation", cat: "good_practice", sev: "info", org: "PROJECTS", mode: "fixed", site: "SITE-105-A", project: "PRJ-S04", areas: ["Camp Bandung Selatan"], title: "Praktik baik: toolbox meeting harian di Camp Bandung Selatan", desc: "Toolbox meeting 10 menit dilakukan setiap pagi dengan daftar hadir lengkap.", fu: [] },
];

interface Scripted {
  key: string;
  date: string;
  hour: number;
  tpl: Tpl;
  fate: Fate;
  closeDays?: number;
  who?: string[];
  lostDays?: number;
}

const SCRIPTED: Scripted[] = [
  { key: "S1", date: "2025-11-19", hour: 10, fate: "closed", closeDays: 9, tpl: INCIDENTS[1] },
  {
    key: "S2", date: "2026-02-10", hour: 14, fate: "closed", closeDays: 24, lostDays: 14,
    tpl: {
      type: "incident", cat: "lost_time_injury", sev: "lti", org: "FACILITY", mode: "fixed", site: "SITE-104-A",
      areas: ["Lobi lantai dasar — pembersihan kaca"], title: "Petugas kebersihan jatuh dari tangga saat membersihkan kaca lobi",
      desc: "Petugas kebersihan jatuh dari tangga lipat setinggi 2,4 m. Patah tulang pergelangan tangan kanan; dirawat di RS dan cuti sakit 14 hari.",
      action: "Pertolongan pertama, korban dibawa ke RS terdekat, pekerjaan ketinggian dihentikan di seluruh site hingga dievaluasi.",
      who: ["CLEANER", "SPV-CLEAN"],
      inv: { framework: "FISHBONE", findings: "Tangga lipat tanpa pengunci tidak sesuai untuk pekerjaan lebih dari 2 m, lantai lobi basah, tidak ada pendamping.", root: "Tidak ada prosedur dan alat kerja yang sesuai untuk pembersihan kaca di ketinggian (JSA tidak ada).", factors: [["Peralatan", "Tangga lipat tanpa pengunci dan kaki karet aus", false], ["Metode", "Tidak ada JSA/izin kerja untuk pekerjaan ketinggian", true], ["Lingkungan", "Lantai lobi basah saat pembersihan", false], ["Manusia", "Pekerja bekerja sendirian tanpa pendamping", false]] },
      capa: { title: "Standar kerja aman di ketinggian untuk pembersihan kaca", desc: "Alat kerja sesuai, JSA, izin kerja dan pelatihan.", type: "corrective", actions: ["Susun JSA dan SOP pembersihan kaca/ketinggian", "Ganti tangga lipat dengan platform bersertifikat", "Pelatihan kerja di ketinggian untuk seluruh petugas kebersihan"] },
      fu: [["Evaluasi seluruh alat kerja ketinggian di semua site", "Inventarisasi tangga dan platform.", 10], ["Pelatihan kerja di ketinggian untuk 14 petugas", "Sertifikasi internal.", 30], ["Kunjungan dan pemantauan pemulihan korban", "Koordinasi HR dan BPJS Ketenagakerjaan.", 14]],
    },
  },
  {
    key: "S3", date: "2026-03-12", hour: 13, fate: "closed", closeDays: 38,
    tpl: {
      type: "incident", cat: "food_safety", sev: "major", org: "CATERING", mode: "fixed", site: "SITE-101-A",
      areas: ["Kantin Pabrik Cikarang"], title: "Dugaan keracunan makanan: 6 penerima box makan siang mengeluh diare",
      desc: "Enam karyawan klien melaporkan diare dan mual 3-5 jam setelah makan siang. Menu: nasi, ayam goreng, tumis sayur. Sampel makanan retained diamankan.",
      action: "Distribusi menu terkait dihentikan, sampel dikirim ke laboratorium, klien dan dinas kesehatan dikoordinasi, korban diantar ke klinik.",
      who: ["QC-OFFICER", "COOK", "PACKER"],
      inv: { framework: "FISHBONE", findings: "Hasil lab menemukan Bacillus cereus pada nasi. Nasi dimasak pagi dan disimpan pada suhu ruang lebih dari 4 jam saat lonjakan produksi Ramadan.", root: "Nasi tidak didinginkan cepat dan disimpan di atas suhu aman karena kapasitas hot-holding tidak mencukupi saat volume Ramadan.", factors: [["Metode", "Tidak ada batas waktu simpan nasi pada suhu ruang", true], ["Peralatan", "Kapasitas hot-holding dan blast chiller tidak cukup", false], ["Manajemen", "Volume produksi dinaikkan tanpa penambahan kapasitas penyimpanan", false], ["Manusia", "Pencatatan suhu pasca-masak terlewat saat jam sibuk", false]] },
      capa: { title: "Pengendalian suhu dan waktu penyimpanan nasi (HACCP CCP)", desc: "Menetapkan batas kritis waktu/suhu untuk nasi dan menambah kapasitas.", type: "corrective", actions: ["Tetapkan CCP waktu-suhu nasi dan catat tiap 2 jam", "Tambah 2 unit hot-holding dan 1 blast chiller", "Pelatihan HACCP ulang seluruh tim produksi"] },
      fu: [["Kirim laporan investigasi dan tindakan korektif ke klien", "Dikirim ke Pabrik Cikarang dan dinas terkait.", 5], ["Pelatihan HACCP ulang seluruh tim produksi", "Fasilitator eksternal.", 20], ["Tambah kapasitas hot-holding dan blast chiller", "Pengadaan peralatan.", 30], ["Audit mendadak penyimpanan makanan matang", "Oleh QC dan HSE.", 14]],
    },
  },
  { key: "S4", date: "2026-04-21", hour: 11, fate: "cancelled", tpl: { ...INCIDENTS[5], title: "Jari tersayat pisau — laporan ganda (diinput dua kali)", desc: "Laporan duplikat dari insiden yang sama, dibatalkan setelah verifikasi HSE.", fu: [] } },
  { key: "S5", date: "2026-05-08", hour: 15, fate: "closed", closeDays: 21, tpl: INCIDENTS[8] },
  {
    key: "S6", date: "2026-07-14", hour: 9, fate: "closed", closeDays: 19, lostDays: 3,
    tpl: {
      type: "incident", cat: "lost_time_injury", sev: "lti", org: "WAREHOUSE", mode: "warehouse",
      areas: ["Area bongkar muat dock 1"], title: "Staf gudang keseleo pergelangan kaki saat bongkar muat, istirahat 3 hari",
      desc: "Staf gudang menginjak pallet yang tidak rata saat menurunkan karung beras dan terkilir. Dokter menyarankan istirahat 3 hari.",
      action: "Dibawa ke klinik, dikompres dan diperban, istirahat sesuai anjuran dokter.",
      who: ["WH-STAFF", "WH-HEAD"],
      inv: { framework: "5WHY", findings: "Pallet retak dan permukaan area bongkar muat tidak rata; pencahayaan dock kurang.", root: "Tidak ada inspeksi pallet dan permukaan area dock secara berkala.", factors: [["Peralatan", "Pallet retak tetap digunakan", false], ["Metode", "Tidak ada inspeksi berkala pallet dan area dock", true], ["Lingkungan", "Pencahayaan dock kurang", false]] },
      capa: { title: "Inspeksi pallet dan perbaikan permukaan area bongkar muat", desc: "Pallet rusak dikeluarkan dan area dock diratakan.", type: "corrective", actions: ["Afkir pallet retak dan ganti dengan pallet plastik", "Perbaiki permukaan dock dan tambah lampu"] },
      fu: [["Afkir pallet rusak dan buat checklist inspeksi pallet", "Dilakukan mingguan.", 7], ["Perbaiki permukaan dan penerangan dock 1", "Pekerjaan sipil ringan.", 21]],
    },
  },
  {
    key: "S7", date: "2026-08-26", hour: 16, fate: "followup", closeDays: 0,
    tpl: {
      type: "incident", cat: "fire", sev: "major", org: "CATERING", mode: "kitchen",
      areas: ["Panel listrik utama dapur"], title: "Percikan api dan asap dari panel listrik dapur, 12 orang dievakuasi",
      desc: "Terminal MCB di panel utama dapur terbakar kecil dan mengeluarkan asap. Dua belas pekerja dievakuasi, api dipadamkan dengan APAR CO2 sebelum meluas.",
      action: "Listrik dapur diputus, evakuasi ke titik kumpul, APAR CO2 dipakai, produksi dialihkan ke generator cadangan.",
      who: ["COOK", "TECH-MEP", "CHEF-HEAD"],
      inv: { framework: "5WHY", findings: "Baut terminal MCB longgar, terjadi panas berlebih (hot spot) dan isolasi meleleh. Tidak ada thermografi tahunan.", root: "Perawatan panel listrik tidak mencakup pengencangan terminal dan thermografi berkala.", factors: [["Peralatan", "Baut terminal MCB longgar", false], ["Metode", "Tidak ada program thermografi dan pengencangan terminal", true], ["Manajemen", "Penambahan beban dapur tidak diikuti evaluasi kapasitas panel", false]] },
      capa: { title: "Program perawatan panel listrik dan thermografi tahunan", desc: "Pengencangan terminal tiap semester dan thermografi.", type: "corrective", actions: ["Kencangkan semua terminal dan ganti MCB terdampak", "Thermografi seluruh panel utama dan sub-panel", "Evaluasi kapasitas panel terhadap beban dapur"] },
      fu: [["Perbaikan panel utama dan penggantian MCB", "Kontraktor listrik bersertifikat.", 10], ["Thermografi seluruh panel", "Vendor thermografi.", 21], ["Simulasi evakuasi kebakaran dapur", "Seluruh shift.", 30], ["Evaluasi kapasitas panel terhadap beban peralatan", "Laporan teknis.", 45]],
    },
  },
  {
    key: "S8", date: "2026-10-19", hour: 12, fate: "followup", closeDays: 0,
    tpl: {
      type: "incident", cat: "food_safety", sev: "moderate", org: "CATERING", mode: "fixed", site: "SITE-104-A",
      areas: ["Kantin Menara Sudirman"], title: "Benda asing (potongan plastik) ditemukan di nasi box pelanggan",
      desc: "Klien melaporkan potongan plastik keras di nasi box makan siang. Pelanggan tidak terluka. Eskalasi dari keluhan pelanggan.",
      action: "Batch ditarik, foto benda asing diamankan, permintaan maaf dan boks pengganti dikirim.",
      who: ["QC-OFFICER", "PACKER", "KITCHEN-HELP"],
      inv: { framework: "FISHBONE", findings: "Dugaan serpihan tutup wadah bumbu curah yang pecah. Penyelidikan masih berlangsung.", root: "", factors: [["Peralatan", "Tutup wadah bumbu curah retak", false]] },
      fu: [["Jawaban resmi ke klien dan rencana pencegahan", "Dikirim oleh Customer Service.", 5], ["Ganti wadah bumbu curah yang retak", "Inspeksi semua wadah plastik.", 14], ["Pasang magnet/metal detector pada lini packing", "Evaluasi kelayakan.", 30]],
    },
  },
  { key: "S9", date: "2026-11-04", hour: 10, fate: "review", tpl: INCIDENTS[2] },
];

// ---------------------------------------------------------------------------
interface PlannedRecord {
  key: string;
  tpl: Tpl;
  date: string;
  hour: number;
  fate: Fate;
  closeDays: number;
  site: string | null;
  area: string;
  empCodes: string[];
  reporter: UserKey;
  responsible: UserKey;
  lostDays: number;
  scripted: boolean;
}

const OWNER_BY_ORG: Record<string, UserKey> = {
  CATERING: "coordinator", FACILITY: "assetOfficer", WAREHOUSE: "warehouse", PROJECTS: "projectManager",
  HEAD_OFFICE: "manager", HSE: "hse", FINANCE: "hse", HR: "hse", PROCUREMENT: "hse", SALES: "hse",
};
const REPORTERS_BY_ORG: Record<string, UserKey[]> = {
  CATERING: ["executor1", "executor2", "executor3", "coordinator", "verifier", "hse"],
  FACILITY: ["executor2", "assetOfficer", "executor3", "hse"],
  WAREHOUSE: ["warehouse", "purchasing", "hse"],
  PROJECTS: ["projectManager", "hse"],
};

const activeOn = (e: { joinedAt: string; endedAt?: string | null }, d: string) => e.joinedAt <= d && (!e.endedAt || d <= e.endedAt);

function pickEmps(positions: string[] | undefined, date: string, n: number): string[] {
  if (!positions) return [];
  const pool = EMPLOYEES.filter((e) => positions.includes(e.positionCode) && activeOn(e, date));
  if (!pool.length) return [];
  const out: string[] = [];
  for (let i = 0; i < n && out.length < pool.length; i++) {
    const c = rnd.pick(pool);
    if (!out.includes(c.code)) out.push(c.code);
  }
  return out;
}

function afOf(month: string): number {
  const f: Record<string, number> = { "2025-11": 0.78, "2025-12": 0.9, "2026-01": 0.82, "2026-02": 0.88, "2026-03": 1.15, "2026-04": 1.0, "2026-05": 1.04, "2026-06": 1.08, "2026-07": 1.12, "2026-08": 1.16, "2026-09": 1.2, "2026-10": 1.26, "2026-11": 1.3 };
  return f[month] ?? 1;
}

function buildPlan(ctx: DemoCtx): PlannedRecord[] {
  const { today, start, months } = ctx.cal;
  const out: PlannedRecord[] = [];
  const dateIn = (month: string): string => {
    const lo = month === months[0] ? start : `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const lastDay = `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
    const hi = lastDay > today ? today : lastDay;
    const span = dayDiff(lo, hi);
    for (let i = 0; i < 12; i++) {
      const d = ctx.cal.addDays(lo, rnd.int(0, Math.max(0, span)));
      if (dow(d) !== 0) return d;
    }
    return lo;
  };
  const fateFor = (date: string, type: "incident" | "observation", i: number): { fate: Fate; closeDays: number } => {
    const age = dayDiff(date, today);
    const r = rnd.next();
    if (type === "observation") {
      if (age > 14) return { fate: "closed", closeDays: rnd.int(2, 12) };
      if (age > 6) return r < 0.6 ? { fate: "closed", closeDays: Math.min(age - 1, rnd.int(2, 6)) } : { fate: "review", closeDays: 0 };
      return r < 0.5 ? { fate: "new", closeDays: 0 } : { fate: "review", closeDays: 0 };
    }
    if (age > 75) return r < 0.93 ? { fate: "closed", closeDays: rnd.int(7, 30) } : { fate: "followup", closeDays: 0 };
    if (age > 25) return r < 0.75 ? { fate: "closed", closeDays: rnd.int(7, Math.min(24, age - 2)) } : { fate: "followup", closeDays: 0 };
    if (age > 8) return r < 0.45 ? { fate: "followup", closeDays: 0 } : r < 0.8 ? { fate: "review", closeDays: 0 } : { fate: "closed", closeDays: Math.min(age - 1, rnd.int(4, 10)) };
    return r < 0.5 ? { fate: "new", closeDays: 0 } : { fate: "review", closeDays: 0 };
  };
  const make = (tpl: Tpl, date: string, hour: number, fate: Fate, closeDays: number, key: string, scripted: boolean, extra?: { who?: string[]; lostDays?: number }): PlannedRecord => {
    const area = rnd.pick(tpl.areas);
    let site: string | null = tpl.site ?? null;
    if (!site && tpl.mode === "client_fac") site = rnd.pick(FAC_SITES);
    if (!site && tpl.mode === "client_cat") site = rnd.pick(CAT_SITES);
    const nWho = tpl.type === "incident" ? (tpl.who ? rnd.int(1, Math.min(2, tpl.who.length + 1)) : 0) : 0;
    const reporters = REPORTERS_BY_ORG[tpl.org] ?? ["hse"];
    return {
      key, tpl, date, hour, fate, closeDays, site, area,
      empCodes: pickEmps(tpl.who, date, nWho),
      reporter: rnd.pick(reporters) as UserKey,
      responsible: OWNER_BY_ORG[tpl.org] ?? "hse",
      lostDays: extra?.lostDays ?? tpl.lostDays ?? 0,
      scripted,
    };
  };

  for (const sc of SCRIPTED) {
    if (sc.date > today) continue;
    out.push(make(sc.tpl, sc.date, sc.hour, sc.fate, sc.closeDays ?? 0, sc.key, true, { lostDays: sc.lostDays }));
  }
  // random fill (templates that are not scripted-only LTIs)
  const randomIncidents = INCIDENTS;
  for (const month of months) {
    const f = afOf(month);
    const partial = month === months[0] ? 0.75 : month === months[months.length - 1] ? 0.35 : 1;
    const ni = Math.max(1, Math.round(2.4 * f * partial));
    const no = Math.max(2, Math.round(7.5 * f * partial));
    for (let i = 0; i < ni; i++) {
      const tpl = randomIncidents[rnd.int(0, randomIncidents.length - 1)];
      const date = dateIn(month);
      const { fate, closeDays } = fateFor(date, "incident", i);
      out.push(make(tpl, date, rnd.int(6, 21), fate, closeDays, `I${month}-${i}`, false));
    }
    for (let i = 0; i < no; i++) {
      const tpl = OBSERVATIONS[rnd.int(0, OBSERVATIONS.length - 1)];
      const date = dateIn(month);
      const { fate, closeDays } = fateFor(date, "observation", i);
      out.push(make(tpl, date, rnd.int(8, 16), fate, closeDays, `O${month}-${i}`, false));
    }
  }
  out.sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date)));
  // random incidents never carry the LTI/major scripted chains twice: leave as-is, they are plain templates
  return out;
}

const titleOf = (p: PlannedRecord) => {
  // site/area are part of the title only when the template varies by place, so repeated templates stay distinguishable
  return p.tpl.title;
};

// ---------------------------------------------------------------------------
export async function run(ctx: DemoCtx): Promise<void> {
  const t0 = Date.now();
  const tid = ctx.tenantId;
  const { today, start, months } = ctx.cal;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs - 45 * 60000).toISOString();
  const at = (d: string, h: number, m = 0) => {
    const s = ctx.cal.at(d, h, m);
    return s > nowIso ? nowIso : s;
  };
  const plus = (iso: string, hours: number) => {
    const s = new Date(new Date(iso).getTime() + hours * 3600000).toISOString();
    return s > nowIso ? nowIso : s;
  };
  const dateOf = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 10);

  const HSEU = USERS.hse;
  const MGR = USERS.manager;
  const hse = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(HSEU.email, HSEU.password, method, url, body);
  const mgr = <T = any>(method: any, url: string, body?: unknown) => ctx.callAs<T>(MGR.email, MGR.password, method, url, body);

  // =========================================================================
  // 0. Setup: reference data, workflows, frameworks, matrix, lookups
  // =========================================================================
  for (const [code, name, desc] of [
    ["hse_category", "HSE Category", "Tenant-configurable HSE record category catalog (near miss, injury, food safety, etc.)"],
    ["hse_severity", "HSE Severity", "Tenant-configurable HSE severity catalog"],
  ]) {
    // the HSE module reads these two types but no migration registers them
    await ctx.sql(
      `INSERT INTO reference_data_types (code, name, description, allow_tenant_add, is_core, classification)
       VALUES ($1, $2, $3, true, true, 'category') ON CONFLICT (code) DO NOTHING`,
      [code, name, desc],
    );
  }
  for (const [type, items] of [["hse_category", CATEGORIES], ["hse_severity", SEVERITIES]] as const) {
    const have = new Set<string>(((await ctx.call("GET", `/config/reference-data/${type}`)) as any[]).map((x) => x.code));
    let order = 1;
    for (const [code, label] of items) {
      if (!have.has(code)) {
        await ctx.call("POST", `/config/reference-data/${type}`, { code, label, sortOrder: order });
        made("referenceData");
      }
      order++;
    }
  }

  const END_A = (c: string, n: string): WfStep => ({ code: c, name: n, type: "end", terminal: "approved" });
  const END_R = (c: string, n: string): WfStep => ({ code: c, name: n, type: "end", terminal: "rejected" });
  const END_C = (c: string, n: string): WfStep => ({ code: c, name: n, type: "end", terminal: "cancelled" });
  await ensureWorkflow(
    ctx, "hse_record_lifecycle", "Siklus Laporan HSE",
    [
      { code: "REPORTED", name: "Dilaporkan", type: "task", initial: true, role: "HSE_OFFICER" },
      { code: "UNDER_REVIEW", name: "Ditinjau & Diklasifikasi HSE", type: "task", role: "HSE_OFFICER" },
      { code: "IN_FOLLOWUP", name: "Tindak Lanjut Berjalan (Menunggu Persetujuan Penutupan)", type: "approval", role: "OPS_MANAGER" },
      END_A("CLOSED", "Ditutup"),
      END_C("CANCELLED", "Dibatalkan"),
    ],
    [
      ["REPORTED", "UNDER_REVIEW", "review", "Tinjau Laporan"],
      ["REPORTED", "CANCELLED", "cancel", "Batalkan (Laporan Ganda)"],
      ["UNDER_REVIEW", "IN_FOLLOWUP", "assign", "Tetapkan Tindak Lanjut"],
      ["UNDER_REVIEW", "CLOSED", "close", "Tutup Laporan"],
      ["UNDER_REVIEW", "CANCELLED", "cancel", "Batalkan"],
      ["IN_FOLLOWUP", "CLOSED", "close", "Setujui Penutupan"],
    ],
    "hse_record",
  );
  await ensureWorkflow(
    ctx, "hse_permit_lifecycle", "Siklus Izin Kerja (Permit to Work)",
    [
      { code: "REQUESTED", name: "Diajukan — Menunggu Persetujuan HSE", type: "approval", initial: true, role: "HSE_OFFICER" },
      { code: "ACTIVE", name: "Izin Aktif", type: "task", role: "HSE_OFFICER" },
      END_A("CLOSED", "Ditutup (Pekerjaan Selesai)"),
      END_R("REJECTED", "Ditolak"),
      END_C("CANCELLED", "Dibatalkan"),
    ],
    [
      ["REQUESTED", "ACTIVE", "approve", "Setujui & Aktifkan"],
      ["REQUESTED", "REJECTED", "reject", "Tolak"],
      ["ACTIVE", "CLOSED", "close", "Tutup Izin"],
      ["ACTIVE", "CANCELLED", "cancel", "Batalkan"],
    ],
    "hse_permit",
  );

  // frameworks
  const fwList: any[] = await hse("GET", "/hse/advanced/frameworks");
  const fwId: Record<string, Id> = {};
  for (const f of fwList) fwId[f.code] = f.id;
  const causeCats = ["Manusia", "Peralatan", "Metode", "Material", "Lingkungan", "Manajemen"];
  for (const [code, name, desc] of [
    ["5WHY", "Analisis 5 Mengapa (5-Why)", "Menelusuri penyebab dengan bertanya 'mengapa' berulang hingga akar masalah."],
    ["FISHBONE", "Diagram Tulang Ikan (Ishikawa)", "Memetakan penyebab ke dalam kategori Manusia, Peralatan, Metode, Material, Lingkungan, Manajemen."],
  ]) {
    if (!fwId[code]) {
      const f = await hse("POST", "/hse/advanced/frameworks", { code, name, description: desc, causeCategories: causeCats });
      fwId[code] = f.id;
      await ctx.sql(`UPDATE hse_investigation_frameworks SET created_at = $2, updated_at = $2 WHERE id = $1`, [f.id, at(start, 10)]);
      made("investigationFramework");
    }
  }

  // risk matrix 5x5
  let matrix: any = await hse("GET", "/hse/advanced/risk-matrix");
  if (!matrix) {
    const LS = ["Hampir tidak mungkin", "Jarang", "Mungkin", "Sering", "Hampir pasti"];
    const SS = ["Tidak signifikan", "Ringan (P3K)", "Sedang (medis / hilang waktu kerja)", "Berat (cacat / rawat inap)", "Fatal / bencana"];
    const band = (s: number) => (s <= 4 ? "low" : s <= 9 ? "medium" : s <= 16 ? "high" : "extreme");
    const cells: any[] = [];
    for (let l = 1; l <= 5; l++) for (let s = 1; s <= 5; s++) cells.push({ likelihood: l, severity: s, bandCode: band(l * s), score: (l * s).toFixed(2) });
    matrix = await hse("POST", "/hse/advanced/risk-matrices", {
      code: "RM-5X5", name: "Matriks Risiko 5 x 5 PT Sentra Layanan Terpadu",
      likelihoodScale: LS.map((label, i) => ({ value: i + 1, label })),
      severityScale: SS.map((label, i) => ({ value: i + 1, label })),
      cells,
    });
    await ctx.sql(`UPDATE hse_risk_matrices SET created_at = $2, updated_at = $2 WHERE id = $1`, [matrix.id, at(start, 11)]);
    made("riskMatrix");
  }

  // lookups
  const orgRows = await ctx.sql(`SELECT id, name FROM organization_units WHERE tenant_id = $1`, [tid]);
  const orgId: Record<string, Id> = {};
  for (const o of ORG_UNITS) {
    const r = orgRows.find((x) => x.name === o.name);
    if (r) orgId[o.key] = r.id;
  }
  const siteRows = await ctx.sql(`SELECT id, code, name FROM sites WHERE tenant_id = $1`, [tid]);
  const siteId = new Map<string, Id>(siteRows.map((s) => [s.code, s.id]));
  const siteName = new Map<string, string>(siteRows.map((s) => [s.code, s.name]));
  const projRows = await ctx.sql(`SELECT id, code FROM projects WHERE tenant_id = $1`, [tid]);
  const projId = new Map<string, Id>(projRows.map((p) => [p.code, p.id]));
  const userRows = await ctx.sql(`SELECT id, email FROM users WHERE tenant_id = $1`, [tid]);
  const uByEmail = new Map<string, Id>(userRows.map((u) => [u.email, u.id]));
  const uid = (k: UserKey): Id => uByEmail.get(USERS[k].email)!;
  const empRows: any[] = await ctx.call("GET", "/employees");
  const empId = new Map<string, Id>(empRows.map((e) => [e.employeeNumber, e.id]));
  const empName = new Map<string, string>(EMPLOYEES.map((e) => [e.code, e.fullName]));
  const empRole = new Map<string, string>(EMPLOYEES.map((e) => [e.code, e.positionCode]));

  // =========================================================================
  // 1. Records (incidents + observations)
  // =========================================================================
  const plan = buildPlan(ctx);
  const existingRec = new Map<string, Id>(
    (await ctx.sql(
      `SELECT id, title, to_char(occurred_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS d FROM hse_records WHERE tenant_id = $1`,
      [tid],
    )).map((r) => [`${r.title}|${r.d}`, r.id]),
  );
  const recKey = (p: PlannedRecord) => `${titleOf(p)}|${p.date}`;
  const recId = new Map<string, Id>(); // plan key -> record id
  const recMeta = new Map<string, { reported: string; closed: string | null }>();

  let nRec = 0;
  for (const p of plan) {
    const k = recKey(p);
    if (existingRec.has(k)) {
      recId.set(p.key, existingRec.get(k)!);
      continue;
    }
    const tpl = p.tpl;
    const occurred = at(p.date, p.hour, rnd.int(0, 59));
    const reported = plus(occurred, rnd.int(1, 5));
    const org = orgId[tpl.org];
    const locName = p.site ? `${siteName.get(p.site) ?? p.site} — ${p.area}` : `${tpl.mode === "warehouse" ? "Gudang & Logistik" : "Dapur Sentral Cikarang"} — ${p.area}`;
    const body: any = {
      recordType: tpl.type, categoryCode: tpl.cat, severityCode: tpl.sev, occurredAt: occurred,
      title: titleOf(p), summary: tpl.desc.split(". ")[0].slice(0, 200), description: tpl.desc,
      immediateAction: tpl.action ?? null,
      organizationUnitId: org, siteId: p.site ? siteId.get(p.site) ?? null : null,
      projectId: tpl.project ? projId.get(tpl.project) ?? null : null,
      locationDetail: locName, responsibleUserId: uid(p.responsible), responsibleOrgUnitId: org,
    };
    const rec = await hse("POST", "/hse/records", body);
    const id: Id = rec.id;
    recId.set(p.key, id);

    // persons involved
    const roles = ["Korban / pihak terdampak", "Saksi", "Atasan langsung"];
    let ri = 0;
    for (const code of p.empCodes) {
      const eid = empId.get(code);
      if (eid) await hse("POST", `/hse/records/${id}/persons`, { employeeId: eid, personRole: roles[Math.min(ri++, roles.length - 1)] });
    }
    if (tpl.type === "incident" && p.site && tpl.org === "FACILITY" && rnd.chance(0.4)) {
      await hse("POST", `/hse/records/${id}/persons`, { personName: "Petugas keamanan gedung (pihak klien)", personRole: "Saksi eksternal" });
    }

    // lifecycle
    await hse("POST", `/hse/records/${id}/lifecycle`);
    let lastAction = reported;
    const reviewAt = plus(reported, rnd.int(4, 20));
    const assignAt = plus(reviewAt, rnd.int(6, 30));
    const closedAt = p.closeDays > 0 ? plus(at(p.date, 15), p.closeDays * 24 + rnd.int(0, 5)) : null;
    const fus: { id: Id; due: string; done: boolean; completedAt: string | null; createdAt: string }[] = [];

    const makeFollowUps = async (completeAll: boolean, createdAt: string) => {
      const list = tpl.fu;
      for (let i = 0; i < list.length; i++) {
        const [t, d, days] = list[i];
        const due = ctx.cal.addDays(p.date, days);
        const fu = await hse("POST", `/hse/records/${id}/follow-ups`, {
          title: t, description: d, assignedToUserId: uid(i % 2 === 0 ? p.responsible : "hse"), assignedToOrgUnitId: org, dueDate: due,
        });
        // for followup fate keep the last follow-up open; completed ones finish before due date (or close date)
        const keepOpen = !completeAll && i === list.length - 1;
        let completedAt: string | null = null;
        if (!keepOpen) {
          await hse("POST", `/hse/records/${id}/follow-ups/${fu.id}/complete`, { completionNotes: rnd.pick(["Selesai dikerjakan dan diverifikasi HSE.", "Tindakan telah dilaksanakan, bukti foto terlampir.", "Selesai sesuai rencana, area diperiksa ulang."]) });
          const base = at(due, rnd.int(9, 16));
          completedAt = closedAt && base > closedAt ? plus(closedAt, -rnd.int(2, 20)) : base;
          if (completedAt < createdAt) completedAt = plus(createdAt, rnd.int(6, 48));
          if (completedAt > nowIso) completedAt = nowIso;
        }
        fus.push({ id: fu.id, due, done: !keepOpen, completedAt, createdAt });
      }
    };

    if (p.fate === "cancelled") {
      await hse("POST", `/hse/records/${id}/actions/cancel`, { comment: "Laporan duplikat, dibatalkan setelah verifikasi HSE." });
      lastAction = plus(reported, 20);
    } else if (p.fate !== "new") {
      await hse("POST", `/hse/records/${id}/actions/review`, { comment: "Laporan ditinjau dan diklasifikasi oleh HSE." });
      lastAction = reviewAt;
      if (p.fate === "followup" || (p.fate === "closed" && tpl.type === "incident")) {
        await hse("POST", `/hse/records/${id}/actions/assign`, { comment: "Tindak lanjut ditetapkan dan ditugaskan." });
        lastAction = assignAt;
        await makeFollowUps(p.fate === "closed", assignAt);
        if (p.fate === "closed") {
          await mgr("POST", `/hse/records/${id}/actions/close`, { comment: "Tindak lanjut tuntas, laporan ditutup." });
          lastAction = closedAt!;
        }
      } else if (p.fate === "closed") {
        await makeFollowUps(true, reviewAt);
        await hse("POST", `/hse/records/${id}/actions/close`, { comment: "Observasi ditindaklanjuti dan ditutup." });
        lastAction = closedAt!;
      } else if (p.fate === "review" && tpl.type === "observation" && tpl.fu.length && rnd.chance(0.5)) {
        await makeFollowUps(false, reviewAt);
      }
    }

    // backdate
    const upd = lastAction;
    await ctx.sql(
      `UPDATE hse_records SET created_at = $2, reported_at = $2, updated_at = $3, reported_by_user_id = $4, created_by_user_id = $4 WHERE id = $1`,
      [id, reported, upd, uid(p.reporter)],
    );
    for (const f of fus) {
      await ctx.sql(
        `UPDATE hse_follow_ups SET created_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz),
                completed_at = CASE WHEN completed_at IS NOT NULL THEN $3::timestamptz END WHERE id = $1`,
        [f.id, f.createdAt, f.completedAt],
      );
    }
    await ctx.sql(`UPDATE hse_persons_involved SET created_at = $2 WHERE hse_record_id = $1`, [id, reported]);
    await backdateEntities(ctx, [{ id, start: reported, end: p.fate === "closed" || p.fate === "cancelled" ? lastAction : lastAction }]);
    recMeta.set(p.key, { reported, closed: p.fate === "closed" ? closedAt : null });
    existingRec.set(k, id);
    nRec++;
    made(tpl.type === "incident" ? "incident" : "observation");
  }
  await renumberYear(ctx, "hse_records", "record_number", "created_at");
  // metadata for already-existing records (re-run): derive from DB
  for (const p of plan) {
    if (recMeta.has(p.key)) continue;
    const id = recId.get(p.key);
    if (!id) continue;
    const r = (await ctx.sql(`SELECT reported_at, updated_at FROM hse_records WHERE id = $1`, [id]))[0];
    recMeta.set(p.key, { reported: new Date(r.reported_at).toISOString(), closed: p.fate === "closed" ? new Date(r.updated_at).toISOString() : null });
  }

  // =========================================================================
  // 2. Investigations
  // =========================================================================
  const haveInv = new Set<Id>((await ctx.sql(`SELECT hse_record_id FROM hse_investigations WHERE tenant_id = $1`, [tid])).map((r) => r.hse_record_id));
  const invId = new Map<string, Id>(); // plan key -> investigation id
  for (const r of await ctx.sql(`SELECT id, hse_record_id FROM hse_investigations WHERE tenant_id = $1`, [tid])) {
    const k = [...recId.entries()].find(([, v]) => v === r.hse_record_id)?.[0];
    if (k) invId.set(k, r.id);
  }
  for (const p of plan) {
    const inv = p.tpl.inv;
    if (!inv || !(p.fate === "closed" || p.fate === "followup")) continue;
    const id = recId.get(p.key);
    if (!id || haveInv.has(id)) continue;
    const meta = recMeta.get(p.key)!;
    const created = plus(meta.reported, rnd.int(20, 40));
    const created2 = created > nowIso ? nowIso : created;
    const iv = await hse("POST", `/hse/advanced/records/${id}/investigations`, { frameworkId: fwId[inv.framework], leadInvestigatorUserId: uid("hse") });
    const concluding = !!inv.root && (p.fate === "closed" || dayDiff(p.date, today) > 40);
    await hse("PATCH", `/hse/advanced/investigations/${iv.id}`, {
      findings: inv.findings,
      rootCause: inv.root || null,
      contributingFactors: inv.factors.map(([category, description, isRootCause]) => ({ category, description, isRootCause })),
      concluded: concluding || undefined,
    });
    const concludedAt = concluding ? plus(created2, rnd.int(72, 240)) : null;
    await ctx.sql(
      `UPDATE hse_investigations SET created_at = $2, started_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz),
              concluded_at = CASE WHEN concluded_at IS NOT NULL THEN $3::timestamptz END WHERE id = $1`,
      [iv.id, created2, concludedAt && concludedAt > nowIso ? nowIso : concludedAt],
    );
    await backdateEntities(ctx, [{ id: iv.id, start: created2, end: concludedAt }]);
    invId.set(p.key, iv.id);
    made("investigation");
  }

  // =========================================================================
  // 3. Risk assessments (JSA / HIRA)
  // =========================================================================
  interface RaSpec { date: string; type: "jsa" | "hira"; title: string; task: string; l: number; s: number; rl: number; rs: number; controls: [string, string][]; rec?: string; project?: string }
  const RA: RaSpec[] = [
    { date: "2025-11-14", type: "hira", title: "HIRA Dapur Produksi — Area Penggorengan dan Oven", task: "Aktivitas memasak dalam jumlah besar: penggorengan, pemanggangan, pengangkatan tray panas.", l: 4, s: 3, rl: 2, rs: 3, controls: [["Sarung tangan dan apron tahan panas", "ppe"], ["Matras anti-slip dan pembersihan tumpahan segera", "engineering"], ["Pelatihan P3K luka bakar", "administrative"]] },
    { date: "2025-11-21", type: "hira", title: "HIRA Penyimpanan dan Penggunaan LPG Dapur", task: "Penyimpanan, penggantian dan pemakaian tabung LPG 12 kg.", l: 3, s: 5, rl: 2, rs: 4, controls: [["Rantai pengaman dan ventilasi gudang LPG", "engineering"], ["Uji kebocoran bulanan dan penggantian regulator berkala", "administrative"], ["Detektor gas LPG", "engineering"]] },
    { date: "2025-12-03", type: "jsa", title: "JSA Distribusi Makanan ke Site Klien", task: "Pemuatan, pengantaran dan penurunan box makan ke 7 site klien.", l: 3, s: 3, rl: 2, rs: 2, controls: [["P2H kendaraan harian", "administrative"], ["Larangan ponsel saat mengemudi", "administrative"], ["Rute dan jadwal aman", "administrative"]] },
    { date: "2026-01-12", type: "hira", title: "HIRA Gudang — Bongkar Muat dan Operasi Forklift", task: "Forklift, pallet racking dan manual handling.", l: 4, s: 4, rl: 2, rs: 3, controls: [["Marka jalur pejalan kaki dan cermin cembung", "engineering"], ["Lisensi operator forklift (SIO)", "administrative"], ["Sepatu safety dan rompi reflektif", "ppe"]] },
    { date: "2026-02-18", type: "jsa", title: "JSA Pembersihan Kaca Fasad dan Lobi Gedung Klien", task: "Pembersihan kaca di ketinggian lebih dari 2 meter.", l: 4, s: 4, rl: 2, rs: 3, controls: [["Platform kerja/scaffold rolling bersertifikat", "engineering"], ["Izin kerja ketinggian dan pendamping", "administrative"], ["Full body harness", "ppe"]], rec: "S2" },
    { date: "2026-03-18", type: "hira", title: "HIRA Keamanan Pangan — Penyimpanan Nasi dan Makanan Matang", task: "Pendinginan cepat, hot-holding dan distribusi nasi/lauk volume Ramadan.", l: 4, s: 5, rl: 2, rs: 4, controls: [["Batas waktu-suhu CCP dan pencatatan tiap 2 jam", "administrative"], ["Blast chiller dan hot-holding tambahan", "engineering"], ["Pelatihan HACCP ulang", "administrative"]], rec: "S3" },
    { date: "2026-04-07", type: "jsa", title: "JSA Servis AC dan Pekerjaan di Atap", task: "Servis unit AC outdoor dan pekerjaan di tepi atap gedung klien.", l: 3, s: 4, rl: 2, rs: 3, controls: [["Full body harness dengan titik jangkar", "ppe"], ["Izin kerja ketinggian", "administrative"], ["Pagar sementara tepi atap", "engineering"]] },
    { date: "2026-05-14", type: "hira", title: "HIRA Camp Management — Genset, Dapur Lapangan dan Akomodasi", task: "Operasi genset, dapur lapangan, listrik dan akomodasi pekerja.", l: 3, s: 4, rl: 2, rs: 3, controls: [["Pagar pengaman dan rambu genset", "engineering"], ["APAR dan jalur evakuasi akomodasi", "engineering"], ["Toolbox meeting harian", "administrative"]], project: "PRJ-S04" },
    { date: "2026-06-09", type: "hira", title: "HIRA Fit-out Central Kitchen Plant Karawang", task: "Pemasangan peralatan dapur, pengelasan, instalasi listrik dan gas.", l: 4, s: 4, rl: 2, rs: 4, controls: [["Izin kerja panas dan galian", "administrative"], ["APD lengkap dan pemeriksaan APD pagi", "ppe"], ["Pengawasan Site Engineer", "administrative"]], project: "PRJ-S06" },
    { date: "2026-07-22", type: "jsa", title: "JSA Bongkar Muat di Dock Gudang", task: "Penurunan karung beras dan galon dari kendaraan pemasok.", l: 3, s: 3, rl: 2, rs: 2, controls: [["Pallet plastik dan inspeksi pallet", "engineering"], ["Pelatihan manual handling", "administrative"]], rec: "S6" },
    { date: "2026-09-02", type: "hira", title: "HIRA Kelistrikan Dapur dan Panel Utama", task: "Operasi dan perawatan panel listrik, peralatan dapur berdaya besar.", l: 3, s: 4, rl: 2, rs: 3, controls: [["Thermografi tahunan dan pengencangan terminal", "administrative"], ["Evaluasi kapasitas beban panel", "engineering"], ["Simulasi evakuasi kebakaran", "administrative"]], rec: "S7" },
    { date: "2026-09-23", type: "jsa", title: "JSA Mobilisasi Layanan Terminal Tanjung Priok", task: "Mobilisasi tim dan peralatan facility service di area pelabuhan.", l: 3, s: 3, rl: 2, rs: 2, controls: [["Induksi keselamatan pelabuhan", "administrative"], ["Rompi reflektif dan sepatu safety", "ppe"]], project: "PRJ-S05" },
    { date: "2026-10-26", type: "hira", title: "HIRA Benda Asing pada Lini Packing", task: "Pengemasan nasi box, risiko kontaminasi fisik.", l: 3, s: 3, rl: 2, rs: 2, controls: [["Inspeksi visual dan penggantian wadah retak", "administrative"], ["Metal detector / magnet pada lini packing", "engineering"]], rec: "S8" },
  ];
  const haveRA = new Set<string>((await ctx.sql(`SELECT title FROM hse_risk_assessments WHERE tenant_id = $1`, [tid])).map((r) => r.title));
  for (const r of RA) {
    if (haveRA.has(r.title) || r.date > today) continue;
    const key = r.rec ? plan.find((p) => p.key === r.rec)?.key : undefined;
    const hseRecordId = key ? recId.get(key) ?? null : null;
    const ra = await hse("POST", "/hse/advanced/risk-assessments", {
      hseRecordId, projectId: hseRecordId ? null : projId.get(r.project ?? "PRJ-001") ?? null,
      assessmentType: r.type, title: r.title, taskDescription: r.task, matrixId: matrix.id,
      likelihood: r.l, severity: r.s, residualLikelihood: r.rl, residualSeverity: r.rs,
      controls: r.controls.map(([description, controlType]) => ({ description, controlType, residualLikelihood: r.rl, residualSeverity: r.rs })),
    });
    const when = at(r.date, rnd.int(9, 14));
    await ctx.sql(`UPDATE hse_risk_assessments SET assessed_at = $2, created_at = $2, updated_at = $2 WHERE id = $1`, [ra.id, when]);
    await backdateEntities(ctx, [{ id: ra.id, start: when }]);
    made("riskAssessment");
  }

  // =========================================================================
  // 4. Permits to work
  // =========================================================================
  interface PermitSpec { type: string; title: string; org: OrgKey; site?: string; project?: string; location: string; days: number; iso: [string, string][] }
  const PERMITS: PermitSpec[] = [
    { type: "work_at_height", title: "Pembersihan kaca fasad lantai 5-8 — Menara Sudirman", org: "FACILITY", site: "SITE-104-A", location: "Fasad barat Menara Sudirman", days: 2, iso: [["Area di bawah dibatasi dan diberi rambu", "Barikade dan petugas jaga"], ["Titik jangkar harness diperiksa", "Diperiksa supervisor"]] },
    { type: "hot_work", title: "Pekerjaan las — perbaikan rangka rak dapur", org: "CATERING", location: "Dapur Sentral Cikarang — area gudang kering", days: 1, iso: [["Area bebas bahan mudah terbakar", "Radius 5 meter"], ["APAR dan fire watch tersedia", "APAR CO2 2 unit"]] },
    { type: "electrical_isolation", title: "LOTO panel distribusi dapur untuk servis MCB", org: "CATERING", location: "Ruang panel dapur", days: 1, iso: [["Sumber listrik diputus dan dikunci (LOTO)", "Gembok dan tag oleh teknisi MEP"], ["Tegangan nol diverifikasi", "Diukur dengan tang ampere"]] },
    { type: "confined_space", title: "Pembersihan grease trap dan bak penampung limbah dapur", org: "CATERING", location: "Bak grease trap halaman belakang", days: 1, iso: [["Uji gas sebelum masuk", "O2, H2S, LEL"], ["Pengawas luar dan alat penyelamat", "Tripod dan harness"]] },
    { type: "work_at_height", title: "Servis AC split di ketinggian lebih dari 2 meter", org: "FACILITY", site: "SITE-110-A", location: "Kantor Kuningan lantai 6", days: 1, iso: [["Platform kerja stabil", "Scaffold rolling"], ["Harness terpasang", "Diperiksa HSE"]] },
    { type: "excavation", title: "Galian saluran limbah — Plant Karawang", org: "PROJECTS", site: "SITE-112-A", project: "PRJ-S06", location: "Sisi timur Central Kitchen", days: 3, iso: [["Utilitas bawah tanah dipetakan", "Gambar as-built"], ["Penahan dinding galian", "Shoring kayu"]] },
    { type: "hot_work", title: "Pekerjaan las rangka kanopi — Camp Tol Bandung Selatan", org: "PROJECTS", site: "SITE-105-A", project: "PRJ-S04", location: "Area dapur lapangan camp", days: 2, iso: [["Area basah dan bebas bahan mudah terbakar", "Disiram dan dibersihkan"], ["Fire watch 30 menit setelah pekerjaan", "Petugas ditunjuk"]] },
    { type: "electrical_isolation", title: "Penggantian ATS/genset kantor Kuningan", org: "FACILITY", site: "SITE-110-A", location: "Ruang genset basement", days: 1, iso: [["Isolasi dan LOTO sumber PLN dan genset", "Dua titik kunci"], ["Pemberitahuan ke penghuni gedung", "Surat pemberitahuan"]] },
    { type: "general", title: "Mobilisasi peralatan dapur dan kitchen equipment ke site baru", org: "PROJECTS", site: "SITE-112-A", project: "PRJ-S06", location: "Plant Karawang", days: 2, iso: [["Jalur angkut dan crane ditinjau", "Rencana pengangkatan"], ["Banksman dan area aman", "Barikade"]] },
  ];
  const havePermit = new Set<string>((await ctx.sql(`SELECT title || '|' || to_char(valid_from AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS k FROM hse_permits WHERE tenant_id = $1`, [tid])).map((r) => r.k));
  const permitPlan: { spec: PermitSpec; from: string; outcome: "closed" | "rejected" | "active" | "requested" }[] = [];
  let cursor = 0;
  const rp = makeRand(777); // independent of DB state so re-runs produce the same permit plan
  for (let mi = 0; mi < months.length; mi++) {
    const m = months[mi];
    const nP = m === months[months.length - 1] ? 2 : mi % 3 === 0 ? 3 : 2;
    for (let j = 0; j < nP; j++) {
      const spec = PERMITS[(cursor++) % PERMITS.length];
      const lo = m === months[0] ? 12 : 3;
      let d = ctx.cal.day(m, rp.int(lo, 26));
      if (dow(d) === 0) d = ctx.cal.addDays(d, 1);
      if (d > today) continue;
      permitPlan.push({ spec, from: d, outcome: rp.chance(0.07) ? "rejected" : "closed" });
    }
  }
  // current board: one permit active today, one pending approval for tomorrow
  permitPlan.push({ spec: PERMITS[0], from: ctx.cal.addDays(today, -1), outcome: "active" });
  permitPlan.push({ spec: PERMITS[2], from: ctx.cal.addDays(today, 1), outcome: "requested" });
  permitPlan.push({ spec: PERMITS[3], from: ctx.cal.addDays(today, 2), outcome: "requested" });
  permitPlan.sort((a, b) => a.from.localeCompare(b.from));
  for (const pp of permitPlan) {
    const key = `${pp.spec.title}|${pp.from}`;
    if (havePermit.has(key)) continue;
    const sp = pp.spec;
    const to = ctx.cal.addDays(pp.from, sp.days);
    const vfrom = ctx.cal.at(pp.from, 7);
    const vto = ctx.cal.at(to, 17);
    const reqAt = at(ctx.cal.addDays(pp.from, pp.outcome === "requested" ? 0 : -1), 9 + (rnd.int(0, 3)));
    const permit = await hse("POST", "/hse/advanced/permits", {
      permitTypeCode: sp.type, title: sp.title, description: `Permohonan izin kerja untuk ${sp.title.toLowerCase()}.`,
      organizationUnitId: orgId[sp.org], projectId: sp.project ? projId.get(sp.project) ?? null : null, siteId: sp.site ? siteId.get(sp.site) ?? null : null,
      locationDetail: sp.location, validFrom: vfrom, validTo: vto,
      isolationConditions: sp.iso.map(([conditionType, description]) => ({ conditionType, description, verifiedAt: pp.outcome === "requested" ? null : vfrom })),
    });
    const pd = await hse("GET", `/hse/advanced/permits/${permit.id}`);
    if (!pd.permit?.workflowInstanceId) await hse("POST", `/hse/advanced/permits/${permit.id}/start-lifecycle`);
    let end: string | null = null;
    if (pp.outcome === "rejected") {
      await hse("POST", `/hse/advanced/permits/${permit.id}/act`, { actionCode: "reject", comment: "Ditolak: analisis risiko/JSA belum dilampirkan." });
      end = plus(reqAt, 5);
    } else if (pp.outcome !== "requested") {
      await hse("POST", `/hse/advanced/permits/${permit.id}/act`, { actionCode: "approve", comment: "Disetujui, kondisi isolasi telah diverifikasi di lapangan." });
      end = plus(reqAt, 6);
      if (pp.outcome === "closed") {
        await hse("POST", `/hse/advanced/permits/${permit.id}/act`, { actionCode: "close", comment: "Pekerjaan selesai, area diperiksa dan dinormalkan." });
        end = at(to, 17, 30);
      }
    }
    await ctx.sql(`UPDATE hse_permits SET created_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz), requested_by_user_id = $4 WHERE id = $1`, [permit.id, reqAt, end, uid(sp.org === "PROJECTS" ? "projectManager" : sp.org === "FACILITY" ? "assetOfficer" : "coordinator")]);
    await backdateEntities(ctx, [{ id: permit.id, start: reqAt, end }]);
    made("permit");
  }
  await renumberYear(ctx, "hse_permits", "permit_number", "created_at");

  // =========================================================================
  // 5. Inspection / audit programmes
  // =========================================================================
  interface ProgSpec { code: string; name: string; desc: string; type: "inspection" | "audit"; freq: number; org: OrgKey; site?: string; owner: UserKey; first: string; checklist: [string, string, boolean][]; missingLast?: boolean }
  const PROGS: ProgSpec[] = [
    { code: "INS-DAPUR", name: "Inspeksi K3 Dapur Sentral", desc: "Inspeksi dua mingguan kondisi K3 dapur produksi.", type: "inspection", freq: 14, org: "CATERING", owner: "coordinator", first: "2025-11-12", checklist: [["APD", "Seluruh pekerja memakai APD sesuai area?", true], ["LANTAI", "Lantai kering, bersih dan bebas hambatan?", true], ["APAR", "APAR tersedia, tersegel dan belum kedaluwarsa?", true], ["LPG", "Tabung LPG terikat dan tidak bocor?", true], ["HIGIENE", "Kebersihan peralatan dan area persiapan baik?", true], ["EVAKUASI", "Jalur evakuasi bebas hambatan?", true], ["P3K", "Kotak P3K lengkap?", false], ["SUHU", "Suhu chiller/freezer sesuai batas?", true]] },
    { code: "INS-APAR", name: "Inspeksi APAR dan Hydrant", desc: "Pemeriksaan bulanan APAR, hydrant dan alarm kebakaran.", type: "inspection", freq: 30, org: "FACILITY", owner: "assetOfficer", first: "2025-11-14", checklist: [["TERA", "Tera/tanggal kedaluwarsa APAR valid?", true], ["TEKANAN", "Jarum tekanan APAR di zona hijau?", true], ["AKSES", "Akses ke APAR dan hydrant tidak terhalang?", true], ["ALARM", "Alarm dan lampu darurat berfungsi?", true]] },
    { code: "AUD-HACCP", name: "Audit Internal HACCP dan Higiene Sanitasi", desc: "Audit internal dua bulanan pelaksanaan HACCP dan sanitasi.", type: "audit", freq: 60, org: "CATERING", owner: "verifier", first: "2025-11-24", checklist: [["CCP", "Pencatatan CCP (suhu/waktu) lengkap?", true], ["PEST", "Tidak ada tanda hama?", true], ["TRACE", "Traceability bahan baku dan batch terdokumentasi?", true], ["PEMASOK", "Penerimaan bahan sesuai spesifikasi dan suhu?", true], ["TRAINING", "Pelatihan higiene karyawan terkini?", true], ["KALIBRASI", "Termometer dan timbangan terkalibrasi?", false]] },
    { code: "INS-ARMADA", name: "Inspeksi Armada Pengantar Makanan", desc: "Pemeriksaan bulanan kendaraan pengantar dan kebersihan boks.", type: "inspection", freq: 30, org: "CATERING", owner: "executor1", first: "2025-11-17", checklist: [["REM", "Rem, ban dan lampu layak jalan?", true], ["BOX", "Boks muatan bersih dan tertutup rapat?", true], ["SUHU", "Pendingin/insulasi berfungsi?", false], ["DOKUMEN", "STNK/KIR dan SIM driver berlaku?", true]], missingLast: true },
    { code: "INS-GUDANG", name: "Inspeksi Gudang dan Forklift", desc: "Pemeriksaan bulanan rak, pallet, forklift dan penyimpanan.", type: "inspection", freq: 30, org: "WAREHOUSE", owner: "warehouse", first: "2025-11-20", checklist: [["RAK", "Rak pallet tegak dan beban sesuai kapasitas?", true], ["PALLET", "Pallet tidak retak?", true], ["FORKLIFT", "Forklift lolos pemeriksaan harian dan SIO operator berlaku?", true], ["FIFO", "Penyimpanan FIFO/FEFO dan label tertib?", true]], missingLast: true },
    { code: "INS-SITE", name: "Inspeksi Keselamatan Site Klien (Facility)", desc: "Inspeksi bulanan praktik kerja aman petugas facility di site klien.", type: "inspection", freq: 30, org: "FACILITY", owner: "executor2", first: "2025-12-02", checklist: [["APD", "Petugas memakai APD sesuai pekerjaan?", true], ["BAHAN", "Bahan kimia berlabel dan tersimpan benar?", true], ["TANDA", "Tanda lantai basah dan pembatas tersedia?", true], ["KETINGGIAN", "Pekerjaan ketinggian memakai izin dan harness?", true]] },
    { code: "INS-KAMP", name: "Inspeksi Camp dan Akomodasi", desc: "Inspeksi bulanan camp dan dapur lapangan Tol Bandung Selatan.", type: "inspection", freq: 30, org: "PROJECTS", site: "SITE-105-A", owner: "projectManager", first: "2026-02-09", checklist: [["GENSET", "Genset berpagar dan ada rambu bahaya?", true], ["DAPUR", "Dapur lapangan higienis, LPG aman?", true], ["AKOMODASI", "Akomodasi bersih dan jalur evakuasi jelas?", true], ["AIR", "Kualitas air minum/bersih terjaga?", true]] },
  ];
  const progRows: any[] = await hse("GET", "/hse/advanced/programmes");
  const progId = new Map<string, Id>(progRows.map((p) => [p.code, p.id]));
  const findingsOut: { id: Id; date: string; type: string; text: string; org: OrgKey }[] = [];
  const FINDINGS = [
    ["observation", "Beberapa item checklist tidak diisi lengkap pada form harian."],
    ["observation", "Label pada wadah bahan kimia mulai pudar."],
    ["nonconformity", "APAR di area pantry tanpa segel dan tera kedaluwarsa."],
    ["nonconformity", "Jalur evakuasi terhalang tumpukan barang."],
    ["nonconformity", "Pencatatan suhu pasca-masak terlewat pada dua shift."],
    ["nonconformity", "Sarung tangan tahan panas tidak tersedia di semua stasiun."],
    ["nonconformity", "Pallet retak masih digunakan di rak penyimpanan."],
    ["major_nonconformity", "Tidak ada bukti kalibrasi termometer inti lebih dari 12 bulan."],
  ] as const;
  const FINDING_ITEMS: Record<string, string> = {};
  for (const pr of PROGS) {
    let pid = progId.get(pr.code);
    if (!pid) {
      const created = await hse("POST", "/hse/advanced/programmes", {
        code: pr.code, name: pr.name, description: pr.desc, programmeType: pr.type, frequencyDays: pr.freq,
        checklist: pr.checklist.map(([code, question, isMandatory]) => ({ code, question, isMandatory })),
        organizationUnitId: orgId[pr.org], siteId: pr.site ? siteId.get(pr.site) ?? null : null, ownerUserId: uid(pr.owner),
      });
      pid = created.id as Id;
      progId.set(pr.code, pid);
      await ctx.sql(`UPDATE hse_audit_programmes SET created_at = $2, updated_at = $2 WHERE id = $1`, [pid, at(ctx.cal.addDays(pr.first, -7) < start ? start : ctx.cal.addDays(pr.first, -7), 10)]);
      made("auditProgramme");
    }
    const occ: any[] = await hse("GET", `/hse/advanced/programmes/${pid}/occurrences`);
    const haveDates = new Set<string>(occ.map((o) => String(o.scheduledFor).slice(0, 10)));
    // schedule: first, +freq ... up to the first date after today
    const dates: string[] = [];
    for (let d = pr.first; ; d = ctx.cal.addDays(d, pr.freq)) {
      let sd = d;
      if (dow(sd) === 0) sd = ctx.cal.addDays(sd, 1);
      dates.push(sd);
      if (sd > today) break;
    }
    const past = dates.filter((d) => d <= today);
    for (let i = 0; i < dates.length; i++) {
      const sd = dates[i];
      if (haveDates.has(sd)) continue;
      const isFuture = sd > today;
      const isMissing = pr.missingLast && i === past.length - 1;
      const o = await hse("POST", `/hse/advanced/programmes/${pid}/occurrences`, { scheduledFor: sd });
      let performedAt: string | null = null;
      if (!isFuture && !isMissing) {
        const results = pr.checklist.map(([code, , mandatory]) => {
          const failChance = pr.code === "AUD-HACCP" ? 0.12 : 0.08;
          const r = rnd.chance(failChance) ? "fail" : !mandatory && rnd.chance(0.3) ? "not_applicable" : "pass";
          return { itemCode: code, result: r, note: r === "fail" ? "Perlu tindak lanjut" : null };
        });
        if (!mandatoryComplete(pr, results)) throw new Error("checklist incomplete");
        await hse("POST", `/hse/advanced/occurrences/${o.id}/complete`, { results, notes: rnd.pick(["Inspeksi berjalan lancar.", "Temuan telah dibahas dengan penanggung jawab area.", "Kondisi umum baik, beberapa catatan perbaikan.", null as any]) ?? undefined });
        performedAt = at(ctx.cal.addDays(sd, rnd.int(0, 1)), rnd.int(9, 15));
        const fails = results.filter((r) => r.result === "fail");
        for (const f of fails) {
          const sev = pr.code === "AUD-HACCP" && rnd.chance(0.15) ? FINDINGS[7] : rnd.pick(FINDINGS.slice(0, 7));
          const fin = await hse("POST", `/hse/advanced/occurrences/${o.id}/findings`, { findingType: sev[0], checklistItemCode: f.itemCode, description: `${sev[1]} (item ${f.itemCode})` });
          findingsOut.push({ id: fin.id, date: dateOf(performedAt), type: sev[0], text: `${sev[1]} (item ${f.itemCode})`, org: pr.org });
          await ctx.sql(`UPDATE hse_audit_findings SET created_at = $2 WHERE id = $1`, [fin.id, plus(performedAt, 1)]);
          made("auditFinding");
        }
      }
      const createdAt = at(ctx.cal.addDays(sd, -7) < start ? start : ctx.cal.addDays(sd, -7), 9);
      await ctx.sql(
        `UPDATE hse_audit_occurrences SET created_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz),
                performed_at = CASE WHEN performed_at IS NOT NULL THEN $3::timestamptz END WHERE id = $1`,
        [o.id, createdAt > nowIso ? nowIso : createdAt, performedAt],
      );
      made("auditOccurrence");
    }
    await ctx.sql(`UPDATE hse_audit_programmes SET last_scheduled_for = (SELECT max(scheduled_for) FROM hse_audit_occurrences WHERE programme_id = $1) WHERE id = $1`, [pid]);
  }
  // findings from earlier runs (for CAPA creation on re-run)
  {
    findingsOut.length = 0;
    for (const r of await ctx.sql(
      `SELECT f.id, f.finding_type, f.description, o.performed_at FROM hse_audit_findings f JOIN hse_audit_occurrences o ON o.id = f.occurrence_id
        WHERE f.tenant_id = $1 AND f.finding_type <> 'observation' ORDER BY o.performed_at`, [tid],
    )) findingsOut.push({ id: r.id, date: dateOf(new Date(r.performed_at).toISOString()), type: r.finding_type, text: r.description, org: "CATERING" });
    findingsOut.sort((a, b) => a.date.localeCompare(b.date));
  }

  // =========================================================================
  // 6. Monitoring points + readings
  // =========================================================================
  interface PointSpec { code: string; name: string; param: string; unit: string; min?: string; max?: string; org: OrgKey; every: number; gen: (i: number) => number; breaches: Record<string, number>; decimals: number }
  const POINTS: PointSpec[] = [
    { code: "MP-CHILLER-01", name: "Suhu Chiller Bahan Baku Dapur Sentral", param: "temperature", unit: "°C", min: "0.0", max: "5.0", org: "CATERING", every: 3, decimals: 1, gen: () => 2.2 + rnd.next() * 2.3, breaches: { "2026-03-14": 9.0, "2026-06-23": 6.2, "2026-09-08": 5.6 } },
    { code: "MP-FREEZER-01", name: "Suhu Freezer Daging dan Ayam", param: "temperature", unit: "°C", min: "-25.0", max: "-15.0", org: "CATERING", every: 3, decimals: 1, gen: () => -20.5 + rnd.next() * 3.0, breaches: { "2026-04-27": -12.8, "2026-08-14": -13.9 } },
    { code: "MP-HOTHOLD-01", name: "Suhu Hot-Holding Makanan Siap Saji", param: "temperature", unit: "°C", min: "60.0", max: "90.0", org: "CATERING", every: 3, decimals: 1, gen: () => 66 + rnd.next() * 12, breaches: { "2026-03-11": 54.5, "2026-03-27": 57.0 } },
    { code: "MP-NOISE-01", name: "Kebisingan Area Produksi Dapur", param: "noise", unit: "dB(A)", max: "85.0", org: "CATERING", every: 7, decimals: 1, gen: () => 76 + rnd.next() * 8, breaches: { "2026-05-22": 87.5 } },
    { code: "MP-WATER-01", name: "Sisa Klorin Air Bersih Dapur", param: "chlorine_residual", unit: "mg/L", min: "0.20", max: "1.00", org: "CATERING", every: 7, decimals: 2, gen: () => 0.35 + rnd.next() * 0.4, breaches: { "2026-07-24": 0.12 } },
    { code: "MP-CO-01", name: "Kadar CO Ruang Dapur", param: "co_ppm", unit: "ppm", max: "25.0", org: "CATERING", every: 7, decimals: 1, gen: () => 5 + rnd.next() * 10, breaches: { "2026-08-26": 31.0 } },
  ];
  const ptRows: any[] = await hse("GET", "/hse/advanced/monitoring-points");
  const ptId = new Map<string, Id>(ptRows.map((p) => [p.code, p.id]));
  const breachReadings: { id: Id; date: string; point: string; text: string }[] = [];
  for (const pt of POINTS) {
    let pid = ptId.get(pt.code);
    if (!pid) {
      const c = await hse("POST", "/hse/advanced/monitoring-points", {
        code: pt.code, name: pt.name, parameterCode: pt.param, unit: pt.unit, thresholdMin: pt.min ?? null, thresholdMax: pt.max ?? null, organizationUnitId: orgId[pt.org],
      });
      pid = c.id as Id;
      ptId.set(pt.code, pid);
      await ctx.sql(`UPDATE hse_monitoring_points SET created_at = $2, updated_at = $2 WHERE id = $1`, [pid, at(start, 12)]);
      made("monitoringPoint");
    }
    const have = new Set<number>((await ctx.sql(`SELECT measured_at FROM hse_monitoring_readings WHERE point_id = $1`, [pid])).map((r) => new Date(r.measured_at).getTime()));
    let i = 0;
    for (let d0 = ctx.cal.addDays(start, 1); d0 <= today; d0 = ctx.cal.addDays(d0, pt.every), i++) {
      // a planned breach falling inside this reading interval is measured on its own day
      const bKey = Object.keys(pt.breaches).find((k) => k >= d0 && k < ctx.cal.addDays(d0, pt.every));
      const d = bKey ?? d0;
      const forced = bKey ? pt.breaches[bKey] : undefined;
      const v = forced !== undefined ? forced : pt.gen(i);
      const measured = at(d, 7, 30);
      if (measured > nowIso) continue;
      if (have.has(new Date(measured).getTime())) continue;
      const rd = await hse("POST", `/hse/advanced/monitoring-points/${pid}/readings`, { measuredAt: measured, value: v.toFixed(pt.decimals), note: forced !== undefined ? "Di luar batas — tindakan korektif dilakukan" : null });
      await ctx.sql(`UPDATE hse_monitoring_readings SET created_at = $2 WHERE id = $1`, [rd.id, measured]);
      made("monitoringReading");
    }
  }
  // breach readings of earlier runs (for CAPA creation on re-run)
  {
    breachReadings.length = 0;
    for (const r of await ctx.sql(
      `SELECT r.id, r.measured_at, r.value, p.name, p.unit FROM hse_monitoring_readings r JOIN hse_monitoring_points p ON p.id = r.point_id
        WHERE r.tenant_id = $1 AND r.is_breach ORDER BY r.measured_at`, [tid],
    )) breachReadings.push({ id: r.id, date: dateOf(new Date(r.measured_at).toISOString()), point: r.name, text: `${r.name}: ${r.value} ${r.unit}` });
  }

  // =========================================================================
  // 7. CAPAs — created in date order so numbers follow time
  // =========================================================================
  interface CapaSpec { title: string; desc: string; type: "corrective" | "preventive"; date: string; root: string; anchor: Record<string, Id | null>; owner: UserKey; actions: string[]; status: "open" | "in_progress" | "verification" | "closed" }
  const capaPlan: CapaSpec[] = [];
  const statusByAge = (date: string, forced?: CapaSpec["status"]): CapaSpec["status"] => {
    if (forced) return forced;
    const age = dayDiff(date, today);
    const r = rnd.next();
    if (age > 120) return r < 0.9 ? "closed" : "in_progress";
    if (age > 60) return r < 0.6 ? "closed" : r < 0.8 ? "verification" : "in_progress";
    if (age > 25) return r < 0.25 ? "closed" : r < 0.45 ? "verification" : r < 0.8 ? "in_progress" : "open";
    return r < 0.6 ? "open" : "in_progress";
  };
  for (const p of plan) {
    const t = p.tpl;
    if (!t.capa || !t.inv) continue;
    const rid = recId.get(p.key);
    const iid = invId.get(p.key);
    if (!rid || !iid || !(p.fate === "closed" || p.fate === "followup")) continue;
    const meta = recMeta.get(p.key)!;
    const date = dateOf(plus(meta.reported, 24 * 5));
    if (date > today) continue;
    const forced: CapaSpec["status"] | undefined = p.fate === "closed" ? "closed" : p.key === "S7" ? "in_progress" : undefined;
    capaPlan.push({ title: t.capa.title, desc: t.capa.desc, type: t.capa.type, date, root: t.inv.root, anchor: { hseRecordId: rid, investigationId: iid }, owner: p.responsible, actions: t.capa.actions, status: statusByAge(date, forced) });
  }
  const sig = findingsOut.filter((f) => f.type !== "observation");
  for (let i = 0; i < sig.length; i++) {
    const f = sig[i];
    // not every finding becomes a CAPA: pick by a stable hash so re-runs choose the same ones
    if ((f.text.length + Number(f.date.slice(-2)) + (f.type === "major_nonconformity" ? 0 : 1)) % 3 !== 0 && f.type !== "major_nonconformity") continue;
    const date = ctx.cal.addDays(f.date, 2);
    if (date > today) continue;
    capaPlan.push({
      title: `Tindak lanjut temuan inspeksi — ${f.text.replace(/\.$/, "")}`.slice(0, 160), desc: `CAPA atas temuan inspeksi/audit tanggal ${f.date}.`, type: "corrective", date,
      root: "Standar belum diterapkan konsisten di lapangan; pengawasan harian belum terjadwal.", anchor: { auditFindingId: f.id }, owner: f.type === "major_nonconformity" ? "manager" : "coordinator",
      actions: ["Perbaiki temuan dan dokumentasikan", "Briefing ulang tim terkait standar yang dilanggar"], status: statusByAge(date),
    });
  }
  for (const b of breachReadings) {
    if (dayDiff(b.date, today) < 0) continue;
    const date = ctx.cal.addDays(b.date, 1);
    if (date > today) continue;
    capaPlan.push({
      title: `Penanganan penyimpangan pemantauan — ${b.point} (${b.date})`.slice(0, 160), desc: `Penyimpangan: ${b.text}. Tindakan korektif dan pencegahan.`, type: "corrective", date,
      root: "Alat/proses bergeser dari batas operasi; dicatat dan dikoreksi.", anchor: { monitoringReadingId: b.id }, owner: "coordinator",
      actions: ["Periksa dan kalibrasi alat/proses terkait", "Catat tindakan koreksi pada log pemantauan"], status: statusByAge(date),
    });
  }
  capaPlan.sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : a.date.localeCompare(b.date)));
  const haveCapa = new Set<string>((await ctx.sql(`SELECT title FROM hse_capas WHERE tenant_id = $1`, [tid])).map((r) => r.title));
  for (const c of capaPlan) {
    if (haveCapa.has(c.title)) continue;
    haveCapa.add(c.title);
    const createdAt = at(c.date, rnd.int(9, 14));
    const due = ctx.cal.addDays(c.date, rnd.int(21, 45));
    const cap = await hse("POST", "/hse/advanced/capas", {
      title: c.title, description: c.desc, ...c.anchor, rootCause: c.root, actionType: c.type, ownerUserId: uid(c.owner), dueDate: due,
    });
    const aIds: { id: Id; due: string; done: boolean }[] = [];
    for (let i = 0; i < c.actions.length; i++) {
      const adue = ctx.cal.addDays(c.date, 7 + i * 10 + rnd.int(0, 5));
      const a = await hse("POST", `/hse/advanced/capas/${cap.id}/actions`, { description: c.actions[i], ownerUserId: uid(i === 0 ? c.owner : "hse"), dueDate: adue });
      const done = c.status === "closed" || c.status === "verification" || (c.status === "in_progress" && i === 0 && c.actions.length > 1);
      if (done) await hse("POST", `/hse/advanced/capas/${cap.id}/actions/${a.id}/complete`, { completionNotes: "Selesai dikerjakan, bukti dilampirkan." });
      aIds.push({ id: a.id, due: adue, done });
    }
    let closedAt: string | null = null;
    if (c.status === "in_progress" || c.status === "verification" || c.status === "closed") await hse("PATCH", `/hse/advanced/capas/${cap.id}/status`, { status: "in_progress" });
    if (c.status === "verification" || c.status === "closed") await hse("PATCH", `/hse/advanced/capas/${cap.id}/status`, { status: "verification" });
    if (c.status === "closed") {
      await mgr("PATCH", `/hse/advanced/capas/${cap.id}/status`, { status: "closed", verificationNotes: "Efektivitas tindakan diverifikasi di lapangan; tidak ada kejadian berulang." });
      closedAt = plus(createdAt, 24 * (aIds.length * 8 + rnd.int(8, 18)));
    }
    const upd = closedAt ?? (c.status === "open" ? createdAt : plus(createdAt, 24 * rnd.int(5, 15)));
    await ctx.sql(
      `UPDATE hse_capas SET created_at = $2, updated_at = $3,
              closed_at = CASE WHEN closed_at IS NOT NULL THEN $4::timestamptz END, verified_at = CASE WHEN verified_at IS NOT NULL THEN $4::timestamptz END WHERE id = $1`,
      [cap.id, createdAt, upd > nowIso ? nowIso : upd, closedAt && closedAt > nowIso ? nowIso : closedAt],
    );
    for (const a of aIds) {
      const comp = a.done ? at(a.due, rnd.int(9, 16)) : null;
      await ctx.sql(
        `UPDATE hse_capa_actions SET created_at = $2, updated_at = COALESCE($3::timestamptz, $2::timestamptz),
                completed_at = CASE WHEN completed_at IS NOT NULL THEN $3::timestamptz END WHERE id = $1`,
        [a.id, createdAt, comp && comp > nowIso ? nowIso : comp],
      );
    }
    await backdateEntities(ctx, [{ id: cap.id, start: createdAt, end: closedAt }]);
    made("capa");
  }
  await renumberYear(ctx, "hse_capas", "capa_number", "created_at");

  // =========================================================================
  // 8. Monthly safety KPI snapshots
  // =========================================================================
  const lostDaysByMonth: Record<string, number> = {};
  for (const p of plan) if (p.lostDays > 0) lostDaysByMonth[p.date.slice(0, 7)] = (lostDaysByMonth[p.date.slice(0, 7)] ?? 0) + p.lostDays;
  const haveSnap = new Set<string>((await ctx.sql(`SELECT window_start::text || '|' || window_end::text || '|' || coalesce(organization_unit_id::text, '') AS k FROM hse_indicator_snapshots WHERE tenant_id = $1`, [tid])).map((r) => r.k));
  const headcount = (d: string, org?: OrgKey) => EMPLOYEES.filter((e) => activeOn(e, d) && (!org || e.org === org)).length;
  const monthsUpTo = (m: string) => months.filter((x) => x <= m);
  for (let mi = 0; mi < months.length; mi++) {
    const m = months[mi];
    const [y, mo] = m.split("-").map(Number);
    const lastDay = `${m}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`;
    const we = lastDay > today ? today : lastDay;
    // tenant-wide: cumulative since go-live (a single month can show more CAPA closures than openings, which the
    // snapshot table's own closure check constraint refuses); Catering / Facility: trailing 3 months, last quarter only
    const scopes: { scope: OrgKey | null; ws: string }[] = [{ scope: null, ws: start }];
    if (mi >= months.length - 3) {
      const m0 = months[Math.max(0, mi - 2)];
      const ws3 = m0 === months[0] ? start : `${m0}-01`;
      scopes.push({ scope: "CATERING", ws: ws3 }, { scope: "FACILITY", ws: ws3 });
    }
    for (const { scope, ws } of scopes) {
      if (haveSnap.has(`${ws}|${we}|${scope ? orgId[scope] : ""}`)) continue;
      const lostDays = scope === null ? monthsUpTo(m).reduce((a, x) => a + (lostDaysByMonth[x] ?? 0), 0) : 0;
      const days = Math.max(1, Math.round(dayDiff(ws, we) * 26 / 30));
      const exposure = (headcount(we, scope ?? undefined) * 8 * days).toFixed(2);
      const snap = await hse("POST", "/hse/advanced/indicators", {
        windowStart: ws, windowEnd: we, organizationUnitId: scope ? orgId[scope] : null, exposureHours: exposure, lostDays,
        nearMissCategoryCode: "near_miss", lostTimeSeverityCode: "lti",
      });
      const at2 = we >= today ? nowIso : at(ctx.cal.addDays(we, 1), 8);
      await ctx.sql(`UPDATE hse_indicator_snapshots SET created_at = $2 WHERE id = $1`, [snap.id, at2 > nowIso ? nowIso : at2]);
      made("indicatorSnapshot");
    }
  }

  ctx.log(S, `created: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing new"} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  void nRec;
  void nowMs;
}

function mandatoryComplete(pr: { checklist: [string, string, boolean][] }, results: { itemCode: string }[]): boolean {
  const have = new Set(results.map((r) => r.itemCode));
  return pr.checklist.filter(([, , m]) => m).every(([c]) => have.has(c));
}
