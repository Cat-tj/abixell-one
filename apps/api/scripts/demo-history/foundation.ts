/**
 * Sector "foundation": the master data of PT Sentra Layanan Terpadu — legal
 * entity profile, org structure, departments/positions, roles + users,
 * customers (sites, contacts, contracts, service links), service packs, units
 * of measure, items, suppliers, warehouses with opening stock and valuation
 * layers, employees, chart of accounts, open accounting periods for every
 * month of history, bank/cash accounts, cost centers and payment terms.
 *
 * Everything goes through the real API; SQL is used only to (a) open the
 * accounting periods (the API creates them as `draft` and has no "open"
 * endpoint) and (b) backdate created_at/updated_at of the rows this module
 * created so the master data looks like it was keyed in at go-live / hire /
 * contract date. Idempotent: every step looks the record up first.
 *
 * Run only some steps while developing:  FOUNDATION_STEPS=org,roles npx tsx ...
 */
import type { DemoCtx } from "./harness.js";
import {
  BANK_ACCOUNTS,
  COST_CENTERS,
  CUSTOMERS,
  DEPARTMENTS,
  EMPLOYEES,
  GL_ACCOUNTS,
  ITEMS,
  LEGAL_ENTITY,
  NEW_ROLES,
  OPENING_BALANCE_REFERENCE,
  ORG_UNITS,
  PAYMENT_TERMS,
  POSITIONS,
  SERVICES,
  SUPPLIERS,
  UNITS,
  UNIT_CONVERSIONS,
  USERS,
  WAREHOUSES,
  periodCodeOf,
  type ServiceKey,
} from "./catalog.js";

const S = "foundation";

type Refs = {
  legalEntityId: string;
  orgIds: Record<string, string>;
  userIds: Record<string, string>; // email -> id
};

/** Convenience: create-if-missing counters for the final log line. */
const counts: Record<string, number> = {};
const made = (k: string, n = 1) => {
  if (n > 0) counts[k] = (counts[k] ?? 0) + n;
};

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. Legal entity profile, addresses, tax registration
// ---------------------------------------------------------------------------
async function legalEntityStep(ctx: DemoCtx): Promise<string> {
  const list = await ctx.call<any[]>("GET", "/legal-entities");
  const le = list.find((x) => x.name === LEGAL_ENTITY.seedName) ?? list[0];
  if (!le) throw new Error("no legal entity found; run seed.ts first");

  if (!le.registrationNo || !le.displayName) {
    await ctx.call("PATCH", `/legal-entities/${le.id}`, {
      name: le.name,
      registrationNo: LEGAL_ENTITY.registrationNo,
      displayName: LEGAL_ENTITY.displayName,
      country: LEGAL_ENTITY.country,
      timezone: LEGAL_ENTITY.timezone,
      baseCurrency: LEGAL_ENTITY.baseCurrency,
      email: LEGAL_ENTITY.email,
      phone: LEGAL_ENTITY.phone,
    });
    made("legalEntityProfile");
  }
  const addrs = await ctx.call<any[]>("GET", `/legal-entities/${le.id}/addresses`);
  for (const a of LEGAL_ENTITY.addresses) {
    if (addrs.some((x) => x.addressType === a.addressType && x.isActive !== false)) continue;
    await ctx.call("POST", `/legal-entities/${le.id}/addresses`, a);
    made("legalEntityAddress");
  }
  const regs = await ctx.call<any[]>("GET", `/accounting/tax-registrations?legalEntityId=${le.id}`);
  if (regs.length === 0) {
    await ctx.call("POST", "/accounting/tax-registrations", { legalEntityId: le.id, ...LEGAL_ENTITY.taxRegistration });
    made("taxRegistration");
  }
  return le.id;
}

