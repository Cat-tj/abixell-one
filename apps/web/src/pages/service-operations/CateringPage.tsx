/**
 * Catering vertical (WP-MD-03) — menus, recipes, meal plans, ingredient
 * requirement ("what do I need to buy") and production batches.
 *
 * The requirement view is computed client-side: the API has no endpoint for
 * it. Required = ingredient quantity × plannedPortions / recipe outputQuantity.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useT } from "../../i18n/LocaleProvider";
import {
  api,
  ApiError,
  type CateringBatchStatus,
  type CateringMealBatch,
  type CateringMealPlan,
  type CateringMealType,
  type CateringMenu,
  type CateringRecipe,
  type CateringRecipeCost,
  type CateringRecipeIngredient,
  type CateringUnitOfMeasure,
  type ScmItem,
  type SiteRecord,
  type StockBalanceRecord,
} from "../../lib/api";
import { localDateInputValue } from "../../shared/localDateTime";
import {
  Alert,
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
  Textarea,
  type Column,
} from "../../shell/components/ui";

type TabKey = "menus" | "recipes" | "plans" | "batches";
const MEAL_TYPES: CateringMealType[] = ["breakfast", "lunch", "dinner", "snack"];
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const isPositiveDecimal = (v: string) => DECIMAL.test(v.trim()) && Number(v) > 0;

/** Best-effort: a role without customer access simply gets no site picker. */
async function loadSites(token: string): Promise<SiteRecord[]> {
  const customers = await api.customers(token).catch(() => []);
  const perCustomer = await Promise.all(
    customers.map((c) => api.sitesForCustomer(token, c.id).catch(() => [] as SiteRecord[])),
  );
  return perCustomer.flat().sort((a, b) => a.name.localeCompare(b.name));
}

/** Date-only values ("YYYY-MM-DD") must not go through a timezone shift. */
function formatDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString() : value;
}

function fmtQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

type IngredientRow = { key: number; itemId: string; quantity: string; unitCode: string };

