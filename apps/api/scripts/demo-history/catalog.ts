/**
 * Demo-history catalog: the shared, typed description of the fictional company
 * "PT Sentra Layanan Terpadu" — an integrated facility & catering services
 * provider (catering, housekeeping, facility maintenance, camp management) that
 * the demo tenant `demo-gs` pretends to have been running for a year.
 *
 * EVERYTHING here is synthetic (fake names, fake NPWP-like ids, 08xx phones,
 * `.local` e-mails). `foundation.ts` creates all of it through the real API;
 * every other sector imports these constants to reference the same customers,
 * sites, items, suppliers, employees and users, so the story stays consistent.
 *
 * Nothing in this file touches the database.
 */

// ---------------------------------------------------------------------------
// Time rhythm
// ---------------------------------------------------------------------------

/** Day the (synthetic) books were opened with starting stock = harness cal.start. */
export const OPENING_BALANCE_REFERENCE = "SALDO-AWAL-2025-11";

/**
 * Relative business volume for a month key ("2025-11" … "2026-11"), 1.0 = the
 * volume of the first history month. Growth over the year (new customers),
 * a dip in the Dec-Jan holiday weeks is NOT applied (catering shrinks only a
 * little), Ramadan Mar-2026 bumps catering (iftar/sahur boxes), year-end bumps
 * events. Sectors multiply their base volume by this so charts have a shape.
 */
export function activityFactor(month: string): number {
  const f: Record<string, number> = {
    "2025-11": 0.78,
    "2025-12": 0.9,
    "2026-01": 0.82,
    "2026-02": 0.88,
    "2026-03": 1.15, // Ramadan 2026
    "2026-04": 1.0,
    "2026-05": 1.04,
    "2026-06": 1.08,
    "2026-07": 1.12,
    "2026-08": 1.16,
    "2026-09": 1.2,
    "2026-10": 1.26,
    "2026-11": 1.3,
  };
  return f[month] ?? 1;
}

/** Months in which an Idul Fitri / Christmas style seasonal bump applies. */
export const SEASONAL_MONTHS = { ramadan: "2026-03", yearEnd: "2025-12", lebaran: "2026-03" } as const;

// ---------------------------------------------------------------------------
// Legal entity & org structure
// ---------------------------------------------------------------------------

/** The legal entity created by seed.ts is kept (name unchanged); the profile is filled in. */
export const LEGAL_ENTITY = {
  /** Name as created by seed.ts — used to find it. */
  seedName: "Demo Legal Entity Pte Ltd",
  displayName: "PT Sentra Layanan Terpadu",
  registrationNo: "AHU-0041287.AH.01.01.TAHUN 2018",
  npwp: "01.234.567.8-413.000", // fake NPWP-like id
  country: "ID",
  timezone: "Asia/Jakarta",
  baseCurrency: "IDR",
  email: "info@sentra-layanan.local",
  phone: "+62-21-5550-1234",
  addresses: [
    { addressType: "registered" as const, line1: "Gedung Graha Sentra Lt. 7, Jl. H.R. Rasuna Said Kav. C-22", city: "Jakarta Selatan", postalCode: "12940", country: "ID" },
    { addressType: "operating" as const, line1: "Kawasan Industri MM2100 Blok DD-12, Cikarang Barat", city: "Bekasi", postalCode: "17530", country: "ID" },
    { addressType: "billing" as const, line1: "Gedung Graha Sentra Lt. 7, Jl. H.R. Rasuna Said Kav. C-22", city: "Jakarta Selatan", postalCode: "12940", country: "ID" },
    { addressType: "tax" as const, line1: "Gedung Graha Sentra Lt. 7, Jl. H.R. Rasuna Said Kav. C-22", city: "Jakarta Selatan", postalCode: "12940", country: "ID" },
  ],
  /** PKP (VAT-registered) since this date. */
  taxRegistration: { taxpayerStatus: "pkp" as const, effectiveFrom: "2018-06-01", registrationNumber: "01.234.567.8-413.000" },
};

export type OrgKey =
  | "HEAD_OFFICE"
  | "CATERING"
  | "FACILITY"
  | "WAREHOUSE"
  | "FINANCE"
  | "HR"
  | "HSE"
  | "PROJECTS"
  | "PROCUREMENT"
  | "SALES";

export interface OrgUnitSpec {
  key: OrgKey;
  /** Name in the system. Head Office + Catering Operations already exist (seed.ts). */
  name: string;
  /** unitType accepted by the API: "Internal Site" for field units, "department" for support. */
  unitType: "Head Office" | "Internal Site" | "department";
  parent: OrgKey | null;
  exists?: true;
}

export const ORG_UNITS: OrgUnitSpec[] = [
  { key: "HEAD_OFFICE", name: "Head Office", unitType: "Head Office", parent: null, exists: true },
  { key: "CATERING", name: "Catering Operations", unitType: "Internal Site", parent: "HEAD_OFFICE", exists: true },
  { key: "FACILITY", name: "Facility Services", unitType: "Internal Site", parent: "HEAD_OFFICE" },
  { key: "WAREHOUSE", name: "Warehouse & Logistics", unitType: "Internal Site", parent: "HEAD_OFFICE" },
  { key: "FINANCE", name: "Finance & Accounting", unitType: "department", parent: "HEAD_OFFICE" },
  { key: "HR", name: "Human Capital", unitType: "department", parent: "HEAD_OFFICE" },
  { key: "HSE", name: "HSE & Quality", unitType: "department", parent: "HEAD_OFFICE" },
  { key: "PROJECTS", name: "Project Management", unitType: "department", parent: "HEAD_OFFICE" },
  { key: "PROCUREMENT", name: "Procurement", unitType: "department", parent: "HEAD_OFFICE" },
  { key: "SALES", name: "Business Development", unitType: "department", parent: "HEAD_OFFICE" },
];

/** Department master (G0 M8) — organises people, one per org unit plus a few. */
export interface DepartmentSpec {
  code: string;
  name: string;
  org: OrgKey;
}
export const DEPARTMENTS: DepartmentSpec[] = [
  { code: "DEP-MGMT", name: "Manajemen", org: "HEAD_OFFICE" },
  { code: "DEP-CAT", name: "Operasional Katering", org: "CATERING" },
  { code: "DEP-FAC", name: "Facility Services", org: "FACILITY" },
  { code: "DEP-WH", name: "Gudang & Logistik", org: "WAREHOUSE" },
  { code: "DEP-FIN", name: "Keuangan & Akuntansi", org: "FINANCE" },
  { code: "DEP-HR", name: "Sumber Daya Manusia", org: "HR" },
  { code: "DEP-HSE", name: "K3, Lingkungan & Mutu", org: "HSE" },
  { code: "DEP-PRJ", name: "Manajemen Proyek", org: "PROJECTS" },
  { code: "DEP-PRC", name: "Pengadaan", org: "PROCUREMENT" },
  { code: "DEP-BD", name: "Pengembangan Bisnis", org: "SALES" },
];

export interface PositionSpec {
  code: string;
  name: string;
}
export const POSITIONS: PositionSpec[] = [
  { code: "DIR", name: "Direktur Utama" },
  { code: "GM-OPS", name: "General Manager Operasional" },
  { code: "MGR-CAT", name: "Manajer Katering" },
  { code: "MGR-FAC", name: "Manajer Facility Services" },
  { code: "MGR-FIN", name: "Manajer Keuangan" },
  { code: "MGR-HR", name: "Manajer SDM" },
  { code: "COORD-OPS", name: "Koordinator Operasional" },
  { code: "CHEF-HEAD", name: "Kepala Dapur (Head Chef)" },
  { code: "COOK", name: "Juru Masak" },
  { code: "KITCHEN-HELP", name: "Helper Dapur" },
  { code: "PACKER", name: "Petugas Packing" },
  { code: "DRIVER", name: "Driver Pengiriman" },
  { code: "SPV-CLEAN", name: "Supervisor Kebersihan" },
  { code: "CLEANER", name: "Petugas Kebersihan" },
  { code: "TECH-MEP", name: "Teknisi MEP" },
  { code: "TECH-AC", name: "Teknisi AC" },
  { code: "QC-OFFICER", name: "QC Officer" },
  { code: "WH-HEAD", name: "Kepala Gudang" },
  { code: "WH-STAFF", name: "Staf Gudang" },
  { code: "PURCH-OFF", name: "Purchasing Officer" },
  { code: "HR-STAFF", name: "Staf SDM" },
  { code: "ACCOUNTANT", name: "Akuntan" },
  { code: "AR-AP", name: "Staf AR/AP" },
  { code: "BILLING-OFF", name: "Staf Penagihan" },
  { code: "HSE-OFF", name: "HSE Officer" },
  { code: "PM", name: "Project Manager" },
  { code: "SITE-ENG", name: "Site Engineer" },
  { code: "SALES-EXEC", name: "Sales Executive" },
  { code: "CS-OFF", name: "Customer Service Officer" },
  { code: "ASSET-OFF", name: "Petugas Aset & Perawatan" },
];

