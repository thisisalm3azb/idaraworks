"use server";

/**
 * H28 — operator controls (ADR-55). Every action verifies the session and
 * then lets the database decide: the definer functions assert an active
 * `platform_operator` row and no organisation context, and they write the
 * audit entry themselves. Nothing here trusts a role in an organisation.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  grantCredits,
  isPlatformOperator,
  NotOperatorError,
  setKillSwitch,
  setOrgAiPolicy,
  setProviderEnabled,
  type AiProviderKey,
} from "@/platform/ai";
import { getSessionUser } from "@/platform/auth/resolve";
import { idaraEnabled } from "@/platform/flags";

const BASE = "/platform/ai";

async function operatorOrRedirect(): Promise<string> {
  if (!idaraEnabled()) redirect("/");
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/platform/ai");
  if (!(await isPlatformOperator(user.id))) redirect("/");
  return user.id;
}

function fail(err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  redirect(`${BASE}?error=${err instanceof NotOperatorError ? "forbidden" : "failed"}`);
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

export async function setKillSwitchAction(
  scope: string,
  scopeKey: string,
  fd: FormData,
): Promise<void> {
  const userId = await operatorOrRedirect();
  try {
    const s = z.enum(["global", "org", "agent", "provider", "model"]).parse(scope);
    await setKillSwitch(
      userId,
      s,
      scopeKey,
      str(fd, "active") === "on",
      str(fd, "reason") ?? "owner action",
    );
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=switch`);
}

export async function setProviderEnabledAction(providerKey: string, fd: FormData): Promise<void> {
  const userId = await operatorOrRedirect();
  try {
    await setProviderEnabled(
      userId,
      z.enum(["openai", "anthropic"]).parse(providerKey) as AiProviderKey,
      str(fd, "enabled") === "on",
      str(fd, "reason") ?? "owner action",
    );
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=provider`);
}

export async function setOrgPolicyAction(orgId: string, fd: FormData): Promise<void> {
  const userId = await operatorOrRedirect();
  try {
    const mode = z
      .enum(["disabled", "trial", "included", "prepaid", "enterprise", "byok"])
      .parse(str(fd, "mode"));
    const credits = str(fd, "monthlyCredits");
    await setOrgAiPolicy(
      userId,
      z.string().uuid().parse(orgId),
      { mode, monthly_credits: credits === null ? null : Number(credits) },
      "owner set the organisation AI policy",
    );
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=policy`);
}

export async function grantCreditsAction(orgId: string, fd: FormData): Promise<void> {
  const userId = await operatorOrRedirect();
  try {
    const credits = Number(str(fd, "credits") ?? 0);
    if (!Number.isFinite(credits) || credits <= 0)
      throw new Error("credits must be a positive number");
    await grantCredits(
      userId,
      z.string().uuid().parse(orgId),
      credits,
      "manual",
      new Date().toISOString().slice(0, 7),
      "owner grant",
    );
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?ok=credits`);
}
