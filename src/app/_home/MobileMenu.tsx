"use client";

/**
 * Public-header mobile menu (005A, hardened in H2) — the only client island on
 * the homepage. An accessible disclosure: a burger button toggles a full-width
 * sheet with the section links + auth actions. Escape closes and returns focus
 * to the trigger; a link click closes; body scroll locks while open; and (H2)
 * Tab is TRAPPED in a cycle of trigger + sheet controls so keyboard focus can
 * never land on the page content hidden behind the open sheet. Logical
 * properties throughout so it mirrors correctly under RTL.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/platform/ui";

export type MobileLink = { href: string; label: string; section?: boolean };

/** The focusable-element selector used by the Tab trap. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Pure Tab-trap decision (H2, unit-tested without a DOM): given the ordered
 * focus cycle (trigger first, then the sheet's controls), the currently active
 * element and the Shift state, return the element that must receive focus, or
 * null to let the browser's default Tab order proceed (it stays inside the
 * cycle). Focus that has escaped the cycle entirely is pulled back to the
 * first element.
 */
export function trapTabTarget<T>(
  focusables: readonly T[],
  active: T | null | undefined,
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const idx = active == null ? -1 : focusables.indexOf(active as T);
  if (idx === -1) return first; // escaped the cycle → pull back in
  if (!shiftKey && active === last) return first; // wrap forward
  if (shiftKey && active === first) return last; // wrap backward
  return null; // default order keeps focus inside the cycle
}

export function MobileMenu({
  links,
  primary,
  secondary,
  openLabel,
  closeLabel,
  navLabel,
  languageSlot,
}: {
  links: MobileLink[];
  /** The prominent CTA (Get Started / Open workspace). */
  primary: { href: string; label: string };
  /** The secondary auth action (Log in), or null when authenticated. */
  secondary: { href: string; label: string } | null;
  openLabel: string;
  closeLabel: string;
  /** Accessible name for the nav LANDMARK inside the sheet (H2 — previously
   * the landmark was mislabelled with the open-menu button label). */
  navLabel: string;
  /** Server-rendered language switcher form. */
  languageSlot: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "Tab") {
        const sheet = sheetRef.current;
        const trigger = triggerRef.current;
        if (!sheet || !trigger) return;
        const cycle = [trigger, ...Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE))];
        const target = trapTabTarget(
          cycle,
          document.activeElement as HTMLElement | null,
          e.shiftKey,
        );
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="home-mobile-menu"
        aria-label={open ? closeLabel : openLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex size-11 items-center justify-center rounded-md text-ink hover:bg-sunken"
      >
        <Icon name={open ? "close" : "menu"} size={22} aria-hidden />
      </button>

      {open ? (
        <div
          id="home-mobile-menu"
          ref={sheetRef}
          className="fixed inset-0 top-14 z-40 flex flex-col gap-1 overflow-y-auto border-t border-line bg-page p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <nav className="flex flex-col gap-1" aria-label={navLabel}>
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="flex min-h-12 items-center rounded-md px-3 text-base font-medium text-ink hover:bg-sunken"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
            {secondary ? (
              <Link
                href={secondary.href}
                onClick={() => setOpen(false)}
                className="flex min-h-12 items-center justify-center rounded-md border border-line-strong bg-card px-4 text-base font-medium text-ink"
              >
                {secondary.label}
              </Link>
            ) : null}
            <Link
              href={primary.href}
              onClick={() => setOpen(false)}
              className="flex min-h-12 items-center justify-center rounded-md bg-brand px-4 text-base font-semibold text-ink-inverse hover:bg-brand-strong"
            >
              {primary.label}
            </Link>
            <div className="pt-1">{languageSlot}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
