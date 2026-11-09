/**
 * Documents — the tenant's document/file service and printout templates.
 *
 * Document storage reuses the shared document service (read + upload, gated by
 * `config.document.*`). Printout templates are a declared follow-up: the
 * backend entity does not exist yet, so this tab renders an honest placeholder
 * instead of a pretend form.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type DocumentRecord } from "../../lib/api";
import { useT } from "../../i18n/LocaleProvider";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, EmptyState, Field, Input, Spinner } from "../../shell/components/ui";

type Message = { type: "error" | "success"; text: string };

export function DocumentsTab({
  token,
  canManage,
  onMessage,
}: {
  token: string;
  canManage: boolean;
  onMessage: (m: Message) => void;
}) {
  const t = useT();
  // Tenant-level documents attach to the tenant itself: the API requires a
  // UUID entityId, so the tenant id stands in for the old "system" literal.
  const tenantId = useAuth().session?.tenantId ?? "";
  const [documents, setDocuments] = useState<DocumentRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    api.documentsForEntity(token, "demo_transaction", tenantId)
      .then((data) => {
        setDocuments(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t("documents.loadFailed"));
        setLoading(false);
      });
  }, [token, tenantId, t]);

  // The list was never fetched on mount, so the tab spun forever.
  useEffect(() => {
    load();
  }, [load]);

  const upload = async () => {
    if (uploading) return;
    if (!file) {
      onMessage({ type: "error", text: t("common.form.missing", { fields: t("documents.uploadLabel") }) });
      return;
    }
    setUploading(true);
    try {
      await api.uploadDocument(token, "demo_transaction", tenantId, file);
      onMessage({ type: "success", text: t("documents.uploaded") });
      setFile(null);
      load();
    } catch (err) {
      onMessage({ type: "error", text: err instanceof Error ? err.message : t("documents.uploadFailed") });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-sm font-semibold text-ink">{t("documents.storageTitle")}</h2>
        <p className="mt-1 text-sm text-ink-dim">{t("documents.storageDesc")}</p>

        {canManage && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Field label={t("documents.uploadLabel")} hint={t("documents.uploadHint")}>
              <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Button disabled={uploading} onClick={upload}>
              {uploading ? t("documents.uploading") : t("documents.upload")}
            </Button>
          </div>
        )}

        <div className="mt-4">
          {loading ? (
            <Spinner label={t("documents.loading")} />
          ) : error ? (
            <Alert tone="error">{error}</Alert>
          ) : documents && documents.length > 0 ? (
            <ul className="divide-y divide-line">
              {documents.map((doc) => (
                <li key={doc.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <div className="text-sm font-medium text-ink">{doc.fileName}</div>
                    <div className="text-xs text-ink-dim">{doc.mimeType}</div>
                  </div>
                  <span className="text-xs text-ink-faint">{new Date(doc.createdAt).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t("documents.emptyTitle")} description={t("documents.emptyDesc")} />
          )}
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">{t("documents.printoutTitle")}</h2>
        <p className="mt-1 text-sm text-ink-dim">{t("documents.printoutDesc")}</p>
        <div className="mt-4">
          <Alert tone="info">{t("documents.printoutComingSoon")}</Alert>
        </div>
      </Card>
    </div>
  );
}
