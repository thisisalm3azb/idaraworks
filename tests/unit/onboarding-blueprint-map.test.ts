/**
 * H15 — answers → H14 blueprint mapping (Part F/G): module recommendations
 * with reasons, dependency closure in both directions, role and agent
 * derivation without authority, review edits (including cascades), country
 * and currency separation, and the hard guarantee that every mapped
 * blueprint passes the H14 validator and compiles.
 */
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import { DraftDataSchema, type DraftAnswers, type DraftData } from "@/modules/onboarding/flow";
import {
  buildBlueprintFromDraft,
  recommendModules,
  applyModuleEdits,
  recommendRoles,
  recommendAgents,
  modulesForDraft,
  moduleSlug,
  moduleFromSlug,
  CORE_MODULES,
  BlueprintMapError,
} from "@/modules/onboarding/blueprint-map";
import { validateBlueprint, compileBlueprint, WORKSPACE_MODULE_KEYS } from "@/platform/workspace";
import { AGENT_IDS, AGENT_TOOL_ALLOW } from "@/platform/agents/registry";
import { FEATURE_KEYS } from "@/platform/entitlements";

const NOW = "2026-08-29T12:00:00.000Z";
const entitleAll = () => ({
  entitlements: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])),
});

const contractorAnswers: DraftAnswers = {
  business_name: "Desert Build",
  industry: "construction",
  country: "AE",
  timezone: "Asia/Dubai",
  base_currency: "AED",
  preferred_language: "en",
  employees_band: "21-50",
  users_band: "11-25",
  locations_band: "2-3",
  departments: ["operations", "field_teams", "purchasing"],
  work_patterns: ["project"],
  customer_types: ["businesses", "government"],
  customer_sharing: true,
  revenue_models: ["milestone_billing"],
  buys_materials: "yes",
  holds_stock: "yes",
  receives_deliveries: "yes",
  sends_quotes: "yes",
  sends_invoices: "yes",
  collects_payments: "yes",
  records_expenses: "yes",
  tracks_costs: "yes",
  vat_registered_q: "yes",
  priority_focus: "delivery",
  device: "both",
};

const soloConsultingAnswers: DraftAnswers = {
  business_name: "Clarity Advisory",
  industry: "other",
  country: "SA",
  timezone: "Asia/Riyadh",
  base_currency: "SAR",
  preferred_language: "ar",
  employees_band: "1-5",
  locations_band: "1",
  work_patterns: ["service", "recurring"],
  customer_types: ["businesses"],
  customer_sharing: false,
  sends_quotes: "yes",
  sends_invoices: "yes",
  collects_payments: "no",
  records_expenses: "no",
  tracks_costs: "no",
  vat_registered_q: "not_sure",
  priority_focus: "collections",
  device: "desktop",
};

function draftOf(answers: DraftAnswers, extra: Partial<DraftData> = {}): DraftData {
  return DraftDataSchema.parse({
    answers,
    template: { selected_key: "generic_operations_v1" },
    ...extra,
  });
}