// ---------------------------------------------------------------------------
// Roles, users, employees
// ---------------------------------------------------------------------------

/** Synthetic password shared by every user created by the demo history. */
export const DEMO_PASSWORD = "Demo12345!";

export interface RoleSpec {
  code: string;
  name: string;
  description: string;
  /** Exact permission codes, or prefixes ending with "*" (e.g. "supply_chain.*"). */
  permissions: string[];
}

/** Existing roles from seed.ts that are reused as they are. */
export const EXISTING_ROLES = ["COORD_OPS", "EXEC_OPS", "VERIFY_OPS", "BILL_OPS", "COMPLAINT_HANDLER", "COMPLAINT_MANAGER"] as const;

const COMMON = ["notification.read", "document.read", "workflow.instance.read", "workflow.instance.act", "customer.read", "site.read", "service.read", "organization_unit.read"];

/** New roles created through POST /admin/roles. */
export const NEW_ROLES: RoleSpec[] = [
  {
    code: "WAREHOUSE_OPS",
    name: "Warehouse Operator",
    description: "Goods receipt, stock movements, opname, warehouse tasks",
    permissions: [...COMMON, "supply_chain.read", "supply_chain.stock.*", "supply_chain.inventory.*", "supply_chain.warehouse*", "supply_chain.receiving.*", "supply_chain.valuation.*", "supply_chain.return.*", "supply_chain.disposal.*", "supply_chain.consignment.*", "wms.price.view", "asset.read", "asset.move"],
  },
  {
    code: "PURCHASING_OPS",
    name: "Purchasing Officer",
    description: "Purchase requests, RFQ, purchase orders, supplier contracts, vendor invoices",
    permissions: [...COMMON, "supply_chain.read", "supply_chain.manage", "supply_chain.procurement.*", "supply_chain.contract.manage", "supply_chain.contract.read", "supply_chain.receiving.read", "supply_chain.vendor_invoice.manage", "supply_chain.vendor_invoice.read", "supply_chain.service_acceptance.*", "supply_chain.analytics.read", "supply_chain.inventory.read", "supply_chain.payment.read", "workflow.instance.start", "wms.price.view"],
  },
  {
    code: "HR_OPS",
    name: "HR Officer",
    description: "Employees, attendance, leave, overtime, payroll, recruitment, training",
    permissions: [...COMMON, "workforce.*", "employee_profile.*", "department.*", "user.read", "workflow.instance.start"],
  },
  {
    code: "FINANCE_OPS",
    name: "Finance Officer",
    description: "Cash & bank, accounting journals, AR/AP, tax, budget, payments",
    permissions: [...COMMON, "finance.*", "supply_chain.payment.*", "supply_chain.vendor_invoice.*", "supply_chain.read", "supply_chain.accounting_event.read", "supply_chain.account_assignment.read", "contract.read", "service_operations.read", "service_operations.billing.manage", "tax_registration.*", "reporting.*", "workflow.instance.start", "workforce.payroll.read"],
  },
  {
    code: "HSE_OFFICER",
    name: "HSE Officer",
    description: "Incidents, inspections, permits to work, CAPA, HSE indicators",
    permissions: [...COMMON, "hse.*", "workforce.read", "workforce.documents.read", "service_quality.read", "service_quality.capa.manage", "service_quality.rca.manage", "workflow.instance.start"],
  },
  {
    code: "PROJECT_MGR",
    name: "Project Manager",
    description: "Project delivery: projects, tasks, milestones, project cost",
    permissions: [...COMMON, "project_delivery.*", "project.*", "contract.read", "supply_chain.read", "workflow.instance.start"],
  },
  {
    code: "ASSET_OFFICER",
    name: "Asset & Maintenance Officer",
    description: "Asset register, maintenance, meters, downtime",
    permissions: [...COMMON, "asset.*", "supply_chain.read", "supply_chain.inventory.read", "workflow.instance.start"],
  },
  {
    code: "SALES_OPS",
    name: "Business Development",
    description: "Sales pipeline, customers, contracts",
    permissions: [...COMMON, "sales.read", "sales.manage", "customer.manage", "contract.manage", "contract.read", "site.manage", "service.manage", "project.read", "workflow.instance.start"],
  },
  {
    code: "OPS_MANAGER",
    name: "Operations Manager (Approver)",
    description: "Cross-functional approvals: purchasing, payments, leave, payroll, HSE closure, sales",
    permissions: [
      ...COMMON,
      "service_operations.*", "supply_chain.read", "supply_chain.*.approve", "supply_chain.procurement.award", "supply_chain.analytics.read",
      "finance.read", "finance.approve", "finance.accounting.read", "finance.accounting.approve", "sales.read", "sales.approve",
      "workforce.read", "workforce.leave.approve", "workforce.payroll.approve", "workforce.payroll.read", "workforce.planning.apply", "workforce.performance.read",
      "hse.read", "hse.close", "hse.capa.verify", "hse.report", "service_quality.*", "complaint.*", "survey.analytics.read", "survey.results.read",
      "asset.read", "asset.analytics.read", "project_delivery.read", "project_delivery.advanced.read", "reporting.read", "reporting.export",
      "workflow.instance.start", "workflow.instance.manage",
    ],
  },
];

export type UserKey =
  | "coordinator"
  | "executor1"
  | "executor2"
  | "executor3"
  | "verifier"
  | "billing"
  | "warehouse"
  | "purchasing"
  | "hr"
  | "finance"
  | "hse"
  | "projectManager"
  | "assetOfficer"
  | "sales"
  | "manager"
  | "customerService"
  | "complaintManager";

export interface UserSpec {
  key: UserKey;
  email: string;
  password: string;
  fullName: string;
  /** Roles at tenant scope. */
  roleCodes: string[];
  /** Employee record (EMPLOYEES[].code) this login belongs to. */
  employeeCode: string;
}

const u = (key: UserKey, email: string, fullName: string, roleCodes: string[], employeeCode: string): UserSpec => ({
  key,
  email: `${email}@sentra.local`,
  password: DEMO_PASSWORD,
  fullName,
  roleCodes,
  employeeCode,
});

/** 17 working logins, all with password DEMO_PASSWORD, tenant-wide scope. */
export const USERS: Record<UserKey, UserSpec> = {
  coordinator: u("coordinator", "andi.prasetyo", "Andi Prasetyo", ["COORD_OPS"], "EMP-0006"),
  executor1: u("executor1", "slamet.riyadi", "Slamet Riyadi", ["EXEC_OPS"], "EMP-0009"),
  executor2: u("executor2", "dewi.lestari", "Dewi Lestari", ["EXEC_OPS"], "EMP-0020"),
  executor3: u("executor3", "joko.susilo", "Joko Susilo", ["EXEC_OPS"], "EMP-0021"),
  verifier: u("verifier", "rina.marlina", "Rina Marlina", ["VERIFY_OPS"], "EMP-0016"),
  billing: u("billing", "yuliana.putri", "Yuliana Putri", ["BILL_OPS"], "EMP-0033"),
  warehouse: u("warehouse", "hendra.gunawan", "Hendra Gunawan", ["WAREHOUSE_OPS"], "EMP-0024"),
  purchasing: u("purchasing", "maya.kusuma", "Maya Kusuma", ["PURCHASING_OPS"], "EMP-0027"),
  hr: u("hr", "ratna.wulandari", "Ratna Wulandari", ["HR_OPS"], "EMP-0030"),
  finance: u("finance", "bambang.hartono", "Bambang Hartono", ["FINANCE_OPS"], "EMP-0031"),
  hse: u("hse", "fajar.nugroho", "Fajar Nugroho", ["HSE_OFFICER"], "EMP-0037"),
  projectManager: u("projectManager", "dimas.anggara", "Dimas Anggara", ["PROJECT_MGR"], "EMP-0039"),
  assetOfficer: u("assetOfficer", "teguh.wibowo", "Teguh Wibowo", ["ASSET_OFFICER"], "EMP-0023"),
  sales: u("sales", "lina.kartika", "Lina Kartika", ["SALES_OPS"], "EMP-0042"),
  manager: u("manager", "hadi.santoso", "Hadi Santoso", ["OPS_MANAGER"], "EMP-0002"),
  customerService: u("customerService", "citra.dewi", "Citra Dewi", ["COMPLAINT_HANDLER"], "EMP-0044"),
  complaintManager: u("complaintManager", "rudi.hermawan", "Rudi Hermawan", ["COMPLAINT_MANAGER"], "EMP-0003"),
};

