/**
 * The AI narration adapter seam (doc 04 step 4; D-4.3; BUILD_BIBLE §10). Layer B is
 * OPTIONAL wording layered over the deterministic digest — it never queries tenant data,
 * never changes a record, and receives a CLOSED payload only. The payload carries
 * system-composed LABELS + NUMBERS (never raw tenant free-text), so there is no
 * prompt-injection surface and no way to leak a value the collector didn't already put in.
 *
 * Same disabled-seam pattern as the e-invoice adapter: with no provider configured the
 * `disabled` provider returns no narration and the deterministic digest stands (the
 * AI-outage / credits-exhausted / no-credentials fallback). The `fake` provider is a
 * deterministic, number-faithful stand-in used in CI + the demo so the metering + the
 * numbers-subset validator paths are exercised. A real provider slots in here behind
 * credentials (owner action) without touching any caller. No secrets in code.
 */
import { logger } from "@/platform/logger";
import { isProd } from "@/platform/env";

export type NarrationItem = {
  /** A resolved, safe label (i18n string) — never raw tenant free-text. */
  label: string;
  /** The numbers this item contributes to the allowed set (the validator's whitelist). */
  numbers: number[];
};

export type NarrationRequest = {
  lang: "en" | "ar";
  title: string;
  items: NarrationItem[];
};

export type NarrationResult = {
  status: "generated" | "disabled" | "failed";
  text: string | null;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
};

export interface NarrationProvider {
  readonly name: string;
  readonly enabled: boolean;
  narrate(req: NarrationRequest): Promise<NarrationResult>;
}

/** Rough token estimate (≈4 chars/token) — the real provider reports actuals. */
const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/**
 * The FAKE provider: deterministic prose built from the request's labels + numbers, using
 * ONLY numbers present in the payload — so it always passes the numbers-subset validator
 * (the happy path). No randomness. Not a real LLM; a stand-in that exercises the seam.
 */
export const fakeNarrationProvider: NarrationProvider = {
  name: "fake",
  enabled: true,
  async narrate(req) {
    const sentences = req.items.map((it) => {
      const nums = it.numbers.join(", ");
      return req.lang === "ar" ? `${it.label}: ${nums || "—"}.` : `${it.label}: ${nums || "—"}.`;
    });
    const lead = req.lang === "ar" ? `${req.title}. ` : `${req.title}. `;
    const text = (lead + sentences.join(" ")).trim();
    const input = estimateTokens(JSON.stringify(req));
    return {
      status: "generated",
      text,
      provider: "fake",
      model: "fake-1",
      inputTokens: input,
      outputTokens: estimateTokens(text),
    };
  },
};

/** The disabled provider — no provider configured (owner action). Returns no narration. */
const disabledNarrationProvider: NarrationProvider = {
  name: "disabled",
  enabled: false,
  async narrate(req) {
    logger.info(
      { provider: "disabled", lang: req.lang },
      "AI narration skipped — no provider configured (owner action; runbooks/ai-provisioning.md)",
    );
    return {
      status: "disabled",
      text: null,
      provider: "disabled",
      model: null,
      inputTokens: 0,
      outputTokens: 0,
    };
  },
};

/**
 * Resolve the active narration provider. AI_NARRATION_PROVIDER=fake forces the fake (tests);
 * otherwise the fake runs outside production (CI/dev/demo exercise the seam) and production
 * is 'disabled' until a real provider + credentials are provisioned.
 */
export function getNarrationProvider(): NarrationProvider {
  const configured = process.env.AI_NARRATION_PROVIDER;
  if (configured === "fake") return fakeNarrationProvider;
  if (configured === "disabled") return disabledNarrationProvider;
  if (isProd() && !configured) return disabledNarrationProvider;
  return fakeNarrationProvider;
}