describe("H15 — module recommendation and dependencies", () => {
  it("recommends from the answers with a reason on every position", () => {
    const rec = recommendModules(contractorAnswers);
    expect(rec.map((m) => m.key).sort()).toEqual([...WORKSPACE_MODULE_KEYS].sort());
    const byKey = new Map(rec.map((m) => [m.key, m]));
    expect(byKey.get("cap.material_requests")?.enabled).toBe(true);
    expect(byKey.get("cap.goods_receipts")?.enabled).toBe(true);
    expect(byKey.get("cap.items")?.enabled).toBe(true);
    expect(byKey.get("cap.daily_reports")?.enabled).toBe(true);
    expect(byKey.get("cap.attendance")?.enabled).toBe(true);
    for (const m of rec) {
      expect(m.reasonKey.length).toBeGreaterThan(0);
      expect(
        `onboarding.flow.reason.${m.reasonKey}` in en,
        `reason copy missing for ${m.reasonKey}`,
      ).toBe(true);
    }
  });

  it("a solo consulting business gets a lean workspace", () => {
    const byKey = new Map(recommendModules(soloConsultingAnswers).map((m) => [m.key, m]));
    expect(byKey.get("cap.material_requests")?.enabled).toBe(false);
    expect(byKey.get("cap.items")?.enabled).toBe(false);
    expect(byKey.get("cap.daily_reports")?.enabled).toBe(false);
    expect(byKey.get("cap.attendance")?.enabled).toBe(false);
    expect(byKey.get("cap.quoting")?.enabled).toBe(true);
    expect(byKey.get("cap.invoicing")?.enabled).toBe(true);
    expect(byKey.get("cap.payments")?.enabled).toBe(false);
  });

  it("review edits cascade dependencies with the consequence recorded", () => {
    // Founder disables purchase orders: goods receipts must follow, explained.
    const edited = applyModuleEdits(recommendModules(contractorAnswers), {
      modules_off: ["purchase_orders"],
    });
    const byKey = new Map(edited.map((m) => [m.key, m]));
    expect(byKey.get("cap.purchase_orders")?.enabled).toBe(false);
    expect(byKey.get("cap.goods_receipts")?.enabled).toBe(false);
    expect(byKey.get("cap.goods_receipts")?.reasonKey).toBe("dependency_disabled");
    expect(byKey.get("cap.goods_receipts")?.cascadedFrom).toBe("cap.purchase_orders");
    // Founder enables costing on the consulting shape: its requirement comes along.
    const enabledUp = applyModuleEdits(recommendModules(soloConsultingAnswers), {
      modules_on: ["payments"],
    });
    const up = new Map(enabledUp.map((m) => [m.key, m]));
    expect(up.get("cap.payments")?.enabled).toBe(true);
    expect(up.get("cap.invoicing")?.enabled).toBe(true); // already on; still valid
  });

  it("core modules cannot be disabled by edits", () => {
    const edited = applyModuleEdits(recommendModules(soloConsultingAnswers), {
      modules_off: CORE_MODULES.map(moduleSlug),
    });
    for (const key of CORE_MODULES) {
      expect(edited.find((m) => m.key === key)?.enabled).toBe(true);
    }
  });

  it("module slugs round-trip and unknown slugs are rejected", () => {
    for (const key of WORKSPACE_MODULE_KEYS) {
      expect(moduleFromSlug(moduleSlug(key))).toBe(key);
    }
    expect(moduleFromSlug("blockchain")).toBeNull();
  });
});

describe("H15 — roles and agents without authority", () => {
  it("derives roles from team size and enabled areas", () => {
    const modules = modulesForDraft(draftOf(contractorAnswers));
    const roles = recommendRoles(contractorAnswers, modules).map((r) => r.archetype);
    expect(roles).toContain("owner");
    expect(roles).toContain("manager");
    expect(roles).toContain("foreman");
    expect(roles).toContain("procurement");
    expect(roles).toContain("accounts");
    // Solo: just the owner.
    const soloModules = modulesForDraft(draftOf(soloConsultingAnswers));
    expect(recommendRoles(soloConsultingAnswers, soloModules).map((r) => r.archetype)).toEqual([
      "owner",
    ]);
  });

  it("agents are canonical, module-bound and opt-out-able; never an authority grant", () => {
    const draft = draftOf(contractorAnswers);
    const modules = modulesForDraft(draft);
    const roles = recommendRoles(contractorAnswers, modules);
    const agents = recommendAgents(contractorAnswers, modules, roles, {});
    for (const a of agents) {
      expect(AGENT_IDS as readonly string[]).toContain(a.agentId);
    }
    expect(agents.map((a) => a.agentId)).toContain("inventory_purchasing");
    // Opt-out removes without touching anything else.
    const without = recommendAgents(contractorAnswers, modules, roles, {
      agents_off: ["inventory_purchasing"],
    });
    expect(without.map((a) => a.agentId)).not.toContain("inventory_purchasing");
    // The blueprint carries no authority: read domains stay within allow-lists
    // (empty = narrow-at-compile), classifications are read_explain only.
    const bp = buildBlueprintFromDraft(draft, NOW);
    for (const a of bp.agents) {
      expect(a.classifications).toEqual(["read_explain"]);
      expect(a.entitlement).toBe("feat.ai_agents");
      for (const d of a.readDomains) {
        expect(AGENT_TOOL_ALLOW[a.agentId] as readonly string[]).toContain(d);
      }
    }
  });
});

