/**
 * Phase 4 — Item master and stock surface (SCM-CORE-013).
 *
 * Items with their current balance, plus goods in / goods out. Every
 * quantity shown comes from the backend's authoritative balance; this page
 * never computes stock itself.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ScmGrade,
  type ScmItem,
  type StockBalanceRecord,
  type StockMovementRecord,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";
import { formatDate } from "../../shared/format";
import { GradeBadge, GradeOptions, parseGrade } from "../../shared/GradeBadge";

export function ItemsPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [items, setItems] = useState<ScmItem[]>([]);
  const [balances, setBalances] = useState<StockBalanceRecord[]>([]);
  const [selected, setSelected] = useState<ScmItem | null>(null);
  const [movements, setMovements] = useState<StockMovementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [uom, setUom] = useState("EA");
  const [grade, setGrade] = useState<ScmGrade | null>(null);
  const [quantity, setQuantity] = useState("");
  const [reference, setReference] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [itemList, balanceList] = await Promise.all([
        api.scmItems(token, { search: search || undefined }),
        api.stockBalances(token),
      ]);
      setItems(itemList);
      setBalances(balanceList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("msc.items.msg.couldNotLoadItems"));
    } finally {
      setLoading(false);
    }
  }, [token, search, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openItem = useCallback(
    async (item: ScmItem) => {
      setSelected(item);
      setError(null);
      try {
        setMovements(await api.stockMovements(token, { itemCode: item.code }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("msc.items.msg.couldNotLoadMovements"));
      }
    },
    [token, t],
  );

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await load();
      if (selected) await openItem(selected);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("msc.items.msg.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** Total across every stock location for this item. */
  function totalFor(item: ScmItem): number {
    return balances.filter((b) => b.itemId === item.id).reduce((sum, b) => sum + b.quantity, 0);
  }

  const columns: Column<ScmItem>[] = [
    { header: t("msc.items.h.code"), cell: (row) => <span className="font-medium">{row.code}</span> },
    { header: t("msc.items.h.name"), cell: (row) => row.name },
    { header: t("msc.items.h.unit"), cell: (row) => row.unitOfMeasure },
    { header: t("grade.label"), cell: (row) => <GradeBadge grade={row.grade} /> },
    { header: t("msc.items.h.onHand"), cell: (row) => <Badge>{totalFor(row)}</Badge> },
    {
      header: t("msc.items.h.state"),
      cell: (row) => (
        <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("msc.items.title.itemsStock")} subtitle={t("msc.items.sub.whatExistsHowMuchOfItAndWhatMoved")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("msc.items.t.addAnItem")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("msc.items.f.code")} required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("msc.items.p.eGBoltM8")} />
          </Field>
          <Field label={t("msc.items.f.name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("msc.items.p.displayName")} />
          </Field>
          <Field label={t("msc.items.f.unitOfMeasure")} required>
            <Input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="EA / KG / L / BOX" />
          </Field>
          <Field label={t("grade.label")}>
            <Select value={grade ?? ""} onChange={(e) => setGrade(parseGrade(e.target.value))}>
              <GradeOptions />
            </Select>
          </Field>
          <div className="flex items-end">
            <Button
              disabled={busy || !code || !name || !uom}
              onClick={async () => {
                await run(
                  () => api.createScmItem(token, { code, name, unitOfMeasure: uom, grade }),
                  "Item created.",
                );
                setCode("");
                setName("");
              }}
            >
              {t("common.create")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <Field label={t("msc.items.f.search")}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("msc.items.p.nameOrCode")} />
        </Field>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={items}
          keyOf={(row) => row.id}
          onRowClick={(row) => void openItem(row)}
          empty={<EmptyState title={t("msc.items.title.noItemsYet")} description={t("msc.items.d.createOneAboveToStartTrackingStock")} />}
        />
      )}

      {selected ? (
        <>
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">
              Move stock — <Badge>{selected.code}</Badge>
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t("msc.items.f.quantity")} required>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </Field>
              <Field label={t("msc.items.f.reference")}>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t("msc.items.p.optional")} />
              </Field>
              <div className="flex items-end gap-2">
                <Button
                  disabled={busy || !(Number(quantity) > 0)}
                  onClick={async () => {
                    await run(
                      () =>
                        api.recordGoodsIn(token, {
                          itemCode: selected.code,
                          quantity: Number(quantity),
                          reference: reference || null,
                        }),
                      "Goods received.",
                    );
                    setQuantity("");
                  }}
                >
                  Receive
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !(Number(quantity) > 0)}
                  onClick={async () => {
                    await run(
                      () =>
                        api.recordGoodsOut(token, {
                          itemCode: selected.code,
                          quantity: Number(quantity),
                          reference: reference || null,
                        }),
                      "Goods issued.",
                    );
                    setQuantity("");
                  }}
                >
                  Issue
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("msc.items.t.movementHistory")}</h2>
            {movements.length === 0 ? (
              <p className="text-sm text-slate-500">{t("msc.items.n.noMovementsRecorded")}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {movements.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 p-3">
                    <StatusPill tone={m.movementType === "in" ? "success" : "warning"}>
                      {m.movementType === "in" ? "In" : "Out"}
                    </StatusPill>
                    <span className="font-medium text-slate-900">{m.quantity}</span>
                    <span className="text-slate-500">{formatDate(m.occurredAt)}</span>
                    {m.reference ? <span className="text-slate-500">{m.reference}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
