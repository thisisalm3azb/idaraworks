/**
 * Microstep 001 — CommandCenterHero (Owner/Admin command-center hero).
 *
 * Mirrors the dashboard-render harness: SSR render without a DOM, no physical-
 * direction classes (Bible §9.11), decorative SVG hidden from AT, numbers
 * pinned LTR. Link-bearing props are omitted in render samples (next/link
 * needs the app-router context); destination correctness is covered by the
 * pure buildOwnerSignals contract instead.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CommandCenterHero,
  buildOwnerSignals,
  type HeroSignal,
} from "@/platform/ui/dashboard/CommandCenterHero";

const PHYSICAL =
  /\b(ml-|mr-|pl-|pr-|text-left|text-right|left-[\d[]|right-[\d[]|border-l-|border-r-|rounded-l|rounded-r|float-(left|right)|origin-(left|right))\b/;

const LONG_AR = "الموافقات التي تنتظر قرارك قبل مواصلة العمل في الورشة هذا الأسبوع";

/** Four real-shaped signals, hrefs omitted (router-free render). */
const SIGNALS: HeroSignal[] = [
  { key: "active_jobs", label: "Active jobs", value: "7", icon: "briefcase", tone: "neutral" },
  { key: "done_week", label: "Done this week", value: "3", icon: "check", tone: "success" },
  { key: "approvals_waiting", label: LONG_AR, value: "2", icon: "inbox", tone: "warning" },
  { key: "overdue_jobs", label: "Overdue", value: "1", icon: "alert", tone: "danger" },
];

function renderHero(): string {
  return renderToStaticMarkup(
    h(CommandCenterHero, {
      eyebrow: "Operations command center",
      heading: "Your operation, at a glance",
      asOf: "As of 2026-08-26",
      roleChip: "Owner",
      signals: SIGNALS,
    }),
  );
}

describe("CommandCenterHero", () => {
  const html = renderHero();

  it("renders all four provided signals — labels and values", () => {
    for (const s of SIGNALS) {
      expect(html).toContain(s.label);
      expect(html).toContain(`>${s.value}<`);
    }
  });

  it("renders exactly the provided values and no fabricated numbers or scores", () => {
    // Every numeric token in the VISIBLE text must come from the provided
    // signals — the component has no health/percentage/trend props and invents
    // nothing. (SVG attribute internals like gradient cx="50%" are not text.)
    const text = html.replace(/<[^>]*>/g, " ");
    const numbers = text.match(/\d+(?:\.\d+)?/g) ?? [];
    expect(new Set(numbers)).toEqual(
      new Set(["2026-08-26".match(/\d+/g)!.concat(SIGNALS.map((s) => s.value))].flat()),
    );
    expect(text).not.toContain("%");
  });

  it("hides the decorative visualization from assistive technology", () => {
    const svgs = [...html.matchAll(/<svg[^>]*>/g)].map((m) => m[0]);
    expect(svgs.length).toBeGreaterThan(0);
    for (const tag of svgs) {
      expect(tag, `svg missing aria-hidden: ${tag}`).toContain('aria-hidden="true"');
    }
  });

  it("pins signal values to LTR with tabular mono treatment", () => {
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("tabular-nums");
  });

  it("emits no physical-direction utility classes (RTL law)", () => {
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(PHYSICAL.test(classes), `leaked physical class: ${classes}`).toBe(false);
  });

  it("renders eyebrow, heading, as-of line and role chip verbatim", () => {
    expect(html).toContain("Operations command center");
    expect(html).toContain("Your operation, at a glance");
    expect(html).toContain("As of 2026-08-26");
    expect(html).toContain("Owner");
  });
});

describe("buildOwnerSignals (the four REAL signals, links + tones preserved)", () => {
  const labels = { active: "A", doneWeek: "B", approvals: "C", overdue: "D" };

  it("maps counts to the same destinations the old KPI row used", () => {
    const s = buildOwnerSignals({
      orgId: "org1",
      labels,
      counts: { active: 5, doneThisWeek: 2, approvalsPending: 1, overdue: 3 },
    });
    expect(s.map((x) => x.href)).toEqual([
      "/o/org1/jobs",
      "/o/org1/jobs",
      "/o/org1/approvals",
      "/o/org1/jobs?filter=overdue",
    ]);
    expect(s.map((x) => x.value)).toEqual(["5", "2", "1", "3"]);
  });

  it("keeps the old tone rules: success/warning/danger only when counts are non-zero", () => {
    const active = buildOwnerSignals({
      orgId: "o",
      labels,
      counts: { active: 1, doneThisWeek: 2, approvalsPending: 3, overdue: 4 },
    });
    expect(active.map((x) => x.tone)).toEqual(["neutral", "success", "warning", "danger"]);

    const quiet = buildOwnerSignals({
      orgId: "o",
      labels,
      counts: { active: 0, doneThisWeek: 0, approvalsPending: 0, overdue: 0 },
    });
    expect(quiet.map((x) => x.tone)).toEqual(["neutral", "neutral", "neutral", "neutral"]);
  });

  it("produces exactly four signals — nothing invented, nothing dropped", () => {
    const s = buildOwnerSignals({
      orgId: "o",
      labels,
      counts: { active: 0, doneThisWeek: 0, approvalsPending: 0, overdue: 0 },
    });
    expect(s).toHaveLength(4);
    expect(s.map((x) => x.key)).toEqual([
      "active_jobs",
      "done_week",
      "approvals_waiting",
      "overdue_jobs",
    ]);
  });
});
