/**
 * H15 — the Intelligent Clay journey engine (Part D) and its copy contract:
 * deterministic question selection with recorded reasons, branch invalidation
 * that never silently discards input, version stamping, complete en/ar copy
 * for every question surface, no em dash anywhere in onboarding copy, no AI
 * claims, and no AI provider in the deterministic path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import {
  QUESTIONS,
  questionsForStep,
  visibleQuestions,
  invalidatedAnswers,
  unknownAnswerKeys,
  JOURNEY_VERSION,
} from "@/modules/onboarding/journey";
import {
  DraftDataSchema,
  JOURNEY_SECTIONS,
  sectionForStep,
  visibleSteps,
  FLOW_STEPS,
} from "@/modules/onboarding/flow";
import type { DraftAnswers } from "@/modules/onboarding/flow";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const consulting: DraftAnswers = { industry: "other", work_patterns: ["service", "recurring"] };
const contractor: DraftAnswers = {
  industry: "construction",
  work_patterns: ["project"],
  employees_band: "21-50",
  buys_materials: "yes",
  sends_invoices: "yes",
};

describe("H15 — deterministic adaptive engine", () => {
  it("every question has a canonical key, a step, blueprint mapping and a reason", () => {
    const keys = new Set<string>();
    for (const q of QUESTIONS) {
      expect(keys.has(q.key), `duplicate question key ${q.key}`).toBe(false);
      keys.add(q.key);
      expect(FLOW_STEPS).toContain(q.step);
      expect(q.shapes.length).toBeGreaterThan(0);
      expect(q.includedBecause.length).toBeGreaterThan(0);
    }
  });

  it("the same answers always produce the same journey (determinism)", () => {
    for (const a of [consulting, contractor, {}]) {
      const first = visibleQuestions(a).map((q) => q.key);
      const second = visibleQuestions(structuredClone(a)).map((q) => q.key);
      expect(first).toEqual(second);
      expect(visibleSteps(a)).toEqual(visibleSteps(structuredClone(a)));
    }
  });

  it("a consulting business is never asked warehouse questions", () => {
    const keys = visibleQuestions(consulting).map((q) => q.key);
    expect(keys).not.toContain("buys_materials");
    expect(keys).not.toContain("holds_stock");
    expect(keys).not.toContain("receives_deliveries");
    expect(visibleSteps(consulting)).not.toContain("materials");
  });

  it("a contractor is asked about materials, deliveries and daily work", () => {
    const keys = visibleQuestions(contractor).map((q) => q.key);
    expect(keys).toContain("buys_materials");
    expect(keys).toContain("holds_stock");
    expect(keys).toContain("receives_deliveries"); // buys yes
    expect(keys).toContain("collects_payments"); // invoices yes
    expect(keys).toContain("tracks_costs"); // project pattern
  });

  it("a solo operator is not forced through department or sign-in design", () => {
    const solo: DraftAnswers = { employees_band: "1-5" };
    const keys = visibleQuestions(solo).map((q) => q.key);
    expect(keys).not.toContain("users_band");
    expect(keys).not.toContain("departments");
  });

  it("no payroll question exists anywhere in the journey", () => {
    expect(QUESTIONS.some((q) => /payroll|salary|wage/i.test(q.key))).toBe(false);
  });

  it("branch changes report invalidated answers, never silently", () => {
    const before: DraftAnswers = {
      ...consulting,
      industry: "construction",
      buys_materials: "yes",
      holds_stock: "yes",
      receives_deliveries: "yes",
    };
    const after: DraftAnswers = {
      ...before,
      industry: "other",
      work_patterns: ["service"],
    };
    const retired = invalidatedAnswers(before, after);
    expect(retired).toContain("buys_materials");
    expect(retired).toContain("holds_stock");
    expect(retired).toContain("receives_deliveries");
    // Unchanged branches invalidate nothing.
    expect(invalidatedAnswers(before, before)).toEqual([]);
  });

  it("unknown stored answers are detected, not crashed on (fail safe)", () => {
    expect(unknownAnswerKeys({ business_name: "x", from_the_future: 1 })).toEqual([
      "from_the_future",
    ]);
    expect(unknownAnswerKeys({})).toEqual([]);
  });

  it("the journey version stamps new drafts", () => {
    expect(JOURNEY_VERSION).toBe(2);
    expect(DraftDataSchema.parse({}).journey_version).toBe(JOURNEY_VERSION);
    // A draft from an older journey still parses (answers preserved).
    const legacy = DraftDataSchema.parse({ journey_version: 1, answers: { business_name: "X" } });
    expect(legacy.journey_version).toBe(1);
    expect(legacy.answers.business_name).toBe("X");
  });

  it("sections cover every step and each step maps to one section", () => {
    const covered = new Set(JOURNEY_SECTIONS.flatMap((s) => s.steps as readonly string[]));
    for (const step of FLOW_STEPS) {
      if (step === "welcome") continue;
      expect(covered.has(step), `step ${step} must belong to a section`).toBe(true);
      expect(sectionForStep(step)).not.toBeNull();
    }
    expect(sectionForStep("welcome")).toBeNull();
  });

  it("questionsForStep filters by the step AND the visibility rule", () => {
    const keys = questionsForStep("money", { sends_invoices: "no" }).map((q) => q.key);
    expect(keys).toContain("sends_invoices");
    expect(keys).not.toContain("collects_payments");
  });
});

describe("H15 — copy contract (en/ar parity, honesty, no em dash)", () => {
  const onboardingKeys = Object.keys(en).filter((k) => k.startsWith("onboarding."));

  it("en and ar carry identical onboarding key sets", () => {
    const arKeys = Object.keys(ar).filter((k) => k.startsWith("onboarding."));
    expect(arKeys.sort()).toEqual(onboardingKeys.sort());
  });

  it("every journey surface has en + ar copy (sections, answers, modules, reasons, agents)", () => {
    const need = [
      ...JOURNEY_SECTIONS.map((s) => `onboarding.flow.section.${s.key}`),
      "onboarding.flow.answer.yes",
      "onboarding.flow.answer.no",
      "onboarding.flow.answer.not_sure",
      "onboarding.flow.saved_note",
      "onboarding.flow.retired_note",
      "onboarding.flow.error.stale_tab",
      "onboarding.flow.review.promise_will",
      "onboarding.flow.review.promise_wont",
      "onboarding.flow.review.promise_later",
      "onboarding.flow.review.promise_authority",
    ];
    for (const k of need) {
      expect(k in en, `en missing ${k}`).toBe(true);
      expect(k in ar, `ar missing ${k}`).toBe(true);
      expect(/[؀-ۿ]/.test(String(ar[k as keyof typeof ar])), `ar.${k} not Arabic`).toBe(true);
    }
  });

  it("no em dash in ANY onboarding copy, either language (Part C)", () => {
    for (const k of onboardingKeys) {
      expect(String(en[k as keyof typeof en]), `en.${k}`).not.toContain("—");
      expect(String(ar[k as keyof typeof ar]), `ar.${k}`).not.toContain("—");
    }
  });

  it("the deterministic recommendation system never claims to be AI", () => {
    const blob = onboardingKeys
      .map((k) => `${en[k as keyof typeof en]} ${ar[k as keyof typeof ar]}`)
      .join(" ");
    expect(blob).not.toMatch(/powered by AI|AI[- ]powered|artificial intelligence/i);
    expect(blob).not.toMatch(/مدعوم بالذكاء الاصطناعي/);
  });

  it("no AI provider is called on the journey or blueprint path (source scan)", () => {
    for (const file of [
      "../../src/modules/onboarding/journey.ts",
      "../../src/modules/onboarding/blueprint-map.ts",
      "../../src/modules/onboarding/flow.ts",
    ]) {
      const src = read(file);
      expect(src).not.toMatch(/@anthropic|openai|fetch\(|https?:\/\//i);
      expect(src).not.toMatch(/getOnboardingProvider|callProvider/);
    }
  });

  it("no client-supplied security state can enter the draft (strict schema)", () => {
    for (const smuggle of [
      { answers: { role: "owner" } },
      { answers: { permissions: ["config.manage"] } },
      { entitlements: { "cap.quoting": true } },
      { confirm: { org_id: "not-a-uuid" } },
      { workspace: { grant: ["all"] } },
    ]) {
      expect(DraftDataSchema.safeParse(smuggle).success, JSON.stringify(smuggle)).toBe(false);
    }
  });
});
