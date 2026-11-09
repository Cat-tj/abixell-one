/**
 * Wave A3 — Vertical Service Packs (PACK-001…PACK-004).
 *
 * Provides complete user-facing pack cards, preset checklist inspection,
 * and explicit human activation / deactivation with optional preset seeding.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type ServicePackCode,
  type ServicePackDetail,
  type ServicePackView,
} from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  StatusPill,
} from "../../shell/components/ui";
import { formatDate } from "../../shared/format";

const PACK_BADGES: Record<ServicePackCode, { code: string; title: string }> = {
  catering: { code: "PACK-001", title: "Catering" },
  housekeeping: { code: "PACK-002", title: "Housekeeping" },
  camp: { code: "PACK-003", title: "Camp Services" },
  facility: { code: "PACK-004", title: "Facility Services" },
};

export function ServicePacksPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [packs, setPacks] = useState<ServicePackView[]>([]);
  const [selectedPack, setSelectedPack] = useState<ServicePackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [seedPresets, setSeedPresets] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.servicePacks(token);
      setPacks(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("so.packs.msg.couldNotLoadServicePacks"));
    } finally {
      setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function inspectPack(code: ServicePackCode) {
    setLoadingDetail(true);
    setError(null);
    try {
      const detail = await api.servicePack(token, code);
      setSelectedPack(detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("so.packs.msg.couldNotInspectServicePack"));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function togglePackActivation(pack: ServicePackView) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (pack.isActive) {
        await api.deactivateServicePack(token, pack.packCode);
        setNotice(`${PACK_BADGES[pack.packCode].code} deactivated.`);
      } else {
        await api.activateServicePack(token, pack.packCode, seedPresets);
        setNotice(
          `${PACK_BADGES[pack.packCode].code} activated${
            seedPresets ? " and presets provisioned to Service Definitions." : "."
          }`,
        );
      }
      await load();
      if (selectedPack?.packCode === pack.packCode) {
        await inspectPack(pack.packCode);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("so.packs.msg.couldNotChangePackActivation"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("so.packs.title.verticalServicePacks")}
        subtitle={t("so.packs.sub.turnkeyConfigurationPackagesPack001Pack0")}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">{t("so.packs.t.presetProvisioningPolicy")}</h2>
            <p className="text-xs text-slate-500">
              When activating a pack, standard service definitions and structured checklists can be
              automatically created in Service Operations.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
              checked={seedPresets}
              onChange={(e) => setSeedPresets(e.target.checked)}
            />
            <span>{t("so.packs.t.autoSeedStandardServicePresets")}</span>
          </label>
        </div>
      </Card>

      {loading ? (
        <Spinner label={t("so.packs.f.loadingServicePacks")} />
      ) : packs.length === 0 ? (
        <EmptyState
          title={t("so.packs.title.noServicePacksFound")}
          description={t("so.packs.d.servicePackDefinitionsAreCurrentlyNotAva")}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {packs.map((pack) => {
            const meta = PACK_BADGES[pack.packCode];
            const isSelected = selectedPack?.packCode === pack.packCode;
            return (
              <Card
                key={pack.packCode}
                className={`transition-colors ${
                  isSelected ? "border-slate-400 ring-1 ring-slate-400" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge>{meta.code}</Badge>
                      <h3 className="text-base font-semibold text-slate-900">{meta.title}</h3>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{pack.description}</p>
                  </div>
                  <StatusPill tone={pack.isActive ? "success" : "neutral"}>
                    {pack.isActive ? "Active" : "Inactive"}
                  </StatusPill>
                </div>

                <dl className="mt-4 grid grid-cols-1 gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600 sm:grid-cols-2">
                  <div>
                    <dt className="font-medium text-slate-400">{t("so.packs.f.presetServiceTypes")}</dt>
                    <dd className="font-semibold text-slate-800">{pack.presetServiceCount} services</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-400">{t("so.packs.f.lastActivation")}</dt>
                    <dd className="text-slate-800">
                      {pack.activatedAt ? formatDate(pack.activatedAt) : "Not yet activated"}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    variant={pack.isActive ? "secondary" : "primary"}
                    disabled={busy}
                    onClick={() => void togglePackActivation(pack)}
                  >
                    {pack.isActive ? "Deactivate pack" : "Activate pack"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={loadingDetail}
                    onClick={() => void inspectPack(pack.packCode)}
                  >
                    {isSelected ? "Refresh preset inspect" : "Inspect preset checklists"}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {selectedPack ? (
        <Card className="mt-6">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <Badge>{PACK_BADGES[selectedPack.packCode].code}</Badge>
                <h2 className="text-base font-semibold text-slate-900">
                  {selectedPack.preset.name} — Preset Specifications
                </h2>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {selectedPack.preset.description}
              </p>
            </div>
            <Button variant="ghost" onClick={() => setSelectedPack(null)}>
              Close
            </Button>
          </div>

          <div className="mt-4 space-y-4">
            {selectedPack.preset.serviceDefinitions.map((def) => (
              <div key={def.code} className="rounded-md border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-mono text-xs text-slate-400">{def.code}</span>
                    <h4 className="text-sm font-semibold text-slate-900">{def.name}</h4>
                  </div>
                  <Badge>{def.category}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-600">{def.description}</p>

                <div className="mt-3">
                  <h5 className="text-xs font-semiboldr text-slate-500">
                    Template Checklist Items ({def.checklistItems.length})
                  </h5>
                  <ul className="mt-2 space-y-1.5 text-xs text-slate-700">
                    {def.checklistItems.map((item) => (
                      <li
                        key={item.code}
                        className="flex items-center justify-between rounded bg-white px-2.5 py-1.5 shadow-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-slate-400">
                            #{item.sortOrder}
                          </span>
                          <span>{item.label}</span>
                        </div>
                        {item.isRequired ? (
                          <Badge className="bg-rose-50 text-rose-700">{t("so.packs.t.mandatory")}</Badge>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-500">{t("so.packs.t.optional")}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
