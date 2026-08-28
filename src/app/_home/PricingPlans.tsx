"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/platform/ui";

/**
 * H9.1: the pricing decision surface — three plans with an accessible
 * Monthly / Annual selector. A small client island (the only state is the
 * billing period); every string and number arrives pre-resolved from the
 * server component, so this file holds no copy and no price constants.
 *
 * Truth: prices are the approved public launch targets; the interface states
 * that early access is free while billing is prepared (the payment provider
 * is disabled), and every CTA continues into the real signup/workspace
 * journey — there is no checkout route to point at.
 *
 * Accessibility: the selector is two real buttons with aria-pressed inside a
 * labelled group; prices swap with text (the billed-annually line appears in
 * the annual state), never color alone. Latin numerals in both locales
 * (F-44). Depth dots communicate increasing operating depth per plan.
 */

export type PlanVM = {
  key: string;
  name: string;
  tag: string;
  users: string;
  outcomes: string[];
  micro: string;
  badge: string | null;
  featured: boolean;
  monthly: { amount: string; suffix: string };
  annual: { amount: string; suffix: string; billed: string };
  cta: { href: string; label: string };
  depth: number; // 1..3
};

export function PricingPlans({
  plans,
  labels,
}: {
  plans: PlanVM[];
  labels: { group: string; monthly: string; annual: string; save: string };
}) {
  const [period, setPeriod] = useState<"monthly" | "annual">("monthly");

  return (
    <div>
      {/* Billing-period selector: real buttons, pressed state exposed. */}
      <div
        role="group"
        aria-label={labels.group}
        className="mx-auto mt-8 flex w-fit items-center rounded-full border border-line bg-page p-1"
      >
        <button
          type="button"
          aria-pressed={period === "monthly"}
          onClick={() => setPeriod("monthly")}
          className={
            "min-h-9 rounded-full px-4 text-sm font-medium transition-none " +
            (period === "monthly"
              ? "bg-card text-ink shadow-card"
              : "text-ink-secondary hover:text-ink")
          }
        >
          {labels.monthly}
        </button>
        <button
          type="button"
          aria-pressed={period === "annual"}
          onClick={() => setPeriod("annual")}
          className={
            "flex min-h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition-none " +
            (period === "annual"
              ? "bg-card text-ink shadow-card"
              : "text-ink-secondary hover:text-ink")
          }
        >
          {labels.annual}
          <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success">
            {labels.save}
          </span>
        </button>
      </div>

      <div className="mt-8 grid items-start gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const price = period === "monthly" ? p.monthly : p.annual;
          return (
            <div
              key={p.key}
              className={
                "flex flex-col rounded-xl border p-6 " +
                (p.featured
                  ? "border-brand/60 bg-card shadow-pop"
                  : "border-line bg-page shadow-card")
              }
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-semibold text-ink">{p.name}</h3>
                {p.badge ? (
                  <span className="inline-flex items-center rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand">
                    {p.badge}
                  </span>
                ) : null}
              </div>
              {/* Operating depth, expressed structurally. */}
              <span className="mt-2 flex items-center gap-1" aria-hidden="true">
                {[1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={
                      "h-1.5 w-6 rounded-full " + (i <= p.depth ? "bg-brand/70" : "bg-line")
                    }
                  />
                ))}
              </span>
              <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{p.tag}</p>

              {/* The price block: strong numerals, honest billing text. */}
              <p className="mt-5 flex items-baseline gap-2">
                <span dir="ltr" className="text-4xl font-semibold tracking-tight text-ink">
                  {price.amount}
                </span>
                <span className="text-sm text-ink-secondary">{price.suffix}</span>
              </p>
              <p
                className={
                  "mt-1 min-h-5 text-xs text-ink-muted " +
                  (period === "annual" && p.annual.billed ? "" : "invisible")
                }
              >
                {p.annual.billed || " "}
              </p>

              <p className="mt-3 flex items-start gap-2 text-sm font-medium text-ink">
                <Icon name="users" size={15} aria-hidden className="mt-0.5 shrink-0 text-brand" />
                {p.users}
              </p>

              <ul className="mt-4 flex flex-1 flex-col gap-2.5 border-t border-line pt-4">
                {p.outcomes.map((o) => (
                  <li key={o} className="flex items-start gap-2.5 text-sm text-ink-secondary">
                    <Icon
                      name="check"
                      size={16}
                      aria-hidden
                      className="mt-0.5 shrink-0 text-brand"
                    />
                    <span>{o}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={p.cta.href}
                className={
                  "mt-6 inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-semibold " +
                  (p.featured
                    ? "bg-brand text-ink-inverse hover:bg-brand-strong"
                    : "border border-line-strong bg-card text-ink hover:bg-sunken")
                }
              >
                {p.cta.label}
              </Link>
              <p className="mt-2 text-center text-xs text-ink-muted">{p.micro}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
