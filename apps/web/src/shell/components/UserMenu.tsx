/**
 * Epic 2 Wave 1 — avatar dropdown for shell header and drawer.
 *
 * Repainted onto the DESIGN.md tokens (Epic 4 Wave 1). Uses an initials
 * circle on the accent, never an invented profile asset.
 *
 * Epic 1 (§4.1 C) adds the active work context (the role and scope the
 * session currently runs as) and the "Switch role" entry, so the dropdown
 * answers "who am I right now" without a page of its own.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useT } from "../../i18n/LocaleProvider";

function initialsOf(fullName?: string, email?: string): string {
  const name = (fullName ?? "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
  }
  const mail = (email ?? "").trim();
  return mail ? mail.slice(0, 2).toUpperCase() : "?";
}

export function UserMenu({
  fullName,
  email,
  activeRoleName,
  activeScopeName,
  onSwitchRole,
  onSignOut,
}: {
  fullName?: string;
  email?: string;
  /** The session's ACTIVE Role display name (Epic 1 §4.1 C), or undefined
   * when the session holds no active assignment. */
  activeRoleName?: string;
  activeScopeName?: string;
  onSwitchRole: () => void;
  onSignOut: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        buttonRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
        if (!items || items.length === 0) return;
        const list = Array.from(items);
        const currentIndex = list.indexOf(document.activeElement as HTMLElement);
        const nextIndex =
          event.key === "ArrowDown"
            ? (currentIndex + 1) % list.length
            : (currentIndex - 1 + list.length) % list.length;
        list[nextIndex]?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  const initials = initialsOf(fullName, email);
  const displayName = fullName || t("userMenu.defaultName");

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex min-h-[44px] items-center gap-2 rounded border border-line-strong bg-panel px-2 py-1 text-sm lg:min-h-[32px] hover:bg-panel-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-on"
        >
          {initials}
        </span>
        <span className="hidden min-w-0 flex-col items-start text-left sm:flex">
          <span className="max-w-40 truncate text-sm font-medium text-ink">{displayName}</span>
          {activeRoleName ? (
            <span className="max-w-40 truncate text-xs text-ink-dim" title={activeScopeName ?? undefined}>
              {activeRoleName}
              {activeScopeName ? ` · ${activeScopeName}` : ""}
            </span>
          ) : (
            email && <span className="max-w-40 truncate text-xs text-ink-dim">{email}</span>
          )}
        </span>
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={t("userMenu.label")}
          className="absolute right-0 z-30 mt-2 w-56 rounded border border-line bg-panel py-1 shadow-lg"
        >
          <div className="border-b border-line px-3 py-2">
            <div className="truncate text-sm font-medium text-ink">{displayName}</div>
            {activeRoleName ? (
              <div className="truncate text-xs text-ink-dim" title={activeScopeName ?? undefined}>
                {t("userMenu.workingAs", { role: activeRoleName })}
                {activeScopeName ? ` (${activeScopeName})` : ""}
              </div>
            ) : (
              email && <div className="truncate text-xs text-ink-dim">{email}</div>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close();
              onSwitchRole();
            }}
            className="block min-h-[44px] w-full px-3 py-2 text-left text-sm text-ink-dim hover:bg-panel-2 hover:text-ink focus-visible:bg-panel-2 focus-visible:outline-hidden"
          >
            {t("userMenu.switchRole")}
          </button>
          <NavLink
            to="/profile"
            role="menuitem"
            tabIndex={-1}
            onClick={close}
            className="block min-h-[44px] px-3 py-2 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink focus-visible:bg-panel-2 focus-visible:outline-hidden"
          >
            {t("userMenu.profile")}
          </NavLink>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              close();
              onSignOut();
            }}
            className="block min-h-[44px] w-full px-3 py-2 text-left text-sm text-ink-dim hover:bg-panel-2 hover:text-ink focus-visible:bg-panel-2 focus-visible:outline-hidden"
          >
            {t("userMenu.signOut")}
          </button>
        </div>
      )}
    </div>
  );
}
