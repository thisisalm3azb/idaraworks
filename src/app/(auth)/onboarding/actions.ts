"use server";

/**
 * The short onboarding's actions. Every screen submit AUTOSAVES the draft
 * (upsert) and advances the saved step, so refresh/logout/login resume exactly
 * where the founder stopped. NOTHING here touches an organisation — the single
 * confirmFlowAction at the end runs the sequential, idempotent confirm chain
 * (org → template apply → blueprint → recorded choices → complete).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/platform/auth/resolve";
import { LOCALE_COOKIE } from "@/platform/i18n";
import { resolveOfferedLocale } from "@/platform/i18n/offered";
import { sql, withUserCtx } from "@/platform/tenancy";
import {
  applySetupChoice,
  applyStepAnswers,
  ConfirmChainError,
  DraftConflictError,
  emptyDraftData,
  FlowValidationError,
  getDraft,
  isFlowStep,
  nextStepAfter,
  runConfirmChain,
  saveDraft,
  type DraftData,
  type FlowStep,
  type OnboardingDraft,
} from "@/modules/onboarding/service";

const LOCALE_COOKIE_OPTS = { path: "/", sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 365 };

/** Session + draft guard shared by every action. */
async function requireFlowUser(): Promise<{ userId: string }> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return { userId: user.id };
}

async function loadDraftOrStart(userId: string): Promise<OnboardingDraft> {
  const draft = await getDraft(userId);
  if (draft && draft.status === "active") return draft;
  return { userId, data: emptyDraftData(), step: "business", status: "active", updatedAt: "" };
}

function toStep(step: FlowStep, error?: string): never {
  redirect(`/onboarding?step=${step}${error ? `&error=${error}` : ""}`);
}

/** The optimistic two-tab guard value posted with every step form. */
function draftRev(formData: FormData): string | undefined {
  const v = String(formData.get("draft_rev") ?? "").trim();
  return v === "" ? undefined : v;
}

// ── Screens 1 and 3: autosave + advance ─────────────────────────────────────
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

  const next = nextStepAfter(step, data.answers);
  try {
    await saveDraft(userId, { data, step: next, expectedUpdatedAt: draftRev(formData) });
  } catch (err) {
    if (err instanceof DraftConflictError) toStep(step, "stale_tab");
    throw err;
  }

  // The language answer flips the ACTIVE locale immediately (the existing
  // locale-cookie mechanism) and persists to the user profile.
  if (step === "business" && data.answers.preferred_language) {
    const locale = resolveOfferedLocale(data.answers.preferred_language);
    (await cookies()).set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTS);
    await withUserCtx(userId, (tx) =>
      tx.execute(sql`update public.user_profile set locale = ${locale} where id = ${userId}`),
    ).catch(() => {
      // Cookie already applied; profile persistence must not block the flow.
    });
  }
  toStep(next);
}

// ── Screen 2: how you work (one card = one template) ────────────────────────
export async function chooseSetupAction(formData: FormData): Promise<void> {
  const { userId } = await requireFlowUser();
  const draft = await loadDraftOrStart(userId);
  const key = String(formData.get("template_key") ?? "").trim();
  let data: DraftData;
  try {
    data = applySetupChoice(draft.data, key);
  } catch (err) {
    if (err instanceof FlowValidationError) toStep("setup", "invalid");
    throw err;
  }
  try {
    await saveDraft(userId, { data, step: "priorities", expectedUpdatedAt: draftRev(formData) });
  } catch (err) {
    if (err instanceof DraftConflictError) toStep("setup", "stale_tab");
    throw err;
  }
  toStep("priorities");
}

// ── THE explicit confirm — the only place anything is created/applied ────────
export async function confirmFlowAction(): Promise<void> {
  const { userId } = await requireFlowUser();
  try {
    const { orgId } = await runConfirmChain(userId);
    redirect(`/o/${orgId}?welcome=1`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof ConfirmChainError) toStep("ready", err.code);
    toStep("ready", "failed");
  }
}
