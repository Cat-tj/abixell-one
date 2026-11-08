/**
 * English/Indonesian switch, shaped like `ThemeToggle` so the two read as one
 * control pair in the topbar.
 *
 * Text ("EN"/"ID") rather than a globe icon: the repo has no icon library, and
 * one glyph is not worth the first dependency. The full language name is the
 * accessible name, so a screen reader never announces a bare two-letter code.
 */
import { useLocale, type Locale } from "../../i18n/LocaleProvider";

const OPTIONS: { value: Locale; label: string; name: string }[] = [
  { value: "en", label: "EN", name: "English" },
  { value: "id", label: "ID", name: "Bahasa Indonesia" },
];

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();

  return (
    <div
      role="group"
      aria-label="Language"
      className="inline-flex shrink-0 rounded border border-line-strong bg-panel p-0.5"
    >
      {OPTIONS.map((option) => {
        const selected = locale === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-label={option.name}
            lang={option.value}
            onClick={() => setLocale(option.value)}
            className={`inline-flex min-h-[44px] flex-1 items-center justify-center rounded px-2.5 lg:min-h-[26px] text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[26px] ${
              selected
                ? "bg-accent text-accent-on"
                : "text-ink-dim hover:bg-panel-2 hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
