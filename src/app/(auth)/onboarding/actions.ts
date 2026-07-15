"use server";

/**
 * U4 pre-org onboarding wizard actions. Every step submit AUTOSAVES the draft
 * (upsert) and advances the saved step, so refresh/logout/login resume exactly
 * where the founder stopped. NOTHING here touches an org — the single
 * confirmFlowAction at the end runs the sequential, idempotent confirm chain
 * (org → template apply → tier recording → branding → complete).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/platform/auth/resolve";
import { LOCALE_COOKIE, normalizeLocale } from "@/platform/i18n";
import { currentRequestId } from "@/platform/observability";
import { requestLogger } from "@/platform/logger";
import { sql, withUserCtx } from "@/platform/tenancy";
import { TEMPLATES } from "@/platform/config";
import { getAddon, isPurchasable } from "@/platform/entitlements";
import { BrandingError, LOGO_MAX_BYTES } from "@/modules/branding/service";
import {
  applyStepAnswers,
  ConfirmChainError,
  emptyDraftData,
  FlowValidationError,
  getDraft,
  isFlowStep,
  nextStepAfter,
  removeDraftLogo,
  runConfirmChain,
  saveDraft,
  stashDraftLogo,
  TierSelectionSchema,
  type DraftData,
  type FlowStep,
  type OnboardingDraft,
} from "@/modules/onboarding/service";

const LOCALE_COOKIE_OPTS = { path: "/", sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 365 };

/** Session + draft guard shared by every wizard action. */
async function requireFlowUser(): Promise<{ userId: string }> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return { userId: user.id };
}

async function loadDraftOrStart(userId: string): Promise<OnboardingDraft> {
  const draft = await getDraft(userId);
  if (draft && draft.status === "active") return draft;
  return { userId, data: emptyDraftData(), step: "welcome", status: "active", updatedAt: "" };
}

function toStep(step: FlowStep, error?: string): never {
  redirect(`/onboarding?step=${step}${error ? `&error=${error}` : ""}`);
}

// ── Welcome → questionnaire ───────────────────────────────────────────────────
export async function startFlowAction(): Promise<void> {
  const { userId } = await requireFlowUser();
  const draft = await loadDraftOrStart(userId);
  await saveDraft(userId, { data: draft.data, step: "business" });
  toStep("business");
}

// ── Questionnaire step submits (autosave + advance) ───────────────────────────
export async function saveStepAction(step: string, formData: FormData): Promise<void> {
  const { userId } = await requireFlowUser();
  if (!isFlowStep(step)) redirect("/onboarding");
  const draft = await loadDraftOrStart(userId);

  const values: Record<string, string | string[]> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$")) continue; // React server-action internals
    const all = formData.getAll(key).map(String);
    values[key] = all.length > 1 ? all : (all[0] ?? "");
  }

  let data: DraftData;
  try {
    data = applyStepAnswers(draft.data, step, values);
  } catch (err) {
    if (err instanceof FlowValidationError) toStep(step, "invalid");
    throw err;
  }

  const next = nextStepAfter(step);
  await saveDraft(userId, { data, step: next });

  // Preferred-language answer flips the ACTIVE flow locale immediately (the
  // existing locale-cookie mechanism) and persists to the user profile.
  if (step === "region" && data.answers.preferred_language) {
    const locale = normalizeLocale(data.answers.preferred_language);
    (await cookies()).set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTS);
    await withUserCtx(userId, (tx) =>
      tx.execute(sql`update public.user_profile set locale = ${locale} where id = ${userId}`),
    ).catch(() => {
      // Cookie already applied; profile persistence must not block the flow.
    });
  }
  toStep(next);
}

// ── Template selection ────────────────────────────────────────────────────────
export async function chooseTemplateAction(formData: FormData): Promise<void> {
  const { userId } = await requireFlowUser();
  const draft = await loadDraftOrStart(userId);
  const key = String(formData.get("template_key") ?? "").trim();
  const recommendedKey = String(formData.get("recommended_key") ?? "").trim();
  const confident = String(formData.get("confident") ?? "") === "1";
  if (!(key in TEMPLATES)) toStep("template", "invalid");
  const data: DraftData = {
    ...draft.data,
    template: {
      selected_key: key,
      recommended_key: recommendedKey || undefined,
      confident,
      manual: recommendedKey !== "" && key !== recommendedKey,
    },
  };
  await saveDraft(userId, { data, step: "proposal" });
  toStep("proposal");
}

// ── Proposal step (editable job terms; typed-vs-blank law) ────────────────────
export async function saveProposalTermsAction(formData: FormData): Promise<void> {
  const { userId } = await requireFlowUser();
  const draft = await loadDraftOrStart(userId);
  const en = String(formData.get("job_term_en") ?? "").trim();
  const ar = String(formData.get("job_term_ar") ?? "").trim();
  if (en.length > 40 || ar.length > 40) toStep("proposal", "invalid");
  const data: DraftData = {
    ...draft.data,
    terms: {
      ...(en ? { job_term_en: en } : {}), // blank = template's own term (omitted)
      ...(ar ? { job_term_ar: ar } : {}),
    },
  };
  await saveDraft(userId, { data, step: "plan" });
  toStep("plan");
}

// ── Subscription selection (a RECORDED choice — no payment, no entitlements) ──
async function saveTier(userId: string, tier: unknown): Promise<void> {
  const parsed = TierSelectionSchema.safeParse(tier);
  if (!parsed.success) toStep("plan", "invalid");
  const draft = await loadDraftOrStart(userId);
  await saveDraft(userId, { data: { ...draft.data, tier: parsed.data }, step: "branding" });
  toStep("branding");
}

