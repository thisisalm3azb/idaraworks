/**
 * H27 — the pure maths behind the Revenue Studio, tested without a database:
 * line pricing in minor units, stage requirements, evidence-based health,
 * forecast overlays and summaries, ISO weeks and quarters, territory rules,
 * and the assistant's evidence validation.
 */
import { describe, expect, it } from "vitest";
import { computeLine } from "@/modules/crm/dealroom";
import { unmetRequirements } from "@/modules/crm/pipelines";
import { scoreHealth } from "@/modules/crm/customers";
import {
  applyOverlay,
  isoWeek,
  quarterOf,
  summarise,
  type ForecastRow,
} from "@/modules/crm/forecast";
import { matchTerritory } from "@/modules/crm/targets";
import { attribute } from "@/modules/crm/campaigns";
import { validateProposals } from "@/modules/crm/intelligence";

const row = (over: Partial<ForecastRow>): ForecastRow => ({
  id: over.id ?? "a",
  name: "Deal",
  customerName: null,
  ownerUserId: null,
  ownerName: null,
  territoryId: null,
  campaignId: null,
  source: null,
  kind: "new_business",
  stageKey: "qualified",
  category: "pipeline",
  valueMinor: 100_000,
  probability: 50,
  probabilitySource: "stage",
  weightedMinor: 50_000,
  expectedCloseDate: "2026-01-31",
  stageAgeDays: 3,
  createdAt: "2026-01-01",
  ...over,
});

describe("computeLine", () => {
  it("rounds in minor units at every step and never floats near money", () => {
    const l = computeLine({
      qty: 3,
      unitPriceMinor: 3333,
      discountPct: 10,
      vatRate: 5,
      unitCostMinor: 2000,
    });
    expect(l.lineNetMinor).toBe(8999); // 9999 × 0.9 = 8999.1 → 8999
    expect(l.lineVatMinor).toBe(450); // 8999 × 5% = 449.95 → 450
    expect(l.lineTotalMinor).toBe(9449);
    expect(l.marginMinor).toBe(2999);
    expect(
      computeLine({ qty: 1, unitPriceMinor: 100, discountPct: 0, vatRate: 0, unitCostMinor: null })
        .marginMinor,
    ).toBeNull();
  });
});

describe("unmetRequirements", () => {
  it("names exactly what a stage still needs", () => {
    const facts = {
      valueMinor: null,
      closeDate: "2026-02-01",
      customerId: "c",
      contactCount: 0,
      stakeholderCount: 1,
      nextAction: "  ",
      productCount: 0,
      quoteId: null,
      decisionCriteria: "price",
    };
    expect(
      unmetRequirements(
        [
          "value",
          "close_date",
          "customer",
          "contact",
          "stakeholder",
          "next_action",
          "product",
          "quote",
          "decision_criteria",
        ],
        facts,
      ),
    ).toEqual(["value", "contact", "next_action", "product", "quote"]);
    expect(unmetRequirements([], facts)).toEqual([]);
  });
});

describe("scoreHealth", () => {
  it("averages only known signals by weight and admits when nothing is known", () => {
    const unknown = scoreHealth([
      { key: "a", label: "A", weight: 3, value: null, evidence: "n/a" },
    ]);
    expect(unknown).toMatchObject({ score: null, band: "unknown", knownSignals: 0 });
    const mixed = scoreHealth([
      { key: "a", label: "A", weight: 3, value: 1, evidence: "good" },
      { key: "b", label: "B", weight: 1, value: -1, evidence: "bad" },
      { key: "c", label: "C", weight: 5, value: null, evidence: "unknown" },
    ]);
    // (3×1 + 1×−1) / 4 = 0.5 → (0.5 + 1) / 2 × 100 = 75 → healthy; the unknown signal never counts.
    expect(mixed.score).toBe(75);
    expect(mixed.band).toBe("healthy");
    expect(mixed.knownSignals).toBe(2);
    expect(scoreHealth([{ key: "a", label: "A", weight: 1, value: -1, evidence: "" }]).band).toBe(
      "at_risk",
    );
    expect(scoreHealth([{ key: "a", label: "A", weight: 1, value: 0, evidence: "" }]).band).toBe(
      "watch",
    );
  });
});

