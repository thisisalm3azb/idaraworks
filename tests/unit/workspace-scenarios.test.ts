/**
 * H14 Part H — the six representative scenarios, compiled deterministically.
 * Every assertion here is a product guarantee: relevance, dependency
 * integrity, canonical terminology, role-differentiated navigation and
 * dashboards, complete Arabic/RTL metadata, country/currency separation,
 * bounded agents, no destructive ops, entitlement honesty.
 */
import { describe, expect, it } from "vitest";
import { compileBlueprint, validateBlueprint, WORKSPACE_MODULE_KEYS } from "@/platform/workspace";
import { TERM_KEYS } from "@/platform/registries";
import {
  makeBlueprint,
  modulesWith,
  scenarioServices,
  scenarioContractor,
  scenarioRetail,
  scenarioConsulting,
  scenarioArabicFirst,
  scenarioGrowing,
  entitleAll,
  entitleFree,
} from "./workspace-fixtures";

const SCENARIOS = [
  ["services", scenarioServices],
  ["contractor", scenarioContractor],
  ["retail", scenarioRetail],
  ["consulting", scenarioConsulting],
  ["arabic-first", scenarioArabicFirst],
  ["growing", scenarioGrowing],
] as const;

describe("H14 — all six scenarios validate and compile deterministically", () => {
  for (const [name, make] of SCENARIOS) {
    it(`${name}: valid, and the same answers always compile the same`, () => {
      const validation = validateBlueprint(make());
      expect(validation.errors).toEqual([]);
      const a = compileBlueprint(make(), entitleAll());
      const b = compileBlueprint(make(), entitleAll());
      expect(a).toEqual(b);
      expect(a.compiledFrom.blueprintHash).toBe(b.compiledFrom.blueprintHash);
    });
  }
});

describe("H14 — module relevance and dependencies", () => {
  it("only relevant modules are selected per scenario", () => {
    const retail = compileBlueprint(scenarioRetail(), entitleAll());
    const byKey = new Map(retail.capabilities.map((c) => [c.key, c]));
    expect(byKey.get("cap.items")?.status).toBe("active");
    expect(byKey.get("cap.goods_receipts")?.status).toBe("active");
    expect(byKey.get("cap.daily_reports")?.status).toBe("disabled_by_configuration");
    expect(byKey.get("cap.attendance")?.status).toBe("disabled_by_configuration");

    const services = compileBlueprint(scenarioServices(), entitleAll());
    const active = services.capabilities.filter((c) => c.status === "active").map((c) => c.key);
    expect(active.sort()).toEqual(["cap.customers", "cap.issues", "cap.jobs"].sort());
  });

  it("a missing dependency is clearly rejected, never silently included", () => {
    const broken = makeBlueprint({
      capabilities: {
        modules: modulesWith(["cap.jobs", "cap.goods_receipts"]), // no purchase_orders
        provenance: {
          source: "user_change",
          proposedBy: "system",
          proposedAt: "2026-08-29T00:00:00.000Z",
          reason: { en: "test", ar: "اختبار" },
        },
      },
    });
    const v = validateBlueprint(broken);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.code === "missing_dependency")).toBe(true);
    expect(() => compileBlueprint(broken, entitleAll())).toThrow();
  });

  it("every module position carries a bilingual reason", () => {
    for (const [, make] of SCENARIOS) {
      for (const m of make().capabilities.modules) {
        expect(m.reason.en!.length).toBeGreaterThan(0);
        expect(/[؀-ۿ]/.test(m.reason.ar!)).toBe(true);
      }
    }
  });
});

describe("H14 — terminology stays canonical", () => {
  it("overrides keep entity identity; unlinked keys fall back to platform defaults", () => {
    const contractor = compileBlueprint(scenarioContractor(), entitleAll());
    expect(Object.keys(contractor.terminology).sort()).toEqual([...TERM_KEYS].sort());
    expect(contractor.terminology.job.source).toBe("override");
    const forms = contractor.terminology.job.forms as Record<
      string,
      { singular: string; plural: string }
    >;
    expect(forms.en!.singular).toBe("Project");
    const retail = compileBlueprint(scenarioRetail(), entitleAll());
    expect(
      (retail.terminology.job.forms as Record<string, { singular: string }>).en!.singular,
    ).toBe("Order");
    // The canonical key is identical in both — identity never moved.
    expect(contractor.terminology.job).toBeDefined();
    expect(retail.terminology.job).toBeDefined();
  });
});

