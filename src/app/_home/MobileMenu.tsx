"use client";

/**
 * Public-header mobile menu (005A) — the only client island on the homepage.
 * An accessible disclosure: a burger button toggles a full-width sheet with
 * the section links + auth actions. Escape closes and returns focus to the
 * trigger; a link click closes; body scroll locks while open. Logical
 * properties throughout so it mirrors correctly under RTL.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/platform/ui";

export type MobileLink = { href: string; label: string; section?: boolean };

export function MobileMenu({
  links,
  primary,
  secondary,
  openLabel,
  closeLabel,
  languageSlot,
}: {
  links: MobileLink[];
  /** The prominent CTA (Get Started / Open workspace). */
  primary: { href: string; label: string };
  /** The secondary auth action (Log in), or null when authenticated. */
  secondary: { href: string; label: string } | null;
  openLabel: string;
  closeLabel: string;
  /** Server-rendered language switcher form. */
  languageSlot: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
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
          className="fixed inset-0 top-14 z-40 flex flex-col gap-1 overflow-y-auto border-t border-line bg-page p-4"
        >
          <nav className="flex flex-col gap-1" aria-label={openLabel}>
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
