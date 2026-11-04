/**
 * Role-aware landing dashboard (Tahap A2).
 *
 * One flexible component, not one dashboard per role: the cards rendered are
 * chosen by the ACTIVE role code (from the session, server-owned) and gated
 * again by the caller's permissions, and the numbers come from the batched
 * `GET /my/dashboard` aggregate. A role without a tailored layout falls back
 * to the generic workspace overview, so a newly seeded role never sees a
 * broken landing.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useShell } from "../shell/layout/AppShell";
import { PageHeader, Spinner, Alert } from "../shell/components/ui";
import { useT } from "../i18n/LocaleProvider";

type Block = Record<string, number | object>;

interface DashCard {
  key: string;
  label: string;
  value: string;
  hint?: string;
  to?: string;
}

/** Which cards each role sees, in order. Unlisted roles fall back to overview. */
const ROLE_CARDS: Record<string, (b: Record<string, Block>, perms: Set<string>) => DashCard[]> = {
  ADMIN: (b) => [
    b.complaints && { key: "c", label: "Keluhan Terbuka", value: String((b.complaints.summary as { open?: number })?.open ?? 0), hint: "total " + String((b.complaints.summary as { total?: number })?.total ?? 0), to: "/complaints" },
    b.administration && { key: "a", label: "Pengguna", value: String(b.administration.users ?? 0), hint: "kelola akses", to: "/settings" },
    b.notifications && { key: "n", label: "Notifikasi", value: String(b.notifications.unread ?? 0), hint: "belum dibaca" },
  ].filter(Boolean) as DashCard[],
  COMPLAINT_MANAGER: (b) => [
    b.complaints && { key: "c", label: "Keluhan Terbuka", value: String((b.complaints.summary as { open?: number })?.open ?? 0), hint: "SLA telat: " + String((b.complaints.summary as { slaOverdue?: number })?.slaOverdue ?? 0), to: "/complaints" },
    b.myQueue && { key: "q", label: "Antrean Operasional", value: String(b.myQueue.count ?? 0), hint: "perlu tindakan", to: "/queue" },
    b.notifications && { key: "n", label: "Notifikasi", value: String(b.notifications.unread ?? 0), hint: "belum dibaca" },
  ].filter(Boolean) as DashCard[],
  COMPLAINT_HANDLER: (b) => [
    b.myQueue && { key: "q", label: "Tugas Saya", value: String(b.myQueue.count ?? 0), hint: "antrean kerja", to: "/queue" },
    b.notifications && { key: "n", label: "Notifikasi", value: String(b.notifications.unread ?? 0), hint: "belum dibaca" },
  ].filter(Boolean) as DashCard[],
  CUSTOMER_USER: (b) => [
    b.myComplaints && { key: "c", label: "Keluhan Saya", value: String(b.myComplaints.total ?? 0), hint: "buat keluhan baru", to: "/complaints/new" },
    b.notifications && { key: "n", label: "Notifikasi", value: String(b.notifications.unread ?? 0), hint: "belum dibaca" },
  ].filter(Boolean) as DashCard[],
  COORD_OPS: (b) => [
    b.workOrders && { key: "w", label: "Perintah Kerja", value: String(b.workOrders.total ?? 0), hint: "kelola permintaan", to: "/work-orders" },
    b.notifications && { key: "n", label: "Notifikasi", value: String(b.notifications.unread ?? 0), hint: "belum dibaca" },
  ].filter(Boolean) as DashCard[],
  EXEC_OPS: (b) => [
    b.workOrders && { key: "w", label: "Perintah Kerja", value: String(b.workOrders.total ?? 0), hint: "tugas lapangan", to: "/work-orders" },
  ].filter(Boolean) as DashCard[],
  VERIFY_OPS: (b) => [
    b.workOrders && { key: "w", label: "Menunggu Verifikasi", value: String(b.workOrders.total ?? 0), hint: "periksa hasil kerja", to: "/work-orders" },
  ].filter(Boolean) as DashCard[],
  BILL_OPS: (b) => [
    b.workOrders && { key: "w", label: "Perintah Kerja", value: String(b.workOrders.total ?? 0), hint: "siap ditagih", to: "/work-orders" },
  ].filter(Boolean) as DashCard[],
};

export function RoleDashboard() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const { activeRoleCode, navGroups } = useShell();
  const t = useT();
  const [blocks, setBlocks] = useState<Record<string, Block> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBlocks(null);
    setError(null);
    if (!activeRoleCode || !ROLE_CARDS[activeRoleCode]) return;
    api
      .myDashboard(token)
      .then((r) => {
        if (!cancelled) setBlocks(r.blocks);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("cmp.create.msg.failedToLoadFormOptions"));
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeRoleCode, t]);

  const cards = blocks && activeRoleCode ? ROLE_CARDS[activeRoleCode]?.(blocks, new Set()) : undefined;

  // No tailored layout for this role (or nothing to show): fall back to the
  // generic overview, which stays correct for every served destination.
  if (!cards || cards.length === 0) return null;

  if (error) {
    return (
      <div>
        <PageHeader title={t("overview.welcome", { tenant: session?.activeRoleName ?? "" })} />
        <Alert tone="error">{error}</Alert>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("overview.welcome", { tenant: session?.activeRoleName ?? "" })}
        subtitle={t("overview.subtitle")}
      />
      {!blocks ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) =>
            card.to ? (
              <Link
                key={card.key}
                to={card.to}
                className="group flex min-h-[112px] flex-col justify-between rounded-lg border border-line bg-panel p-4 transition-colors hover:border-line-strong hover:bg-panel-2"
              >
                <span className="text-sm font-semibold text-ink">{card.label}</span>
                <span className="text-3xl font-bold text-ink">{card.value}</span>
                {card.hint && <span className="text-xs text-ink-faint">{card.hint}</span>}
              </Link>
            ) : (
              <div key={card.key} className="flex min-h-[112px] flex-col justify-between rounded-lg border border-line bg-panel p-4">
                <span className="text-sm font-semibold text-ink">{card.label}</span>
                <span className="text-3xl font-bold text-ink">{card.value}</span>
                {card.hint && <span className="text-xs text-ink-faint">{card.hint}</span>}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
