/**
 * Phase 7 — Health, Safety & Environment (HSE-CORE-001/002).
 *
 * Report new incident or observation form.
 * Mobile-friendly with date/time pickers for occurred-at timestamp.
 * Submits and redirects to detail view where lifecycle begins.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import {
  api,
  ApiError,
  type HseRecordType,
} from "../../lib/api";
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
import { useT } from "../../i18n/LocaleProvider";
import { localDateInputValue } from "../../shared/localDateTime";

export function HseReportPage() {
  const { session } = useAuth();
  const token = session!.accessToken;
  const navigate = useNavigate();
  const t = useT();

  const [recordType, setRecordType] = useState<HseRecordType>("incident");
  const [categoryCode, setCategoryCode] = useState("");
  const [severityCode, setSeverityCode] = useState("");
  const [occurredDate, setOccurredDate] = useState(() => {
    return localDateInputValue();
  });
  const [occurredTime, setOccurredTime] = useState("09:00");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [immediateAction, setImmediateAction] = useState("");
  const [locationDetail, setLocationDetail] = useState("");

  const [categories, setCategories] = useState<{ code: string; label: string }[]>([]);
  const [severities, setSeverities] = useState<{ code: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load reference data once per session token.
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [categoryList, severityList] = await Promise.all([
          api.configReferenceDataItems(token, "hse_category").catch(() => [] as { code: string; label: string }[]),
          api.configReferenceDataItems(token, "hse_severity").catch(() => [] as { code: string; label: string }[]),
        ]);
        setCategories(categoryList);
        setSeverities(severityList);
        if (categoryList[0]) setCategoryCode(categoryList[0].code);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("hse.report.loadRefFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [token, t]);

  async function submit() {
    const missing = [
      title.trim() ? null : t("hse.common.title"),
      occurredDate ? null : t("fin.common.date"),
      occurredTime ? null : t("hse.common.time"),
    ].filter((x): x is string => x !== null);
    if (missing.length > 0) {
      setError(t("common.form.missing", { fields: missing.join(", ") }));
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Combine date and time into ISO timestamp
      const occurredAt = new Date(`${occurredDate}T${occurredTime}:00`).toISOString();

      const created = await api.reportHseRecord(token, {
        recordType,
        categoryCode: categoryCode || null,
        severityCode: severityCode || null,
        occurredAt,
        title,
        summary: summary || null,
        description: description || null,
        immediateAction: immediateAction || null,
        locationDetail: locationDetail || null,
      });
      navigate(`/hse/records/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("hse.report.failed"));
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="space-y-4">
      <PageHeader title={t("hse.report.title")} subtitle={t("hse.report.subtitle")} />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.report.eventClassification")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("fin.common.type")} required>
            <Select value={recordType} onChange={(e) => setRecordType(e.target.value as HseRecordType)}>
              <option value="incident">{t("hse.common.incident")}</option>
              <option value="observation">{t("hse.common.observation")}</option>
            </Select>
          </Field>
          <Field label={t("fin.common.category")}>
            <Select value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
              <option value="">{t("fin.common.select")}</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("hse.common.severity")}>
            <Select value={severityCode} onChange={(e) => setSeverityCode(e.target.value)}>
              <option value="">{t("fin.common.select")}</option>
              {severities.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("hse.report.whenAndWhere")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("fin.common.date")} required>
            <Input type="date" value={occurredDate} onChange={(e) => setOccurredDate(e.target.value)} />
          </Field>
          <Field label={t("hse.common.time")} required>
            <Input type="time" value={occurredTime} onChange={(e) => setOccurredTime(e.target.value)} />
          </Field>
          <Field label={t("hse.report.locationDetail")}>
            <Input
              value={locationDetail}
              onChange={(e) => setLocationDetail(e.target.value)}
              placeholder={t("hse.report.locationPlaceholder")}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">{t("fin.common.description")}</h2>
        <div className="space-y-3">
          <Field label={t("hse.common.title")} required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("hse.report.titlePlaceholder")}
            />
          </Field>
          <Field label={t("hse.common.summary")}>
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t("hse.report.summaryPlaceholder")}
            />
          </Field>
          <Field label={t("hse.report.fullDescription")}>
            <Textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("hse.report.descriptionPlaceholder")}
            />
          </Field>
          <Field label={t("hse.report.immediateAction")}>
            <Textarea
              rows={3}
              value={immediateAction}
              onChange={(e) => setImmediateAction(e.target.value)}
              placeholder={t("hse.report.actionPlaceholder")}
            />
          </Field>
        </div>
      </Card>

      <div className="flex gap-2">
        <Button disabled={busy || loading} onClick={() => void submit()}>
          {busy ? <Spinner /> : t("hse.report.submit")}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/hse")}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