/** Logins that already exist from seed.ts (see seed.ts for their passwords). */
export const SEED_USERS = {
  admin: { email: "admin@demo.local", password: "admin123!" },
  coord: { email: "coord@demo.local", password: "Coord12345!" },
  exec: { email: "exec@demo.local", password: "Exec12345!" },
  verify: { email: "verify@demo.local", password: "Verify12345!" },
  bill: { email: "bill@demo.local", password: "Bill12345!" },
} as const;

export interface EmployeeSpec {
  code: string;
  fullName: string;
  positionCode: string;
  org: OrgKey;
  department: string;
  /** YYYY-MM-DD — spread over several years; ~10 joined inside the history year. */
  joinedAt: string;
  employmentType: "permanent" | "contract" | "daily";
  /** Gross monthly salary in IDR (UMK Bekasi ≈ 5.3 juta). */
  salary: number;
  phone: string;
  /** Resigned inside the history year (employment_status = ended). */
  endedAt?: string;
}

const e = (
  n: number,
  fullName: string,
  positionCode: string,
  org: OrgKey,
  joinedAt: string,
  employmentType: EmployeeSpec["employmentType"],
  salary: number,
  endedAt?: string,
): EmployeeSpec => {
  const dep = DEPARTMENTS.find((d) => d.org === org)!.code;
  return {
    code: `EMP-${String(n).padStart(4, "0")}`,
    fullName,
    positionCode,
    org,
    department: dep,
    joinedAt,
    employmentType,
    salary,
    phone: `0812${String(30000000 + n * 137913).slice(0, 8)}`,
    ...(endedAt ? { endedAt } : {}),
  };
};

export const EMPLOYEES: EmployeeSpec[] = [
  e(1, "Ir. Surya Wijaya", "DIR", "HEAD_OFFICE", "2018-06-01", "permanent", 48000000),
  e(2, "Hadi Santoso", "GM-OPS", "HEAD_OFFICE", "2019-03-01", "permanent", 32000000),
  e(3, "Rudi Hermawan", "MGR-FAC", "FACILITY", "2019-09-02", "permanent", 24000000),
  e(4, "Wahyu Setiawan", "MGR-CAT", "CATERING", "2019-04-01", "permanent", 24000000),
  e(5, "Agus Salim", "CHEF-HEAD", "CATERING", "2020-01-06", "permanent", 12500000),
  e(6, "Andi Prasetyo", "COORD-OPS", "CATERING", "2021-02-01", "permanent", 9500000),
  e(7, "Eko Purnomo", "COOK", "CATERING", "2021-05-03", "permanent", 7200000),
  e(8, "Sari Indah", "COOK", "CATERING", "2021-08-02", "permanent", 7000000),
  e(9, "Slamet Riyadi", "COOK", "CATERING", "2022-01-03", "permanent", 7200000),
  e(10, "Tuti Handayani", "KITCHEN-HELP", "CATERING", "2022-06-01", "permanent", 5600000),
  e(11, "Bagus Firmansyah", "KITCHEN-HELP", "CATERING", "2023-02-01", "permanent", 5500000),
  e(12, "Nur Aini", "PACKER", "CATERING", "2023-03-01", "permanent", 5450000),
  e(13, "Yanti Susanti", "PACKER", "CATERING", "2023-07-03", "permanent", 5450000),
  e(14, "Dedi Kurniawan", "DRIVER", "CATERING", "2022-09-05", "permanent", 6200000),
  e(15, "Mulyadi", "DRIVER", "CATERING", "2024-01-08", "permanent", 6000000),
  e(16, "Rina Marlina", "QC-OFFICER", "CATERING", "2022-11-01", "permanent", 8800000),
  e(17, "Ahmad Fauzi", "KITCHEN-HELP", "CATERING", "2025-12-01", "contract", 5400000),
  e(18, "Wati Rahmawati", "PACKER", "CATERING", "2026-01-05", "contract", 5400000),
  e(19, "Iwan Setiabudi", "DRIVER", "CATERING", "2026-04-01", "contract", 5800000),
  e(20, "Dewi Lestari", "COOK", "CATERING", "2024-06-03", "permanent", 6900000),
  e(21, "Joko Susilo", "COOK", "CATERING", "2024-08-01", "permanent", 6900000),
  e(22, "Heru Cahyono", "SPV-CLEAN", "FACILITY", "2020-10-05", "permanent", 9800000),
  e(23, "Teguh Wibowo", "ASSET-OFF", "FACILITY", "2021-07-01", "permanent", 8600000),
  e(24, "Hendra Gunawan", "WH-HEAD", "WAREHOUSE", "2020-05-04", "permanent", 10500000),
  e(25, "Sulastri", "CLEANER", "FACILITY", "2022-02-01", "permanent", 5350000),
  e(26, "Paijo Santoso", "CLEANER", "FACILITY", "2022-02-01", "permanent", 5350000),
  e(27, "Maya Kusuma", "PURCH-OFF", "PROCUREMENT", "2021-09-01", "permanent", 9200000),
  e(28, "Anton Wijayanto", "TECH-MEP", "FACILITY", "2022-04-04", "permanent", 7800000),
  e(29, "Budi Raharjo", "TECH-AC", "FACILITY", "2023-01-09", "permanent", 7400000),
  e(30, "Ratna Wulandari", "MGR-HR", "HR", "2020-02-03", "permanent", 17500000),
  e(31, "Bambang Hartono", "MGR-FIN", "FINANCE", "2019-11-01", "permanent", 21000000),
  e(32, "Fitri Handayani", "ACCOUNTANT", "FINANCE", "2021-03-01", "permanent", 9600000),
  e(33, "Yuliana Putri", "BILLING-OFF", "FINANCE", "2022-08-01", "permanent", 7600000),
  e(34, "Doni Saputra", "AR-AP", "FINANCE", "2024-03-04", "permanent", 7200000),
  e(35, "Lestari Ningsih", "HR-STAFF", "HR", "2023-05-02", "permanent", 7000000),
  e(36, "Gilang Ramadhan", "WH-STAFF", "WAREHOUSE", "2023-09-04", "permanent", 5700000),
  e(37, "Fajar Nugroho", "HSE-OFF", "HSE", "2021-12-01", "permanent", 10200000),
  e(38, "Nina Kartini", "QC-OFFICER", "HSE", "2025-12-15", "contract", 8200000),
  e(39, "Dimas Anggara", "PM", "PROJECTS", "2022-05-02", "permanent", 17000000),
  e(40, "Reza Pahlevi", "SITE-ENG", "PROJECTS", "2024-02-05", "permanent", 10800000),
  e(41, "Kevin Aditya", "SITE-ENG", "PROJECTS", "2026-02-02", "contract", 9800000),
  e(42, "Lina Kartika", "SALES-EXEC", "SALES", "2023-04-03", "permanent", 11000000),
  e(43, "Alvin Maulana", "SALES-EXEC", "SALES", "2026-06-01", "permanent", 9500000),
  e(44, "Citra Dewi", "CS-OFF", "SALES", "2024-07-01", "permanent", 7600000),
  e(45, "Rizki Pratama", "WH-STAFF", "WAREHOUSE", "2026-08-03", "contract", 5500000),
  e(46, "Mega Puspita", "CLEANER", "FACILITY", "2026-09-14", "contract", 5300000),
  e(47, "Tono Sugiarto", "CLEANER", "FACILITY", "2023-06-01", "permanent", 5350000, "2026-07-31"),
  e(48, "Nanda Permana", "KITCHEN-HELP", "CATERING", "2024-10-07", "permanent", 5500000, "2026-09-30"),
  e(49, "Sinta Purnamasari", "CLEANER", "FACILITY", "2026-10-05", "contract", 5300000),
];

// ---------------------------------------------------------------------------
// Services, customers, sites, contracts
// ---------------------------------------------------------------------------

export type ServiceKey = "CATERING" | "HOUSEKEEPING" | "FACILITY" | "CAMP" | "PESTCTRL";

export interface ServiceSpec {
  key: ServiceKey;
  /** services.code (SVC-CATERING already exists from seed.ts). */
  code: string;
  name: string;
  description: string;
  /** Service pack that provides the work-order definitions. */
  pack: "catering" | "housekeeping" | "facility" | "camp" | null;
  exists?: true;
}
export const SERVICES: ServiceSpec[] = [
  { key: "CATERING", code: "SVC-CATERING", name: "Catering Service", description: "Katering karyawan: nasi box harian, prasmanan, snack & event", pack: "catering", exists: true },
  { key: "HOUSEKEEPING", code: "SVC-HOUSEKEEPING", name: "Housekeeping & Cleaning Service", description: "Jasa kebersihan gedung/pabrik, harian & periodik", pack: "housekeeping" },
  { key: "FACILITY", code: "SVC-FACILITY", name: "Facility Maintenance Service", description: "Perawatan MEP, AC, genset dan fasilitas gedung", pack: "facility" },
  { key: "CAMP", code: "SVC-CAMP", name: "Camp & Mess Management", description: "Pengelolaan camp proyek: akomodasi, laundry, dapur camp", pack: "camp" },
  { key: "PESTCTRL", code: "SVC-PESTCTRL", name: "Pest Control Service", description: "Pengendalian hama berkala (fogging, rodent control)", pack: null },
];

