/**
 * Epic 4 Wave 1 — light/dark switch for the shell.
 *
 * Light is the shipped default until the module pages finish migrating onto
 * the tokens; the choice is stored by ThemeProvider under `abixell.theme.v1`,
 * the same key the pre-paint script in index.html reads, so the two never
 * disagree about which theme is on.
 */
import { useTheme, type ThemeChoice } from "../../theme/ThemeProvider";

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="inline-flex shrink-0 rounded-full border border-line-strong bg-panel p-1"
    >
      {OPTIONS.map((option) => {
        const selected = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => setTheme(option.value)}
            className={`inline-flex min-h-[44px] flex-1 items-center justify-center rounded-full px-3 lg:min-h-[32px] text-xs font-bold transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[32px] ${
              selected
                ? "bg-accent-soft text-accent"
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
