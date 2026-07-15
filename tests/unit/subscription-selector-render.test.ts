/**
 * PART D (render, DOM-free) — the redesigned four-path selector, asserted by
 * rendering to static markup (no jsdom needed; the components have no DOM-only
 * deps; createElement avoids a .tsx the vitest glob would skip). Proves: all four
 * options render as EQUAL cards; the desktop grid is 4-up (xl:grid-cols-4) and
 * mobile-stacked (grid-cols-1); price and its "/mo" label are separate tokens (no
 * overlap); NO tier is silently preselected; the Custom card opens the builder
 * IN-PAGE (initialPanel="custom" swaps the grid for search + steppers with a
 * back-to-comparison action) — no navigation; and it renders in EN and AR.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubscriptionSelector } from "@/platform/ui/subscription/SubscriptionSelector";
import { buildSelectionView } from "@/modules/subscription/selection";

const view = buildSelectionView();
const noop = async () => {};

function render(overrides: Partial<Parameters<typeof SubscriptionSelector>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SubscriptionSelector, {
      view,
      locale: "en",
      currency: "USD",
      jobsNoun: "jobs",
      current: null,
      canManage: true,
      providerEnabled: false,
      selectTierAction: noop,
      selectFreeAction: noop,
      customAction: noop,
      ...overrides,
    }),
  );
}

describe("compare view — all four options, no scroll, no preselect", () => {
  const html = render();

  it("renders all four choices (Free / Medium / High / Custom)", () => {
    expect(html).toContain("Free");
    expect(html).toContain("Medium");
    expect(html).toContain("High");
    expect(html).toContain("Custom");
  });

  it("uses a 4-up desktop grid + stacked mobile grid (the no-scroll layout law)", () => {
    expect(html).toContain("xl:grid-cols-4");
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("md:grid-cols-2");
    expect(html).toContain('data-testid="tier-grid"');
  });

  it("marks Medium 'Recommended' and High 'Most complete'", () => {
    expect(html).toContain("Recommended");
    expect(html).toContain("Most complete");
  });

  it("shows the price and a SEPARATE non-wrapping /mo label, next to the true member total", () => {
    expect(html).toContain("$15.00");
    expect(html).toContain("$39.00");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("$28.00");
    expect(html).toContain("$75.00");
  });

  it("does NOT silently preselect any tier (no 'Current' badge when current=null)", () => {
    expect(html).not.toContain(">Current<");
    expect(html).not.toContain("ring-2 ring-brand");
  });

  it("marks the current path when one is set (display mapping only)", () => {
    expect(render({ current: "medium" })).toContain("Current");
  });

  it("renders the no-payment honesty line when the provider is disabled (D1)", () => {
    expect(html).toContain("No payment is collected now");
  });
});

describe("custom builder — opens IN-PAGE (no navigation)", () => {
  const html = render({ initialPanel: "custom" });

  it("shows the builder (search + back), not the tier grid", () => {
    expect(html).toContain("Search add-ons");
    expect(html).toContain("Back to comparison");
    expect(html).not.toContain('data-testid="tier-grid"');
  });

  it("has quantity steppers with screen-reader labels on stackable packs", () => {
    expect(html).toMatch(/Increase [^"]*members/i);
    expect(html).toContain("Monthly subtotal");
  });

  it("shows honest indicators for credential-gated add-ons (visible, not selectable)", () => {
    expect(html).toContain("Needs activation");
  });

  it("marks bundle-included add-ons as included (no double charge) when passed", () => {
    const withBundle = render({
      initialPanel: "custom",
      bundleIncludedKeys: ["addon.quotes_invoices"],
    });
    expect(withBundle).toContain("Included in your bundle");
  });
});

describe("AR / RTL", () => {
  const html = render({ locale: "ar" });
  it("renders Arabic tier names and keeps money latin (dir=ltr isolates numbers)", () => {
    expect(html).toContain("المتوسطة"); // Medium
    expect(html).toContain("العليا"); // High
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("15.00"); // latin numerals preserved under ar (F-44)
  });
});