export interface SiteSpec {
  /** sites.code */
  code: string;
  name: string;
  address: string;
  city: string;
  /** Catering: portions delivered per working day at this site (0 = none). */
  dailyMeals: number;
  /** Cleaning/facility: staff deployed at the site. */
  headcount: number;
}

export interface CustomerSpec {
  /** customers.code */
  code: string;
  name: string;
  industry: string;
  npwp: string;
  /** Org unit that owns the customer account. */
  owner: OrgKey;
  contacts: { name: string; email: string; phone: string; title: string; primary?: boolean }[];
  sites: SiteSpec[];
  services: ServiceKey[];
  contract: {
    code: string;
    name: string;
    startDate: string;
    endDate: string;
    /** Price per catering portion (IDR) and monthly fee for non-catering services. */
    mealPrice: number;
    monthlyServiceFee: number;
    paymentTermCode: string;
  };
  /** Account manager (UserKey) used as customer-service-link PIC. */
  pic: UserKey;
}

export const CUSTOMERS: CustomerSpec[] = [
  {
    code: "CUST-101",
    name: "PT Mitra Baja Nusantara",
    industry: "Manufaktur baja",
    npwp: "02.118.443.6-413.000",
    owner: "CATERING",
    contacts: [
      { name: "Bambang Suryono", email: "bambang.suryono@mitrabaja.local", phone: "081311220101", title: "GA Manager", primary: true },
      { name: "Retno Palupi", email: "retno.palupi@mitrabaja.local", phone: "081311220102", title: "HRD Supervisor" },
    ],
    sites: [
      { code: "SITE-101-A", name: "Pabrik Cikarang", address: "Jl. Industri Selatan 5 Blok GG-3, Kawasan Jababeka, Cikarang", city: "Bekasi", dailyMeals: 650, headcount: 0 },
      { code: "SITE-101-B", name: "Kantor Marunda", address: "Jl. Marunda Makmur Km 3, Cilincing", city: "Jakarta Utara", dailyMeals: 120, headcount: 6 },
    ],
    services: ["CATERING", "HOUSEKEEPING"],
    contract: { code: "CTR-2025-101", name: "Katering & Housekeeping PT Mitra Baja 2025-2027", startDate: "2025-01-01", endDate: "2027-01-01", mealPrice: 24500, monthlyServiceFee: 38000000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-102",
    name: "PT Cipta Elektronik Indonesia",
    industry: "Manufaktur elektronik",
    npwp: "02.455.870.1-412.000",
    owner: "CATERING",
    contacts: [
      { name: "Hendrik Tanujaya", email: "hendrik.t@ciptaelektronik.local", phone: "081310445502", title: "Plant Admin Head", primary: true },
    ],
    sites: [{ code: "SITE-102-A", name: "Plant MM2100", address: "Kawasan Industri MM2100 Blok C-9, Cikarang Barat", city: "Bekasi", dailyMeals: 900, headcount: 0 }],
    services: ["CATERING"],
    contract: { code: "CTR-2024-102", name: "Katering Karyawan PT Cipta Elektronik 2024-2026", startDate: "2024-09-01", endDate: "2026-12-31", mealPrice: 26000, monthlyServiceFee: 0, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-103",
    name: "PT Garuda Logistik Prima",
    industry: "Logistik & pergudangan",
    npwp: "03.210.667.9-416.000",
    owner: "CATERING",
    contacts: [
      { name: "Siti Nurhaliza", email: "siti.n@garudalogistik.local", phone: "081288770303", title: "Facility Manager", primary: true },
      { name: "Aris Munandar", email: "aris.m@garudalogistik.local", phone: "081288770304", title: "Admin Gudang" },
    ],
    sites: [
      { code: "SITE-103-A", name: "Gudang Batuceper", address: "Jl. Raya Batuceper No. 88, Batuceper", city: "Tangerang", dailyMeals: 240, headcount: 8 },
      { code: "SITE-103-B", name: "Kantor Cengkareng", address: "Komplek Pergudangan Kosambi Blok B-17, Kosambi", city: "Tangerang", dailyMeals: 60, headcount: 3 },
    ],
    services: ["CATERING", "HOUSEKEEPING"],
    contract: { code: "CTR-2025-103", name: "Katering & Cleaning PT Garuda Logistik 2025-2026", startDate: "2025-03-01", endDate: "2027-02-28", mealPrice: 23500, monthlyServiceFee: 29500000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-104",
    name: "PT Bank Nusa Makmur Tbk",
    industry: "Perbankan",
    npwp: "01.870.112.5-054.000",
    owner: "FACILITY",
    contacts: [
      { name: "Diana Anggraeni", email: "diana.a@banknusamakmur.local", phone: "081380990404", title: "Head of General Affairs", primary: true },
    ],
    sites: [
      { code: "SITE-104-A", name: "Gedung Menara Sudirman", address: "Jl. Jend. Sudirman Kav. 52-53, Senayan", city: "Jakarta Selatan", dailyMeals: 0, headcount: 28 },
      { code: "SITE-104-B", name: "Kantor Cabang Kelapa Gading", address: "Jl. Boulevard Raya Blok QA-2, Kelapa Gading", city: "Jakarta Utara", dailyMeals: 0, headcount: 7 },
    ],
    services: ["HOUSEKEEPING", "FACILITY"],
    contract: { code: "CTR-2024-104", name: "Facility Services Bank Nusa Makmur 2024-2026", startDate: "2024-07-01", endDate: "2026-12-31", mealPrice: 0, monthlyServiceFee: 215000000, paymentTermCode: "NET-45" },
    pic: "sales",
  },
  {
    code: "CUST-105",
    name: "PT Bumi Konstruksi Perkasa",
    industry: "Konstruksi",
    npwp: "02.774.309.4-017.000",
    owner: "FACILITY",
    contacts: [
      { name: "Ir. Taufik Hidayat", email: "taufik.h@bumikonstruksi.local", phone: "081355660505", title: "Project Director", primary: true },
    ],
    sites: [{ code: "SITE-105-A", name: "Camp Proyek Tol Bandung Selatan", address: "Jl. Raya Soreang-Kopo Km 4, Soreang", city: "Bandung", dailyMeals: 380, headcount: 14 }],
    services: ["CAMP", "CATERING"],
    contract: { code: "CTR-2025-105", name: "Camp Management & Katering Proyek Tol Bandung Selatan", startDate: "2025-06-01", endDate: "2027-05-31", mealPrice: 31000, monthlyServiceFee: 96000000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-106",
    name: "RS Harapan Sehat",
    industry: "Rumah sakit",
    npwp: "01.664.231.0-441.000",
    owner: "CATERING",
    contacts: [
      { name: "dr. Anisa Rahmi", email: "anisa.r@rsharapansehat.local", phone: "081234560606", title: "Wadir Penunjang", primary: true },
      { name: "Yoga Pratama", email: "yoga.p@rsharapansehat.local", phone: "081234560607", title: "Kepala Instalasi Gizi" },
    ],
    sites: [{ code: "SITE-106-A", name: "RS Harapan Sehat Dago", address: "Jl. Ir. H. Juanda No. 201, Dago", city: "Bandung", dailyMeals: 520, headcount: 18 }],
    services: ["CATERING", "HOUSEKEEPING"],
    contract: { code: "CTR-2025-106", name: "Gizi Pasien & Housekeeping RS Harapan Sehat", startDate: "2025-10-01", endDate: "2027-09-30", mealPrice: 36000, monthlyServiceFee: 72000000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-107",
    name: "PT Tekstil Sinar Priangan",
    industry: "Tekstil",
    npwp: "02.331.905.2-423.000",
    owner: "CATERING",
    contacts: [{ name: "Cecep Hermawan", email: "cecep.h@sinarpriangan.local", phone: "081322770707", title: "Manajer Umum", primary: true }],
    sites: [{ code: "SITE-107-A", name: "Pabrik Majalaya", address: "Jl. Raya Majalaya No. 14, Majalaya", city: "Bandung", dailyMeals: 800, headcount: 0 }],
    services: ["CATERING"],
    contract: { code: "CTR-2025-107", name: "Katering Karyawan Pabrik Majalaya", startDate: "2025-12-01", endDate: "2027-11-30", mealPrice: 22500, monthlyServiceFee: 0, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-108",
    name: "PT Pangan Jaya Abadi",
    industry: "FMCG makanan & minuman",
    npwp: "03.552.118.7-609.000",
    owner: "CATERING",
    contacts: [
      { name: "Linda Wijaya", email: "linda.w@pangan-jaya.local", phone: "081230880808", title: "HR & GA Manager", primary: true },
    ],
    sites: [
      { code: "SITE-108-A", name: "Pabrik Rungkut", address: "Jl. Rungkut Industri Raya No. 21, SIER", city: "Surabaya", dailyMeals: 560, headcount: 9 },
      { code: "SITE-108-B", name: "Gudang Margomulyo", address: "Jl. Margomulyo Indah Blok C-5", city: "Surabaya", dailyMeals: 150, headcount: 4 },
    ],
    services: ["CATERING", "HOUSEKEEPING"],
    contract: { code: "CTR-2026-108", name: "Katering & Cleaning PT Pangan Jaya Abadi", startDate: "2026-02-01", endDate: "2028-01-31", mealPrice: 25000, monthlyServiceFee: 34000000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-109",
    name: "Universitas Teknologi Nusantara",
    industry: "Pendidikan tinggi",
    npwp: "00.912.488.3-423.000",
    owner: "FACILITY",
    contacts: [{ name: "Prof. Dr. Heri Susanto", email: "heri.s@utn.local", phone: "081321990909", title: "Wakil Rektor II", primary: true }],
    sites: [{ code: "SITE-109-A", name: "Kampus Dago", address: "Jl. Dipati Ukur No. 35, Lebakgede", city: "Bandung", dailyMeals: 300, headcount: 22 }],
    services: ["HOUSEKEEPING", "FACILITY", "CATERING"],
    contract: { code: "CTR-2026-109", name: "Pengelolaan Kampus & Kantin UTN 2026-2028", startDate: "2026-03-01", endDate: "2028-02-29", mealPrice: 19500, monthlyServiceFee: 118000000, paymentTermCode: "NET-45" },
    pic: "sales",
  },
  {
    code: "CUST-110",
    name: "PT Energi Mandiri Persada",
    industry: "Jasa migas",
    npwp: "01.205.776.9-054.000",
    owner: "FACILITY",
    contacts: [
      { name: "Rahmat Hidayat", email: "rahmat.h@energimandiri.local", phone: "081384551010", title: "Logistics & Camp Superintendent", primary: true },
    ],
    sites: [
      { code: "SITE-110-A", name: "Kantor Kuningan", address: "Jl. H.R. Rasuna Said Kav. X-5, Kuningan", city: "Jakarta Selatan", dailyMeals: 110, headcount: 10 },
      { code: "SITE-110-B", name: "Camp Cilegon", address: "Jl. Raya Merak Km 9, Pulomerak", city: "Cilegon", dailyMeals: 260, headcount: 12 },
    ],
    services: ["CAMP", "CATERING", "FACILITY"],
    contract: { code: "CTR-2026-110", name: "Camp, Katering & Facility PT Energi Mandiri", startDate: "2026-05-01", endDate: "2028-04-30", mealPrice: 33000, monthlyServiceFee: 145000000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-111",
    name: "PT Pelabuhan Samudra Terminal",
    industry: "Pelabuhan & terminal",
    npwp: "02.640.119.8-046.000",
    owner: "FACILITY",
    contacts: [{ name: "Capt. Ridwan Effendi", email: "ridwan.e@samudraterminal.local", phone: "081311330111", title: "Port Services Manager", primary: true }],
    sites: [{ code: "SITE-111-A", name: "Terminal Tanjung Priok", address: "Jl. Raya Pelabuhan No. 1, Tanjung Priok", city: "Jakarta Utara", dailyMeals: 180, headcount: 16 }],
    services: ["HOUSEKEEPING", "PESTCTRL", "CATERING"],
    contract: { code: "CTR-2026-111", name: "Cleaning, Pest Control & Katering Terminal Tanjung Priok", startDate: "2026-07-01", endDate: "2028-06-30", mealPrice: 27500, monthlyServiceFee: 88000000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
  {
    code: "CUST-112",
    name: "PT Otomotif Nusa Jaya",
    industry: "Otomotif",
    npwp: "03.118.652.4-412.000",
    owner: "CATERING",
    contacts: [{ name: "Gunawan Setiadi", email: "gunawan.s@otonusajaya.local", phone: "081355220212", title: "GA Department Head", primary: true }],
    sites: [{ code: "SITE-112-A", name: "Plant Karawang", address: "Kawasan KIIC Jl. Permata Raya Lot F-4, Teluk Jambe", city: "Karawang", dailyMeals: 1100, headcount: 5 }],
    services: ["CATERING", "HOUSEKEEPING"],
    contract: { code: "CTR-2026-112", name: "Katering & Cleaning Plant Karawang", startDate: "2026-09-01", endDate: "2028-08-31", mealPrice: 25500, monthlyServiceFee: 21000000, paymentTermCode: "NET-30" },
    pic: "sales",
  },
];

/** Records that already exist from seed.ts — referenced, never recreated. */
export const EXISTING = {
  customers: { complaintDemo: "CUST-001", catering: "CUST-CATER" },
  sites: { complaintDemo: "SITE-001", catering: "SITE-CATER" },
  contract: "CTR-2026-001",
  services: ["SVC-GENERAL", "SVC-CATERING"],
  items: ["RICE", "COOKED-RICE", "NASIBOX-AYAM", "SAYUR", "AYAM", "SAMBAL"],
  menu: "MENU-DEMO",
  recipe: "RC-COOKED-RICE",
  orgUnits: ["Head Office", "Site A", "Catering Operations"],
};

// ---------------------------------------------------------------------------
// Units, items, suppliers, warehouses
// ---------------------------------------------------------------------------

export interface UnitSpec {
  code: string;
  name: string;
  baseUnitCode: string;
  category: "qty" | "vol" | "mass" | "length";
  exists?: true;
}
export const UNITS: UnitSpec[] = [
  { code: "KG", name: "Kilogram", baseUnitCode: "KG", category: "mass", exists: true },
  { code: "G", name: "Gram", baseUnitCode: "G", category: "mass", exists: true },
  { code: "PORSI", name: "Porsi", baseUnitCode: "PORSI", category: "qty", exists: true },
  { code: "LTR", name: "Liter", baseUnitCode: "LTR", category: "vol" },
  { code: "ML", name: "Mililiter", baseUnitCode: "ML", category: "vol" },
  { code: "PCS", name: "Pieces", baseUnitCode: "PCS", category: "qty" },
  { code: "BTR", name: "Butir", baseUnitCode: "BTR", category: "qty" },
  { code: "PAK", name: "Pak", baseUnitCode: "PAK", category: "qty" },
  { code: "BOX", name: "Box / Dus", baseUnitCode: "BOX", category: "qty" },
  { code: "BTL", name: "Botol", baseUnitCode: "BTL", category: "qty" },
  { code: "GLN", name: "Galon", baseUnitCode: "GLN", category: "qty" },
  { code: "RLL", name: "Roll", baseUnitCode: "RLL", category: "qty" },
  { code: "PSG", name: "Pasang", baseUnitCode: "PSG", category: "qty" },
  { code: "SET", name: "Set", baseUnitCode: "SET", category: "qty" },
];
export const UNIT_CONVERSIONS: { from: string; to: string; factor: string }[] = [
  { from: "LTR", to: "ML", factor: "1000" },
  { from: "KG", to: "G", factor: "1000" }, // exists from seed.ts
];

export type SupplierKey =
  | "BERAS"
  | "UNGGAS"
  | "DAGING"
  | "TELUR"
  | "SAYUR"
  | "SEMBAKO"
  | "IKAN"
  | "BUMBU"
  | "AIR"
  | "KEMASAN"
  | "KIMIA"
  | "SPAREPART"
  | "APD";

export interface SupplierSpec {
  key: SupplierKey;
  code: string;
  name: string;
  category: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  /** Payment term code (see PAYMENT_TERMS). */
  paymentTermCode: string;
}
export const SUPPLIERS: SupplierSpec[] = [
  { key: "BERAS", code: "SUP-001", name: "UD Beras Pandan Wangi Cipinang", category: "Beras & biji-bijian", contactName: "H. Sulaiman", email: "sulaiman@berascipinang.local", phone: "081280010001", address: "Pasar Induk Beras Cipinang Blok C-14", city: "Jakarta Timur", paymentTermCode: "NET-14" },
  { key: "UNGGAS", code: "SUP-002", name: "PT Unggas Prima Sejahtera", category: "Ayam & unggas", contactName: "Eddy Gunawan", email: "eddy@unggasprima.local", phone: "081280010002", address: "Jl. Raya Narogong Km 12", city: "Bekasi", paymentTermCode: "NET-14" },
  { key: "DAGING", code: "SUP-003", name: "CV Segar Daging Jaya", category: "Daging sapi", contactName: "Ibu Marlina", email: "marlina@segardaging.local", phone: "081280010003", address: "RPH Cakung Blok D-3", city: "Jakarta Timur", paymentTermCode: "NET-7" },
  { key: "TELUR", code: "SUP-004", name: "UD Telur Sumber Rejeki", category: "Telur", contactName: "Pak Darmawan", email: "darmawan@telursumberrejeki.local", phone: "081280010004", address: "Jl. Pasar Baru No. 45, Tambun", city: "Bekasi", paymentTermCode: "NET-7" },
  { key: "SAYUR", code: "SUP-005", name: "CV Sayur Segar Lembang", category: "Sayur & buah", contactName: "Asep Saepudin", email: "asep@sayursegarlembang.local", phone: "081280010005", address: "Jl. Raya Lembang Km 8", city: "Bandung Barat", paymentTermCode: "NET-7" },
  { key: "SEMBAKO", code: "SUP-006", name: "PT Sembako Nusantara Indah", category: "Sembako (minyak, gula, garam, tepung)", contactName: "Linda Susanti", email: "linda@sembakonusantara.local", phone: "081280010006", address: "Kawasan Pergudangan Bizpark Blok A-7", city: "Bekasi", paymentTermCode: "NET-30" },
  { key: "IKAN", code: "SUP-007", name: "CV Ikan Laut Segar Muara Baru", category: "Ikan & seafood", contactName: "Bang Rohim", email: "rohim@ikanmuarabaru.local", phone: "081280010007", address: "Pelabuhan Perikanan Muara Baru Blok B-22", city: "Jakarta Utara", paymentTermCode: "NET-7" },
  { key: "BUMBU", code: "SUP-008", name: "PT Boga Bumbu Nusantara", category: "Bumbu, saus & rempah", contactName: "Yeni Rahayu", email: "yeni@bogabumbu.local", phone: "081280010008", address: "Jl. Industri Raya No. 17, Cibitung", city: "Bekasi", paymentTermCode: "NET-30" },
  { key: "AIR", code: "SUP-009", name: "PT Tirta Pegunungan Sejati", category: "Air minum & minuman", contactName: "Joni Iskandar", email: "joni@tirtapegunungan.local", phone: "081280010009", address: "Jl. Raya Cibarusah Km 5", city: "Bekasi", paymentTermCode: "NET-30" },
  { key: "KEMASAN", code: "SUP-010", name: "PT Kemasan Hijau Lestari", category: "Kemasan & packaging", contactName: "Winarti", email: "winarti@kemasanhijau.local", phone: "081280010010", address: "Kawasan Industri Jatake Blok F-2", city: "Tangerang", paymentTermCode: "NET-30" },
  { key: "KIMIA", code: "SUP-011", name: "CV Pelita Kimia Bersih", category: "Kimia kebersihan & janitorial", contactName: "Santoso", email: "santoso@pelitakimia.local", phone: "081280010011", address: "Jl. Gatot Subroto No. 120", city: "Tangerang", paymentTermCode: "NET-30" },
  { key: "SPAREPART", code: "SUP-012", name: "PT Teknik Sparepart Mandiri", category: "Suku cadang & teknik", contactName: "Ir. Benny", email: "benny@sparepartmandiri.local", phone: "081280010012", address: "Jl. Mangga Besar Raya No. 33", city: "Jakarta Barat", paymentTermCode: "NET-45" },
  { key: "APD", code: "SUP-013", name: "PT Safety Indo Perkasa", category: "APD & perlengkapan K3", contactName: "Rita Amalia", email: "rita@safetyindo.local", phone: "081280010013", address: "Jl. Pluit Raya No. 9", city: "Jakarta Utara", paymentTermCode: "NET-30" },
];

export type WarehouseKey = "FOOD" | "GENERAL";
export interface WarehouseSpec {
  key: WarehouseKey;
  code: string;
  name: string;
  grade: "food" | "non_food";
  org: OrgKey;
  address: string;
  locations: { code: string; zone: string; rack?: string; shelf?: string }[];
}
export const WAREHOUSES: WarehouseSpec[] = [
  {
    key: "FOOD",
    code: "WH-FOOD",
    name: "Gudang Bahan Pangan Bekasi",
    grade: "food",
    org: "WAREHOUSE",
    address: "Kawasan Industri MM2100 Blok DD-12, Cikarang Barat, Bekasi",
    locations: [
      { code: "DRY-A1", zone: "Dry Store", rack: "A", shelf: "1" },
      { code: "DRY-A2", zone: "Dry Store", rack: "A", shelf: "2" },
      { code: "CHL-B1", zone: "Chiller (0-4C)", rack: "B", shelf: "1" },
      { code: "FRZ-C1", zone: "Freezer (-18C)", rack: "C", shelf: "1" },
    ],
  },
  {
    key: "GENERAL",
    code: "WH-GEN",
    name: "Gudang Umum & Sparepart Bekasi",
    grade: "non_food",
    org: "WAREHOUSE",
    address: "Kawasan Industri MM2100 Blok DD-13, Cikarang Barat, Bekasi",
    locations: [
      { code: "CHM-E1", zone: "Chemicals", rack: "E", shelf: "1" },
      { code: "SPR-F1", zone: "Spare Parts", rack: "F", shelf: "1" },
      { code: "SPR-F2", zone: "Spare Parts", rack: "F", shelf: "2" },
      { code: "PPE-G1", zone: "PPE", rack: "G", shelf: "1" },
      { code: "PKG-H1", zone: "Packaging (kemasan)", rack: "H", shelf: "1" },
    ],
  },
];

export type ItemCategory =
  | "Bahan Pokok"
  | "Protein"
  | "Sayur & Buah"
  | "Bumbu & Saus"
  | "Minuman"
  | "Kemasan"
  | "Kimia Kebersihan"
  | "Suku Cadang"
  | "APD";

export interface ItemSpec {
  code: string;
  name: string;
  category: ItemCategory;
  /** Stock/purchase unit code (must exist in UNITS). */
  unit: string;
  grade: "food" | "non_food";
  /** Standard purchase cost per unit in IDR. */
  unitCost: number;
  supplier: SupplierKey;
  warehouse: WarehouseKey;
  location: string;
  /** Opening stock on the first day of history. */
  openingQty: number;
  /** Reorder policy. */
  minQty: number;
  reorderPoint: number;
  reorderQty: number;
  leadTimeDays: number;
  /** Already exists from seed.ts (not re-created; stock/layers still added). */
  exists?: true;
  /** Perishable items get a shorter shelf life in batches. */
  perishable?: boolean;
}

const it = (
  code: string,
  name: string,
  category: ItemCategory,
  unit: string,
  grade: "food" | "non_food",
  unitCost: number,
  supplier: SupplierKey,
  warehouse: WarehouseKey,
  location: string,
  openingQty: number,
  reorderPoint: number,
  reorderQty: number,
  extra: Partial<ItemSpec> = {},
): ItemSpec => ({
  code,
  name,
  category,
  unit,
  grade,
  unitCost,
  supplier,
  warehouse,
  location,
  openingQty,
  minQty: Math.round(reorderPoint * 0.5),
  reorderPoint,
  reorderQty,
  leadTimeDays: extra.perishable ? 1 : 3,
  ...extra,
});

export const ITEMS: ItemSpec[] = [
  // --- Bahan pokok
  it("RICE", "Beras Premium", "Bahan Pokok", "KG", "food", 14500, "BERAS", "FOOD", "DRY-A1", 800, 600, 1500, { exists: true }),
  it("MINYAK", "Minyak Goreng Curah", "Bahan Pokok", "LTR", "food", 17500, "SEMBAKO", "FOOD", "DRY-A1", 240, 150, 400),
  it("GULA", "Gula Pasir", "Bahan Pokok", "KG", "food", 17000, "SEMBAKO", "FOOD", "DRY-A1", 120, 60, 150),
  it("GARAM", "Garam Halus", "Bahan Pokok", "KG", "food", 9000, "SEMBAKO", "FOOD", "DRY-A1", 60, 25, 60),
  it("TEPUNG", "Tepung Terigu Serbaguna", "Bahan Pokok", "KG", "food", 12500, "SEMBAKO", "FOOD", "DRY-A2", 90, 40, 100),
  it("MIE-KERING", "Mie Kuning Kering", "Bahan Pokok", "KG", "food", 19000, "SEMBAKO", "FOOD", "DRY-A2", 50, 30, 80),
  it("SANTAN", "Santan Kemasan", "Bahan Pokok", "LTR", "food", 28000, "SEMBAKO", "FOOD", "DRY-A2", 40, 20, 50),
  // --- Protein
  it("AYAM", "Daging Ayam Potong", "Protein", "KG", "food", 38000, "UNGGAS", "FOOD", "FRZ-C1", 260, 200, 500, { exists: true, perishable: true }),
  it("DAGING-SAPI", "Daging Sapi Has Dalam", "Protein", "KG", "food", 135000, "DAGING", "FOOD", "FRZ-C1", 60, 40, 120, { perishable: true }),
  it("IKAN-DORI", "Fillet Ikan Dori", "Protein", "KG", "food", 42000, "IKAN", "FOOD", "FRZ-C1", 70, 50, 120, { perishable: true }),
  it("IKAN-LELE", "Ikan Lele Segar", "Protein", "KG", "food", 27000, "IKAN", "FOOD", "CHL-B1", 40, 30, 80, { perishable: true }),
  it("TELUR", "Telur Ayam Negeri", "Protein", "KG", "food", 29500, "TELUR", "FOOD", "CHL-B1", 120, 80, 200, { perishable: true }),
  it("TEMPE", "Tempe Papan", "Protein", "KG", "food", 14000, "SAYUR", "FOOD", "CHL-B1", 40, 30, 80, { perishable: true }),
  it("TAHU", "Tahu Putih", "Protein", "KG", "food", 11000, "SAYUR", "FOOD", "CHL-B1", 40, 30, 80, { perishable: true }),
  // --- Sayur & buah
  it("SAYUR", "Sayur Tumis (Campur)", "Sayur & Buah", "KG", "food", 12000, "SAYUR", "FOOD", "CHL-B1", 90, 80, 200, { exists: true, perishable: true }),
  it("BAWANG-MERAH", "Bawang Merah", "Sayur & Buah", "KG", "food", 38000, "SAYUR", "FOOD", "DRY-A2", 45, 30, 80),
  it("BAWANG-PUTIH", "Bawang Putih", "Sayur & Buah", "KG", "food", 36000, "SAYUR", "FOOD", "DRY-A2", 40, 25, 70),
  it("CABAI-MERAH", "Cabai Merah Keriting", "Sayur & Buah", "KG", "food", 55000, "SAYUR", "FOOD", "CHL-B1", 25, 20, 50, { perishable: true }),
  it("CABAI-RAWIT", "Cabai Rawit", "Sayur & Buah", "KG", "food", 70000, "SAYUR", "FOOD", "CHL-B1", 12, 10, 25, { perishable: true }),
  it("TOMAT", "Tomat", "Sayur & Buah", "KG", "food", 14000, "SAYUR", "FOOD", "CHL-B1", 30, 25, 60, { perishable: true }),
  it("WORTEL", "Wortel", "Sayur & Buah", "KG", "food", 12500, "SAYUR", "FOOD", "CHL-B1", 40, 30, 80, { perishable: true }),
  it("KENTANG", "Kentang", "Sayur & Buah", "KG", "food", 16000, "SAYUR", "FOOD", "DRY-A2", 50, 35, 90),
  it("BUAH-PISANG", "Pisang (Buah Penutup)", "Sayur & Buah", "KG", "food", 15000, "SAYUR", "FOOD", "CHL-B1", 30, 40, 100, { perishable: true }),
  // --- Bumbu & saus
  it("BUMBU-RACIK", "Bumbu Racik Dasar (Kuning)", "Bumbu & Saus", "KG", "food", 48000, "BUMBU", "FOOD", "DRY-A2", 25, 15, 40),
  it("KECAP", "Kecap Manis", "Bumbu & Saus", "LTR", "food", 26000, "BUMBU", "FOOD", "DRY-A2", 40, 20, 50),
  it("SAMBAL", "Sambal Botol", "Bumbu & Saus", "G", "food", 45, "BUMBU", "FOOD", "DRY-A2", 20000, 8000, 25000, { exists: true }),
  it("SAUS-TOMAT", "Saus Tomat", "Bumbu & Saus", "LTR", "food", 22000, "BUMBU", "FOOD", "DRY-A2", 30, 15, 40),
  // --- Minuman
  it("AIR-GALON", "Air Mineral Galon 19L", "Minuman", "GLN", "food", 21000, "AIR", "FOOD", "DRY-A1", 100, 60, 150),
  it("TEH-CELUP", "Teh Celup (Box 100)", "Minuman", "BOX", "food", 28000, "AIR", "FOOD", "DRY-A1", 50, 25, 60),
  it("KOPI-SACHET", "Kopi Sachet (Box 100)", "Minuman", "BOX", "food", 52000, "AIR", "FOOD", "DRY-A1", 40, 20, 50),
  // --- Kemasan
  it("BOX-NASI", "Kotak Nasi Kertas (Paper Lunch Box)", "Kemasan", "PCS", "non_food", 1250, "KEMASAN", "GENERAL", "PKG-H1", 12000, 8000, 25000),
  it("BOX-SNACK", "Kotak Snack Mika", "Kemasan", "PCS", "non_food", 950, "KEMASAN", "GENERAL", "PKG-H1", 4000, 2500, 8000),
  it("SENDOK-GARPU", "Sendok Garpu Plastik Set", "Kemasan", "PCS", "non_food", 350, "KEMASAN", "GENERAL", "PKG-H1", 15000, 10000, 30000),
  it("KANTONG-PLASTIK", "Kantong Plastik Kresek (Pak)", "Kemasan", "PAK", "non_food", 18000, "KEMASAN", "GENERAL", "PKG-H1", 120, 80, 200),
  it("GELAS-CUP", "Gelas Plastik Cup 220ml", "Kemasan", "PCS", "non_food", 280, "KEMASAN", "GENERAL", "PKG-H1", 20000, 12000, 40000),
  // --- Kimia kebersihan
  it("CLN-LANTAI", "Pembersih Lantai Konsentrat 5L", "Kimia Kebersihan", "BTL", "non_food", 78000, "KIMIA", "GENERAL", "CHM-E1", 70, 40, 100),
  it("CLN-KACA", "Pembersih Kaca 5L", "Kimia Kebersihan", "BTL", "non_food", 64000, "KIMIA", "GENERAL", "CHM-E1", 40, 20, 60),
  it("CLN-DISINFEKTAN", "Disinfektan Konsentrat 5L", "Kimia Kebersihan", "BTL", "non_food", 92000, "KIMIA", "GENERAL", "CHM-E1", 50, 30, 80),
  it("SABUN-TANGAN", "Sabun Cuci Tangan Refill 5L", "Kimia Kebersihan", "BTL", "non_food", 58000, "KIMIA", "GENERAL", "CHM-E1", 60, 35, 90),
  it("KANTONG-SAMPAH", "Kantong Sampah Hitam Jumbo (Pak)", "Kimia Kebersihan", "PAK", "non_food", 42000, "KIMIA", "GENERAL", "CHM-E1", 150, 100, 250),
  it("TISU-ROLL", "Tisu Toilet Jumbo Roll", "Kimia Kebersihan", "RLL", "non_food", 14500, "KIMIA", "GENERAL", "CHM-E1", 500, 300, 800),
  // --- Suku cadang
  it("SPR-FILTER-AC", "Filter AC Split/Cassette", "Suku Cadang", "PCS", "non_food", 85000, "SPAREPART", "GENERAL", "SPR-F1", 40, 20, 50),
  it("SPR-LAMPU-LED", "Lampu LED Tubular 18W", "Suku Cadang", "PCS", "non_food", 45000, "SPAREPART", "GENERAL", "SPR-F1", 120, 60, 150),
  it("SPR-VBELT", "V-Belt Kipas Exhaust B-52", "Suku Cadang", "PCS", "non_food", 62000, "SPAREPART", "GENERAL", "SPR-F2", 20, 10, 25),
  it("SPR-MCB", "MCB 2P 16A", "Suku Cadang", "PCS", "non_food", 78000, "SPAREPART", "GENERAL", "SPR-F2", 25, 12, 30),
  it("SPR-OLI-GENSET", "Oli Genset 20L", "Suku Cadang", "BTL", "non_food", 920000, "SPAREPART", "GENERAL", "SPR-F2", 6, 4, 8),
  // --- APD
  it("PPE-SARUNG", "Sarung Tangan Karet (Pasang)", "APD", "PSG", "non_food", 18000, "APD", "GENERAL", "PPE-G1", 200, 120, 300),
  it("PPE-MASKER", "Masker Medis 3-Ply (Box 50)", "APD", "BOX", "non_food", 32000, "APD", "GENERAL", "PPE-G1", 80, 40, 100),
  it("PPE-SEPATU", "Sepatu Safety Boots (Pasang)", "APD", "PSG", "non_food", 185000, "APD", "GENERAL", "PPE-G1", 30, 15, 40),
  it("PPE-APRON", "Apron Tahan Air", "APD", "PCS", "non_food", 36000, "APD", "GENERAL", "PPE-G1", 60, 30, 80),
  it("PPE-HAIRNET", "Hairnet / Penutup Kepala (Pak 100)", "APD", "PAK", "non_food", 24000, "APD", "GENERAL", "PPE-G1", 40, 20, 60),
];

// ---------------------------------------------------------------------------
// Accounting: periods, accounts, banks, cost centers, payment terms
// ---------------------------------------------------------------------------

export interface GlAccountSpec {
  code: string;
  name: string;
  cls: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  normal: "debit" | "credit";
  /** Already exists from seed.ts (COA FY2026). */
  exists?: true;
}

const gl = (code: string, name: string, cls: GlAccountSpec["cls"], exists = false): GlAccountSpec => ({
  code,
  name,
  cls,
  normal: cls === "ASSET" || cls === "EXPENSE" ? "debit" : "credit",
  ...(exists ? { exists: true as const } : {}),
});

/** Chart of accounts used across the demo (added to the existing COA "FY2026"). */
export const GL_ACCOUNTS: GlAccountSpec[] = [
  gl("1110", "Kas Kecil (Petty Cash)", "ASSET"),
  gl("1121", "Bank Mandiri - Operasional", "ASSET"),
  gl("1122", "Bank BCA - Penerimaan", "ASSET"),
  gl("1123", "Bank BCA - Payroll", "ASSET"),
  gl("1210", "Accounts Receivable", "ASSET", true),
  gl("1230", "PPN Masukan", "ASSET"),
  gl("1310", "Persediaan Bahan Pangan", "ASSET"),
  gl("1320", "Persediaan Kemasan & Perlengkapan", "ASSET"),
  gl("1330", "Persediaan Suku Cadang & APD", "ASSET"),
  gl("1410", "Biaya Dibayar Dimuka", "ASSET"),
  gl("1510", "Peralatan Dapur & Operasional", "ASSET"),
  gl("1520", "Kendaraan Operasional", "ASSET"),
  { code: "1590", name: "Akumulasi Penyusutan", cls: "ASSET", normal: "credit" },
  gl("2110", "Utang Usaha (Accounts Payable)", "LIABILITY"),
  gl("2130", "Utang Gaji & Upah", "LIABILITY"),
  gl("2150", "Utang BPJS", "LIABILITY"),
  gl("2410", "Tax Payable", "LIABILITY", true),
  gl("2420", "Utang PPh 21", "LIABILITY"),
  gl("2430", "PPN Keluaran", "LIABILITY"),
  gl("2500", "Accrued WO Cost", "LIABILITY", true),
  gl("3100", "Modal Disetor", "EQUITY"),
  gl("3200", "Laba Ditahan", "EQUITY"),
  gl("4100", "Service Revenue", "INCOME", true),
  gl("4110", "Pendapatan Katering", "INCOME"),
  gl("4120", "Pendapatan Housekeeping", "INCOME"),
  gl("4130", "Pendapatan Facility & Camp", "INCOME"),
  gl("4900", "Pendapatan Lain-lain", "INCOME"),
  gl("5100", "HPP Bahan Pangan", "EXPENSE"),
  gl("5200", "HPP Tenaga Kerja Langsung", "EXPENSE"),
  gl("5300", "HPP Kemasan & Perlengkapan", "EXPENSE"),
  gl("6100", "Beban Gaji & Tunjangan", "EXPENSE"),
  gl("6110", "Beban BPJS & Asuransi", "EXPENSE"),
  gl("6200", "WO Cost", "EXPENSE", true),
  gl("6300", "Beban Utilitas (Listrik, Air, Gas)", "EXPENSE"),
  gl("6400", "Beban Penyusutan", "EXPENSE"),
  gl("6500", "Beban Perawatan & Perbaikan", "EXPENSE"),
  gl("6600", "Beban Transportasi & BBM", "EXPENSE"),
  gl("6700", "Beban Sewa", "EXPENSE"),
  gl("6800", "Beban Administrasi & Umum", "EXPENSE"),
  gl("6900", "Beban Bank & Lain-lain", "EXPENSE"),
];

export interface BankAccountSpec {
  /** finance cash/bank account code (POST /finance/accounts). */
  code: string;
  name: string;
  accountType: "cash" | "bank" | "petty_cash";
  /** GL account code on the chart (GL_ACCOUNTS). */
  glCode: string;
  bankName?: string;
  /** Masked account number for accounting bank accounts. */
  masked?: string;
  houseBankCode?: string;
  /** Opening balance used by the finance sector (IDR). */
  openingBalance: number;
}
export const BANK_ACCOUNTS: BankAccountSpec[] = [
  { code: "KAS-KECIL", name: "Kas Kecil Kantor Pusat", accountType: "petty_cash", glCode: "1110", openingBalance: 15000000 },
  { code: "BANK-MDR-OPS", name: "Bank Mandiri Operasional", accountType: "bank", glCode: "1121", bankName: "Bank Mandiri", masked: "****-****-3321", houseBankCode: "MDR-OPS", openingBalance: 850000000 },
  { code: "BANK-BCA-REC", name: "Bank BCA Penerimaan", accountType: "bank", glCode: "1122", bankName: "Bank BCA", masked: "****-****-7745", houseBankCode: "BCA-REC", openingBalance: 1250000000 },
  { code: "BANK-BCA-PAY", name: "Bank BCA Payroll", accountType: "bank", glCode: "1123", bankName: "Bank BCA", masked: "****-****-9008", houseBankCode: "BCA-PAY", openingBalance: 400000000 },
];

export const COST_CENTERS: { code: string; name: string; type: "cost" | "profit"; org: OrgKey }[] = [
  { code: "CC-HO", name: "Head Office & Manajemen", type: "cost", org: "HEAD_OFFICE" },
  { code: "CC-CAT", name: "Operasional Katering", type: "profit", org: "CATERING" },
  { code: "CC-FAC", name: "Facility Services", type: "profit", org: "FACILITY" },
  { code: "CC-WH", name: "Gudang & Logistik", type: "cost", org: "WAREHOUSE" },
  { code: "CC-FIN", name: "Keuangan & Akuntansi", type: "cost", org: "FINANCE" },
  { code: "CC-HR", name: "Sumber Daya Manusia", type: "cost", org: "HR" },
  { code: "CC-HSE", name: "K3 & Mutu", type: "cost", org: "HSE" },
  { code: "CC-PRJ", name: "Proyek", type: "profit", org: "PROJECTS" },
];

export const PAYMENT_TERMS: { code: string; name: string; netDays: number }[] = [
  { code: "COD", name: "Tunai saat penerimaan (COD)", netDays: 0 },
  { code: "NET-7", name: "Net 7 hari", netDays: 7 },
  { code: "NET-14", name: "Net 14 hari", netDays: 14 },
  { code: "NET-30", name: "Net 30 hari", netDays: 30 },
  { code: "NET-45", name: "Net 45 hari", netDays: 45 },
];

// ---------------------------------------------------------------------------
// Small lookups every sector needs
// ---------------------------------------------------------------------------

export const customerByCode = (code: string): CustomerSpec | undefined => CUSTOMERS.find((c) => c.code === code);
export const itemByCode = (code: string): ItemSpec | undefined => ITEMS.find((i) => i.code === code);
export const supplierByKey = (key: SupplierKey): SupplierSpec => SUPPLIERS.find((s) => s.key === key)!;
export const employeeByCode = (code: string): EmployeeSpec | undefined => EMPLOYEES.find((x) => x.code === code);
export const allSites = (): (SiteSpec & { customerCode: string })[] =>
  CUSTOMERS.flatMap((c) => c.sites.map((s) => ({ ...s, customerCode: c.code })));
export const itemsByCategory = (category: ItemCategory): ItemSpec[] => ITEMS.filter((i) => i.category === category);
export const itemsBySupplier = (key: SupplierKey): ItemSpec[] => ITEMS.filter((i) => i.supplier === key);

/** Fiscal period code helpers shared with the finance sector ("2026-03" → "MAR-2026"). */
const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
export function periodCodeOf(month: string): { fiscalYearCode: string; periodCode: string; periodName: string } {
  const [y, m] = month.split("-").map(Number);
  return { fiscalYearCode: `FY${y}`, periodCode: `${MONTH_CODES[m - 1]}-${y}`, periodName: `${MONTH_NAMES[m - 1]} ${y}` };
}
