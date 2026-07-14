"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  startOnboarding,
  applyOnboarding,
  undoOnboarding,
  getOnboardingSession,
  OnboardingError,
  OnboardingCapError,
  OnboardingValidationError,
} from "@/modules/onboarding/service";

function num(fd: FormData, key: string): number | undefined {
  const v = String(fd.get(key) ?? "").trim();
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function startOnboardingAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const auto: Record<string, number> = {};
  const po = num(formData, "auto_po");
  const mr = num(formData, "auto_mr");
  if (po !== undefined) auto.purchase_order = po;
  if (mr !== undefined) auto.material_request = mr;
  const languages = formData.getAll("languages").map(String).filter(Boolean);
  // Explicit template choice: empty = "recommend for me" (classifier decides) — omit the key.
  const templateKey = String(formData.get("template_key") ?? "").trim();
  try {
    const { sessionId } = await startOnboarding(resolved.ctx, resolved.archetype, {
      business_name: String(formData.get("business_name") ?? ""),
      business_description: String(formData.get("business_description") ?? ""),
      ...(templateKey ? { template_key: templateKey } : {}),
      country: String(formData.get("country") ?? "AE"),
      base_currency: String(formData.get("base_currency") ?? "AED"),
      languages: languages.length ? languages : ["ar", "en"],
      six_day_week: formData.get("six_day_week") === "on",
      vat_registered: formData.get("vat_registered") === "on",
      job_term_en: String(formData.get("job_term_en") ?? ""),
      job_term_ar: String(formData.get("job_term_ar") ?? ""),
      approval_auto_approve_below: auto,
      requested_features: [],
    });
    revalidatePath(`/o/${orgId}/onboarding`);
    redirect(`/o/${orgId}/onboarding/${sessionId}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof OnboardingCapError
        ? "cap"
        : err instanceof OnboardingValidationError
          ? "invalid"
          : err instanceof ForbiddenError
            ? "forbidden"
            : "failed";
    redirect(`/o/${orgId}/onboarding?error=${code}`);
  }
}

/**
 * "Use this template instead": re-run the proposal with the SAME stored intake but the
 * chosen template as an explicit override → a NEW session (redirected to). The old
 * session is never mutated — the template_key column grant forbids it by design.
 */
export async function chooseAlternativeAction(
  orgId: string,
  sessionId: string,
  templateKey: string,
  formData: FormData,
): Promise<void> {
  void formData;
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  try {
    const session = await getOnboardingSession(resolved.ctx, resolved.archetype, sessionId);
    if (!session) throw new OnboardingError("session not found");
    const { sessionId: newSessionId } = await startOnboarding(resolved.ctx, resolved.archetype, {
      ...session.intake,
      template_key: templateKey,
    });
    revalidatePath(`/o/${orgId}/onboarding`);
    redirect(`/o/${orgId}/onboarding/${newSessionId}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof OnboardingCapError
        ? "cap"
        : err instanceof OnboardingValidationError
          ? "invalid"
          : err instanceof ForbiddenError
            ? "forbidden"
            : "failed";
    redirect(`/o/${orgId}/onboarding?error=${code}`);
  }
}

export async function applyOnboardingAction(
  orgId: string,
  sessionId: string,
  formData: FormData,
): Promise<void> {
  void formData;
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  try {
    await applyOnboarding(resolved.ctx, resolved.archetype, sessionId);
    revalidatePath(`/o/${orgId}`);
    redirect(`/o/${orgId}/onboarding/${sessionId}?applied=1`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/onboarding/${sessionId}?error=apply`);
  }
}

export async function undoOnboardingAction(
  orgId: string,
  sessionId: string,
  formData: FormData,
): Promise<void> {
  void formData;
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  try {
    await undoOnboarding(resolved.ctx, resolved.archetype, sessionId);
    revalidatePath(`/o/${orgId}`);
    redirect(`/o/${orgId}/onboarding/${sessionId}?undone=1`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/onboarding/${sessionId}?error=undo`);
  }
}
