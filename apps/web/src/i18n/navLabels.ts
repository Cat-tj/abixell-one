/**
 * Nav labels per served menu code (`nav-*`).
 *
 * `MenuNode.name` comes from the seed migration, so the shell cannot translate
 * it by rewriting the payload. The dictionary is keyed by `code`, which is
 * stable and locked in code, and `en` is kept here so a tenant override can be
 * told apart from the seed label: when the served name differs from `en`, the
 * tenant renamed the menu and that rename wins in every locale.
 *
 * Adding a page means adding its row here; a missing row falls back to the
 * served name, never to a raw key.
 */

export interface NavLabel {
  en: string;
  id: string;
  descriptionId?: string;
}

export const NAV_LABELS: Record<string, NavLabel> = {
  // Overview
  "nav-overview": {
    en: "Overview",
    id: "Ringkasan",
    descriptionId: "Jangkauan cepat ke modul, daftar tugas, dan status sistem.",
  },

  // Groups
  "nav-operations": {
    en: "Operations",
    id: "Operasional",
    descriptionId: "Pekerjaan harian, antrean, layanan, dan survei.",
  },
  "nav-enterprise-core": {
    en: "Enterprise Core",
    id: "Inti Perusahaan",
    descriptionId: "Pelanggan, orang, sumber daya, keuangan, keselamatan, dan pengiriman.",
  },
  "nav-governance": {
    en: "Governance & Platform",
    id: "Tata Kelola & Platform",
    descriptionId: "Pelaporan, administrasi, dan tata kelola tenant.",
  },

  // Operations
  "nav-customer_complaint": { en: "Customer Complaints", id: "Keluhan Pelanggan" },
  "nav-customer_complaint-complaints": {
    en: "Complaints",
    id: "Keluhan",
    descriptionId: "Terima, telusuri, dan selesaikan keluhan pelanggan.",
  },
  "nav-customer_complaint-complaints-admin": {
    en: "Complaint Configuration",
    id: "Konfigurasi Keluhan",
    descriptionId: "Kategori, SLA, dan jalur eskalasi keluhan.",
  },
  "nav-customer_complaint-queue": {
    en: "Queue",
    id: "Antrean",
    descriptionId: "Keluhan yang menunggu penanganan, diurutkan berdasarkan prioritas dan SLA.",
  },
  "nav-customer_complaint-verification": {
    en: "Verification",
    id: "Verifikasi",
    descriptionId: "Tinjau dan verifikasi penyelesaian keluhan sebelum ditutup.",
  },
  "nav-customer_complaint-management": {
    en: "Management",
    id: "Manajemen",
    descriptionId: "Ringkasan dan pengawasan atas seluruh keluhan pelanggan.",
  },
  "nav-customer_complaint-service-quality": {
    en: "Service Quality",
    id: "Kualitas Layanan",
    descriptionId: "Metrik kualitas layanan yang ditarik dari riwayat keluhan.",
  },
  "nav-survey_assessment": { en: "Surveys & Assessments", id: "Survei & Penilaian" },
  "nav-survey_assessment-my-surveys": {
    en: "My Surveys",
    id: "Survei saya",
    descriptionId: "Survei yang ditugaskan kepada Anda. Isi lalu kirim.",
  },
  "nav-survey_assessment-surveys": {
    en: "Surveys",
    id: "Survei",
    descriptionId: "Kirim survei, kumpulkan tanggapan, dan tindak lanjuti.",
  },
  "nav-service_operations": { en: "Service Operations", id: "Operasional Layanan" },
  "nav-service_operations-my-work": {
    en: "My Work",
    id: "Pekerjaan saya",
    descriptionId: "Pekerjaan yang ditugaskan kepada Anda, status, dan tindakan yang diperlukan.",
  },
  "nav-service_operations-work-orders": {
    en: "Work Orders",
    id: "Perintah Kerja",
    descriptionId: "Rencanakan, tugaskan, dan pantau pekerjaan yang diselesaikan tim Anda.",
  },
  "nav-service_operations-customer-invoices": {
    en: "Customer Invoices",
    id: "Faktur Pelanggan",
    descriptionId: "Lihat semua faktur yang dibuat dari Perintah Kerja beserta nilai dan status pembayarannya.",
  },
  "nav-service_operations-service-types": {
    en: "Service Types",
    id: "Jenis Layanan",
    descriptionId: "Tentukan layanan yang dapat digunakan ulang oleh tim Anda.",
  },
  "nav-service_operations-catering": {
    en: "Catering",
    id: "Katering",
    descriptionId: "Rencanakan menu, resep, dan pesanan makan, lihat kebutuhan belanja, serta lacak batch makanan.",
  },
  "nav-service_operations-service-packs": {
    en: "Service Packs",
    id: "Paket Layanan",
    descriptionId: "Aktifkan preset layanan Katering, Tata Graha, Camp, dan Fasilitas.",
  },
  "nav-service_operations-service-optimization": {
    en: "Service Optimization",
    id: "Optimasi Layanan",
    descriptionId: "Buat usulan penugasan, periksa alasannya, lalu terapkan atau tolak secara eksplisit.",
  },

  // Enterprise core
  "nav-customer_commercial": { en: "Customers & Commercial", id: "Pelanggan & Komersial" },
  "nav-customer_commercial-customer-commercial": {
    en: "Customers",
    id: "Pelanggan",
    descriptionId: "Kelola pelanggan, kontak, kontrak, proyek, lokasi, dan tautan layanan.",
  },
  "nav-customer_commercial-sales-pipeline": {
    en: "Sales & Pipeline",
    id: "Penjualan & Pipeline",
    descriptionId: "Peluang, tahapan pipeline, penawaran, dan daftar harga.",
  },
  "nav-workforce": { en: "Workforce & HR", id: "Tenaga Kerja & SDM" },
  "nav-workforce-employees": {
    en: "Employees",
    id: "Karyawan",
    descriptionId: "Siapa yang bekerja di sini, dan di mana posisinya.",
  },
  "nav-workforce-workforce-attendance": {
    en: "Attendance & Rosters",
    id: "Kehadiran & Jadwal",
    descriptionId: "Rencanakan shift dan jadwal, lalu catat hasil kehadiran.",
  },
  "nav-workforce-workforce-leave-overtime": {
    en: "Leave & Overtime",
    id: "Cuti & Lembur",
    descriptionId: "Kelola saldo cuti, permintaan, lembur, dan persetujuannya.",
  },
  "nav-workforce-workforce-payroll": {
    en: "Payroll",
    id: "Penggajian",
    descriptionId: "Atur kebijakan statutori, profil gaji, proses penggajian, dan slip gaji.",
  },
  "nav-workforce-workforce-recruitment": {
    en: "Recruitment",
    id: "Rekrutmen",
    descriptionId: "Publikasikan lowongan dan gerakkan kandidat melewati proses seleksi.",
  },
  "nav-workforce-workforce-performance": {
    en: "Talent & Performance",
    id: "Talenta & Kinerja",
    descriptionId: "Kembangkan kompetensi, pelatihan, kinerja, dan jalur karier.",
  },
  "nav-workforce-workforce-planning": {
    en: "Workforce Planning",
    id: "Perencanaan Tenaga Kerja",
    descriptionId: "Bandingkan skenario jumlah dan biaya sebelum keputusan.",
  },
  "nav-warehouse_management-items": {
    en: "Items & Stock",
    id: "Barang & Stok",
    descriptionId: "Apa yang ada, berapa jumlahnya, dan apa yang bergerak.",
  },
  "nav-procurement_management-suppliers": {
    en: "Suppliers",
    id: "Pemasok",
    descriptionId: "Dari siapa Anda membeli.",
  },
  "nav-procurement_management-purchasing": {
    en: "Purchasing",
    id: "Pembelian",
    descriptionId: "Minta, pesan, dan terima kebutuhan tim Anda.",
  },
  "nav-warehouse_management": { en: "Warehouse Management", id: "Manajemen Gudang" },
  "nav-warehouse_management-scm-warehouses": {
    en: "Warehouses & Tracking",
    id: "Gudang & Pelacakan",
    descriptionId: "Topologi multi-gudang, lokasi bin, batch/lot, dan pelacakan serial.",
  },
  "nav-warehouse_management-scm-operations": {
    en: "Stock Operations",
    id: "Operasi Stok",
    descriptionId: "Peringatan pemesanan ulang, reservasi stok, transfer gudang, dan stock opname.",
  },
  "nav-warehouse_management-scm-valuation": {
    en: "Valuation & Landed Cost",
    id: "Valuasi & Biaya Angkut",
    descriptionId: "Lapisan FIFO/rata-rata bergerak, voucher biaya angkut, dan alokasinya.",
  },
  "nav-procurement_management": { en: "Procurement Management", id: "Manajemen Pengadaan" },
  "nav-procurement_management-scm-procurement": {
    en: "RFQ & Tendering",
    id: "RFQ & Tender",
    descriptionId: "RFQ, tender, penawaran pemasok, perbandingan penawaran, dan pemenangan.",
  },
  "nav-procurement_management-scm-contracts": {
    en: "Supplier Contracts & Scorecards",
    id: "Kontrak & Skor Pemasok",
    descriptionId: "Evaluasi kinerja pemasok, kartu skor, dan kontrak pembelian payung.",
  },
  "nav-procurement_management-scm-spend": {
    en: "Spend Analytics",
    id: "Analitik Belanja",
    descriptionId: "Analitik belanja pengadaan, rincian vendor, metrik PO, dan tren pembelian.",
  },
  "nav-asset": { en: "Asset Management", id: "Manajemen Aset" },
  "nav-asset-assets": {
    en: "Assets",
    id: "Aset",
    descriptionId: "Apa yang Anda miliki, di mana, dan siapa yang memegangnya.",
  },
  "nav-asset-asset-maintenance": {
    en: "Asset Maintenance",
    id: "Pemeliharaan Aset",
    descriptionId: "Jadwal, perintah kerja, suku cadang, pembacaan meter, dan henti mesin.",
  },
  "nav-finance": { en: "Finance", id: "Keuangan" },
  "nav-finance-finance-transactions": {
    en: "Transactions",
    id: "Transaksi",
    descriptionId: "Apa yang masuk, apa yang keluar, dan untuk apa.",
  },
  "nav-finance-finance-cashflow": {
    en: "Cashflow",
    id: "Arus Kas",
    descriptionId: "Apa yang bergerak periode ini, dan posisi Anda sekarang.",
  },
  "nav-finance-finance-accounts": {
    en: "Cash & Bank",
    id: "Kas & Bank",
    descriptionId: "Di mana uang sebenarnya berada.",
  },
  "nav-hse": { en: "Health, Safety & Environment", id: "Kesehatan, Keselamatan & Lingkungan" },
  "nav-hse-hse": {
    en: "HSE",
    id: "K3L",
    descriptionId: "Catat dan tinjau aktivitas kesehatan, keselamatan, dan lingkungan.",
  },
  "nav-hse-hse-advanced-investigations": {
    en: "Investigations & Risk",
    id: "Investigasi & Risiko",
    descriptionId: "Kerangka investigasi bervisi, akar masalah, dan penilaian risiko JSA/HIRA.",
  },
  "nav-hse-hse-advanced-permits-audit": {
    en: "Permits & Audit",
    id: "Izin & Audit",
    descriptionId: "Izin kerja pada Mesin Alur Kerja, ditambah program audit, kejadian, dan temuan.",
  },
  "nav-hse-hse-advanced-monitoring-capa": {
    en: "Monitoring & CAPA",
    id: "Pemantauan & CAPA",
    descriptionId: "Pemantauan ambang batas dengan tanda pelanggaran, tindakan korektif dan preventif, serta snapshot indikator.",
  },
  "nav-project_delivery": { en: "Project Delivery", id: "Pengiriman Proyek" },
  "nav-project_delivery-project-delivery": {
    en: "Project Delivery",
    id: "Pengiriman Proyek",
    descriptionId: "Lacak aktivitas proyek, tonggak, dan kemajuan pengiriman.",
  },
  "nav-project_delivery-project-delivery-advanced-planning": {
    en: "Planning & Scheduling",
    id: "Perencanaan & Penjadwalan",
    descriptionId: "Rincian pekerjaan, dependensi, tampilan Gantt, pembebanan sumber daya, dan varians baseline.",
  },
  "nav-project_delivery-project-delivery-advanced-cost-ev": {
    en: "Cost & Earned Value",
    id: "Biaya & Nilai Hasil",
    descriptionId: "Entri dan posisi biaya, nilai hasil, dan riwayat snapshot yang menjadi tolok ukurnya.",
  },

  // Governance
  "nav-reporting_insight": { en: "Reporting & Insights", id: "Pelaporan & Wawasan" },
  "nav-reporting_insight-reporting-insight": {
    en: "Reporting",
    id: "Pelaporan",
    descriptionId: "Laporan aman-scope, BI terkelola, dan wawasan prediktif deterministik.",
  },
  "nav-reporting_insight-dashboard": {
    en: "Dashboard",
    id: "Dasbor",
    descriptionId: "Ringkasan KPI lintas modul dengan penelusuran ke data per catatan.",
  },
  "nav-settings": {
    en: "Settings",
    id: "Pengaturan",
    descriptionId: "Organisasi, pengguna, akses, konfigurasi, layanan bersama, cadangan, tampilan, dan dokumen.",
  },
};

/**
 * Pick the label to render. A served name that differs from the seed English
 * label is a tenant override and is shown as-is; otherwise the dictionary is
 * used, falling back to the served name when the code has no row.
 *
 * Descriptions get no override check: the seed English description is not
 * recorded here, so there is nothing to compare against. The localized
 * description is used when present, the served one otherwise — a tenant that
 * rewrote a description keeps the English text, which is honest but not ideal.
 * ponytail: record seed descriptions too if per-tenant description overrides
 * ever ship.
 */
export function resolveNavLabel(
  code: string,
  servedName: string,
  locale: "en" | "id",
  kind: "label" | "description" = "label",
): string {
  const entry = NAV_LABELS[code];
  if (!entry) return servedName;
  if (kind === "description") {
    return locale === "en" ? servedName : (entry.descriptionId ?? servedName);
  }
  if (servedName !== entry.en) return servedName;
  return locale === "en" ? entry.en : entry.id;
}