export function CateringPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [tab, setTab] = useState<TabKey>("menus");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [packActive, setPackActive] = useState<boolean | null>(null);

  const [menus, setMenus] = useState<CateringMenu[]>([]);
  const [recipes, setRecipes] = useState<CateringRecipe[]>([]);
  const [plans, setPlans] = useState<CateringMealPlan[]>([]);
  const [batches, setBatches] = useState<CateringMealBatch[]>([]);
  const [items, setItems] = useState<ScmItem[]>([]);
  const [units, setUnits] = useState<CateringUnitOfMeasure[]>([]);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [balances, setBalances] = useState<StockBalanceRecord[] | null>(null);

  // Cross-tab selection for the requirement view.
  const [reqPlanId, setReqPlanId] = useState("");
  const [reqRecipeCode, setReqRecipeCode] = useState("");

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const menuById = useMemo(() => new Map(menus.map((m) => [m.id, m])), [menus]);
  const recipeById = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);
  const planById = useMemo(() => new Map(plans.map((p) => [p.id, p])), [plans]);
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);

  const mealTypeLabel = useCallback(
    (m: CateringMealType) => t(`cat.mealType.${m}` as const),
    [t],
  );
  const planLabel = useCallback(
    (p: CateringMealPlan) =>
      `${formatDate(p.mealDate)} · ${mealTypeLabel(p.mealType)} · ${menuById.get(p.menuId)?.code ?? "?"} · ${t("cat.plan.portionsCount", { count: p.plannedPortions })}`,
    [menuById, mealTypeLabel, t],
  );

  /** Turns an API failure into a message; flags an inactive catering pack so
   * the page can show one clear message instead of a wall of errors. */
  const failure = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError) {
        if (/catering pack is not active/i.test(err.message)) {
          setPackActive(false);
          return null;
        }
        return err.message;
      }
      return fallback;
    },
    [],
  );

  // Only the first load shows the page spinner; a refresh after a save must
  // not unmount the tabs (it would drop the open ingredient editor).
  const load = useCallback(async () => {
    try {
      const packs = await api.servicePacks(token).catch(() => null);
      if (packs) {
        const catering = packs.find((p) => p.packCode === "catering");
        setPackActive(catering ? catering.isActive : false);
      }
      const [m, r, p, b, i, u, loc, bal] = await Promise.all([
        api.cateringMenus(token),
        api.cateringRecipes(token),
        api.cateringMealPlans(token),
        api.cateringMealBatches(token),
        api.scmItems(token).catch(() => [] as ScmItem[]),
        api.unitsOfMeasure(token).catch(() => [] as CateringUnitOfMeasure[]),
        loadSites(token),
        api.stockBalances(token).catch(() => null),
      ]);
      setMenus(m);
      setRecipes(r);
      setPlans(p);
      setBatches(b);
      setItems(i.filter((x) => x.isActive));
      setUnits(u);
      setSites(loc);
      setBalances(bal);
    } catch (err) {
      const msg = failure(err, t("cat.msg.couldNotLoad"));
      if (msg) setError(msg);
    } finally {
      setLoading(false);
    }
  }, [token, t, failure]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && packActive === null) {
    return <Spinner label={t("cat.loading")} />;
  }

  if (packActive === false) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("cat.title")} subtitle={t("cat.subtitle")} />
        <EmptyState
          title={t("cat.packInactive.title")}
          description={t("cat.packInactive.body")}
          action={
            <Link
              to="/service-packs"
              className="inline-flex min-h-[40px] items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-on hover:bg-accent-line"
            >
              {t("cat.packInactive.link")}
            </Link>
          }
        />
      </div>
    );
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: "menus", label: t("cat.tab.menus") },
    { key: "recipes", label: t("cat.tab.recipes") },
    { key: "plans", label: t("cat.tab.plans") },
    { key: "batches", label: t("cat.tab.batches") },
  ];

  const shared = {
    token,
    t,
    items,
    units,
    setError,
    setNotice,
    failure,
    reload: load,
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t("cat.title")} subtitle={t("cat.subtitle")} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            role="tab"
            type="button"
            aria-selected={tab === tb.key}
            onClick={() => setTab(tb.key)}
            className={`-mb-px min-h-[40px] border-b-2 px-4 text-sm font-bold transition-colors ${
              tab === tb.key
                ? "border-accent text-ink"
                : "border-transparent text-ink-faint hover:text-ink"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {loading ? <Spinner label={t("cat.loading")} /> : null}

      {!loading && tab === "menus" ? <MenusTab {...shared} menus={menus} /> : null}
      {!loading && tab === "recipes" ? (
        <RecipesTab {...shared} recipes={recipes} unitById={unitById} itemById={itemById} />
      ) : null}
      {!loading && tab === "plans" ? (
        <PlansTab
          {...shared}
          menus={menus}
          recipes={recipes}
          plans={plans}
          sites={sites}
          siteById={siteById}
          menuById={menuById}
          unitById={unitById}
          itemById={itemById}
          balances={balances}
          planLabel={planLabel}
          mealTypeLabel={mealTypeLabel}
          reqPlanId={reqPlanId}
          setReqPlanId={setReqPlanId}
          reqRecipeCode={reqRecipeCode}
          setReqRecipeCode={setReqRecipeCode}
        />
      ) : null}
      {!loading && tab === "batches" ? (
        <BatchesTab
          {...shared}
          recipes={recipes}
          plans={plans}
          batches={batches}
          recipeById={recipeById}
          planById={planById}
          unitById={unitById}
          planLabel={planLabel}
        />
      ) : null}
    </div>
  );
}

type Shared = {
  token: string;
  t: ReturnType<typeof useT>;
  items: ScmItem[];
  units: CateringUnitOfMeasure[];
  setError: (m: string | null) => void;
  setNotice: (m: string | null) => void;
  failure: (err: unknown, fallback: string) => string | null;
  reload: () => Promise<void>;
};

/* ------------------------------------------------------------------ Pickers */

function ItemSelect({
  items,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  items: ScmItem[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  ariaLabel?: string;
}) {
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.code} — {i.name}
        </option>
      ))}
    </Select>
  );
}

/** A picker when the unit master is readable; otherwise free text (the API
 * validates the code either way). */
function UnitSelect({
  units,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  units: CateringUnitOfMeasure[];
  value: string;
  onChange: (code: string) => void;
  placeholder: string;
  ariaLabel?: string;
}) {
  if (units.length === 0) {
    return (
      <Input
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder={placeholder}
      />
    );
  }
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {units.map((u) => (
        <option key={u.id} value={u.code}>
          {u.code} — {u.name}
        </option>
      ))}
    </Select>
  );
}

/* -------------------------------------------------------------------- Menus */

function MenusTab({ token, t, setError, setNotice, failure, reload, menus }: Shared & { menus: CateringMenu[] }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState(localDateInputValue());
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const valid = code.trim() !== "" && name.trim() !== "" && from !== "" && (to === "" || to >= from);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const menu = await api.createCateringMenu(token, {
        code: code.trim(),
        name: name.trim(),
        description: description.trim() || null,
        effectiveFrom: from,
        effectiveTo: to || null,
      });
      setNotice(t("cat.menu.created", { code: menu.code }));
      setCode("");
      setName("");
      setDescription("");
      setTo("");
      await reload();
    } catch (err) {
      setError(failure(err, t("cat.menu.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<CateringMenu>[] = [
    { header: t("cat.f.code"), cell: (m) => <span className="font-semibold">{m.code}</span>, mobileRole: "title" },
    { header: t("cat.f.name"), cell: (m) => m.name },
    {
      header: t("cat.f.effective"),
      cell: (m) => `${formatDate(m.effectiveFrom)} – ${m.effectiveTo ? formatDate(m.effectiveTo) : t("cat.f.openEnded")}`,
    },
    {
      header: t("cat.f.status"),
      cell: (m) => (
        <StatusPill tone={m.isActive ? "success" : "neutral"}>
          {m.isActive ? t("cat.status.active") : t("cat.status.inactive")}
        </StatusPill>
      ),
      mobileRole: "status",
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 text-sm font-extrabold text-ink">{t("cat.menu.new")}</h2>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("cat.f.code")} required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MENU-LUNCH-01" />
          </Field>
          <Field label={t("cat.f.name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("cat.menu.namePlaceholder")} />
          </Field>
          <Field label={t("cat.f.effectiveFrom")} required>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("cat.f.effectiveTo")} hint={t("cat.f.optional")}>
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Field label={t("cat.f.description")} hint={t("cat.f.optional")}>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={!valid || busy}>
              {t("cat.menu.create")}
            </Button>
          </div>
        </form>
      </Card>
      <DataTable
        columns={columns}
        rows={menus}
        keyOf={(m) => m.id}
        empty={<EmptyState title={t("cat.menu.empty")} />}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ Recipes */

function RecipesTab({
  token,
  t,
  items,
  units,
  setError,
  setNotice,
  failure,
  reload,
  recipes,
  unitById,
  itemById,
}: Shared & {
  recipes: CateringRecipe[];
  unitById: Map<string, CateringUnitOfMeasure>;
  itemById: Map<string, ScmItem>;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [outputItemId, setOutputItemId] = useState("");
  const [outputQty, setOutputQty] = useState("1");
  const [outputUnit, setOutputUnit] = useState("");
  const [from, setFrom] = useState(localDateInputValue());
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<CateringRecipe | null>(null);
  const [rows, setRows] = useState<IngredientRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [editBusy, setEditBusy] = useState(false);
  const [cost, setCost] = useState<CateringRecipeCost | null>(null);
  const [costBusy, setCostBusy] = useState<string | null>(null);

  const valid =
    code.trim() !== "" && name.trim() !== "" && outputItemId !== "" && isPositiveDecimal(outputQty) && outputUnit.trim() !== "" && from !== "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const recipe = await api.createCateringRecipe(token, {
        code: code.trim(),
        name: name.trim(),
        outputItemId,
        outputQuantity: outputQty.trim(),
        outputUnitCode: outputUnit.trim(),
        effectiveFrom: from,
      });
      setNotice(t("cat.recipe.created", { code: recipe.code }));
      setCode("");
      setName("");
      setOutputItemId("");
      setOutputQty("1");
      await reload();
      openEditor(recipe);
    } catch (err) {
      setError(failure(err, t("cat.recipe.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function openEditor(recipe: CateringRecipe) {
    setEditing(recipe);
    setCost(null);
    setError(null);
    try {
      const existing: CateringRecipeIngredient[] = await api.cateringRecipeIngredients(token, recipe.code);
      const mapped = existing
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((ing, idx) => ({
          key: idx + 1,
          itemId: ing.itemId,
          quantity: ing.quantity,
          unitCode: unitById.get(ing.unitId)?.code ?? itemById.get(ing.itemId)?.unitOfMeasure ?? "",
        }));
      setRows(mapped.length > 0 ? mapped : [{ key: 1, itemId: "", quantity: "", unitCode: "" }]);
      setNextKey(mapped.length + 2);
    } catch (err) {
      setError(failure(err, t("cat.recipe.loadIngredientsFailed")));
    }
  }

  function updateRow(key: number, patch: Partial<IngredientRow>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        // Picking an item defaults the unit to the item's own stock unit.
        if (patch.itemId && !r.unitCode) {
          next.unitCode = itemById.get(patch.itemId)?.unitOfMeasure ?? "";
        }
        return next;
      }),
    );
  }

  const isBlank = (r: IngredientRow) => r.itemId === "" && r.quantity.trim() === "";
  const filled = rows.filter((r) => !isBlank(r));
  const duplicate = new Set(filled.map((r) => r.itemId)).size !== filled.length;
  const rowsValid =
    filled.length > 0 && !duplicate && filled.every((r) => r.itemId !== "" && isPositiveDecimal(r.quantity) && r.unitCode.trim() !== "");

  async function saveIngredients() {
    if (!editing || !rowsValid) return;
    setEditBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.setCateringRecipeIngredients(
        token,
        editing.code,
        filled.map((r, idx) => ({
          itemId: r.itemId,
          quantity: r.quantity.trim(),
          unitCode: r.unitCode.trim(),
          sortOrder: idx,
        })),
      );
      setNotice(t("cat.recipe.ingredientsSaved", { code: editing.code }));
      setCost(null);
    } catch (err) {
      setError(failure(err, t("cat.recipe.saveIngredientsFailed")));
    } finally {
      setEditBusy(false);
    }
  }

  async function computeCost(recipe: CateringRecipe) {
    setCostBusy(recipe.code);
    setError(null);
    try {
      setCost(await api.cateringRecipeCost(token, recipe.code));
    } catch (err) {
      setError(failure(err, t("cat.recipe.costFailed")));
    } finally {
      setCostBusy(null);
    }
  }

  const columns: Column<CateringRecipe>[] = [
    { header: t("cat.f.code"), cell: (r) => <span className="font-semibold">{r.code}</span>, mobileRole: "title" },
    { header: t("cat.f.name"), cell: (r) => r.name },
    {
      header: t("cat.recipe.output"),
      cell: (r) =>
        `${itemById.get(r.outputItemId)?.name ?? "?"} · ${r.outputQuantity} ${unitById.get(r.outputUnitId)?.code ?? ""}`,
    },
    {
      header: "",
      cell: (r) => (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => void openEditor(r)}>
            {t("cat.recipe.ingredients")}
          </Button>
          <Button type="button" variant="secondary" disabled={costBusy === r.code} onClick={() => void computeCost(r)}>
            {t("cat.recipe.computeCost")}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 text-sm font-extrabold text-ink">{t("cat.recipe.new")}</h2>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("cat.f.code")} required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="RCP-NASIBOX-AYAM" />
          </Field>
          <Field label={t("cat.f.name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("cat.recipe.namePlaceholder")} />
          </Field>
          <Field label={t("cat.recipe.outputItem")} required hint={t("cat.recipe.outputItemHint")}>
            <ItemSelect items={items} value={outputItemId} onChange={setOutputItemId} placeholder={t("cat.pickItem")} />
          </Field>
          <Field label={t("cat.f.effectiveFrom")} required>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t("cat.recipe.outputQty")} required>
            <Input inputMode="decimal" value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />
          </Field>
          <Field label={t("cat.recipe.outputUnit")} required>
            <UnitSelect units={units} value={outputUnit} onChange={setOutputUnit} placeholder={t("cat.pickUnit")} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={!valid || busy}>
              {t("cat.recipe.create")}
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        columns={columns}
        rows={recipes}
        keyOf={(r) => r.id}
        empty={<EmptyState title={t("cat.recipe.empty")} />}
      />

      {cost ? (
        <Card>
          <h2 className="mb-1 text-sm font-extrabold text-ink">
            {t("cat.recipe.costTitle", { code: cost.recipeCode })}
          </h2>
          <p className="mb-3 text-xs text-ink-faint">{t("cat.recipe.costHint", { qty: cost.outputQuantity })}</p>
          {cost.lines.length === 0 ? (
            <p className="text-sm text-ink-dim">{t("cat.recipe.costNoLines")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-faint">
                    <th className="py-1 pr-3">{t("cat.req.ingredient")}</th>
                    <th className="py-1 pr-3 text-right">{t("cat.recipe.qty")}</th>
                    <th className="py-1 pr-3 text-right">{t("cat.recipe.unitCost")}</th>
                    <th className="py-1 text-right">{t("cat.recipe.lineCost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {cost.lines.map((l) => (
                    <tr key={l.itemId} className="border-t border-line">
                      <td className="py-1 pr-3">{l.itemName}</td>
                      <td className="py-1 pr-3 text-right">{l.quantity}</td>
                      <td className="py-1 pr-3 text-right">{l.unitCost}</td>
                      <td className="py-1 text-right">{l.lineCost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-sm font-extrabold text-ink">
            {t("cat.recipe.totalCost")}: {cost.totalCost}
          </p>
          <p className="mt-1 text-xs text-ink-faint">{t("cat.recipe.costNote")}</p>
        </Card>
      ) : null}

      {editing ? (
        <Card>
          <h2 className="mb-1 text-sm font-extrabold text-ink">
            {t("cat.recipe.ingredientsTitle", { code: editing.code })}
          </h2>
          <p className="mb-3 text-xs text-ink-faint">
            {t("cat.recipe.ingredientsHint", {
              qty: editing.outputQuantity,
              unit: unitById.get(editing.outputUnitId)?.code ?? "",
            })}
          </p>
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.key} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-start">
                <ItemSelect
                  items={items}
                  value={r.itemId}
                  onChange={(id) => updateRow(r.key, { itemId: id })}
                  placeholder={t("cat.pickItem")}
                  ariaLabel={t("cat.req.ingredient")}
                />
                <Input
                  aria-label={t("cat.recipe.qty")}
                  inputMode="decimal"
                  className="mt-1"
                  placeholder={t("cat.recipe.qty")}
                  value={r.quantity}
                  onChange={(e) => updateRow(r.key, { quantity: e.target.value })}
                />
                <UnitSelect
                  units={units}
                  value={r.unitCode}
                  onChange={(c) => updateRow(r.key, { unitCode: c })}
                  placeholder={t("cat.pickUnit")}
                  ariaLabel={t("cat.recipe.outputUnit")}
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-1"
                  onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((x) => x.key !== r.key) : prev))}
                >
                  {t("cat.recipe.removeRow")}
                </Button>
              </div>
            ))}
          </div>
          {duplicate ? <p className="mt-2 text-xs font-semibold text-status-danger">{t("cat.recipe.duplicate")}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setRows((prev) => [...prev, { key: nextKey, itemId: "", quantity: "", unitCode: "" }]);
                setNextKey((k) => k + 1);
              }}
            >
              {t("cat.recipe.addRow")}
            </Button>
            <Button type="button" disabled={!rowsValid || editBusy} onClick={() => void saveIngredients()}>
              {t("cat.recipe.saveIngredients")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              {t("cat.close")}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- Meal plans */

function PlansTab({
  token,
  t,
  setError,
  setNotice,
  failure,
  reload,
  menus,
  recipes,
  plans,
  sites,
  siteById,
  menuById,
  unitById,
  itemById,
  balances,
  planLabel,
  mealTypeLabel,
  reqPlanId,
  setReqPlanId,
  reqRecipeCode,
  setReqRecipeCode,
}: Shared & {
  menus: CateringMenu[];
  recipes: CateringRecipe[];
  plans: CateringMealPlan[];
  sites: SiteRecord[];
  siteById: Map<string, SiteRecord>;
  menuById: Map<string, CateringMenu>;
  unitById: Map<string, CateringUnitOfMeasure>;
  itemById: Map<string, ScmItem>;
  balances: StockBalanceRecord[] | null;
  planLabel: (p: CateringMealPlan) => string;
  mealTypeLabel: (m: CateringMealType) => string;
  reqPlanId: string;
  setReqPlanId: (v: string) => void;
  reqRecipeCode: string;
  setReqRecipeCode: (v: string) => void;
}) {
  const [menuCode, setMenuCode] = useState("");
  const [siteId, setSiteId] = useState("");
  const [mealDate, setMealDate] = useState(localDateInputValue());
  const [mealType, setMealType] = useState<CateringMealType>("lunch");
  const [portions, setPortions] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const activeMenus = menus.filter((m) => m.isActive);
  const portionsNum = Number(portions);
  const valid = menuCode !== "" && mealDate !== "" && /^\d+$/.test(portions) && portionsNum > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const plan = await api.createCateringMealPlan(token, {
        menuCode,
        siteId: siteId || null,
        mealDate,
        mealType,
        plannedPortions: portionsNum,
        notes: notes.trim() || null,
      });
      setNotice(t("cat.plan.created"));
      setReqPlanId(plan.id);
      setPortions("");
      setNotes("");
      await reload();
    } catch (err) {
      setError(failure(err, t("cat.plan.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<CateringMealPlan>[] = [
    { header: t("cat.f.date"), cell: (p) => formatDate(p.mealDate), mobileRole: "title" },
    { header: t("cat.plan.mealType"), cell: (p) => mealTypeLabel(p.mealType) },
    { header: t("cat.plan.menu"), cell: (p) => menuById.get(p.menuId)?.name ?? "?" },
    { header: t("cat.plan.site"), cell: (p) => (p.siteId ? (siteById.get(p.siteId)?.name ?? "?") : "—") },
    { header: t("cat.plan.portions"), cell: (p) => p.plannedPortions, className: "text-right" },
    {
      header: "",
      cell: (p) => (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setReqPlanId(p.id);
            document.getElementById("cat-requirement")?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          {t("cat.plan.seeRequirement")}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 text-sm font-extrabold text-ink">{t("cat.plan.new")}</h2>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("cat.plan.menu")} required>
            <Select value={menuCode} onChange={(e) => setMenuCode(e.target.value)}>
              <option value="">{t("cat.plan.pickMenu")}</option>
              {activeMenus.map((m) => (
                <option key={m.id} value={m.code}>
                  {m.code} — {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("cat.plan.site")} hint={t("cat.f.optional")}>
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">{t("cat.plan.noSite")}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("cat.f.date")} required>
            <Input type="date" value={mealDate} onChange={(e) => setMealDate(e.target.value)} />
          </Field>
          <Field label={t("cat.plan.mealType")} required>
            <Select value={mealType} onChange={(e) => setMealType(e.target.value as CateringMealType)}>
              {MEAL_TYPES.map((m) => (
                <option key={m} value={m}>
                  {mealTypeLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("cat.plan.portions")} required>
            <Input inputMode="numeric" value={portions} onChange={(e) => setPortions(e.target.value)} placeholder="150" />
          </Field>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label={t("cat.f.notes")} hint={t("cat.f.optional")}>
              <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={!valid || busy}>
              {t("cat.plan.create")}
            </Button>
          </div>
        </form>
      </Card>

      <DataTable
        columns={columns}
        rows={plans}
        keyOf={(p) => p.id}
        empty={<EmptyState title={t("cat.plan.empty")} />}
      />

      <div id="cat-requirement">
        <RequirementView
          token={token}
          t={t}
          setError={setError}
          failure={failure}
          plans={plans}
          recipes={recipes}
          unitById={unitById}
          itemById={itemById}
          balances={balances}
          planLabel={planLabel}
          planId={reqPlanId}
          setPlanId={setReqPlanId}
          recipeCode={reqRecipeCode}
          setRecipeCode={setReqRecipeCode}
        />
      </div>
    </div>
  );
}

function RequirementView({
  token,
  t,
  setError,
  failure,
  plans,
  recipes,
  unitById,
  itemById,
  balances,
  planLabel,
  planId,
  setPlanId,
  recipeCode,
  setRecipeCode,
}: {
  token: string;
  t: ReturnType<typeof useT>;
  setError: (m: string | null) => void;
  failure: (err: unknown, fallback: string) => string | null;
  plans: CateringMealPlan[];
  recipes: CateringRecipe[];
  unitById: Map<string, CateringUnitOfMeasure>;
  itemById: Map<string, ScmItem>;
  balances: StockBalanceRecord[] | null;
  planLabel: (p: CateringMealPlan) => string;
  planId: string;
  setPlanId: (v: string) => void;
  recipeCode: string;
  setRecipeCode: (v: string) => void;
}) {
  const [ingredients, setIngredients] = useState<CateringRecipeIngredient[] | null>(null);
  const [loadingIng, setLoadingIng] = useState(false);

  const plan = plans.find((p) => p.id === planId);
  const recipe = recipes.find((r) => r.code === recipeCode);

  useEffect(() => {
    if (!recipeCode) {
      setIngredients(null);
      return;
    }
    let cancelled = false;
    setLoadingIng(true);
    api
      .cateringRecipeIngredients(token, recipeCode)
      .then((list) => {
        if (!cancelled) setIngredients(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setIngredients(null);
          setError(failure(err, t("cat.recipe.loadIngredientsFailed")));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingIng(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, recipeCode]);

  const stockByItem = useMemo(() => {
    if (!balances) return null;
    const m = new Map<string, number>();
    for (const b of balances) m.set(b.itemId, (m.get(b.itemId) ?? 0) + Number(b.quantity));
    return m;
  }, [balances]);

  const lines = useMemo(() => {
    if (!plan || !recipe || !ingredients) return [];
    const scale = plan.plannedPortions / Number(recipe.outputQuantity);
    return ingredients
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((ing) => {
        const item = itemById.get(ing.itemId);
        const unit = unitById.get(ing.unitId)?.code ?? "";
        const required = Number(ing.quantity) * scale;
        const onHand = stockByItem ? (stockByItem.get(ing.itemId) ?? 0) : null;
        // Stock is held in the item's own unit; only compare like with like.
        const comparable = onHand !== null && (!item || !unit || item.unitOfMeasure.toUpperCase() === unit.toUpperCase());
        const shortage = comparable && onHand !== null ? Math.max(0, required - onHand) : null;
        return { ing, item, unit, required, onHand, comparable, shortage };
      });
  }, [plan, recipe, ingredients, itemById, unitById, stockByItem]);

  const anyShort = lines.some((l) => (l.shortage ?? 0) > 0);

  return (
    <Card>
      <h2 className="mb-1 text-sm font-extrabold text-ink">{t("cat.req.title")}</h2>
      <p className="mb-3 text-xs text-ink-faint">{t("cat.req.hint")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("cat.req.plan")}>
          <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">{t("cat.req.pickPlan")}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {planLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("cat.req.recipe")}>
          <Select value={recipeCode} onChange={(e) => setRecipeCode(e.target.value)}>
            <option value="">{t("cat.req.pickRecipe")}</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.code}>
                {r.code} — {r.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {loadingIng ? <Spinner label={t("cat.loading")} /> : null}

      {plan && recipe && ingredients && !loadingIng ? (
        ingredients.length === 0 ? (
          <p className="mt-3 text-sm text-ink-dim">{t("cat.req.noIngredients")}</p>
        ) : (
          <div className="mt-4">
            <p className="mb-2 text-sm text-ink-dim">
              {t("cat.req.scaled", {
                portions: plan.plannedPortions,
                qty: recipe.outputQuantity,
                unit: unitById.get(recipe.outputUnitId)?.code ?? "",
              })}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-faint">
                    <th className="py-1 pr-3">{t("cat.req.ingredient")}</th>
                    <th className="py-1 pr-3 text-right">{t("cat.req.required")}</th>
                    <th className="py-1 pr-3 text-right">{t("cat.req.onHand")}</th>
                    <th className="py-1 pr-3 text-right">{t("cat.req.toBuy")}</th>
                    <th className="py-1">{t("cat.f.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.ing.id} className="border-t border-line">
                      <td className="py-1.5 pr-3">{l.item ? `${l.item.code} — ${l.item.name}` : l.ing.itemId}</td>
                      <td className="py-1.5 pr-3 text-right font-semibold">
                        {fmtQty(l.required)} {l.unit}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {l.onHand === null ? "—" : `${fmtQty(l.onHand)} ${l.item?.unitOfMeasure ?? ""}`}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {l.shortage === null ? "—" : `${fmtQty(l.shortage)} ${l.unit}`}
                      </td>
                      <td className="py-1.5">
                        {l.onHand === null ? (
                          <StatusPill>{t("cat.req.stockUnknown")}</StatusPill>
                        ) : !l.comparable ? (
                          <StatusPill tone="warning">{t("cat.req.unitDiffers")}</StatusPill>
                        ) : (l.shortage ?? 0) > 0 ? (
                          <StatusPill tone="danger">{t("cat.req.short")}</StatusPill>
                        ) : (
                          <StatusPill tone="success">{t("cat.req.enough")}</StatusPill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm text-ink-dim">
              {anyShort ? t("cat.req.shortSummary") : t("cat.req.okSummary")}{" "}
              <Link to="/purchasing" className="font-semibold text-ink underline">
                {t("cat.req.purchasingLink")}
              </Link>
            </p>
            {stockByItem === null ? <p className="mt-1 text-xs text-ink-faint">{t("cat.req.stockNoAccess")}</p> : null}
          </div>
        )
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ Batches */

function BatchesTab({
  token,
  t,
  setError,
  setNotice,
  failure,
  reload,
  recipes,
  plans,
  batches,
  recipeById,
  planById,
  unitById,
  planLabel,
}: Shared & {
  recipes: CateringRecipe[];
  plans: CateringMealPlan[];
  batches: CateringMealBatch[];
  recipeById: Map<string, CateringRecipe>;
  planById: Map<string, CateringMealPlan>;
  unitById: Map<string, CateringUnitOfMeasure>;
  planLabel: (p: CateringMealPlan) => string;
}) {
  const [batchNumber, setBatchNumber] = useState("");
  const [recipeCode, setRecipeCode] = useState("");
  const [planId, setPlanId] = useState("");
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);

  const activeRecipes = recipes.filter((r) => r.isActive);
  const valid = batchNumber.trim() !== "" && recipeCode !== "" && (qty.trim() === "" || isPositiveDecimal(qty));

  /** Planned portions × recipe yield is the natural batch size for a plan. */
  function suggestQty(nextPlanId: string, nextRecipeCode: string) {
    const plan = planById.get(nextPlanId);
    const recipe = recipes.find((r) => r.code === nextRecipeCode);
    if (plan && recipe) setQty(String(plan.plannedPortions * Number(recipe.outputQuantity)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const batch = await api.createCateringMealBatch(token, {
        batchNumber: batchNumber.trim(),
        recipeCode,
        mealPlanId: planId || null,
        ...(qty.trim() ? { outputQuantity: qty.trim() } : {}),
      });
      setNotice(t("cat.batch.created", { number: batch.batchNumber }));
      setBatchNumber("");
      setQty("");
      await reload();
    } catch (err) {
      setError(failure(err, t("cat.batch.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function move(batch: CateringMealBatch, status: CateringBatchStatus) {
    setMoving(batch.batchNumber);
    setError(null);
    setNotice(null);
    try {
      await api.setCateringMealBatchStatus(token, batch.batchNumber, status);
      setNotice(t("cat.batch.moved", { number: batch.batchNumber, status: t(`cat.batch.status.${status}` as const) }));
      await reload();
    } catch (err) {
      setError(failure(err, t("cat.batch.moveFailed")));
    } finally {
      setMoving(null);
    }
  }

  const statusTone = { draft: "neutral", confirmed: "info", consumed: "success" } as const;

  const columns: Column<CateringMealBatch>[] = [
    { header: t("cat.batch.number"), cell: (b) => <span className="font-semibold">{b.batchNumber}</span>, mobileRole: "title" },
    { header: t("cat.batch.recipe"), cell: (b) => recipeById.get(b.recipeId)?.name ?? "?" },
    {
      header: t("cat.batch.plan"),
      cell: (b) => {
        const p = b.mealPlanId ? planById.get(b.mealPlanId) : undefined;
        return p ? planLabel(p) : "—";
      },
    },
    {
      header: t("cat.batch.outputQty"),
      cell: (b) => `${b.outputQuantity} ${unitById.get(b.outputUnitId)?.code ?? ""}`,
      className: "text-right",
    },
    {
      header: t("cat.f.status"),
      cell: (b) => <StatusPill tone={statusTone[b.status]}>{t(`cat.batch.status.${b.status}` as const)}</StatusPill>,
      mobileRole: "status",
    },
    {
      header: "",
      cell: (b) =>
        b.status === "draft" ? (
          <Button type="button" variant="secondary" disabled={moving === b.batchNumber} onClick={() => void move(b, "confirmed")}>
            {t("cat.batch.confirm")}
          </Button>
        ) : b.status === "confirmed" ? (
          <Button type="button" variant="secondary" disabled={moving === b.batchNumber} onClick={() => void move(b, "consumed")}>
            {t("cat.batch.markConsumed")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-3 text-sm font-extrabold text-ink">{t("cat.batch.new")}</h2>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("cat.batch.number")} required>
            <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} placeholder="BATCH-2026-001" />
          </Field>
          <Field label={t("cat.batch.recipe")} required>
            <Select
              value={recipeCode}
              onChange={(e) => {
                setRecipeCode(e.target.value);
                suggestQty(planId, e.target.value);
              }}
            >
              <option value="">{t("cat.req.pickRecipe")}</option>
              {activeRecipes.map((r) => (
                <option key={r.id} value={r.code}>
                  {r.code} — {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("cat.batch.plan")} hint={t("cat.f.optional")}>
            <Select
              value={planId}
              onChange={(e) => {
                setPlanId(e.target.value);
                suggestQty(e.target.value, recipeCode);
              }}
            >
              <option value="">{t("cat.batch.noPlan")}</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {planLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("cat.batch.outputQty")} hint={t("cat.batch.outputQtyHint")}>
            <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={!valid || busy}>
              {t("cat.batch.create")}
            </Button>
          </div>
        </form>
      </Card>

      <p className="text-xs text-ink-faint">{t("cat.batch.consumeHint")}</p>

      <DataTable
        columns={columns}
        rows={batches}
        keyOf={(b) => b.id}
        empty={<EmptyState title={t("cat.batch.empty")} />}
      />
    </div>
  );
}
