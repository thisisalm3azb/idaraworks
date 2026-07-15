"use client";
/**
 * <CustomBuilder> — the Custom path of the four-path subscription model (U3):
 * grouped add-ons with quantity steppers for the stackable packs and a LIVE
 * monthly total. Client component; all data + labels arrive as serializable
 * props (built from buildSelectionView + t() on the server), so it embeds in
 * settings or the wave-2 onboarding flow unchanged.
 *
 * Honesty: gated items render visible-but-disabled with their reason; deferred
 * items never reach this component (excluded by buildSelectionView); the total
 * is labelled indicative + tax-exclusive by the host's note; no payment is
 * implied while the provider is disabled (submit is simply not offered).
 *
 * Submission contract (optional `action`): one hidden input per selected
 * add-on named `addon:<key>` with the quantity as value — the host action maps
 * those to a changeAddons additions list. Overlap with an active bundle is
 * handled server-side (one org_addon row per key — never a double charge);
 * the overlapNote label states that.
 */
import { useMemo, useState } from "react";
import { Button, Card } from "@/platform/ui";
import { formatMoney } from "@/platform/format";
import type { Locale } from "@/platform/registries";
import type { SelectionCurrency } from "./types";

export type CustomBuilderItem = {
  key: string;
  name: string;
  description: string;
  priceMonthlyMinor: number;
  stackable: boolean;
  selectable: boolean;
  /** Honest reason when not selectable (credential/D1 gated). */
  note?: string;
};

export type CustomBuilderGroup = { key: string; label: string; items: CustomBuilderItem[] };

export type CustomBuilderLabels = {
  total: string;
  perMonth: string;
  taxNote: string;
  overlapNote: string;
  quantity: string;
  notAvailable: string;
  submit?: string;
  /** Stepper aria-labels: "<increase> <add-on name>" (translated verbs). */
  increase?: string;
  decrease?: string;
};

export type CustomBuilderProps = {
  groups: CustomBuilderGroup[];
  currency: SelectionCurrency;
  locale: Locale;
  labels: CustomBuilderLabels;
  /** Pre-selected quantities (e.g. the org's current add-ons). */
  initial?: Record<string, number>;
  /** Optional server action — rendered as a submit button when provided. */
  action?: (formData: FormData) => Promise<void>;
};

const MAX_QTY = 99;

export function CustomBuilder({
  groups,
  currency,
  locale,
  labels,
  initial,
  action,
}: CustomBuilderProps) {
  const [qty, setQty] = useState<Record<string, number>>(initial ?? {});
  const items = useMemo(
    () => new Map(groups.flatMap((g) => g.items.map((i) => [i.key, i]))),
    [groups],
  );

  const set = (key: string, next: number) =>
    setQty((q) => {
      const clamped = Math.max(0, Math.min(MAX_QTY, Math.trunc(next)));
      const copy = { ...q };
      if (clamped === 0) delete copy[key];
      else copy[key] = clamped;
      return copy;
    });

  const totalMinor = Object.entries(qty).reduce((sum, [key, n]) => {
    const item = items.get(key);
    return sum + (item ? item.priceMonthlyMinor * n : 0);
  }, 0);

  const body = (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.key}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {g.label}
          </h3>
          <ul className="flex flex-col gap-2">
            {g.items.map((item) => {
              const n = qty[item.key] ?? 0;
              return (
                <li
                  key={item.key}
                  className="flex flex-col gap-2 rounded-md border border-line p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">{item.name}</p>
                    <p className="text-sm text-ink">
                      <span dir="ltr" className="font-mono font-medium">
                        {formatMoney(item.priceMonthlyMinor, currency, { locale })}
                      </span>{" "}
                      <span className="text-xs text-ink-muted">/ {labels.perMonth}</span>
                    </p>
                  </div>
                  <p className="text-xs text-ink-muted">{item.description}</p>
                  {!item.selectable ? (
                    <p className="text-xs text-warning">{item.note ?? labels.notAvailable}</p>
                  ) : item.stackable ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-muted">{labels.quantity}</span>
                      <Button
                        variant="secondary"
                        aria-label={`${labels.decrease ?? "−"} ${item.name}`}
                        onClick={() => set(item.key, n - 1)}
                        disabled={n === 0}
                      >
                        <span aria-hidden>−</span>
                      </Button>
                      <span dir="ltr" className="w-8 text-center font-mono text-sm text-ink">
                        {n}
                      </span>
                      <Button
                        variant="secondary"
                        aria-label={`${labels.increase ?? "+"} ${item.name}`}
                        onClick={() => set(item.key, n + 1)}
                        disabled={n >= MAX_QTY}
                      >
                        <span aria-hidden>+</span>
                      </Button>
                    </div>
                  ) : (
                    <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={n > 0}
                        onChange={(e) => set(item.key, e.target.checked ? 1 : 0)}
                        className="size-5 accent-current"
                      />
                      {item.name}
                    </label>
                  )}
                  {n > 0 && item.selectable ? (
                    <input type="hidden" name={`addon:${item.key}`} value={n} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">{labels.total}</span>
          <span className="text-sm text-ink">
            <span dir="ltr" className="font-mono text-lg font-semibold" data-testid="custom-total">
              {formatMoney(totalMinor, currency, { locale })}
            </span>{" "}
            <span className="text-xs text-ink-muted">/ {labels.perMonth}</span>
          </span>
        </div>
        <p className="text-xs text-ink-muted">{labels.taxNote}</p>
        <p className="text-xs text-ink-muted">{labels.overlapNote}</p>
        {action && labels.submit ? (
          <Button type="submit" className="mt-2 self-start">
            {labels.submit}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return <Card>{action ? <form action={action}>{body}</form> : body}</Card>;
}
