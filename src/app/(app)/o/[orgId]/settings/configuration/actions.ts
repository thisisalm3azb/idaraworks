"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { assertCan } from "@/platform/authz";
import { isTermKey } from "@/platform/registries";
import {
  applyConfigChange,
  installTemplate,
  undoRevision,
  ConfigGuardError,
  ConfigValidationError,
} from "@/platform/config";
import { sql, withCtx } from "@/platform/tenancy";

async function resolveOr(orgId: string) {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  assertCan(resolved.archetype, "config.manage");
  return resolved;
}

function errCode(err: unknown): string {
  if (err instanceof ConfigGuardError) return "guard";
  if (err instanceof ConfigValidationError) return "invalid";
  return "failed";
}

export async function installTemplateAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const base = `/o/${orgId}/settings/configuration`;
  try {
    await installTemplate(resolved.ctx, String(formData.get("template_key") ?? ""));
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${errCode(err)}`);
  }
  revalidatePath(base);
  redirect(`${base}?notice=installed`);
}

export async function saveTermAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const base = `/o/${orgId}/settings/configuration`;
  const key = String(formData.get("term_key") ?? "");
  if (!isTermKey(key)) redirect(`${base}?error=invalid`);
  try {
    // Merge this key into the CURRENT override blob — one revision per save.
    const rows = (await withCtx(resolved.ctx, (tx) =>
      tx.execute(sql`
        select value from public.app_settings
        where org_id = ${resolved.ctx.orgId} and key = 'terminology.overrides'
      `),
    )) as unknown as Array<{ value: Record<string, unknown> }>;
    const current = rows[0]?.value ?? {};
    const next = {
      ...current,
      [key]: {
        en: {
          singular: String(formData.get("en_singular") ?? ""),
          plural: String(formData.get("en_plural") ?? ""),
        },
        ar: {
          singular: String(formData.get("ar_singular") ?? ""),
          plural: String(formData.get("ar_plural") ?? ""),
          gender: (formData.get("ar_gender") as "m" | "f") || "m",
        },
      },
    };
    await applyConfigChange(resolved.ctx, "terminology.overrides", next, {
      summary: `Renamed "${key}"`,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${errCode(err)}`);
  }
  revalidatePath(base);
  revalidatePath(`/o/${orgId}`, "layout"); // nav labels change with terms
  redirect(base);
}

export async function undoRevisionAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveOr(orgId);
  const base = `/o/${orgId}/settings/configuration`;
  try {
    await undoRevision(resolved.ctx, String(formData.get("revision_id") ?? ""));
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${errCode(err)}`);
  }
  revalidatePath(base);
  revalidatePath(`/o/${orgId}`, "layout");
  redirect(base);
}
