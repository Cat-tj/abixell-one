/**
 * Phase 4 — Supplier master (SCM-CORE-002 / SCM-CORE-013).
 *
 * Deliberately plain: no scorecard, rating, qualification, or tender
 * analytics — those are Advanced supplier-performance capabilities.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type SupplierRecord } from "../../lib/api";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  StatusPill,
  type Column,
} from "../../shell/components/ui";

export function SuppliersPage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;

  const [rows, setRows] = useState<SupplierRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await api.suppliers(token, { search: search || undefined }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("msc.suppl.msg.couldNotLoadSuppliers"));
    } finally {
      setLoading(false);
    }
  }, [token, search, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Column<SupplierRecord>[] = [
    { header: t("msc.suppl.h.code"), cell: (row) => <span className="font-medium">{row.code}</span> },
    { header: t("msc.suppl.h.name"), cell: (row) => row.name },
    { header: t("msc.suppl.h.contact"), cell: (row) => row.contactName ?? "—" },
    { header: t("msc.suppl.h.email"), cell: (row) => row.email ?? "—" },
    {
      header: t("msc.suppl.h.state"),
      cell: (row) => (
        <StatusPill tone={row.isActive ? "success" : "neutral"}>{row.isActive ? "Active" : "Inactive"}</StatusPill>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={t("msc.suppl.title.suppliers")} subtitle={t("msc.suppl.sub.whoYouBuyFrom")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("msc.suppl.t.addASupplier")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("msc.suppl.f.code")} required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("msc.suppl.p.eGAcme")} />
          </Field>
          <Field label={t("msc.suppl.f.name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("msc.suppl.f.contact")}>
            <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </Field>
          <Field label={t("msc.suppl.f.email")}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              disabled={busy}
              onClick={async () => {
                const missing = [
                  code.trim() ? null : t("msc.suppl.f.code"),
                  name.trim() ? null : t("msc.suppl.f.name"),
                ].filter((x): x is string => x !== null);
                const emailBad = email.trim() !== "" && !/^\S+@\S+\.\S+$/.test(email.trim());
                if (missing.length > 0 || emailBad) {
                  setNotice(null);
                  setError(
                    missing.length > 0
                      ? t("common.form.missing", { fields: missing.join(", ") })
                      : t("common.form.invalid", { fields: t("msc.suppl.f.email") }),
                  );
                  return;
                }
                setBusy(true);
                setError(null);
                setNotice(null);
                try {
                  await api.createSupplier(token, {
                    code: code.trim(),
                    name: name.trim(),
                    contactName: contactName.trim() || null,
                    email: email.trim() || null,
                  });
                  setNotice(t("msc.suppl.msg.supplierCreated"));
                  setCode("");
                  setName("");
                  setContactName("");
                  setEmail("");
                  await load();
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : t("msc.suppl.msg.couldNotCreateTheSupplier"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("common.create")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <Field label={t("msc.suppl.f.search")}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("msc.suppl.p.nameOrCode")} />
        </Field>
      </Card>

      {loading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(row) => row.id}
          empty={<EmptyState title={t("msc.suppl.title.noSuppliersYet")} description={t("msc.suppl.d.addOneAboveBeforeRaisingPurchaseOrders")} />}
        />
      )}
    </div>
  );
}