export async function selectFreeAction(): Promise<void> {
  const { userId } = await requireFlowUser();
  await saveTier(userId, { mode: "free" });
}

/** TierCards contract: posts { bundle: "bundle.tier_medium" | "bundle.tier_high" }. */
export async function selectTierFlowAction(formData: FormData): Promise<void> {
  const { userId } = await requireFlowUser();
  const bundle = String(formData.get("bundle") ?? "");
  const mode =
    bundle === "bundle.tier_medium"
      ? "tier_medium"
      : bundle === "bundle.tier_high"
        ? "tier_high"
        : null;
  if (!mode) toStep("plan", "invalid");
  await saveTier(userId, { mode });
}

/** CustomBuilder contract: one `addon:<key>` field per selected add-on, value = quantity.
 * Keys are validated against the REAL catalogue (review fix): a well-formed but
 * nonexistent or non-purchasable key is rejected, never recorded. */
export async function selectCustomAction(formData: FormData): Promise<void> {
  const { userId } = await requireFlowUser();
  const quantities: Record<string, number> = {};
  for (const key of new Set(formData.keys())) {
    if (!key.startsWith("addon:")) continue;
    const addonKey = key.slice("addon:".length);
    const def = getAddon(addonKey);
    if (!def || !isPurchasable(def)) toStep("plan", "invalid");
    const qty = Math.trunc(Number(formData.get(key) ?? 0));
    if (Number.isFinite(qty) && qty >= 1) {
      quantities[addonKey] = def.stackable ? Math.min(99, qty) : 1;
    }
  }
  if (Object.keys(quantities).length === 0) toStep("plan", "custom_empty");
  await saveTier(userId, {
    mode: "custom",
    customKeys: Object.keys(quantities),
    quantities,
  });
}

// ── Branding step ─────────────────────────────────────────────────────────────
// The client maps `error` to a specific, safe message; `correlationId` is set
// ONLY for an unexpected server error (error === "server_error"), so the founder
// can quote a "Reference: <id>" that ties their report to the server log line.
export type FlowActionResult = { error: string | null; correlationId?: string };

/** Client-invoked logo stash (validated + re-encoded; only the 512px PNG kept).
 * Failure reasons are DISTINGUISHED: a BrandingError surfaces its own validation
 * code (bad_type / too_large / bad_signature / too_small_dims / too_large_dims /
 * bad_image / quota_exceeded / invalid_input — each a specific client message);
 * anything else (e.g. sharp ERR_DLOPEN_FAILED when the native libs are missing
 * from the function trace) is logged server-side with a correlation id and
 * returned as a generic { error: "server_error", correlationId }. */
export async function uploadFlowLogoAction(formData: FormData): Promise<FlowActionResult> {
  const user = await getSessionUser();
  if (!user) return { error: "session" };
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return { error: "bad_type" };
  if (file.size > LOGO_MAX_BYTES) return { error: "too_large" };
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await stashDraftLogo(user.id, { mime: file.type, bytes });
  } catch (err) {
    // Expected, actionable validation failures carry their own code + message.
    if (err instanceof BrandingError) return { error: err.code };
    // Unexpected server fault (sharp dlopen, storage, …): never leak the reason
    // to the client — log it with a correlation id and hand the id back so a
    // user-reported failure can be traced in the server logs.
    const correlationId = await currentRequestId();
    requestLogger({ requestId: correlationId, userId: user.id }).error(
      { err: (err as Error)?.message ?? String(err), action: "onboarding.logo_upload" },
      "onboarding logo upload failed unexpectedly",
    );
    return { error: "server_error", correlationId };
  }
  return { error: null };
}

export async function removeFlowLogoAction(): Promise<FlowActionResult> {
  const user = await getSessionUser();
  if (!user) return { error: "session" };
  await removeDraftLogo(user.id);
  return { error: null };
}

export async function saveBrandingStepAction(formData: FormData): Promise<void> {
  const { userId } = await requireFlowUser();
  const draft = await loadDraftOrStart(userId);
  const swatch = String(formData.get("accent_swatch") ?? "").trim();
  const hex = String(formData.get("accent_color") ?? "").trim();
  const accent = hex || swatch;
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) toStep("branding", "invalid");
  const display = String(formData.get("display_name") ?? "").trim();
  const legal = String(formData.get("legal_name") ?? "").trim();
  const footer = String(formData.get("footer_details") ?? "").trim();
  if (display.length > 120 || legal.length > 200 || footer.length > 500) {
    toStep("branding", "invalid");
  }
  const data: DraftData = {
    ...draft.data,
    branding: {
      ...(draft.data.branding.logo_base64 ? { logo_base64: draft.data.branding.logo_base64 } : {}),
      ...(accent ? { accent_color: accent } : {}),
      ...(display ? { display_name: display } : {}),
      ...(legal ? { legal_name: legal } : {}),
      ...(footer ? { footer_details: footer } : {}),
    },
  };
  await saveDraft(userId, { data, step: "review" });
  toStep("review");
}

export async function skipBrandingStepAction(): Promise<void> {
  const { userId } = await requireFlowUser();
  const draft = await loadDraftOrStart(userId);
  const data: DraftData = {
    ...draft.data,
    branding: { ...draft.data.branding, skipped: true },
  };
  await saveDraft(userId, { data, step: "review" });
  toStep("review");
}

// ── THE explicit confirm — the only place anything is created/applied ─────────
export async function confirmFlowAction(): Promise<void> {
  const { userId } = await requireFlowUser();
  try {
    const { orgId } = await runConfirmChain(userId);
    redirect(`/o/${orgId}?welcome=1`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof ConfirmChainError) toStep("review", err.code);
    toStep("review", "failed");
  }
}
