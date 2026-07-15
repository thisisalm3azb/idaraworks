"use client";
/**
 * <CustomBuilder> — the Custom path (U3, redesigned V2). Opens as a full-width
 * in-page panel that REPLACES the tier comparison (driven by SubscriptionSelector)
 * — the page never becomes one unstructured scroll of 19 add-ons. It provides:
 * category tabs + search, grouped concise cards, quantity steppers for stackable
 * packs, honest included-free / credential-gated / deferred / D1-gated / already-
 * in-a-bundle indicators, a LIVE monthly subtotal, a sticky selection summary, a
 * reset, a "back to comparison" action, and — for the settings management surface
 * — a CHANGE-REVIEW step before submit (current vs new, added/removed, quantity
 * changes, total difference, immediate vs scheduled, a no-data-deletion note).
 *
 * Client component; imports the pure client-usable t() and builds a request-locale
 * translator. Submission contract (optional `action`): one hidden input per
 * selected add-on named `addon:<key>` with the quantity, plus any `hiddenFields`.
 */
import { useMemo, useState } from "react";
import { Badge, Button, Card } from "@/platform/ui";
import { formatMoney } from "@/platform/format";
import { t as translate } from "@/platform/i18n/t";
import type { Locale } from "@/platform/registries";
import type { SelectionCurrency } from "./types";
import { buildChangeReview, type ReviewItem } from "./review";

export type CustomBuilderItem = {
  key: string;
  name: string;
  description: string;
  priceMonthlyMinor: number;
  stackable: boolean;
  selectable: boolean;
  /** Honest reason when not selectable (credential/D1 gated). */
  note?: string;
  /** Availability class — drives the honest indicator badge. */
  availabilityClass?: "available" | "manual_process" | "credential_gated" | "d1_gated";
  /** This add-on is ALREADY provided by an active bundle — included, never charged twice. */
  bundleIncluded?: boolean;
};

export type CustomBuilderGroup = { key: string; label: string; items: CustomBuilderItem[] };

export type CustomBuilderProps = {
  groups: CustomBuilderGroup[];
  currency: SelectionCurrency;
  locale: Locale;
  /** Pre-selected quantities (the org's current individually-selected add-ons). */
  initial?: Record<string, number>;
  /** Optional server action — rendered as a submit button when provided. */
  action?: (formData: FormData) => Promise<void>;
  /** Return to the tier comparison (SubscriptionSelector). */
  onBack?: () => void;
  /** Extra hidden fields to post with the form (e.g. priceVersion). */
  hiddenFields?: Record<string, string>;
  /** Show a change-review step before the final submit (settings management). */
  reviewBeforeSubmit?: boolean;
  /** Override the submit label (onboarding uses its own CTA). */
  submitLabel?: string;
  /** Focus/scroll to this add-on on open (LockedFeature deep link). */
  highlightKey?: string;
};

const MAX_QTY = 99;

