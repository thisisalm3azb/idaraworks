/**
 * H14 — the Intelligent Clay laws, pinned to executable behavior, plus the
 * registry parity checks that keep the workspace vocabularies honest against
 * their platform sources of truth (nav builder, Today cards, entitlement
 * catalogue, onboarding countries, terminology keys).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTELLIGENT_CLAY_LAWS,
  EFFECTIVE_ACCESS_LAYERS,
  AGENT_ACCESS_LAYERS,
  effectiveCapability,
  effectiveAgentAction,
  WORKSPACE_MODULE_KEYS,
  MODULE_INFO,
  NAV_ITEM_KEYS,
  NAV_ITEM_INFO,
  DASHBOARD_CARD_KEYS,
  DASHBOARD_CARD_MODULE,
  WORKSPACE_COUNTRIES,
  COUNTRY_PACKS,
  ORG_SIZE_BANDS,
  BLUEPRINT_ARCHETYPES,
  validateBlueprint,
  compileBlueprint,
  blueprintHash,
  WorkspaceBlueprintSchema,
} from "@/platform/workspace";
import { FEATURE_KEYS } from "@/platform/entitlements";
import { can } from "@/platform/authz";
import { buildNavGroups } from "@/platform/ui/nav/build";
import { SUPPORTED_LOCALES, TERM_KEYS, MVP_GRANTABLE_ARCHETYPES } from "@/platform/registries";
import { SUPPORTED_COUNTRIES } from "@/modules/onboarding/proposal";
import { COUNTRY_DEFAULTS, EMPLOYEE_BANDS } from "@/modules/onboarding/flow";
import { AGENT_IDS, AGENT_TOOL_ALLOW } from "@/platform/agents/registry";
import { makeBlueprint, scenarioContractor, entitleAll, prov } from "./workspace-fixtures";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const compilerSrc = read("../../src/platform/workspace/compiler.ts");
const todaySrc = read("../../src/modules/today/service.ts");

describe("H14 — the twenty Intelligent Clay laws are pinned", () => {
  it("all twenty laws exist, numbered and worded", () => {
    expect(INTELLIGENT_CLAY_LAWS.length).toBe(20);
    expect(INTELLIGENT_CLAY_LAWS.map((l) => l.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const text = INTELLIGENT_CLAY_LAWS.map((l) => l.law).join(" ");
    for (const phrase of [
      "does not generate application code",
      "organization-scoped",
      "never trusted",
      "plan entitlement",
      "server-resolved permissions",
      "presentation but never authority",
      "explain what it changes and why",
      "authorized human confirms",
      "idempotent",
      "audited",
      "support undo",
      "never delete its business records",
      "must not change entity identity",
      "must not corrupt historical records",
      "may not weaken security",
      "bounded by entitlement",
      "English and Arabic are first-class",
      "without embedding English assumptions",
      "fail closed",
      "truth remains internal",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("law 1: the compiler is pure — no DB, UI, AI, network or schema access", () => {
    for (const banned of [
      "@/platform/tenancy",
      "@/platform/audit",
      "@/platform/ai",
      "@/platform/events",
      "@/platform/ui",
      "fetch(",
      "process.env",
      "sql`",
      "create table",
      "drop table",
      "Math.random",
      "Date.now",
    ]) {
      expect(compilerSrc, `compiler must not contain ${banned}`).not.toContain(banned);
    }
  });

  it("laws 4+5: the effective-access equation is a strict intersection", () => {
    expect(EFFECTIVE_ACCESS_LAYERS).toEqual([
      "platform_availability",
      "plan_entitlement",
      "approved_organization_configuration",
      "acting_user_permission",
    ]);
    expect(AGENT_ACCESS_LAYERS.slice(0, 4)).toEqual([...EFFECTIVE_ACCESS_LAYERS]);
    const all = {
      platformAvailable: true,
      planEntitled: true,
      configEnabled: true,
      userPermitted: true,
    };
    expect(effectiveCapability(all)).toBe(true);
    // Flipping ANY single layer denies — no layer can override another.
    for (const key of Object.keys(all) as (keyof typeof all)[]) {
      expect(effectiveCapability({ ...all, [key]: false })).toBe(false);
    }
    const agent = {
      ...all,
      agentAllowListed: true,
      classificationSupported: true,
      approvalSatisfied: true,
    };
    expect(effectiveAgentAction(agent)).toBe(true);
    for (const key of Object.keys(agent) as (keyof typeof agent)[]) {
      expect(effectiveAgentAction({ ...agent, [key]: false })).toBe(false);
    }
  });

  it("law 6: configuration can hide presentation but never add authority", () => {
    const bp = makeBlueprint();
    const compiled = compileBlueprint(bp, entitleAll());
    // A viewer never gains an item can() denies, whatever the blueprint says.
    for (const key of compiled.navigation.viewer) {
      const info = NAV_ITEM_INFO[key];
      expect(info.action === null || can("viewer", info.action)).toBe(true);
    }
  });

  it("law 7: a section without provenance/reason does not parse", () => {
    const bp = makeBlueprint() as unknown as Record<string, unknown>;
    const broken = {
      ...bp,
      capabilities: { ...(bp.capabilities as object), provenance: undefined },
    };
    expect(WorkspaceBlueprintSchema.safeParse(broken).success).toBe(false);
  });

  it("law 12: compiled output contains no destructive operation", () => {
    const compiled = compileBlueprint(scenarioContractor(), entitleAll());
    const json = JSON.stringify(compiled).toLowerCase();
    for (const banned of ['"delete"', '"drop"', '"truncate"', "delete from"]) {
      expect(json).not.toContain(banned);
    }
    // Disabling is a STATUS, never a removal instruction.
    const disabled = compileBlueprint(makeBlueprint(), entitleAll()).capabilities.find(
      (c) => c.key === "cap.expenses",
    );
    expect(disabled?.status).toBe("disabled_by_configuration");
  });

  it("law 13: terminology stays keyed by canonical identity", () => {
    const compiled = compileBlueprint(scenarioContractor(), entitleAll());
    expect(Object.keys(compiled.terminology).sort()).toEqual([...TERM_KEYS].sort());
    expect(compiled.terminology.job.source).toBe("override");
    expect(compiled.terminology.invoice.source).toBe("platform_default");
  });

  it("law 15: country packs carry no permission or security surface", () => {
    for (const pack of Object.values(COUNTRY_PACKS)) {
      const json = JSON.stringify(pack).toLowerCase();
      for (const banned of ["permission", "archetype", "role", "rls", "grant", "entitle"]) {
        expect(json, `${pack.country} pack must not mention ${banned}`).not.toContain(banned);
      }
      expect(pack.regulatoryExtensions).toEqual([]);
      expect(pack.unsupportedAssumptions.length).toBeGreaterThan(0);
    }
  });

  it("law 16: compiled agent access only ever narrows the canonical allow-list", () => {
    const compiled = compileBlueprint(scenarioContractor(), entitleAll());
    for (const agent of compiled.agents) {
      const allow = AGENT_TOOL_ALLOW[agent.agentId] as readonly string[];
      for (const domain of agent.readDomains) expect(allow).toContain(domain);
    }
  });

  it("laws 17+18: en and ar are required; extra locales are accepted", () => {
    const bp = makeBlueprint();
    // Missing ar anywhere fails…
    const noAr = makeBlueprint({
      workflows: [
        {
          ...bp.workflows[0]!,
          name: { en: "Engagement" } as never,
        },
      ],
    });
    expect(WorkspaceBlueprintSchema.safeParse(noAr).success).toBe(false);
    // …while an additional locale key parses without any schema change.
    const withEs = makeBlueprint({
      workflows: [
        {
          ...bp.workflows[0]!,
          name: { en: "Engagement", ar: "مهمة", es: "Encargo" },
        },
      ],
    });
    expect(WorkspaceBlueprintSchema.safeParse(withEs).success).toBe(true);
  });

  it("law 19: missing, invalid or incompatible configuration fails closed", () => {
    expect(validateBlueprint(null).ok).toBe(false);
    expect(validateBlueprint({}).ok).toBe(false);
    expect(() => compileBlueprint({}, entitleAll())).toThrow();
    // Unsupported locale and unknown country never parse.
    expect(
      WorkspaceBlueprintSchema.safeParse(
        makeBlueprint({
          international: { ...makeBlueprint().international, defaultLocale: "es" as never },
        }),
      ).success,
    ).toBe(false);
    expect(
      WorkspaceBlueprintSchema.safeParse(
        makeBlueprint({
          international: { ...makeBlueprint().international, countryPack: "US" as never },
        }),
      ).success,
    ).toBe(false);
  });

  it("compiler determinism: same blueprint + same snapshot = identical output", () => {
    const bp = scenarioContractor();
    const a = compileBlueprint(bp, entitleAll());
    const b = compileBlueprint(structuredClone(bp), entitleAll());
    expect(a).toEqual(b);
    expect(blueprintHash(bp)).toBe(blueprintHash(structuredClone(bp)));
    // Hash is key-order independent (canonical JSON).
    const reordered = JSON.parse(JSON.stringify(bp)) as Record<string, unknown>;
    const { profile, ...rest } = reordered;
    expect(blueprintHash({ ...rest, profile })).toBe(blueprintHash(bp));
  });
});

describe("H14 — registry parity with the platform sources of truth", () => {
  it("workspace modules are registered entitlement features", () => {
    for (const key of WORKSPACE_MODULE_KEYS) {
      expect(FEATURE_KEYS as readonly string[]).toContain(key);
      expect(MODULE_INFO[key].entitlement).toBe(key);
    }
    // Dependencies stay inside the registry.
    for (const info of Object.values(MODULE_INFO)) {
      for (const dep of [...info.requires, ...info.recommends]) {
        expect(WORKSPACE_MODULE_KEYS as readonly string[]).toContain(dep);
      }
    }
  });

  it("nav item registry matches the shipped nav builder exactly", () => {
    const allOn = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
    const seen = new Set<string>();
    for (const archetype of BLUEPRINT_ARCHETYPES) {
      const keys = new Set(
        buildNavGroups({
          orgId: "x",
          archetype,
          features: allOn,
          stockSurfaces: true,
          // H23G — parity is judged with every release gate open, same as stock.
          hrSurfaces: true,
          financeSurfaces: true,
          studioSurfaces: true,
          documentSurfaces: true,
        })
          .flatMap((g) => g.items)
          .map((i) => i.key),
      );
      for (const k of keys) seen.add(k);
      // Presence parity: with everything entitled, an item exists exactly
      // when its registered action passes can() (today is unconditional).
      for (const key of NAV_ITEM_KEYS) {
        const info = NAV_ITEM_INFO[key];
        const expected = info.action === null || can(archetype, info.action);
        expect(keys.has(key), `${archetype}/${key}`).toBe(expected);
      }
    }
    expect([...seen].sort()).toEqual([...NAV_ITEM_KEYS].sort());
    // Feature parity: turning ONE feature off removes-or-locks exactly the
    // items registered against it (owner sees everything, so test as owner).
    for (const feature of new Set(
      Object.values(NAV_ITEM_INFO)
        .map((i) => i.feature)
        .filter((f): f is NonNullable<typeof f> => f !== null),
    )) {
      const features = { ...allOn, [feature]: false };
      // Released, so the H22F items take part in the parity check: their whole
      // point is that a RELEASE gate and an ENTITLEMENT gate are different, and
      // that only means something if the entitlement half is exercised.
      const items = buildNavGroups({
        orgId: "x",
        archetype: "owner",
        features,
        stockSurfaces: true,
        hrSurfaces: true,
        financeSurfaces: true,
        studioSurfaces: true,
        documentSurfaces: true,
      }).flatMap((g) => g.items);
      const byKey = new Map(items.map((i) => [i.key, i]));
      for (const key of NAV_ITEM_KEYS) {
        const info = NAV_ITEM_INFO[key];
        if (info.feature === feature) {
          const item = byKey.get(key);
          expect(!item || item.locked, `${key} should hide or lock without ${feature}`).toBe(true);
        } else {
          expect(byKey.has(key), `${key} must be unaffected by ${feature}`).toBe(true);
        }
      }
    }
  });

  it("dashboard card registry matches composeToday's real cards", () => {
    const inSource = new Set([...todaySrc.matchAll(/key: "([a-z_]+)"/g)].map((m) => m[1]!));
    expect([...inSource].sort()).toEqual([...DASHBOARD_CARD_KEYS].sort());
    for (const key of DASHBOARD_CARD_KEYS) {
      const mod = DASHBOARD_CARD_MODULE[key];
      if (mod !== null) {
        expect(WORKSPACE_MODULE_KEYS as readonly string[]).toContain(mod);
      }
    }
  });

  it("countries, size bands and locales mirror their platform sources", () => {
    expect([...WORKSPACE_COUNTRIES].sort()).toEqual([...SUPPORTED_COUNTRIES].sort());
    expect([...ORG_SIZE_BANDS]).toEqual([...EMPLOYEE_BANDS]);
    for (const c of WORKSPACE_COUNTRIES) {
      expect(COUNTRY_PACKS[c].defaultCurrency).toBe(COUNTRY_DEFAULTS[c].currency);
      expect(COUNTRY_PACKS[c].defaultTimezone).toBe(COUNTRY_DEFAULTS[c].timezone);
      expect([...COUNTRY_PACKS[c].locales]).toEqual([...SUPPORTED_LOCALES]);
      expect(COUNTRY_PACKS[c].direction.ar).toBe("rtl");
      expect(COUNTRY_PACKS[c].direction.en).toBe("ltr");
    }
    expect([...BLUEPRINT_ARCHETYPES]).toEqual([...MVP_GRANTABLE_ARCHETYPES]);
  });

  it("agent vocabulary is exactly the canonical registry", () => {
    const bp = scenarioContractor();
    for (const a of bp.agents) {
      expect(AGENT_IDS as readonly string[]).toContain(a.agentId);
    }
    // A fabricated agent id never parses.
    const forged = makeBlueprint({
      agents: [
        {
          agentId: "growth_hacker" as never,
          relevantRoles: ["owner"],
          relevantModules: [],
          readDomains: [],
          classifications: ["read_explain"],
          entitlement: "feat.ai_agents",
          provenance: prov("x", "س"),
        },
      ],
    });
    expect(WorkspaceBlueprintSchema.safeParse(forged).success).toBe(false);
  });
});
