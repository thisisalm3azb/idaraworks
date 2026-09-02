"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  applyTerritoryRules,
  createTerritory,
  setTarget,
  updateTerritory,
} from "@/modules/crm/service";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const list = (fd: FormData, k: string) =>
  (str(fd, k) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
async function ctxOrRedirect(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  return resolved;
}
function fail(back: string, err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  redirect(`${back}?error=${err instanceof ForbiddenError ? "forbidden" : "failed"}`);
}

export async function createTerritoryAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/targets`;
  try {
    await createTerritory(resolved.ctx, resolved.archetype, {
      key: str(formData, "key") ?? "",
      name: {
        en: str(formData, "name_en") ?? undefined,
        ar: str(formData, "name_ar") ?? undefined,
      },
      rules: {
        countries: list(formData, "countries").map((c) => c.toUpperCase()),
        tags: list(formData, "tags"),
        segments: list(formData, "segments"),
      },
      ownerUserId: str(formData, "owner_user_id"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=territory`);
  } catch (err) {
    fail(back, err);
  }
}

export async function updateTerritoryAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/targets`;
  try {
    await updateTerritory(resolved.ctx, resolved.archetype, {
      id: String(formData.get("id") ?? ""),
      active: formData.get("active") === undefined ? undefined : formData.get("active") === "on",
      ownerUserId: str(formData, "owner_user_id"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=saved`);
  } catch (err) {
    fail(back, err);
  }
}

/** Assign customers without a territory by the rules; nothing already assigned is moved. */
export async function applyTerritoryRulesAction(orgId: string, formData: FormData): Promise<void> {
  void formData;
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/targets`;
  try {
    const r = await applyTerritoryRules(resolved.ctx, resolved.archetype, false);
    revalidatePath(back);
    redirect(`${back}?ok=applied&n=${r.applied}`);
  } catch (err) {
    fail(back, err);
  }
}

export async function setTargetAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await ctxOrRedirect(orgId);
  const back = `/o/${orgId}/revenue/targets`;
  const metric = str(formData, "metric") ?? "revenue";
  const countMetric = metric === "activities" || metric === "new_customers";
  const amount = str(formData, "amount_major");
  const count = str(formData, "count_target");
  const scopeKind = str(formData, "scope_kind") ?? "org";
  try {
    await setTarget(resolved.ctx, resolved.archetype, {
      scopeKind,
      scopeId: scopeKind === "org" ? null : str(formData, "scope_id"),
      metric,
      periodStart: str(formData, "period_start") ?? "",
      periodEnd: str(formData, "period_end") ?? "",
      amountMinor:
        countMetric || amount === null ? null : Math.round(Number(amount.replace(/,/g, "")) * 100),
      countTarget: countMetric && count !== null ? Number(count) : null,
      currency: countMetric
        ? null
        : (str(formData, "currency")?.toUpperCase() ?? resolved.baseCurrency),
      note: str(formData, "note"),
    });
    revalidatePath(back);
    redirect(`${back}?ok=target`);
  } catch (err) {
    fail(back, err);
  }
}