export function CustomBuilder({
  groups,
  currency,
  locale,
  initial,
  action,
  onBack,
  hiddenFields,
  reviewBeforeSubmit,
  submitLabel,
  highlightKey,
}: CustomBuilderProps) {
  const t = (key: string, vars?: Record<string, string | number>) => translate(key, vars, locale);
  const [qty, setQty] = useState<Record<string, number>>(initial ?? {});
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string>("all");
  const [showReview, setShowReview] = useState(false);

  const items = useMemo(
    () => new Map(groups.flatMap((g) => g.items.map((i) => [i.key, i]))),
    [groups],
  );
  const reviewItems = useMemo<ReviewItem[]>(
    () =>
      [...items.values()].map((i) => ({
        key: i.key,
        name: i.name,
        priceMonthlyMinor: i.priceMonthlyMinor,
        stackable: i.stackable,
      })),
    [items],
  );

  const set = (key: string, next: number) =>
    setQty((q) => {
      const clamped = Math.max(0, Math.min(MAX_QTY, Math.trunc(next)));
      const copy = { ...q };
      if (clamped === 0) delete copy[key];
      else copy[key] = clamped;
      return copy;
    });
  const reset = () => setQty(initial ?? {});

  const totalMinor = Object.entries(qty).reduce((sum, [key, n]) => {
    const item = items.get(key);
    return sum + (item ? item.priceMonthlyMinor * n : 0);
  }, 0);
  const selectedCount = Object.values(qty).filter((n) => n > 0).length;

  const review = useMemo(
    () => buildChangeReview(reviewItems, initial ?? {}, qty),
    [reviewItems, initial, qty],
  );

  const q = query.trim().toLowerCase();
  const visibleGroups = groups
    .filter((g) => activeCat === "all" || g.key === activeCat)
    .map((g) => ({
      ...g,
      items: q
        ? g.items.filter(
            (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
          )
        : g.items,
    }))
    .filter((g) => g.items.length > 0);

  const money = (m: number) => formatMoney(m, currency, { locale });

  function IndicatorBadge({ item }: { item: CustomBuilderItem }) {
    if (item.bundleIncluded)
      return <Badge tone="success">{t("subscription.builder.included_bundle")}</Badge>;
    if (item.availabilityClass === "credential_gated")
      return <Badge tone="warning">{t("subscription.builder.credential_gated")}</Badge>;
    if (item.availabilityClass === "d1_gated")
      return <Badge tone="warning">{t("subscription.builder.d1_gated")}</Badge>;
    if (item.availabilityClass === "manual_process")
      return <Badge tone="neutral">{t("subscription.builder.manual")}</Badge>;
    return null;
  }

  return (
    <Card className="flex flex-col gap-4">
      {/* Header: back to comparison + heading + reset. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {onBack ? (
            <Button type="button" variant="ghost" onClick={onBack}>
              <span aria-hidden>←</span> {t("subscription.builder.back")}
            </Button>
          ) : null}
          <h3 className="text-lg font-bold text-ink">{t("subscription.builder.title")}</h3>
        </div>
        <Button type="button" variant="ghost" onClick={reset}>
          {t("subscription.builder.reset")}
        </Button>
      </div>

      {/* Search + category tabs. */}
      <div className="flex flex-col gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("subscription.builder.search")}
          aria-label={t("subscription.builder.search")}
          className="min-h-11 w-full rounded-md border border-line bg-card px-3 text-sm text-ink"
        />
        <div
          className="flex flex-wrap gap-1.5"
          role="tablist"
          aria-label={t("subscription.builder.categories")}
        >
          <CatTab active={activeCat === "all"} onClick={() => setActiveCat("all")}>
            {t("subscription.builder.all")}
          </CatTab>
          {groups.map((g) => (
            <CatTab key={g.key} active={activeCat === g.key} onClick={() => setActiveCat(g.key)}>
              {g.label}
            </CatTab>
          ))}
        </div>
      </div>

      {/* The grouped add-on grid (two columns on wider screens — never one long column). */}
      <div className="flex flex-col gap-4">
        {visibleGroups.map((g) => (
          <section key={g.key}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              {g.label}
            </h4>
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {g.items.map((item) => {
                const n = qty[item.key] ?? 0;
                const selected = n > 0 && item.selectable;
                return (
                  <li
                    key={item.key}
                    id={`addon-${item.key}`}
                    className={`flex flex-col gap-2 rounded-md border p-3 transition-colors ${
                      selected ? "border-brand ring-1 ring-brand/40" : "border-line"
                    } ${highlightKey === item.key ? "ring-2 ring-brand" : ""}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-ink">{item.name}</p>
                      <p className="whitespace-nowrap text-sm text-ink">
                        <span dir="ltr" className="font-mono font-semibold">
                          {money(item.priceMonthlyMinor)}
                        </span>{" "}
                        <span className="text-xs text-ink-muted">/{t("subscription.per_mo")}</span>
                      </p>
                    </div>
                    <p className="text-xs leading-snug text-ink-muted">{item.description}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <IndicatorBadge item={item} />
                    </div>
                    {!item.selectable ? (
                      <p className="text-xs text-warning">
                        {item.note ?? t("subscription.builder.not_available")}
                      </p>
                    ) : item.bundleIncluded ? (
                      <p className="text-xs text-success">
                        {t("subscription.builder.included_bundle_note")}
                      </p>
                    ) : item.stackable ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-ink-muted">
                          {t("subscription.addon.quantity")}
                        </span>
                        <Button
                          variant="secondary"
                          aria-label={`${t("subscription.addon.decrease")} ${item.name}`}
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
                          aria-label={`${t("subscription.addon.increase")} ${item.name}`}
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
                        {n > 0 ? t("subscription.builder.selected") : t("subscription.builder.add")}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {visibleGroups.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-muted">
            {t("subscription.builder.no_results")}
          </p>
        ) : null}
      </div>

      {/* Sticky selection summary + live subtotal + submit (with optional review step). */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col gap-2 border-t border-line bg-card/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-ink-muted">
            {t("subscription.builder.selected_count", { count: selectedCount })}
          </span>
          <span className="text-sm text-ink">
            {t("subscription.builder.subtotal")}{" "}
            <span
              dir="ltr"
              className="font-mono text-lg font-bold text-ink"
              data-testid="custom-total"
            >
              {money(totalMinor)}
            </span>{" "}
            <span className="text-xs text-ink-muted">/{t("subscription.per_mo")}</span>
          </span>
        </div>
        <p className="text-xs text-ink-muted">{t("subscription.indicative_pricing")}</p>
        <p className="text-xs text-ink-muted">{t("subscription.tier.custom_note")}</p>

        {reviewBeforeSubmit && showReview ? (
          <ChangeReviewPanel review={review} money={money} t={t} />
        ) : null}

        {action ? (
          reviewBeforeSubmit ? (
            showReview ? (
              <form action={action} className="flex flex-wrap items-center gap-2">
                <HiddenAddons qty={qty} items={items} />
                <HiddenFields fields={hiddenFields} />
                <Button type="submit" disabled={review.isNoop}>
                  {submitLabel ?? t("subscription.builder.confirm")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setShowReview(false)}>
                  {t("subscription.builder.keep_editing")}
                </Button>
              </form>
            ) : (
              <Button
                type="button"
                onClick={() => setShowReview(true)}
                disabled={review.isNoop}
                className="self-start"
              >
                {t("subscription.builder.review_cta")}
              </Button>
            )
          ) : (
            <form action={action}>
              <HiddenAddons qty={qty} items={items} />
              <HiddenFields fields={hiddenFields} />
              <Button type="submit" className="self-start">
                {submitLabel ?? t("subscription.builder.confirm")}
              </Button>
            </form>
          )
        ) : null}
      </div>
    </Card>
  );
}

function CatTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`min-h-11 rounded-full px-3 text-xs font-medium transition-colors ${
        active
          ? "bg-brand text-ink-inverse"
          : "border border-line bg-card text-ink-muted hover:bg-sunken"
      }`}
    >
      {children}
    </button>
  );
}

function HiddenAddons({
  qty,
  items,
}: {
  qty: Record<string, number>;
  items: Map<string, CustomBuilderItem>;
}) {
  return (
    <>
      {Object.entries(qty).map(([key, n]) =>
        n > 0 && items.get(key)?.selectable && !items.get(key)?.bundleIncluded ? (
          <input key={key} type="hidden" name={`addon:${key}`} value={n} />
        ) : null,
      )}
    </>
  );
}

function HiddenFields({ fields }: { fields?: Record<string, string> }) {
  if (!fields) return null;
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

function ReviewLine({
  label,
  deltas,
}: {
  label: string;
  deltas: ReturnType<typeof buildChangeReview>["added"];
}) {
  if (deltas.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-semibold text-ink">{label}</p>
      <ul className="flex flex-col gap-0.5">
        {deltas.map((d) => (
          <li key={d.key} className="flex items-center justify-between text-xs text-ink-muted">
            <span>
              {d.name}
              {d.from > 0 || d.to > 1 ? ` (${d.from}→${d.to})` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangeReviewPanel({
  review,
  money,
  t,
}: {
  review: ReturnType<typeof buildChangeReview>;
  money: (m: number) => string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line bg-sunken p-3"
      role="region"
      aria-label={t("subscription.builder.review_title")}
    >
      <p className="text-sm font-semibold text-ink">{t("subscription.builder.review_title")}</p>
      <ReviewLine label={t("subscription.builder.review_added")} deltas={review.added} />
      <ReviewLine label={t("subscription.builder.review_increased")} deltas={review.increased} />
      <ReviewLine label={t("subscription.builder.review_removed")} deltas={review.removed} />
      <ReviewLine label={t("subscription.builder.review_decreased")} deltas={review.decreased} />
      <div className="flex items-center justify-between border-t border-line pt-2 text-sm">
        <span className="text-ink-muted">{t("subscription.builder.review_current")}</span>
        <span dir="ltr" className="font-mono">
          {money(review.currentTotalMinor)}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-ink-muted">{t("subscription.builder.review_new")}</span>
        <span dir="ltr" className="font-mono font-bold">
          {money(review.newTotalMinor)}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-ink-muted">{t("subscription.builder.review_diff")}</span>
        <span dir="ltr" className="font-mono">
          {review.diffMinor >= 0 ? "+" : "−"}
          {money(Math.abs(review.diffMinor))}
        </span>
      </div>
      {review.hasImmediate ? (
        <p className="text-xs text-ink-muted">{t("subscription.builder.review_immediate")}</p>
      ) : null}
      {review.hasScheduled ? (
        <p className="text-xs text-warning">{t("subscription.builder.review_scheduled")}</p>
      ) : null}
      <p className="text-xs text-ink-muted">{t("subscription.builder.review_no_delete")}</p>
      <p className="text-xs text-ink-muted">{t("subscription.monthly_total_note")}</p>
    </div>
  );
}