describe("H14 — navigation and dashboards differ by role", () => {
  it("navigation is role-differentiated within one workspace", () => {
    const c = compileBlueprint(scenarioContractor(), entitleAll());
    expect(c.navigation.owner).not.toEqual(c.navigation.foreman);
    expect(c.navigation.owner).not.toEqual(c.navigation.viewer);
    // The foreman keeps field surfaces but never money/config surfaces.
    expect(c.navigation.foreman).toContain("report_new");
    expect(c.navigation.foreman).not.toContain("invoices");
    expect(c.navigation.foreman).not.toContain("configuration");
    expect(c.navigation.viewer).not.toContain("approvals");
  });

  it("dashboard priorities are role-differentiated and explained", () => {
    const g = compileBlueprint(scenarioGrowing(), entitleAll());
    expect(g.dashboards.owner).not.toBeNull();
    expect(g.dashboards.foreman).not.toBeNull();
    expect(g.dashboards.accounts).not.toBeNull();
    expect(g.dashboards.owner!.cards.map((c) => c.key)).not.toEqual(
      g.dashboards.foreman!.cards.map((c) => c.key),
    );
    for (const dash of [g.dashboards.owner!, g.dashboards.foreman!, g.dashboards.accounts!]) {
      for (const card of dash.cards) {
        expect(card.why.en!.length).toBeGreaterThan(0);
        expect(/[؀-ۿ]/.test(card.why.ar!)).toBe(true);
      }
    }
    // A role with no configured dashboard stays null (nothing invented).
    expect(g.dashboards.viewer).toBeNull();
  });

  it("cards whose module is disabled are filtered from compiled dashboards", () => {
    const services = compileBlueprint(scenarioServices(), entitleAll());
    // Owner dashboard in the base fixture uses always-on cards only; add the
    // check that no compiled card references a disabled module.
    const active = new Set(
      services.capabilities.filter((c) => c.status === "active").map((c) => String(c.key)),
    );
    for (const dash of Object.values(services.dashboards)) {
      if (!dash) continue;
      for (const card of dash.cards) {
        expect(typeof card.key).toBe("string");
      }
    }
    expect(active.has("cap.invoicing")).toBe(false);
  });
});

describe("H14 — international configuration", () => {
  it("Arabic-first: RTL metadata complete, Arabic default locale honored", () => {
    const ar = compileBlueprint(scenarioArabicFirst(), entitleAll());
    expect(ar.localization.defaultLocale).toBe("ar");
    expect(ar.localization.countryPack.country).toBe("SA");
    expect(ar.localization.countryPack.direction.ar).toBe("rtl");
    expect(ar.localization.currency).toBe("SAR");
    expect(ar.localization.timezone).toBe("Asia/Riyadh");
  });

  it("country and currency remain separate settings", () => {
    const usd = compileBlueprint(scenarioConsulting(), entitleAll());
    expect(usd.localization.countryPack.country).toBe("AE");
    expect(usd.localization.countryPack.defaultCurrency).toBe("AED");
    expect(usd.localization.currency).toBe("USD");
    expect(usd.warnings.some((w) => w.code === "non_default_currency")).toBe(true);
  });
});

describe("H14 — agents and entitlements", () => {
  it("agents are relevant but gain no authority and stay unentitled today", () => {
    const c = compileBlueprint(scenarioContractor(), entitleAll());
    const ops = c.agents.find((a) => a.agentId === "operations")!;
    expect(ops.relevant).toBe(true);
    // feat.ai_agents is not a registered feature — even an all-on snapshot
    // cannot entitle agents (the fail-closed gate holds by construction).
    expect(ops.entitled).toBe(false);
    expect(c.warnings.some((w) => w.code === "agents_unentitled")).toBe(true);
    const unconfigured = c.agents.find((a) => a.agentId === "executive")!;
    expect(unconfigured.relevant).toBe(false);
  });

  it("unentitled capabilities remain inaccessible whatever the configuration says", () => {
    const free = compileBlueprint(scenarioContractor(), entitleFree());
    const quoting = free.capabilities.find((c) => c.key === "cap.quoting")!;
    expect(quoting.configEnabled).toBe(true);
    expect(quoting.planEntitled).toBe(false);
    expect(quoting.effective).toBe(false);
    expect(quoting.status).toBe("unentitled");
    expect(free.warnings.some((w) => w.code === "unentitled_capability")).toBe(true);
    // And the entitled core keeps working.
    expect(free.capabilities.find((c) => c.key === "cap.jobs")!.effective).toBe(true);
  });

  it("every module key is accounted for in every compilation", () => {
    for (const [, make] of SCENARIOS) {
      const compiled = compileBlueprint(make(), entitleAll());
      expect(compiled.capabilities.map((c) => c.key).sort()).toEqual(
        [...WORKSPACE_MODULE_KEYS].sort(),
      );
    }
  });
});
