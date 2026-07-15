"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "../icons";

/**
 * The ?welcome=1 banner (U5 §6): shown once after onboarding's confirm
 * redirect; dismiss is local (removing the param happens on any navigation, so
 * no persistence is needed). Suggestions are role-resolved by the server page.
 */
export function WelcomeBanner({
  title,
  body,
  dismissLabel,
  links,
}: {
  title: string;
  body: string;
  dismissLabel: string;
  links: Array<{ key: string; label: string; href: string }>;
}) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <section
      className="rounded-lg border border-accent-line bg-accent-soft p-4 shadow-card"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="text-accent" aria-hidden>
              <Icon name="sparkle" size={18} />
            </span>
            {title}
          </h2>
          <p className="mt-1 text-sm text-ink-secondary">{body}</p>
          {links.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {links.map((l) => (
                <li key={l.key}>
                  <Link
                    href={l.href}
                    className="inline-flex min-h-9 items-center rounded-md border border-accent-line bg-card px-3 text-sm font-medium text-ink hover:bg-sunken"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={dismissLabel}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-card hover:text-ink"
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    </section>
  );
}
