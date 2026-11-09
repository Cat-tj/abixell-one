/**
 * Checkpoint 1C.2 — Create complaint. Uses only the existing Complaint
 * model fields; category / severity / priority options come from Tenant
 * Configuration reference data (never hardcoded). Submits to the real API
 * and surfaces backend validation/authorization errors safely.
 */
import { useT } from "../../i18n/LocaleProvider";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { api, ApiError, type ComplaintCreateOptions } from "../../lib/api";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Textarea,
} from "../../shell/components/ui";
import { useCustomerScope } from "./useCustomerScope";

export function ComplaintCreatePage() {
  const t = useT();
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetCustomerId = searchParams.get("customerId") ?? "";

  const { customers, selectedId, setSelectedId, loading: customersLoading } = useCustomerScope();
  const [options, setOptions] = useState<ComplaintCreateOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Honour a customerId passed from the list page.
  useEffect(() => {
    if (presetCustomerId) setSelectedId(presetCustomerId);
  }, [presetCustomerId, setSelectedId]);

  const loadOptions = useCallback(async () => {
    setOptionsError(null);
    try {
      setOptions(await api.complaintReferenceData(token));
    } catch (err) {
      setOptionsError(err instanceof ApiError ? err.message : t("cmp.create.msg.failedToLoadFormOptions"));
    }
  }, [token, t]);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedId) {
      setError(t("cmp.create.msg.pleaseSelectACustomerFirst"));
      return;
    }
    const form = new FormData(e.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.createComplaint(token, {
        customerId: selectedId,
        category: String(form.get("category")),
        subcategory: form.get("subcategory") ? String(form.get("subcategory")) : null,
        severity: String(form.get("severity")),
        priority: String(form.get("priority")),
        description: String(form.get("description")),
      });
      navigate(`/complaints/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("cmp.create.msg.failedToCreateTheComplaint"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t("cmp.create.title.newComplaint")}
        subtitle={t("cmp.create.sub.tellUsWhatHappenedYourComplaintWillBeRou")}
        actions={
          <Button variant="secondary" onClick={() => navigate("/complaints")}>
            Back to list
          </Button>
        }
      />

      {optionsError && <Alert tone="error">{optionsError}</Alert>}

      {customersLoading || !options ? (
        <Spinner label={t("cmp.create.f.preparingTheForm")} />
      ) : (
        <Card className="max-w-xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            {customers.length > 1 && (
              <Field label={t("cmp.create.f.customer")} required>
                <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} required>
                  <option value="">{t("cmp.create.t.selectACustomer")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label={t("cmp.create.f.category")} required>
              <Select name="category" required defaultValue="">
                <option value="" disabled>{t("cmp.create.t.selectACategory")}</option>
                {options.categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t("cmp.create.f.subcategory")} hint={t("cmp.create.n.optional")}>
              <Input name="subcategory" placeholder={t("cmp.create.p.eGCleaningSchedule")} />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t("cmp.create.f.severity")} required>
                <Select name="severity" required defaultValue="">
                  <option value="" disabled>{t("cmp.create.t.select")}</option>
                  {options.severities.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("cmp.create.f.priority")} required>
                <Select name="priority" required defaultValue="">
                  <option value="" disabled>{t("cmp.create.t.select")}</option>
                  {options.priorities.map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label={t("cmp.create.f.description")} required>
              <Textarea name="description" required rows={5} placeholder={t("cmp.create.p.describeTheIssueInDetail")} />
            </Field>

            {error && <Alert tone="error">{error}</Alert>}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Submitting…" : "Create complaint"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => navigate("/complaints")}>
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
