/**
 * Wave A5 — Warehouses, Bin/Locations, Batches & Serials (SCM-ADV-001..003).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ScmGrade,
  type ScmItem,
  type ScmItemBatch,
  type ScmItemSerial,
  type ScmWarehouse,
  type ScmWarehouseLocation,
  type ScmAdvancedStockBalance,
  type ScmAdvancedStockMovement,
  type ScmAdvancedStockMovementType,
} from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
import { PERMISSIONS } from "../../lib/capabilities";
import { useShell } from "../../shell/layout/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { formatDateShort, formatMoney } from "../../shared/format";
import { GradeBadge, GradeOptions, parseGrade } from "../../shared/GradeBadge";

const MOVEMENT_TYPES: ScmAdvancedStockMovementType[] = [
  "in",
  "out",
  "transfer_in",
  "transfer_out",
  "adjustment_in",
  "adjustment_out",
  "opname_in",
  "opname_out",
];

function label(v: string): string {
  return v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function WarehousesPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const t = useT();
  const { permissions } = useShell();

  const canManage = permissions.includes(PERMISSIONS.supplyChainWarehouseManage);

  const [tab, setTab] = useState<"warehouses" | "locations" | "batches" | "serials" | "balances" | "movements">("warehouses");
  const [warehouses, setWarehouses] = useState<ScmWarehouse[]>([]);
  const [locations, setLocations] = useState<ScmWarehouseLocation[]>([]);
  const [batches, setBatches] = useState<ScmItemBatch[]>([]);
  const [serials, setSerials] = useState<ScmItemSerial[]>([]);
  const [balances, setBalances] = useState<ScmAdvancedStockBalance[]>([]);
  const [movements, setMovements] = useState<ScmAdvancedStockMovement[]>([]);
  const [items, setItems] = useState<ScmItem[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form states - Warehouse
  const [whCode, setWhCode] = useState("");
  const [whName, setWhName] = useState("");
  const [whAddress, setWhAddress] = useState("");
  const [whGrade, setWhGrade] = useState<ScmGrade | null>(null);

  // Form states - Location
  const [locWhId, setLocWhId] = useState("");
  const [locCode, setLocCode] = useState("");
  const [locZone, setLocZone] = useState("");
  const [locAisle, setLocAisle] = useState("");
  const [locRack, setLocRack] = useState("");
  const [locShelf, setLocShelf] = useState("");
  const [locBin, setLocBin] = useState("");

  // Form states - Batch
  const [batchItemId, setBatchItemId] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [batchMfgDate, setBatchMfgDate] = useState("");
  const [batchExpDate, setBatchExpDate] = useState("");
  const [batchNotes, setBatchNotes] = useState("");

  // Form states - Serial
  const [serialItemId, setSerialItemId] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [serialWhId, setSerialWhId] = useState("");
  const [serialWarranty, setSerialWarranty] = useState("");

  // Form states - Movement
  const [movItemId, setMovItemId] = useState("");
  const [movWhId, setMovWhId] = useState("");
  const [movType, setMovType] = useState<ScmAdvancedStockMovementType>("in");
  const [movQty, setMovQty] = useState("10");
  const [movUnitCost, setMovUnitCost] = useState("0");
  const [movNotes, setMovNotes] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [whList, itList, locList, bList, sList, balList, movList] = await Promise.all([
        api.scmWarehouses(token),
        api.scmItems(token),
        api.scmWarehouseLocations(token),
        api.scmBatches(token, { includeExpired: true }),
        api.scmSerials(token),
        api.scmAdvancedStockBalances(token),
        api.scmAdvancedStockMovements(token, { limit: 100 }),
      ]);
      setWarehouses(whList);
      setItems(itList);
      setLocations(locList);
      setBatches(bList);
      setSerials(sList);
      setBalances(balList);
      setMovements(movList);
      if (whList.length > 0 && !locWhId) setLocWhId(whList[0].id);
      if (whList.length > 0 && !movWhId) setMovWhId(whList[0].id);
      if (whList.length > 0 && !serialWhId) setSerialWhId(whList[0].id);
      if (itList.length > 0 && !batchItemId) setBatchItemId(itList[0].id);
      if (itList.length > 0 && !serialItemId) setSerialItemId(itList[0].id);
      if (itList.length > 0 && !movItemId) setMovItemId(itList[0].id);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.wh.msg.failedToLoadWarehouseData"));
    } finally {
      setLoading(false);
    }
  }, [token, locWhId, movWhId, serialWhId, batchItemId, serialItemId, movItemId, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const whMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);
  const locMap = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  const batchMap = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);

  async function handleCreateWarehouse(e: React.FormEvent) {
    e.preventDefault();
    if (!whCode.trim() || !whName.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmWarehouse(token, {
        code: whCode.trim(),
        name: whName.trim(),
        siteId: null,
        address: whAddress.trim() || null,
        grade: whGrade,
      });
      setNotice(`Warehouse ${whCode} created.`);
      setWhCode("");
      setWhName("");
      setWhAddress("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.wh.msg.failedToCreateWarehouse"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateLocation(e: React.FormEvent) {
    e.preventDefault();
    if (!locWhId || !locCode.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmWarehouseLocation(token, {
        warehouseId: locWhId,
        code: locCode.trim(),
        zone: locZone.trim() || null,
        aisle: locAisle.trim() || null,
        rack: locRack.trim() || null,
        shelf: locShelf.trim() || null,
        bin: locBin.trim() || null,
      });
      setNotice(`Location ${locCode} created.`);
      setLocCode("");
      setLocZone("");
      setLocAisle("");
      setLocRack("");
      setLocShelf("");
      setLocBin("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.wh.msg.failedToCreateLocation"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateBatch(e: React.FormEvent) {
    e.preventDefault();
    if (!batchItemId || !batchNumber.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmBatch(token, {
        itemId: batchItemId,
        batchNumber: batchNumber.trim(),
        manufacturedDate: batchMfgDate || null,
        expiryDate: batchExpDate || null,
        notes: batchNotes.trim() || null,
      });
      setNotice(`Batch ${batchNumber} created.`);
      setBatchNumber("");
      setBatchMfgDate("");
      setBatchExpDate("");
      setBatchNotes("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.wh.msg.failedToCreateBatch"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSerial(e: React.FormEvent) {
    e.preventDefault();
    if (!serialItemId || !serialNumber.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createScmSerial(token, {
        itemId: serialItemId,
        serialNumber: serialNumber.trim(),
        warehouseId: serialWhId || null,
        locationId: null,
        batchId: null,
        warrantyExpiryDate: serialWarranty || null,
      });
      setNotice(`Serial ${serialNumber} registered.`);
      setSerialNumber("");
      setSerialWarranty("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.wh.msg.failedToCreateSerial"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordMovement(e: React.FormEvent) {
    e.preventDefault();
    if (!movItemId || !movWhId || Number(movQty) <= 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.recordScmAdvancedStockMovement(token, {
        itemId: movItemId,
        warehouseId: movWhId,
        locationId: null,
        batchId: null,
        movementType: movType,
        quantity: Number(movQty),
        unitCost: Number(movUnitCost) || 0,
        notes: movNotes.trim() || null,
      });
      setNotice(t("scm.wh.msg.movementRecordedSuccessfully"));
      setMovNotes("");
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t("scm.wh.msg.failedToRecordMovement"));
    } finally {
      setBusy(false);
    }
  }

  const warehouseColumns: Column<ScmWarehouse>[] = [
    {
      header: t("scm.wh.h.code"),
      cell: (r) => <span className="font-mono font-semibold">{r.code}</span>,
      mobileRole: "title",
    },
    { header: t("scm.wh.h.name"), cell: (r) => r.name },
    { header: t("scm.wh.h.address"), cell: (r) => r.address || "—" },
    { header: t("grade.label"), cell: (r) => <GradeBadge grade={r.grade} /> },
    {
      header: t("scm.wh.h.status"),
      cell: (r) => <StatusPill tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "Active" : "Inactive"}</StatusPill>,
      mobileRole: "status",
    },
    { header: t("scm.wh.h.created"), cell: (r) => formatDateShort(r.createdAt) },
  ];

  const locationColumns: Column<ScmWarehouseLocation>[] = [
    { header: t("scm.wh.h.warehouse"), cell: (r) => whMap.get(r.warehouseId)?.name || r.warehouseId },
    {
      header: t("scm.wh.h.locationCode"),
      cell: (r) => <span className="font-mono font-semibold">{r.code}</span>,
      mobileRole: "title",
    },
    { header: t("scm.wh.h.zoneAisle"), cell: (r) => `${r.zone || "—"} / ${r.aisle || "—"}` },
    { header: t("scm.wh.h.rackShelfBin"), cell: (r) => `${r.rack || "—"} / ${r.shelf || "—"} / ${r.bin || "—"}` },
    {
      header: t("scm.wh.h.status"),
      cell: (r) => <StatusPill tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "Active" : "Inactive"}</StatusPill>,
      mobileRole: "status",
    },
  ];

  const batchColumns: Column<ScmItemBatch>[] = [
    {
      header: t("scm.wh.h.batch"),
      cell: (r) => <span className="font-mono font-semibold">{r.batchNumber}</span>,
      mobileRole: "title",
    },
    { header: t("scm.wh.h.item"), cell: (r) => itemMap.get(r.itemId)?.name || r.itemId },
    { header: t("scm.wh.h.mfgDate"), cell: (r) => r.manufacturedDate ? formatDateShort(r.manufacturedDate) : "—" },
    { header: t("scm.wh.h.expiryDate"), cell: (r) => r.expiryDate ? formatDateShort(r.expiryDate) : "—" },
    { header: t("scm.wh.h.notes"), cell: (r) => r.notes || "—" },
  ];

  const serialColumns: Column<ScmItemSerial>[] = [
    {
      header: t("scm.wh.h.serial"),
      cell: (r) => <span className="font-mono font-semibold">{r.serialNumber}</span>,
      mobileRole: "title",
    },
    { header: t("scm.wh.h.item"), cell: (r) => itemMap.get(r.itemId)?.name || r.itemId },
    { header: t("scm.wh.h.warehouse"), cell: (r) => r.warehouseId ? (whMap.get(r.warehouseId)?.name || r.warehouseId) : "—" },
    {
      header: t("scm.wh.h.status"),
      cell: (r) => <StatusPill tone={r.status === "in_stock" ? "success" : r.status === "reserved" ? "warning" : "neutral"}>{label(r.status)}</StatusPill>,
      mobileRole: "status",
    },
    { header: t("scm.wh.h.warrantyExpiry"), cell: (r) => r.warrantyExpiryDate ? formatDateShort(r.warrantyExpiryDate) : "—" },
  ];

  const balanceColumns: Column<ScmAdvancedStockBalance>[] = [
    {
      header: t("scm.wh.h.item"),
      cell: (r) => itemMap.get(r.itemId)?.name || r.itemId,
      mobileRole: "title",
    },
    { header: t("scm.wh.h.warehouse"), cell: (r) => whMap.get(r.warehouseId)?.name || r.warehouseId },
    { header: t("scm.wh.h.location"), cell: (r) => r.locationId ? (locMap.get(r.locationId)?.code || r.locationId) : "—" },
    { header: t("scm.wh.h.batch2"), cell: (r) => r.batchId ? (batchMap.get(r.batchId)?.batchNumber || r.batchId) : "—" },
    { header: t("scm.wh.h.onHand"), cell: (r) => <span className="font-mono font-bold">{r.quantity}</span> },
    { header: t("scm.wh.h.reserved"), cell: (r) => <span className="font-mono text-amber-600">{r.reservedQty}</span> },
    {
      header: t("scm.wh.h.available"),
      cell: (r) => <span className="font-mono font-bold text-emerald-600">{r.availableQuantity}</span>,
      mobileRole: "status",
    },
  ];

  const movementColumns: Column<ScmAdvancedStockMovement>[] = [
    { header: t("scm.wh.h.date"), cell: (r) => formatDateShort(r.occurredAt) },
    {
      header: t("scm.wh.h.type"),
      cell: (r) => <Badge className={r.movementType.includes("in") ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}>{label(r.movementType)}</Badge>,
      mobileRole: "status",
    },
    {
      header: t("scm.wh.h.item"),
      cell: (r) => itemMap.get(r.itemId)?.name || r.itemId,
      mobileRole: "title",
    },
    { header: t("scm.wh.h.warehouse"), cell: (r) => whMap.get(r.warehouseId)?.name || r.warehouseId },
    { header: t("scm.wh.h.quantity"), cell: (r) => <span className="font-mono font-bold">{r.quantity}</span> },
    { header: t("scm.wh.h.totalCost"), cell: (r) => formatMoney(r.totalCost) },
    { header: t("scm.wh.h.notes"), cell: (r) => r.notes || "—" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("scm.wh.title.warehousesTracking")}
        subtitle={t("scm.wh.sub.multiWarehouseTopologyBinStorageLocation")}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <Button variant={tab === "warehouses" ? "primary" : "secondary"} onClick={() => setTab("warehouses")}>{t("scm.wh.t.warehouses")}</Button>
        <Button variant={tab === "locations" ? "primary" : "secondary"} onClick={() => setTab("locations")}>{t("scm.wh.t.locationsBins")}</Button>
        <Button variant={tab === "batches" ? "primary" : "secondary"} onClick={() => setTab("batches")}>{t("scm.wh.t.batchesLots")}</Button>
        <Button variant={tab === "serials" ? "primary" : "secondary"} onClick={() => setTab("serials")}>{t("scm.wh.t.serials")}</Button>
        <Button variant={tab === "balances" ? "primary" : "secondary"} onClick={() => setTab("balances")}>{t("scm.wh.t.stockBalances")}</Button>
        <Button variant={tab === "movements" ? "primary" : "secondary"} onClick={() => setTab("movements")}>{t("scm.wh.t.ledgerMovements")}</Button>
      </div>

      {loading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : tab === "warehouses" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.warehouseDirectory")}</h3>
              <DataTable columns={warehouseColumns} rows={warehouses} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.wh.n.noWarehousesDefinedYet")}</p>} />
            </Card>
          </div>
          <div>
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.registerWarehouse")}</h3>
              <form onSubmit={handleCreateWarehouse} className="space-y-4">
                <Field label={t("scm.wh.f.warehouseCode")} required>
                  <Input value={whCode} onChange={(e) => setWhCode(e.target.value)} placeholder={t("scm.wh.p.eGWhMain")} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.wh.f.warehouseName")} required>
                  <Input value={whName} onChange={(e) => setWhName(e.target.value)} placeholder={t("scm.wh.p.eGCentralDistributionHub")} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.wh.f.address")}>
                  <Input value={whAddress} onChange={(e) => setWhAddress(e.target.value)} placeholder={t("scm.wh.p.eGBuilding4LogisticsPark")} disabled={!canManage || busy} />
                </Field>
                <Field label={t("grade.label")}>
                  <Select value={whGrade ?? ""} onChange={(e) => setWhGrade(parseGrade(e.target.value))} disabled={!canManage || busy}>
                    <GradeOptions />
                  </Select>
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.wh.t.createWarehouse")}</Button>
              </form>
            </Card>
          </div>
        </div>
      ) : tab === "locations" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.storageBinsLocations")}</h3>
              <DataTable columns={locationColumns} rows={locations} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.wh.n.noLocationsDefinedYet")}</p>} />
            </Card>
          </div>
          <div>
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.defineStorageLocation")}</h3>
              <form onSubmit={handleCreateLocation} className="space-y-4">
                <Field label={t("scm.wh.f.warehouse")} required>
                  <Select value={locWhId} onChange={(e) => setLocWhId(e.target.value)} disabled={!canManage || busy}>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.wh.f.locationBinCode")} required>
                  <Input value={locCode} onChange={(e) => setLocCode(e.target.value)} placeholder={t("scm.wh.p.eGA0102B")} disabled={!canManage || busy} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t("scm.wh.f.zone")}><Input value={locZone} onChange={(e) => setLocZone(e.target.value)} placeholder={t("scm.wh.p.zoneA")} disabled={!canManage || busy} /></Field>
                  <Field label={t("scm.wh.f.aisle")}><Input value={locAisle} onChange={(e) => setLocAisle(e.target.value)} placeholder={t("scm.wh.p.aisle1")} disabled={!canManage || busy} /></Field>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label={t("scm.wh.f.rack")}><Input value={locRack} onChange={(e) => setLocRack(e.target.value)} placeholder="R1" disabled={!canManage || busy} /></Field>
                  <Field label={t("scm.wh.f.shelf")}><Input value={locShelf} onChange={(e) => setLocShelf(e.target.value)} placeholder="S2" disabled={!canManage || busy} /></Field>
                  <Field label={t("scm.wh.f.bin")}><Input value={locBin} onChange={(e) => setLocBin(e.target.value)} placeholder="B1" disabled={!canManage || busy} /></Field>
                </div>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.wh.t.addLocation")}</Button>
              </form>
            </Card>
          </div>
        </div>
      ) : tab === "batches" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.batchLotRegistry")}</h3>
              <DataTable columns={batchColumns} rows={batches} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.wh.n.noBatchesRegisteredYet")}</p>} />
            </Card>
          </div>
          <div>
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.createItemBatch")}</h3>
              <form onSubmit={handleCreateBatch} className="space-y-4">
                <Field label={t("scm.wh.f.item")} required>
                  <Select value={batchItemId} onChange={(e) => setBatchItemId(e.target.value)} disabled={!canManage || busy}>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.wh.f.batchNumber")} required>
                  <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} placeholder={t("scm.wh.p.eGLot2026001")} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.wh.f.manufacturedDate")}>
                  <Input type="date" value={batchMfgDate} onChange={(e) => setBatchMfgDate(e.target.value)} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.wh.f.expiryDate")}>
                  <Input type="date" value={batchExpDate} onChange={(e) => setBatchExpDate(e.target.value)} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.wh.f.notes")}>
                  <Input value={batchNotes} onChange={(e) => setBatchNotes(e.target.value)} placeholder={t("scm.wh.p.supplierCertificatesStorageNotes")} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.wh.t.registerBatch")}</Button>
              </form>
            </Card>
          </div>
        </div>
      ) : tab === "serials" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.serialNumberTracking")}</h3>
              <DataTable columns={serialColumns} rows={serials} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.wh.n.noSerialItemsRegisteredYet")}</p>} />
            </Card>
          </div>
          <div>
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.registerSerialNumber")}</h3>
              <form onSubmit={handleCreateSerial} className="space-y-4">
                <Field label={t("scm.wh.f.item")} required>
                  <Select value={serialItemId} onChange={(e) => setSerialItemId(e.target.value)} disabled={!canManage || busy}>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.wh.f.serialNumber")} required>
                  <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder={t("scm.wh.p.eGSn88492019")} disabled={!canManage || busy} />
                </Field>
                <Field label={t("scm.wh.f.warehouse")}>
                  <Select value={serialWhId} onChange={(e) => setSerialWhId(e.target.value)} disabled={!canManage || busy}>
                    <option value="">{t("scm.wh.t.noneUnassigned")}</option>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.wh.f.warrantyExpiryDate")}>
                  <Input type="date" value={serialWarranty} onChange={(e) => setSerialWarranty(e.target.value)} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.wh.t.registerSerial")}</Button>
              </form>
            </Card>
          </div>
        </div>
      ) : tab === "balances" ? (
        <Card>
          <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.authoritativeMultiWarehouseBalances")}</h3>
          <DataTable columns={balanceColumns} rows={balances} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.wh.n.noStockBalancesFound")}</p>} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.immutableStockMovementLedger")}</h3>
              <DataTable columns={movementColumns} rows={movements} keyOf={(r) => r.id} empty={<p className="text-slate-500 py-4 text-center text-sm">{t("scm.wh.n.noLedgerMovementsRecordedYet")}</p>} />
            </Card>
          </div>
          <div>
            <Card>
              <h3 className="text-base font-semibold text-slate-900 mb-3">{t("scm.wh.t.recordLedgerMovement")}</h3>
              <form onSubmit={handleRecordMovement} className="space-y-4">
                <Field label={t("scm.wh.f.item")} required>
                  <Select value={movItemId} onChange={(e) => setMovItemId(e.target.value)} disabled={!canManage || busy}>
                    {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.wh.f.warehouse")} required>
                  <Select value={movWhId} onChange={(e) => setMovWhId(e.target.value)} disabled={!canManage || busy}>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                </Field>
                <Field label={t("scm.wh.f.movementType")} required>
                  <Select value={movType} onChange={(e) => setMovType(e.target.value as ScmAdvancedStockMovementType)} disabled={!canManage || busy}>
                    {MOVEMENT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t("scm.wh.f.quantity")} required>
                    <Input type="number" min="0.01" step="any" value={movQty} onChange={(e) => setMovQty(e.target.value)} disabled={!canManage || busy} />
                  </Field>
                  <Field label={t("scm.wh.f.unitCost")}>
                    <Input type="number" min="0" step="any" value={movUnitCost} onChange={(e) => setMovUnitCost(e.target.value)} disabled={!canManage || busy} />
                  </Field>
                </div>
                <Field label={t("scm.wh.f.notesReference")}>
                  <Input value={movNotes} onChange={(e) => setMovNotes(e.target.value)} placeholder={t("scm.wh.p.reasonOrPoJobReference")} disabled={!canManage || busy} />
                </Field>
                <Button type="submit" variant="primary" disabled={!canManage || busy}>{t("scm.wh.t.postLedgerMovement")}</Button>
              </form>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