// ---------------------------------------------------------------------------
// 2. Org units, departments, positions
// ---------------------------------------------------------------------------
async function orgStep(ctx: DemoCtx, legalEntityId: string): Promise<Record<string, string>> {
  let units = await ctx.call<any[]>("GET", "/organization-units");
  const byName = new Map(units.map((u) => [u.name as string, u]));
  const ids: Record<string, string> = {};

  // A leftover probe unit from development is turned into a real one.
  const probe = byName.get("ZZ Probe");
  const facility = ORG_UNITS.find((o) => o.key === "FACILITY")!;
  if (probe && !byName.has(facility.name)) {
    await ctx.call("PATCH", `/organization-units/${probe.id}`, { name: facility.name, unitType: facility.unitType });
    probe.name = facility.name;
    byName.set(facility.name, probe);
  }

  for (const spec of ORG_UNITS) {
    let unit = byName.get(spec.name);
    if (!unit) {
      const parentName = spec.parent ? ORG_UNITS.find((o) => o.key === spec.parent)!.name : null;
      const parent = parentName ? byName.get(parentName) : null;
      unit = await ctx.call("POST", "/organization-units", {
        legalEntityId,
        parentId: parent?.id ?? null,
        name: spec.name,
        unitType: spec.unitType,
        timezone: "Asia/Jakarta",
      });
      byName.set(spec.name, unit);
      made("orgUnit");
    }
    ids[spec.key] = unit.id;
  }

  const deps = await ctx.call<any[]>("GET", "/departments");
  for (const d of DEPARTMENTS) {
    if (deps.some((x) => x.code === d.code)) continue;
    await ctx.call("POST", "/departments", { code: d.code, name: d.name });
    made("department");
  }
  const poss = await ctx.call<any[]>("GET", "/positions");
  for (const p of POSITIONS) {
    if (poss.some((x) => x.code === p.code)) continue;
    await ctx.call("POST", "/positions", { code: p.code, name: p.name, description: p.name });
    made("position");
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 3. Roles + users
// ---------------------------------------------------------------------------
async function roleStep(ctx: DemoCtx): Promise<void> {
  const existing = await ctx.call<any[]>("GET", "/admin/roles");
  const have = new Set(existing.map((r) => r.code));
  const options = await ctx.call<any>("GET", "/admin/role-definition-options");
  const selectable: string[] = options.permissions.filter((p: any) => p.selectable).map((p: any) => p.code);
  const windows: any[] = options.windows.filter((w: any) => w.selectable);

  const resolve = (patterns: string[]): string[] => {
    const out = new Set<string>();
    for (const pat of patterns) {
      if (pat.includes("*")) {
        const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        for (const c of selectable) if (re.test(c)) out.add(c);
      } else if (selectable.includes(pat)) out.add(pat);
    }
    return [...out].sort();
  };

  for (const role of NEW_ROLES) {
    if (have.has(role.code)) continue;
    const permissionCodes = resolve(role.permissions);
    if (permissionCodes.length === 0) throw new Error(`role ${role.code}: no permissions resolved`);
    const granted = new Set(permissionCodes);
    // Menu windows: those with no requirement, or whose required permissions the role holds (any).
    const roleWindows = windows
      .filter((w) => !w.isDetail || true)
      .filter((w) => (w.requiredPermissions ?? []).length === 0 || (w.requiredPermissions as string[]).some((p) => granted.has(p)))
      .map((w) => ({ windowCode: w.code as string, isReadWrite: true, isActive: true }));
    await ctx.call("POST", "/admin/roles", {
      code: role.code,
      description: role.description,
      name: role.name,
      permissionCodes,
      windows: roleWindows,
      includedRoleCodes: [],
    });
    made("role");
  }
}

async function userStep(ctx: DemoCtx): Promise<Record<string, string>> {
  const list = await ctx.call<any[]>("GET", "/admin/users");
  const byEmail = new Map(list.map((x) => [x.email as string, x]));
  const ids: Record<string, string> = {};
  for (const u of Object.values(USERS)) {
    let row = byEmail.get(u.email);
    if (!row) {
      const res = await ctx.call<any>("POST", "/admin/users", {
        email: u.email,
        fullName: u.fullName,
        password: u.password,
        pairs: u.roleCodes.map((roleCode) => ({ roleCode, scopeType: "tenant" })),
      });
      row = res.user ?? res;
      made("user");
    }
    ids[u.email] = row.id;
  }
  // Pre-existing seed users are referenced too.
  for (const x of list) ids[x.email] = x.id;
  return ids;
}

// ---------------------------------------------------------------------------
// 4. Service packs, services
// ---------------------------------------------------------------------------
async function serviceStep(ctx: DemoCtx): Promise<Record<ServiceKey, string>> {
  const packs = await ctx.call<any[]>("GET", "/service-operations/packs");
  for (const p of packs) {
    if (p.isActive) continue;
    await ctx.call("POST", `/service-operations/packs/${p.packCode}/activate`, { seedPresets: true });
    made("servicePack");
  }
  const svcs = await ctx.call<any[]>("GET", "/services");
  const ids = {} as Record<ServiceKey, string>;
  for (const s of SERVICES) {
    let row = svcs.find((x) => x.code === s.code);
    if (!row) {
      row = await ctx.call("POST", "/services", { code: s.code, name: s.name, description: s.description });
      made("service");
    }
    ids[s.key] = row.id;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 5. Customers, contacts, sites, contracts, service links
// ---------------------------------------------------------------------------
async function customerStep(
  ctx: DemoCtx,
  orgIds: Record<string, string>,
  userIds: Record<string, string>,
  serviceIds: Record<ServiceKey, string>,
): Promise<void> {
  const customers = await ctx.call<any[]>("GET", "/customers");
  const byCode = new Map(customers.map((c) => [c.code as string, c]));
  for (const spec of CUSTOMERS) {
    let cust = byCode.get(spec.code);
    if (!cust) {
      cust = await ctx.call("POST", "/customers", {
        code: spec.code,
        name: spec.name,
        ownerOrganizationUnitId: orgIds[spec.owner],
        notes: `Industri: ${spec.industry}. NPWP ${spec.npwp}. Kontrak ${spec.contract.code}, termin ${spec.contract.paymentTermCode}.`,
      });
      made("customer");
    }
    const contacts = await ctx.call<any[]>("GET", `/customer-contacts?customerId=${cust.id}`);
    for (const c of spec.contacts) {
      if (contacts.some((x) => x.email === c.email)) continue;
      await ctx.call("POST", "/customer-contacts", { customerId: cust.id, name: c.name, email: c.email, phone: c.phone, isPrimary: !!c.primary });
      made("customerContact");
    }
    const sites = await ctx.call<any[]>("GET", `/sites?customerId=${cust.id}`);
    const siteIds: Record<string, string> = {};
    for (const s of spec.sites) {
      let site = sites.find((x) => x.code === s.code);
      if (!site) {
        site = await ctx.call("POST", "/sites", { customerId: cust.id, code: s.code, name: s.name, address: `${s.address}, ${s.city}` });
        made("site");
      }
      siteIds[s.code] = site.id;
    }
    const contracts = await ctx.call<any[]>("GET", `/contracts?customerId=${cust.id}`);
    let contract = contracts.find((x) => x.code === spec.contract.code);
    if (!contract) {
      contract = await ctx.call("POST", "/contracts", {
        customerId: cust.id,
        code: spec.contract.code,
        name: spec.contract.name,
        startDate: spec.contract.startDate,
        endDate: spec.contract.endDate,
        status: "active",
      });
      made("contract");
    }
    const links = await ctx.call<any[]>("GET", `/customer-service-links?customerId=${cust.id}`);
    const picEmail = USERS[spec.pic].email;
    for (const svc of spec.services) {
      const targetSites =
        svc === "CATERING"
          ? spec.sites.filter((s) => s.dailyMeals > 0)
          : spec.sites.filter((s) => s.headcount > 0).length > 0
            ? spec.sites.filter((s) => s.headcount > 0)
            : spec.sites.slice(0, 1);
      for (const s of targetSites) {
        if (links.some((l) => l.serviceId === serviceIds[svc] && l.siteId === siteIds[s.code])) continue;
        await ctx.call("POST", "/customer-service-links", {
          customerId: cust.id,
          serviceId: serviceIds[svc],
          contractId: contract.id,
          siteId: siteIds[s.code],
          internalPicUserId: userIds[picEmail] ?? null,
        });
        made("serviceLink");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Units, items, suppliers
// ---------------------------------------------------------------------------
async function unitStep(ctx: DemoCtx): Promise<void> {
  const units = await ctx.call<any[]>("GET", "/units-of-measure");
  for (const u of UNITS) {
    if (units.some((x) => x.code === u.code)) continue;
    await ctx.call("POST", "/units-of-measure", { code: u.code, name: u.name, baseUnitCode: u.baseUnitCode, category: u.category });
    made("unit");
  }
  const conv = await ctx.call<any[]>("GET", "/unit-conversions");
  for (const c of UNIT_CONVERSIONS) {
    const done = conv.some((x) => (x.fromUnitCode ?? x.fromUnit?.code) === c.from && (x.toUnitCode ?? x.toUnit?.code) === c.to);
    if (done) continue;
    try {
      await ctx.call("POST", "/unit-conversions", { fromUnitCode: c.from, toUnitCode: c.to, factor: c.factor, effectiveFrom: "2020-01-01" });
      made("unitConversion");
    } catch (err) {
      // KG->G already exists from seed.ts under a different response shape.
      if (!/exist|overlap|duplicate|conflict/i.test(String(err))) throw err;
    }
  }
}

async function itemSupplierStep(ctx: DemoCtx): Promise<void> {
  const suppliers = await ctx.call<any[]>("GET", "/suppliers");
  for (const s of SUPPLIERS) {
    if (suppliers.some((x) => x.code === s.code)) continue;
    await ctx.call("POST", "/suppliers", {
      code: s.code,
      name: s.name,
      category: s.category,
      contactName: s.contactName,
      email: s.email,
      phone: s.phone,
      address: `${s.address}, ${s.city}`,
    });
    made("supplier");
  }
  const items = await ctx.call<any[]>("GET", "/items");
  for (const i of ITEMS) {
    const row = items.find((x) => x.code === i.code);
    if (row) {
      // Pre-existing seed items only get their missing category / grade filled in.
      if (!row.category || !row.grade) {
        await ctx.call("PATCH", `/items/${i.code}`, { category: row.category ?? i.category, grade: row.grade ?? i.grade, name: undefined });
      }
      continue;
    }
    await ctx.call("POST", "/items", {
      code: i.code,
      name: i.name,
      category: i.category,
      unitOfMeasure: i.unit,
      grade: i.grade,
      description: `${i.name} — standar beli Rp ${i.unitCost.toLocaleString("id-ID")}/${i.unit}`,
    });
    made("item");
  }
}

// ---------------------------------------------------------------------------
// 7. Warehouses, reorder policies, opening stock + valuation layers
// ---------------------------------------------------------------------------
async function warehouseStep(ctx: DemoCtx, orgIds: Record<string, string>): Promise<void> {
  const whs = await ctx.call<any[]>("GET", "/wms/warehouses");
  const whIds: Record<string, string> = {};
  const locIds: Record<string, string> = {}; // `${whKey}:${locCode}`
  for (const w of WAREHOUSES) {
    let wh = whs.find((x) => x.code === w.code);
    if (!wh) {
      wh = await ctx.call("POST", "/wms/warehouses", {
        code: w.code,
        name: w.name,
        organizationUnitId: orgIds[w.org],
        address: w.address,
        grade: w.grade,
      });
      made("warehouse");
    }
    whIds[w.key] = wh.id;
    const locs = await ctx.call<any[]>("GET", `/wms/warehouse-locations?warehouseId=${wh.id}`);
    for (const l of w.locations) {
      let loc = locs.find((x) => x.code === l.code);
      if (!loc) {
        loc = await ctx.call("POST", "/wms/warehouse-locations", { warehouseId: wh.id, code: l.code, zone: l.zone, rack: l.rack ?? null, shelf: l.shelf ?? null });
        made("warehouseLocation");
      }
      locIds[`${w.key}:${l.code}`] = loc.id;
    }
  }

  const items = await ctx.call<any[]>("GET", "/items");
  const itemId = new Map(items.map((x) => [x.code as string, x.id as string]));
  const policies = await ctx.call<any[]>("GET", "/wms/reorder-policies");
  const stockDate = ctx.cal.start;
  const coreBal = await ctx.call<any[]>("GET", "/stock/balances");
  for (const i of ITEMS) {
    const id = itemId.get(i.code);
    if (!id) throw new Error(`item ${i.code} missing`);
    const wid = whIds[i.warehouse];

    if (!policies.some((p) => p.itemId === id && p.warehouseId === wid)) {
      await ctx.call("PUT", "/wms/reorder-policies", {
        itemId: id,
        warehouseId: wid,
        minQuantity: i.minQty,
        reorderPoint: i.reorderPoint,
        reorderQuantity: i.reorderQty,
        safetyStock: Math.round(i.minQty * 0.6),
        leadTimeDays: i.leadTimeDays,
      });
      made("reorderPolicy");
    }

    // Opening stock — core ledger (stock_movements), keyed by the reference.
    const moves = await ctx.call<any[]>("GET", `/stock/movements?itemCode=${encodeURIComponent(i.code)}&limit=200`);
    if (!moves.some((m) => m.reference === OPENING_BALANCE_REFERENCE)) {
      await ctx.call("POST", "/stock/goods-in", {
        itemCode: i.code,
        quantity: i.openingQty,
        reference: OPENING_BALANCE_REFERENCE,
        note: "Saldo awal stok saat go-live sistem",
      });
      made("openingStockCore");
    }
    // Opening stock — warehouse ledger + FIFO valuation layer.
    const advMoves = await ctx.call<any[]>("GET", `/wms/movements?itemId=${id}&warehouseId=${wid}`);
    if (!advMoves.some((m) => m.referenceNumber === OPENING_BALANCE_REFERENCE)) {
      await ctx.call("POST", "/wms/movements", {
        itemId: id,
        warehouseId: wid,
        locationId: locIds[`${i.warehouse}:${i.location}`],
        movementType: "in",
        quantity: i.openingQty,
        unitCost: i.unitCost,
        referenceType: "opening_balance",
        referenceNumber: OPENING_BALANCE_REFERENCE,
        notes: "Saldo awal stok saat go-live sistem",
        occurredAt: ctx.cal.at(stockDate, 14),
      });
      made("openingStockWms");
    }
    const layers = await ctx.call<any[]>("GET", `/wms/valuation-layers?itemId=${id}`);
    if (!layers.some((l) => String(l.receivedDate).slice(0, 10) === stockDate && Number(l.originalQuantity) === i.openingQty)) {
      await ctx.call("POST", "/wms/valuation-layers", {
        itemId: id,
        warehouseId: wid,
        receivedDate: stockDate,
        originalQuantity: i.openingQty,
        unitCost: i.unitCost,
      });
      made("valuationLayer");
    }
  }
  void coreBal;

  // Backdate the opening movements to go-live (core ledger has no occurredAt input).
  await ctx.sql(
    `UPDATE stock_movements SET occurred_at = $2::timestamptz, created_at = $2::timestamptz
      WHERE tenant_id = $1 AND reference = $3`,
    [ctx.tenantId, ctx.cal.at(stockDate, 14), OPENING_BALANCE_REFERENCE],
  );
}

// ---------------------------------------------------------------------------
// 8. Employees (+ login links, resignations)
// ---------------------------------------------------------------------------
async function employeeStep(ctx: DemoCtx, legalEntityId: string, orgIds: Record<string, string>, userIds: Record<string, string>): Promise<void> {
  const existing = await ctx.call<any[]>("GET", "/employees");
  const byNo = new Map(existing.map((x) => [x.employeeNumber as string, x]));
  const userByEmp = new Map(Object.values(USERS).map((u) => [u.employeeCode, userIds[u.email]]));
  for (const e of EMPLOYEES) {
    let row = byNo.get(e.code);
    if (!row) {
      row = await ctx.call("POST", "/employees", {
        employeeNumber: e.code,
        fullName: e.fullName,
        email: `${e.fullName.toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/ +/g, ".")}@sentra.local`,
        phone: e.phone,
        employmentType: e.employmentType,
        employmentStatus: "active",
        joinedAt: e.joinedAt,
        legalEntityId,
        organizationUnitId: orgIds[e.org],
        positionCode: e.positionCode,
        userId: userByEmp.get(e.code) ?? null,
      });
      made("employee");
    } else if (userByEmp.get(e.code) && row.userId !== userByEmp.get(e.code)) {
      await ctx.call("POST", `/employees/${row.id}/user-link`, { userId: userByEmp.get(e.code) });
    }
    if (e.endedAt && row.employmentStatus !== "ended") {
      await ctx.call("POST", `/employees/${row.id}/placement`, {
        employmentStatus: "ended",
        effectiveFrom: e.endedAt,
        note: "Pengunduran diri (resign)",
      });
      made("employeeEnded");
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Accounting: accounts, periods, posting rules, cash/bank, cost centers, terms
// ---------------------------------------------------------------------------
async function accountingStep(ctx: DemoCtx, legalEntityId: string): Promise<void> {
  const charts = await ctx.call<any[]>("GET", "/accounting/charts");
  const coa = charts.find((c) => c.legalEntityId === legalEntityId && c.isActive) ?? charts[0];
  if (!coa) throw new Error("no chart of accounts; run seed.ts first");

  const accounts = await ctx.call<any[]>("GET", "/accounting/accounts");
  const accByCode = new Map(accounts.map((a) => [a.accountCode as string, a]));
  for (const a of GL_ACCOUNTS) {
    if (accByCode.has(a.code)) continue;
    const row = await ctx.call("POST", "/accounting/accounts", {
      legalEntityId,
      coaId: coa.id,
      accountCode: a.code,
      accountName: a.name,
      accountClass: a.cls,
      normalBalance: a.normal,
      accountType: null,
    });
    accByCode.set(a.code, row);
    made("glAccount");
  }

  // Periods: every month from the first history month through Dec of next year.
  const periods = await ctx.call<any[]>("GET", `/accounting/periods?legalEntityId=${legalEntityId}`);
  const first = ctx.cal.months[0];
  const last = `${Number(ctx.cal.months[ctx.cal.months.length - 1].slice(0, 4))}-12`;
  for (let m = first; m <= last; m = addMonths(m, 1)) {
    const from = `${m}-01`;
    const to = lastDayOf(m);
    const overlapping = periods.find((p) => String(p.dateFrom).slice(0, 10) <= to && String(p.dateTo).slice(0, 10) >= from);
    if (overlapping) continue;
    const code = periodCodeOf(m);
    await ctx.call("POST", "/accounting/periods", {
      legalEntityId,
      fiscalYearCode: code.fiscalYearCode,
      periodCode: code.periodCode,
      periodName: code.periodName,
      periodType: "monthly",
      dateFrom: from,
      dateTo: to,
    });
    made("accountingPeriod");
  }
  // The API creates periods as draft and has no "open" action — open the ones in our range.
  const opened = await ctx.sql(
    `UPDATE accounting_periods SET status = 'open', updated_at = now()
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'draft'
        AND date_from >= $3::date AND date_to <= $4::date
      RETURNING id`,
    [ctx.tenantId, legalEntityId, `${first}-01`, lastDayOf(last)],
  );
  made("accountingPeriodOpened", opened.length);

  // Posting rules: the seed's v1 rules are effective 2026-01-01; add v0 so the
  // history months of 2025 resolve a rule too.
  const rules = await ctx.call<any[]>("GET", "/accounting/posting-rules");
  const seedRules = rules.filter((r) => r.ruleVersion === "v1");
  for (const r of seedRules) {
    if (rules.some((x) => x.ruleCode === r.ruleCode && x.ruleVersion === "v0")) continue;
    await ctx.call("POST", "/accounting/posting-rules", {
      ruleCode: r.ruleCode,
      ruleName: r.ruleName,
      ruleVersion: "v0",
      triggerEventType: r.triggerEventType,
      accountingFormula: r.accountingFormula,
      requiresApproval: false,
      effectiveDate: "2025-01-01",
    });
    made("postingRuleV0");
  }

  // Cash / bank accounts (finance module) and bank accounts (accounting bank-recon).
  const finAccts = await ctx.call<any[]>("GET", "/finance/accounts");
  for (const b of BANK_ACCOUNTS) {
    if (!finAccts.some((x) => x.code === b.code)) {
      await ctx.call("POST", "/finance/accounts", {
        code: b.code,
        name: b.name,
        accountType: b.accountType,
        currency: "IDR",
        description: b.bankName ? `${b.bankName} ${b.masked ?? ""}`.trim() : "Kas kecil operasional kantor pusat",
        legalEntityId,
      });
      made("financeAccount");
    }
  }
  const banks = await ctx.call<any[]>("GET", "/accounting/bank-accounts");
  for (const b of BANK_ACCOUNTS.filter((x) => x.accountType === "bank")) {
    if (banks.some((x) => x.houseBankCode === b.houseBankCode)) continue;
    await ctx.call("POST", "/accounting/bank-accounts", {
      legalEntityId,
      bankName: b.bankName,
      houseBankCode: b.houseBankCode,
      bankAccountId: b.houseBankCode,
      accountNumberMasked: b.masked,
      name: b.name,
      currency: "IDR",
      ledgerAccountId: accByCode.get(b.glCode).id,
      reconciliationPolicy: "suggested",
      effectiveFrom: ctx.cal.start,
    });
    made("bankAccount");
  }

  const ccs = await ctx.call<any[]>("GET", "/finance/cost-centers");
  const orgs = await ctx.call<any[]>("GET", "/organization-units");
  for (const c of COST_CENTERS) {
    if (ccs.some((x) => x.code === c.code)) continue;
    const orgName = ORG_UNITS.find((o) => o.key === c.org)!.name;
    await ctx.call("POST", "/finance/cost-centers", {
      code: c.code,
      name: c.name,
      type: c.type,
      legalEntityId,
      orgUnitId: orgs.find((o) => o.name === orgName)?.id ?? null,
      effectiveFrom: "2025-01-01",
    });
    made("costCenter");
  }
  const terms = await ctx.call<any[]>("GET", "/finance/payment-terms");
  for (const t of PAYMENT_TERMS) {
    if (terms.some((x) => x.code === t.code)) continue;
    await ctx.call("POST", "/finance/payment-terms", { code: t.code, name: t.name, netDays: t.netDays, effectiveFrom: "2025-01-01" });
    made("paymentTerm");
  }
}

// ---------------------------------------------------------------------------
// 10. Backdating: only rows this module created
// ---------------------------------------------------------------------------
async function backdate(ctx: DemoCtx): Promise<void> {
  const t = ctx.tenantId;
  const goLive = (h = 9) => ctx.cal.at(ctx.cal.start, h);
  const clampDate = (d: string) => (d < ctx.cal.start ? ctx.cal.start : d);

  // Master data keyed in at go-live.
  const golive = [
    ["organization_units", "name", ORG_UNITS.map((o) => o.name).filter((n) => !["Head Office", "Catering Operations"].includes(n))],
    ["departments", "code", DEPARTMENTS.map((d) => d.code)],
    ["positions", "code", POSITIONS.map((p) => p.code)],
    ["suppliers", "code", SUPPLIERS.map((s) => s.code)],
    ["items", "code", ITEMS.filter((i) => !i.exists).map((i) => i.code)],
    ["units_of_measure", "code", UNITS.filter((u) => !u.exists).map((u) => u.code)],
    ["services", "code", SERVICES.filter((s) => !s.exists).map((s) => s.code)],
    ["scm_warehouses", "code", WAREHOUSES.map((w) => w.code)],
    ["accounting_accounts", "account_code", GL_ACCOUNTS.filter((a) => !a.exists).map((a) => a.code)],
    ["finance_cost_centers", "code", COST_CENTERS.map((c) => c.code)],
    ["finance_payment_terms", "code", PAYMENT_TERMS.map((p) => p.code)],
    ["finance_accounts", "code", BANK_ACCOUNTS.map((b) => b.code)],
  ] as const;
  for (const [table, col, codes] of golive) {
    try {
      await ctx.sql(
        `UPDATE ${table} SET created_at = $3::timestamptz + (random() * interval '6 hours'), updated_at = $3::timestamptz + interval '7 hours'
          WHERE tenant_id = $1 AND ${col} = ANY($2) AND created_at > $3::timestamptz + interval '1 day'`,
        [t, codes as unknown as string[], goLive(8)],
      );
    } catch (err) {
      ctx.log(S, `backdate ${table} skipped: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  // Warehouse locations, reorder policies, valuation layers, WMS movements.
  await ctx.sql(
    `UPDATE scm_warehouse_locations l SET created_at = $2::timestamptz, updated_at = $2::timestamptz
       FROM scm_warehouses w WHERE w.id = l.warehouse_id AND w.tenant_id = $1 AND l.created_at > $2::timestamptz + interval '1 day'`,
    [t, goLive(8)],
  );
  await ctx.sql(
    `UPDATE scm_reorder_policies SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '1 day'`,
    [t, goLive(8)],
  );
  await ctx.sql(
    `UPDATE scm_valuation_layers SET created_at = $2::timestamptz WHERE tenant_id = $1 AND received_date = $3::date AND created_at > $2::timestamptz + interval '1 day'`,
    [t, goLive(14), ctx.cal.start],
  );
  // scm_advanced_stock_movements is append-only (trigger); its occurred_at was set through the API.
  await ctx.sql(`UPDATE stock_balances SET updated_at = $2::timestamptz WHERE tenant_id = $1 AND updated_at > $2::timestamptz + interval '1 day'`, [t, goLive(14)]);
  await ctx.sql(
    `UPDATE accounting_periods SET created_at = $2::timestamptz, updated_at = $2::timestamptz
      WHERE tenant_id = $1 AND date_from >= '2025-11-01' AND created_at > $2::timestamptz + interval '1 day'`,
    [t, goLive(8)],
  );
  await ctx.sql(
    `UPDATE posting_rules SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE tenant_id = $1 AND rule_version = 'v0'`,
    [t, goLive(8)],
  );
  await ctx.sql(
    `UPDATE finance_bank_accounts SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE tenant_id = $1 AND created_at > $2::timestamptz + interval '1 day'`,
    [t, goLive(8)],
  ).catch(() => undefined);

  // Employees + their logins: hire date (clamped to go-live) — placements start on the real join date already.
  for (const e of EMPLOYEES) {
    const at = ctx.cal.at(clampDate(e.joinedAt), 9);
    await ctx.sql(
      `UPDATE employees SET created_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE tenant_id = $1 AND employee_number = $2 AND created_at > $3::timestamptz + interval '1 day'`,
      [t, e.code, at],
    );
  }
  for (const u of Object.values(USERS)) {
    const emp = EMPLOYEES.find((x) => x.code === u.employeeCode)!;
    const at = ctx.cal.at(clampDate(emp.joinedAt), 10);
    await ctx.sql(
      `UPDATE users SET created_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE tenant_id = $1 AND email = $2 AND created_at > $3::timestamptz + interval '1 day'`,
      [t, u.email, at],
    );
  }
  await ctx.sql(
    `UPDATE user_role_assignments a SET assigned_at = u.created_at
       FROM users u WHERE u.id = a.user_id AND u.tenant_id = $1 AND u.email = ANY($2) AND a.assigned_at > u.created_at + interval '1 day'`,
    [t, Object.values(USERS).map((u) => u.email)],
  ).catch(() => undefined);
  await ctx.sql(
    `UPDATE roles SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE tenant_id = $1 AND code = ANY($3) AND created_at > $2::timestamptz + interval '1 day'`,
    [t, goLive(8), NEW_ROLES.map((r) => r.code)],
  ).catch(() => undefined);

  // Customers, sites, contacts, contracts, links: the account opens ~2 weeks before the contract starts.
  for (const c of CUSTOMERS) {
    const opened = clampDate(ctx.cal.addDays(c.contract.startDate, -14));
    const at = ctx.cal.at(opened, 11);
    await ctx.sql(
      `UPDATE customers SET created_at = $3::timestamptz, updated_at = $3::timestamptz WHERE tenant_id = $1 AND code = $2 AND created_at > $3::timestamptz + interval '1 day'`,
      [t, c.code, at],
    );
    const sub = (table: string, fk = "customer_id") =>
      ctx.sql(
        `UPDATE ${table} x SET created_at = $3::timestamptz + (random() * interval '3 hours'), updated_at = $3::timestamptz + interval '4 hours'
           FROM customers c WHERE c.id = x.${fk} AND c.tenant_id = $1 AND c.code = $2 AND x.created_at > $3::timestamptz + interval '1 day'`,
        [t, c.code, at],
      );
    await sub("sites");
    await sub("customer_contacts");
    await sub("contracts");
    await sub("customer_service_links");
  }
}

// ---------------------------------------------------------------------------

export async function run(ctx: DemoCtx): Promise<void> {
  const only = (process.env.FOUNDATION_STEPS ?? "").split(",").filter(Boolean);
  const want = (k: string) => only.length === 0 || only.includes(k);

  const legalEntityId = await legalEntityStep(ctx);
  const orgIds = await orgStep(ctx, legalEntityId);
  if (want("roles")) await roleStep(ctx);
  const userIds = await userStep(ctx);
  const serviceIds = await serviceStep(ctx);
  if (want("customers")) await customerStep(ctx, orgIds, userIds, serviceIds);
  if (want("items")) {
    await unitStep(ctx);
    await itemSupplierStep(ctx);
  }
  if (want("stock")) await warehouseStep(ctx, orgIds);
  if (want("employees")) await employeeStep(ctx, legalEntityId, orgIds, userIds);
  if (want("accounting")) await accountingStep(ctx, legalEntityId);
  if (want("backdate")) await backdate(ctx);

  const summary = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  ctx.log(S, summary ? `created: ${summary}` : "nothing new to create (already seeded)");
}
