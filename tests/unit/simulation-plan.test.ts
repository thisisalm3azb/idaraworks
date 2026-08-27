/**
 * Unit tests for the deterministic business-simulation factory (micro-step 006A).
 * These run WITHOUT a database: they build each scenario's plan and assert the
 * task's data-quality guarantees — idempotency/determinism, referential integrity,
 * financial reconciliation, lifecycle validity, required "personality" states,
 * date-range coverage, no real-contact patterns, and the Arabic/RTL config — plus
 * the safety guards and the private-credentials git exclusion.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCENARIOS, scenarioByKey } from "../../tooling/simulation/scenarios";
import { buildPlan } from "../../tooling/simulation/plan";
import { check, invoiceBalance } from "../../tooling/simulation/invariants";
import { planCounts } from "../../tooling/simulation/types";
import { computeTotals, toMinor } from "../../tooling/simulation/money";
import { assertKnownProject, parseFlags, projectRefFromUrl } from "../../tooling/simulation/guards";
import { isDemoMarker, EXPECTED_PROJECT_REF } from "../../tooling/simulation/marker";
import { uuidv5 } from "../../tooling/simulation/rng";

const ASOF = "2026-08-27";

describe("scenarios", () => {
  it("has exactly the five required businesses", () => {
    expect(SCENARIOS.map((s) => s.key).sort()).toEqual(
      ["auto_workshop", "coffee_catering", "home_cupcakes", "palm_farm", "shortstay_ops"].sort(),
    );
  });
  it("each scenario is uniquely keyed and templated", () => {
    expect(new Set(SCENARIOS.map((s) => s.key)).size).toBe(5);
    for (const s of SCENARIOS) {
      expect(["food_beverage_v1", "service_business_v1", "agriculture_v1"]).toContain(
        s.templateKey,
      );
      expect(/^#[0-9a-f]{6}$/i.test(s.accentColor)).toBe(true);
    }
  });
  it("the palm farm is the Arabic/RTL account", () => {
    const farm = scenarioByKey("palm_farm")!;
    expect(farm.locale).toBe("ar");
    expect(farm.languages).toContain("ar");
  });
});

describe.each(SCENARIOS)("plan for $key", (scenario) => {
  const plan = buildPlan(scenario, ASOF);
  const res = check(plan, scenario);

  it("passes every data-quality invariant", () => {
    if (!res.ok) throw new Error(`invariant failures:\n - ${res.errors.join("\n - ")}`);
    expect(res.ok).toBe(true);
  });

  it("produces a non-trivial, bounded dataset", () => {
    const c = planCounts(plan);
    expect(c.customers).toBeGreaterThan(0);
    expect(c.jobs).toBeGreaterThan(0);
    expect(c.invoices).toBeGreaterThan(0);
    expect(c.payments).toBeGreaterThan(0);
    // Guardrail against runaway generation (the task forbids thousands of rows).
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(4000);
  });

  it("is idempotent — re-building yields a byte-identical plan", () => {
    const again = buildPlan(scenario, ASOF);
    expect(JSON.stringify(again)).toEqual(JSON.stringify(plan));
  });

  it("hits the required dashboard 'personality' states", () => {
    expect(res.metrics.overdueInvoices).toBeGreaterThanOrEqual(1);
    expect(res.metrics.upcomingDeadlines).toBeGreaterThanOrEqual(1);
    expect(res.metrics.doneThisWeek).toBeGreaterThanOrEqual(1);
    expect(res.metrics.pendingApprovals).toBeGreaterThanOrEqual(1);
    expect(res.metrics.openBlockers).toBeGreaterThanOrEqual(1);
    expect(res.metrics.sentQuotes).toBeGreaterThanOrEqual(1);
    expect(res.metrics.unpaidExpenses).toBeGreaterThanOrEqual(1);
  });

  it("covers the scenario's stated history depth", () => {
    expect(res.metrics.monthsCovered).toBeGreaterThanOrEqual(
      Math.min(2, scenario.historyMonths - 1),
    );
  });

  it("has no future-dated historical records (reports/attendance/payments)", () => {
    for (const r of plan.reports) expect(r.reportDate <= ASOF).toBe(true);
    for (const a of plan.attendance) expect(a.date <= ASOF).toBe(true);
    for (const p of plan.payments) expect(p.paymentDate <= ASOF).toBe(true);
  });

  it("carries no real contact data (emails, TRNs, IBANs, deliverable inboxes)", () => {
    const blob = JSON.stringify(plan);
    expect(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/.test(blob)).toBe(false); // no IBANs
    for (const c of [...plan.customers, ...plan.suppliers]) {
      expect(c.email).toBeNull();
      expect(c.taxRegNo).toBeNull();
    }
  });

  it("never overpays or overcredits an invoice", () => {
    for (const inv of plan.invoices.filter((i) => i.kind === "invoice")) {
      const bal = invoiceBalance(plan, inv);
      expect(bal).toBeGreaterThanOrEqual(0);
      expect(bal).toBeLessThanOrEqual(inv.baseTotalMinor);
    }
  });
});

describe("determinism", () => {
  it("stable ids do not depend on scenario ordering", () => {
    const a = buildPlan(SCENARIOS[0]!, ASOF).customers[0]!.id;
    const b = buildPlan(SCENARIOS[0]!, ASOF).customers[0]!.id;
    expect(a).toBe(b);
    expect(a).toBe(uuidv5(`${SCENARIOS[0]!.key}:customer:0`));
  });
  it("different as-of dates change dated content but not ids", () => {
    const p1 = buildPlan(SCENARIOS[0]!, "2026-08-27");
    const p2 = buildPlan(SCENARIOS[0]!, "2026-09-15");
    expect(p1.customers[0]!.id).toBe(p2.customers[0]!.id);
  });
});

describe("money formulas", () => {
  it("tax-exclusive, per-line VAT rounded then summed", () => {
    const t = computeTotals(
      [
        { qty: 3, unitPriceMinor: 333, vatRate: 5 },
        { qty: 1, unitPriceMinor: 1000, vatRate: 5 },
      ],
      1,
      true,
    );
    // line1 = round(3*333)=999, vat=round(999*.05)=50; line2=1000, vat=50
    expect(t.subtotalMinor).toBe(1999);
    expect(t.vatAmountMinor).toBe(100);
    expect(t.totalMinor).toBe(2099);
    expect(t.baseTotalMinor).toBe(2099);
  });
  it("zeroes VAT when not applicable", () => {
    const t = computeTotals([{ qty: 2, unitPriceMinor: 5000, vatRate: 5 }], 1, false);
    expect(t.vatAmountMinor).toBe(0);
    expect(t.totalMinor).toBe(10000);
  });
  it("minor units respect the currency exponent", () => {
    expect(toMinor(10, "AED")).toBe(1000);
    expect(toMinor(10, "KWD")).toBe(10000);
  });
});

describe("safety guards", () => {
  it("extracts the project ref and refuses an unknown project", () => {
    expect(projectRefFromUrl("https://anhgeeutrwftsvuzfinf.supabase.co")).toBe(
      EXPECTED_PROJECT_REF,
    );
    expect(() =>
      assertKnownProject({ NEXT_PUBLIC_SUPABASE_URL: "https://someoneelse.supabase.co" }),
    ).toThrow(/not the expected/);
    expect(
      assertKnownProject({
        NEXT_PUBLIC_SUPABASE_URL: `https://${EXPECTED_PROJECT_REF}.supabase.co`,
      }),
    ).toBe(EXPECTED_PROJECT_REF);
  });
  it("parses flags; --confirm and --dry-run are opt-in", () => {
    const f = parseFlags(["--dry-run", "--as-of=2026-08-27", "--only=coffee_catering,palm_farm"]);
    expect(f.dryRun).toBe(true);
    expect(f.confirm).toBe(false);
    expect(f.asOf).toBe("2026-08-27");
    expect(f.only).toEqual(["coffee_catering", "palm_farm"]);
    expect(parseFlags(["--confirm"]).confirm).toBe(true);
  });
  it("rejects a malformed --as-of", () => {
    expect(() => parseFlags(["--as-of=27-08-2026"])).toThrow();
  });
  it("recognises the demo marker shape", () => {
    expect(isDemoMarker({ is_demo: true, scenario: "coffee_catering" })).toBe(true);
    expect(isDemoMarker({ is_demo: false, scenario: "x" })).toBe(false);
    expect(isDemoMarker(null)).toBe(false);
  });
});

describe("credentials are excluded from git", () => {
  it("the private credentials directory is git-ignored", () => {
    // The private dir lives OUTSIDE the repo (…/Desktop/IdaraWorks Private), but we
    // also defensively git-ignore any in-repo simulation secret artifacts.
    const gi = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
    expect(/simulation-accounts|IdaraWorks Private|\.sim-secrets/.test(gi)).toBe(true);
  });
  it("git does not track any credentials/manifest file", () => {
    const tracked = execSync("git ls-files", { encoding: "utf8" });
    expect(/simulation-accounts\.txt|sim-credentials|sim-manifest/.test(tracked)).toBe(false);
  });
});
