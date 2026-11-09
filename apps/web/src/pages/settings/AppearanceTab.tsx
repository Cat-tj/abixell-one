/**
 * Appearance — theme and language. Both are personal, per-browser preferences
 * (ThemeProvider / LocaleProvider), so this tab needs no backend write path;
 * it is gated by `config.platform.*` purely to keep the tab list honest.
 */
import { Card, Field, Select, Toggle } from "../../shell/components/ui";
import { useTheme, type ThemeChoice } from "../../theme/ThemeProvider";
import { useLocale } from "../../i18n/LocaleProvider";
import { useT } from "../../i18n/LocaleProvider";

export function AppearanceTab({ canManage }: { canManage: boolean }) {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();

  return (
    <div className="max-w-2xl space-y-4">
      {!canManage && <p className="text-sm text-ink-dim">{t("appearance.readOnlyHint")}</p>}
      <Card>
        <h2 className="text-sm font-semibold text-ink">{t("appearance.themeTitle")}</h2>
        <p className="mt-1 text-sm text-ink-dim">{t("appearance.themeDesc")}</p>
        <div className="mt-4 space-y-3">
          <Field label={t("appearance.themeMode")} hint={t("appearance.themeHint")}>
            <Select
              value={theme}
              disabled={!canManage}
              onChange={(e) => setTheme(e.target.value as ThemeChoice)}
            >
              <option value="light">{t("appearance.light")}</option>
              <option value="dark">{t("appearance.dark")}</option>
            </Select>
          </Field>
          <Toggle
            checked={theme === "dark"}
            disabled={!canManage}
            onChange={(dark) => setTheme(dark ? "dark" : "light")}
            label={t("appearance.darkMode")}
          />
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">{t("appearance.languageTitle")}</h2>
        <p className="mt-1 text-sm text-ink-dim">{t("appearance.languageDesc")}</p>
        <div className="mt-4">
          <Field label={t("appearance.language")} hint={t("appearance.languageHint")}>
            <Select
              value={locale}
              disabled={!canManage}
              onChange={(e) => setLocale(e.target.value as "en" | "id")}
            >
              <option value="en">English</option>
              <option value="id">Bahasa Indonesia</option>
            </Select>
          </Field>
        </div>
      </Card>
    </div>
  );
}