describe("forecast overlay and summary", () => {
  it("excludes, slips (clamped to month end), re-weights and re-categorises without touching the input", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", valueMinor: 200_000, weightedMinor: 100_000 }),
      row({ id: "c", category: "omitted" }),
    ];
    const out = applyOverlay(rows, {
      excludes: ["c"],
      slips: [{ opportunityId: "a", months: 1 }],
      probabilities: [{ opportunityId: "b", probability: 90 }],
      categories: [{ opportunityId: "b", category: "commit" }],
    });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]!.expectedCloseDate).toBe("2026-02-28"); // 31 Jan + 1 month clamps
    expect(out[1]!.probability).toBe(90);
    expect(out[1]!.weightedMinor).toBe(180_000);
    expect(out[1]!.category).toBe("commit");
    expect(rows[1]!.probability).toBe(50); // pure
    const s = summarise(out);
    expect(s).toMatchObject({
      count: 2,
      pipelineMinor: 300_000,
      weightedMinor: 230_000,
      commitMinor: 200_000,
    });
    expect(s.month.map((m) => m.key)).toEqual(["2026-01", "2026-02"]);
    expect(summarise(rows).count).toBe(2); // omitted rows never count
  });
  it("buckets ISO weeks and quarters deterministically", () => {
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(quarterOf("2026-05-15")).toBe("2026-Q2");
    expect(quarterOf("2026-12-31")).toBe("2026-Q4");
  });
});

describe("matchTerritory", () => {
  it("takes the first active territory whose rules match, countries before tags and segments", () => {
    const territories = [
      { id: "off", rules: { countries: ["AE"] }, active: false },
      { id: "north", rules: { countries: ["AE", "OM"] }, active: true },
      { id: "vip", rules: { tags: ["vip"] }, active: true },
      { id: "any", rules: {}, active: true },
    ];
    expect(matchTerritory(territories, { country: "AE", tags: [], segment: null })).toBe("north");
    expect(matchTerritory(territories, { country: "SA", tags: ["vip"], segment: null })).toBe(
      "vip",
    );
    expect(
      matchTerritory(territories.slice(0, 3), { country: "SA", tags: [], segment: null }),
    ).toBeNull();
  });
});

describe("validateProposals", () => {
  it("keeps only evidence that exists in the gathered context and marks the rest unverified", () => {
    const ctx = {
      subject: { kind: "customer" as const, id: "c1", name: "Co" },
      lines: [],
      refs: [
        {
          type: "activity" as const,
          id: "aaaaaaaa-1111-4111-8111-111111111111",
          label: "note: hello",
        },
      ],
    };
    const out = validateProposals(ctx, {
      summary: "s",
      proposals: [
        { kind: "action_item", title: "Do", evidence: ["aaaaaaaa", "deadbeef"] },
        { kind: "brief", title: "Invented", evidence: [] },
      ],
    });
    expect(out.proposals[0]!.evidence.map((e) => e.id)).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111",
    ]);
    expect(out.proposals[0]!.evidenceFound).toBe(true);
    expect(out.proposals[1]!.evidenceFound).toBe(false);
    expect(out.notice.length).toBeGreaterThan(0);
  });
});

describe("attribute", () => {
  const won = [
    {
      opportunityId: "o1",
      valueMinor: 90_000,
      touches: [
        { campaignId: "show", at: "2026-01-01T00:00:00Z" },
        { campaignId: "ads", at: "2026-01-05T00:00:00Z" },
        { campaignId: "referral", at: "2026-01-09T00:00:00Z" },
      ],
    },
    {
      opportunityId: "o2",
      valueMinor: 10_000,
      touches: [{ campaignId: "ads", at: "2026-02-01T00:00:00Z" }],
    },
  ];
  it("gives the whole value to the first or last touch, or splits it evenly, under the named model", () => {
    const first = attribute("first_touch", won);
    expect(first.get("show")).toEqual({ won: 1, minor: 90_000 });
    expect(first.get("ads")).toEqual({ won: 1, minor: 10_000 });
    const last = attribute("last_touch", won);
    expect(last.get("referral")).toEqual({ won: 1, minor: 90_000 });
    expect(last.get("show")).toBeUndefined();
    const linear = attribute("linear", won);
    expect(linear.get("show")!.minor).toBe(30_000);
    expect(linear.get("ads")!.minor).toBe(40_000);
    expect(linear.get("referral")!.minor).toBe(30_000);
    const total = [...linear.values()].reduce((s, v) => s + v.minor, 0);
    expect(total).toBe(100_000); // nothing invented, nothing lost
  });
});
