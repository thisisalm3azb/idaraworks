/**
 * The short journey engine (journey 3) and its copy contract: a deterministic
 * registry of the questions the four screens ask, older answers kept as
 * legacy rather than reported as unknown or retired, version stamping,
 * complete en/ar/es copy for every screen, no em dash anywhere in onboarding
 * copy, no AI claims, and no AI provider on the deterministic path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/platform/i18n/messages/en.json";
import ar from "@/platform/i18n/messages/ar.json";
import es from "@/platform/i18n/messages/es.json";
import {
  LEGACY_QUESTION_KEYS,
  QUESTIONS,
  questionsForStep,
  visibleQuestions,
  invalidatedAnswers,
  unknownAnswerKeys,
  JOURNEY_VERSION,
} from "@/modules/onboarding/journey";
import {
  DraftDataSchema,
  FLOW_STEPS,
  JOURNEY_SECTIONS,
  sectionForStep,
  visibleSteps,
} from "@/modules/onboarding/flow";
import type { DraftAnswers } from "@/modules/onboarding/flow";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const E = en as Record<string, string>;
const A = ar as Record<string, string>;
const S = es as Record<string, string>;

describe("journey 3 — the deterministic short registry", () => {
  it("every question has a canonical key, a real step, blueprint areas and a reason", () => {
    for (const q of QUESTIONS) {
      expect(q.key).toMatch(/^[a-z_]+$/);
      expect(FLOW_STEPS as readonly string[]).toContain(q.step);
      expect(q.shapes.length).toBeGreaterThan(0);
      expect(q.includedBecause).toBeTruthy();
    }
    expect(new Set(QUESTIONS.map((q) => q.key)).size).toBe(QUESTIONS.length);
  });

  it("asks only on the three answer screens, and nothing on the ready screen", () => {
    expect(questionsForStep("business", {}).map((q) => q.key)).toEqual([
      "business_name",
      "country",
      "preferred_language",
    ]);
    expect(questionsForStep("setup", {}).map((q) => q.key)).toEqual(["industry"]);
    expect(questionsForStep("priorities", {}).map((q) => q.key)).toEqual([
      "priorities",
      "employees_band",
    ]);
    expect(questionsForStep("ready", {})).toEqual([]);
  });

  it("the same answers always produce the same journey (determinism)", () => {
    const a: DraftAnswers = { business_name: "X", country: "AE", priorities: ["work"] };
    const one = visibleQuestions(a).map((q) => q.key);
    const two = visibleQuestions({ ...a }).map((q) => q.key);
    expect(one).toEqual(two);
    expect(visibleSteps(a)).toEqual([...FLOW_STEPS]);
  });

  it("no payroll, tax-registration or payment-card question exists in the journey", () => {
    expect(QUESTIONS.some((q) => /payroll|salary|wage|vat|tax|card/i.test(q.key))).toBe(false);
  });

  it("answers from the long journey are legacy: kept, never unknown, never retired", () => {
    const old: DraftAnswers = {
      business_name: "Old Co",
      customer_types: ["businesses"],
      buys_materials: "yes",
      sends_invoices: "yes",
      vat_registered_q: "no",
    };
    expect(unknownAnswerKeys(old)).toEqual([]);
    expect(invalidatedAnswers(old, { ...old, country: "AE" })).toEqual([]);
    for (const k of LEGACY_QUESTION_KEYS) {
      expect(
        QUESTIONS.some((q) => q.key === k),
        `${k} must not also be asked`,
      ).toBe(false);
    }
  });

  it("truly unknown stored answers are detected, not crashed on (fail safe)", () => {
    expect(unknownAnswerKeys({ business_name: "x", from_the_future: 1 })).toEqual([
      "from_the_future",
    ]);
    expect(unknownAnswerKeys({})).toEqual([]);
  });

  it("the journey version stamps new drafts and older drafts still parse", () => {
    expect(JOURNEY_VERSION).toBe(3);
    expect(DraftDataSchema.parse({}).journey_version).toBe(JOURNEY_VERSION);
    const legacy = DraftDataSchema.parse({
      journey_version: 2,
      answers: { business_name: "X", customer_types: ["mixed"], vat_registered_q: "not_sure" },
    });
    expect(legacy.journey_version).toBe(2);
    expect(legacy.answers.business_name).toBe("X");
    expect(legacy.answers.customer_types).toEqual(["mixed"]);
  });

  it("sections cover every step and each step maps to one section", () => {
    const covered = new Set(JOURNEY_SECTIONS.flatMap((s) => s.steps as readonly string[]));
    for (const step of FLOW_STEPS) {
      expect(covered.has(step), `step ${step} must belong to a section`).toBe(true);
      expect(sectionForStep(step)).not.toBeNull();
    }
  });
});

describe("journey 3 — copy contract (en/ar/es parity, honesty, no em dash)", () => {
  const onbKeys = Object.keys(E).filter((k) => k.startsWith("onb."));

  it("every short-flow key exists in all three catalogues, Arabic in Arabic script", () => {
    expect(onbKeys.length).toBeGreaterThan(40);
    for (const k of onbKeys) {
      expect(A[k], `ar missing ${k}`).toBeTruthy();
      expect(S[k], `es missing ${k}`).toBeTruthy();
      if (/[A-Za-z]{3,}/.test(E[k]!.replace(/IdaraWorks/g, ""))) {
        expect(/[؀-ۿ]/.test(A[k]!), `ar.${k} has no Arabic script`).toBe(true);
      }
    }
    for (const step of FLOW_STEPS) expect(E[`onb.step.${step}.title`]).toBeTruthy();
    for (const key of Object.keys(en).filter((k) => k.startsWith("onb.setup.tpl."))) {
      expect(E[key]!.length).toBeLessThan(120);
    }
  });

  it("no em dash in ANY onboarding copy, in any language", () => {
    for (const cat of [E, A, S]) {
      for (const [k, v] of Object.entries(cat)) {
        if (k.startsWith("onb.") || k.startsWith("onboarding.")) expect(v, k).not.toContain("—");
      }
    }
  });

  it("the trial is stated in two short lines, with the detail behind a disclosure", () => {
    expect(E["trial.promise.headline"]).toBe("30 days free. No credit card needed.");
    expect(E["trial.promise.after_short"]).toBe(
      "Afterwards, continue on Free or choose a paid plan.",
    );
    expect(E["trial.promise.details"]).toBe("See details");
    // The same three keys carry the trial on every surface: onboarding, the
    // workspace banner and the subscription page. No surface has private copy.
    const layoutSrc = read("../../src/app/(app)/o/[orgId]/layout.tsx");
    const subSrc = read("../../src/app/(app)/o/[orgId]/settings/subscription/page.tsx");
    expect(layoutSrc).toMatch(/trial\.promise\.details/);
    expect(subSrc).toMatch(/trial\.promise\.headline/);
    expect(subSrc).toMatch(/trial\.promise\.after_short/);
    expect(subSrc).toMatch(/<details/);
    expect(E["trial.banner.no_card"]).toBe("No credit card needed.");
    expect(E["trial.promise.headline"]!.length).toBeLessThan(40);
    expect(E["trial.promise.after_short"]!.length).toBeLessThan(60);
    const src = read("../../src/app/(auth)/onboarding/screens.tsx");
    expect(src).toMatch(/<details/);
    expect(src).toMatch(/trial\.promise\.no_restart/);
  });

  it("makes no AI, migration or guarantee claim, and never invents tax facts", () => {
    for (const k of onbKeys) {
      expect(E[k]).not.toMatch(
        /\bAI\b|artificial intelligence|guarantee|migrat|automatically move/i,
      );
    }
    expect(E["onb.setup.note"]).toMatch(/Nothing is switched on that you did not choose/);
  });

  it("no AI provider is called on the journey or blueprint path (source scan)", () => {
    for (const p of [
      "../../src/modules/onboarding/journey.ts",
      "../../src/modules/onboarding/flow.ts",
      "../../src/modules/onboarding/blueprint-map.ts",
    ]) {
      const src = read(p);
      expect(src).not.toMatch(/@anthropic-ai|openai|fetch\(/);
    }
  });
});
