/**
 * U5 dashboard components — SSR smoke + RTL-safety (mirrors rtl-primitives):
 * every new presentational component must render without a DOM and emit no
 * physical-direction utility classes (logical properties law, Bible §9.11).
 * Link-bearing props are omitted (next/link needs the app-router context).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KpiCard } from "@/platform/ui/dashboard/KpiCard";
import { TrendChart } from "@/platform/ui/dashboard/TrendChart";
import { StatusDonut } from "@/platform/ui/dashboard/StatusDonut";
import { DistributionBar } from "@/platform/ui/dashboard/ProgressCard";
import { ActivityTimeline, LockedCard, RowList, Skeleton } from "@/platform/ui/dashboard/cards";
import { WelcomeBanner } from "@/platform/ui/dashboard/WelcomeBanner";
import { Icon, ICON_NAMES } from "@/platform/ui/icons";

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l|rounded-r|float-(left|right)|origin-(left|right))\b/;

const LONG_AR = "مرحلة التجميع النهائي للهيكل قبل التسليم — مراجعة الجودة والطلاء";

const samples: Array<[string, string]> = [
  [
    "kpiCard",
    renderToStaticMarkup(
      h(KpiCard, {
        label: LONG_AR,
        value: "42",
        icon: "briefcase",
        delta: { direction: "up", label: "+3" },
        sub: LONG_AR,
        tone: "warning",
      }),
    ),
  ],
  [
    "trendChart",
    renderToStaticMarkup(
      h(TrendChart, {
        points: [
          { label: "07-01", value: 2 },
          { label: "07-02", value: 5 },
          { label: "07-03", value: 0 },
        ],
        title: LONG_AR,
        kind: "line",
      }),
    ),
  ],
  [
    "statusDonut",
    renderToStaticMarkup(
      h(StatusDonut, {
        data: [
          { key: "a", label: LONG_AR, value: 3 },
          { key: "b", label: "B", value: 1 },
        ],
        title: LONG_AR,
        centerLabel: "4",
      }),
    ),
  ],
  [
    "distributionBar",
    renderToStaticMarkup(
      h(DistributionBar, {
        data: [
          { key: "a", label: LONG_AR, value: 3 },
          { key: "b", label: "B", value: 2 },
        ],
        title: LONG_AR,
      }),
    ),
  ],
  [
    "activityTimeline",
    renderToStaticMarkup(
      h(ActivityTimeline, {
        entries: [{ key: "1", summary: LONG_AR, when: "2026-07-15", actor: "A" }],
        emptyLabel: "-",
      }),
    ),
  ],
  [
    "rowList",
    renderToStaticMarkup(
      h(RowList, {
        rows: [
          { key: "1", title: LONG_AR, meta: "12", metaLtr: true },
          { key: "2", title: "x", badge: { label: LONG_AR, tone: "danger" } },
        ],
        emptyLabel: "-",
      }),
    ),
  ],
  ["lockedCard", renderToStaticMarkup(h(LockedCard, { title: LONG_AR, description: LONG_AR }))],
  ["skeleton", renderToStaticMarkup(h(Skeleton, { className: "h-24" }))],
  [
    "welcomeBanner",
    renderToStaticMarkup(
      h(WelcomeBanner, { title: LONG_AR, body: LONG_AR, dismissLabel: "x", links: [] }),
    ),
  ],
];

describe("U5 dashboard components render and stay RTL-safe", () => {
  for (const [name, html] of samples) {
    it(`${name} renders without physical-direction classes`, () => {
      expect(html.length).toBeGreaterThan(0);
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), `${name} leaked a physical class: ${classes}`).toBe(false);
    });
  }

  it("charts pin their plot to LTR (a time axis is a number line)", () => {
    const chart = samples.find(([n]) => n === "trendChart")![1];
    expect(chart).toContain('dir="ltr"');
  });

  it("every icon name renders one svg with currentColor stroke", () => {
    for (const name of ICON_NAMES) {
      const svg = renderToStaticMarkup(h(Icon, { name }));
      expect(svg).toContain("<svg");
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('aria-hidden="true"');
    }
  });
});