describe("H15 — the mapped blueprint is H14-valid", () => {
  it("both representative shapes validate and compile", () => {
    for (const answers of [contractorAnswers, soloConsultingAnswers]) {
      const bp = buildBlueprintFromDraft(draftOf(answers), NOW);
      const v = validateBlueprint(bp);
      expect(v.errors).toEqual([]);
      const compiled = compileBlueprint(bp, entitleAll());
      expect(compiled.compilerVersion).toBe("1.0.0");
    }
  });

  it("country, currency and locale remain separate decisions", () => {
    const usd = buildBlueprintFromDraft(
      draftOf({ ...contractorAnswers, base_currency: "USD" }),
      NOW,
    );
    expect(usd.international.countryPack).toBe("AE");
    expect(usd.international.currency).toBe("USD");
    const arFirst = buildBlueprintFromDraft(draftOf(soloConsultingAnswers), NOW);
    expect(arFirst.international.countryPack).toBe("SA");
    expect(arFirst.international.defaultLocale).toBe("ar");
    expect(arFirst.international.currency).toBe("SAR");
  });

  it("vat 'not sure' resolves to the safe default (not registered)", () => {
    const bp = buildBlueprintFromDraft(draftOf(soloConsultingAnswers), NOW);
    expect(bp.international.vatRegistered).toBe(false);
    expect(bp.international.taxIdentityFields).toEqual([]);
    const vat = buildBlueprintFromDraft(draftOf(contractorAnswers), NOW);
    expect(vat.international.vatRegistered).toBe(true);
    expect(vat.international.taxIdentityFields).toEqual(["tax_registration_number"]);
  });

  it("terminology overrides stay canonical: typed term keys job, identity stable", () => {
    const typed = buildBlueprintFromDraft(
      draftOf(contractorAnswers, { terms: { job_term_en: "Site", job_term_ar: "موقع" } }),
      NOW,
    );
    expect(Object.keys(typed.terminology.overrides)).toEqual(["job"]);
    expect(typed.terminology.overrides.job?.en?.singular).toBe("Site");
    const blank = buildBlueprintFromDraft(draftOf(contractorAnswers), NOW);
    expect(Object.keys(blank.terminology.overrides)).toEqual([]);
  });

  it("dashboards differ by role and honor the priority focus", () => {
    const bp = buildBlueprintFromDraft(draftOf(contractorAnswers), NOW);
    const archetypes = bp.dashboards.map((d) => d.archetype);
    expect(archetypes).toContain("owner");
    expect(archetypes).toContain("foreman");
    expect(archetypes).toContain("accounts");
    const focusCollections = buildBlueprintFromDraft(
      draftOf({ ...contractorAnswers, priority_focus: "collections" }),
      NOW,
    );
    expect(focusCollections.dashboards[0]!.cards.map((c) => c.key)).toContain("collections");
  });

  it("role name edits change labels, never authority", () => {
    const bp = buildBlueprintFromDraft(
      draftOf(contractorAnswers, {
        workspace: { role_names: { foreman: { en: "Site captain", ar: "قبطان الموقع" } } },
      }),
      NOW,
    );
    const foreman = bp.roles.find((r) => r.archetype === "foreman")!;
    expect(foreman.name.en).toBe("Site captain");
    // The archetype (the authority anchor) is untouched.
    expect(foreman.archetype).toBe("foreman");
    expect(foreman.permissionRefs).toEqual(["reports.create"]);
  });

  it("an incomplete draft throws with the missing fields named", () => {
    expect(() =>
      buildBlueprintFromDraft(DraftDataSchema.parse({ answers: { business_name: "X" } }), NOW),
    ).toThrow(BlueprintMapError);
  });

  it("the mapping is deterministic in (draft, now)", () => {
    const a = buildBlueprintFromDraft(draftOf(contractorAnswers), NOW);
    const b = buildBlueprintFromDraft(draftOf(structuredClone(contractorAnswers)), NOW);
    expect(a).toEqual(b);
  });
});
