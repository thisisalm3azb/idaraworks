"use server";

/**
 * H31 — the company app settings actions.
 *
 * Every one re-resolves the caller from the session and lets the module check
 * `config.manage` itself. The form is never trusted for identity, and hiding a
 * control is never the thing standing between a user and a write.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { brandedCompanyAppsEnabled } from "@/platform/flags";
import {
  CompanyAppError,
  claimSubdomain,
  requestCustomDomain,
  saveAppBrand,
} from "@/modules/companyapp/service";

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function back(orgId: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  revalidatePath(`/o/${orgId}/settings/app`);
  redirect(`/o/${orgId}/settings/app${q ? `?${q}` : ""}`);
}

async function guard(orgId: string) {
  if (!brandedCompanyAppsEnabled()) redirect(`/o/${orgId}`);
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

export async function saveAppBrandAction(orgId: string, form: FormData): Promise<void> {
  const resolved = await guard(orgId);
  try {
    await saveAppBrand(resolved.ctx, resolved.archetype, {
      appName: str(form, "app_name"),
      appShortName: str(form, "app_short_name"),
      appDescription: str(form, "app_description"),
      brandColor: str(form, "brand_color"),
      backgroundColor: str(form, "background_color"),
      defaultLocale: str(form, "default_locale"),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof CompanyAppError) back(orgId, { error: err.messageKey });
    throw err;
  }
  back(orgId, { ok: "saved" });
}

export async function claimSubdomainAction(orgId: string, form: FormData): Promise<void> {
  const resolved = await guard(orgId);
  try {
    await claimSubdomain(resolved.ctx, resolved.archetype, str(form, "slug"));
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof CompanyAppError) back(orgId, { error: err.messageKey });
    throw err;
  }
  back(orgId, { ok: "reserved" });
}

export async function requestCustomDomainAction(orgId: string, form: FormData): Promise<void> {
  const resolved = await guard(orgId);
  try {
    await requestCustomDomain(resolved.ctx, resolved.archetype, str(form, "domain"));
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof CompanyAppError) back(orgId, { error: err.messageKey });
    throw err;
  }
  back(orgId, { ok: "domain_requested" });
}
