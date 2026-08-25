/**
 * Microstep 002B — Owner Home presentational components (SSR + RTL-safety,
 * mirrors the dashboard-render harness). Link-bearing props are omitted where
 * next/link would need the router; destination correctness is covered by the
 * composer contract tests instead.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AttentionZone,
  BusinessBrief,
  CapabilitiesRow,
  NextBestActions,
  SetupProgress,
} from "@/platform/ui/dashboard/OwnerHome";

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l|rounded-r|float-(left|right)|origin-(left|right))\b/;

const LONG_AR = "الموافقات التي تنتظر قرارك قبل مواصلة العمل في الورشة هذا الأسبوع بكامل تفاصيلها";

const samples: Array<[string, string]> = [
  [
    "businessBrief",
    renderToStaticMarkup(
      h(BusinessBrief, {
        orgName: "مخبز روان للحلويات",
        logo: null,
        dateLine: "26/08/2026",
        sentence: LONG_AR,
        chips: [
          { key: "a", label: LONG_AR, tone: "warning" },
          { key: "b", label: "3 completed", tone: "success" },
        ],
      }),
    ),
  ],
  [
    "nextBestActions",
    renderToStaticMarkup(
      h(NextBestActions, {
        title: "Next best actions",
        actions: [
          // href omitted is not allowed by the type — use realistic hrefs; the
          // harness renders links only when the router is unnecessary… Next's
          // <Link> renders fine in static markup for plain hrefs.
          {
            key: "a",
            title: LONG_AR,
            reason: LONG_AR,
            href: "/o/x/approvals",
            icon: "inbox",
            urgency: "decide",
          },
          {
            key: "b",
            title: "Review overdue work",
            href: "/o/x/jobs?filter=overdue",
            icon: "alert",
            urgency: "overdue",
          },
          { key: "c", title: "Create", href: "/o/x/jobs", icon: "briefcase", urgency: "create" },
        ],
      }),
    ),
  ],
  [
    "attentionZone",
    renderToStaticMarkup(
      h(AttentionZone, {
        title: "Needs attention",
        rows: [
          {
            key: "r1",
            label: LONG_AR,
            severity: "critical",
            severityLabel: "حرج",
            href: "/o/x/jobs/1",
          },
          {
            key: "r2",
            label: "Approvals waiting",
            severity: "info",
            severityLabel: "Info",
            href: "/o/x/approvals",
          },
        ],
        viewAllLabel: "View all",
        viewAllHref: "/o/x/week",
      }),
    ),
  ],
  [
    "setupProgress",
    renderToStaticMarkup(
      h(SetupProgress, {
        title: "Workspace setup",
        steps: [
          { key: "s1", label: "Workspace created", done: true },
          {
            key: "s2",
            label: LONG_AR,
            done: false,
            href: "/o/x/settings/branding",
            unlocks: LONG_AR,
          },
          { key: "s3", label: "Invite a teammate", done: false },
        ],
        diagram: { from: "طلب", mid: "تقارير", to: "مكتمل", caption: "كيف يسير العمل" },
      }),
    ),
  ],
  [
    "capabilitiesRow",
    renderToStaticMarkup(
      h(CapabilitiesRow, {
        label: "5 capabilities active",
        manageLabel: "Manage",
        manageHref: "/o/x/settings/subscription",
      }),
    ),
  ],
];

describe("Owner Home components render and stay RTL-safe", () => {
  for (const [name, html] of samples) {
    it(`${name} renders without physical-direction classes`, () => {
      expect(html.length).toBeGreaterThan(0);
      const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
      expect(PHYSICAL.test(classes), `${name} leaked a physical class: ${classes}`).toBe(false);
    });
  }

  it("AttentionZone and NextBestActions render nothing when empty (zones earn their place)", () => {
    expect(
      renderToStaticMarkup(
        h(AttentionZone, { title: "t", rows: [], viewAllLabel: "v", viewAllHref: "/x" }),
      ),
    ).toBe("");
    expect(renderToStaticMarkup(h(NextBestActions, { title: "t", actions: [] }))).toBe("");
  });

  it("decorative SVG (teaching diagram) is hidden from assistive technology", () => {
    const setup = samples.find(([n]) => n === "setupProgress")![1];
    const svgs = [...setup.matchAll(/<svg[^>]*>/g)].map((m) => m[0]);
    expect(svgs.length).toBeGreaterThan(0);
    for (const tag of svgs) expect(tag).toContain('aria-hidden="true"');
    // …while the caption reaches AT as text.
    expect(setup).toContain("كيف يسير العمل");
  });

  it("no component fabricates numbers, percentages or health words", () => {
    for (const [name, html] of samples) {
      const text = html.replace(/<[^>]*>/g, " ");
      expect(text, name).not.toMatch(/\d+\s*%/);
      expect(text.toLowerCase(), name).not.toMatch(/healthy|all calm|under control/);
    }
  });

  it("setup steps show done/next states without any aggregate count", () => {
    const setup = samples.find(([n]) => n === "setupProgress")![1];
    const text = setup.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/\d+\s*(of|\/|من)\s*\d+/);
  });

  it("action links keep their given destinations", () => {
    const actions = samples.find(([n]) => n === "nextBestActions")![1];
    expect(actions).toContain('href="/o/x/approvals"');
    expect(actions).toContain('href="/o/x/jobs?filter=overdue"');
  });
});
