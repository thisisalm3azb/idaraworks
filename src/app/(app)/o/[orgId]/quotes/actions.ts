"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { toMinorUnits } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import {
  createQuote,
  submitQuote,
  markQuoteSent,
  acceptQuote,
  rejectQuote,
  QuoteStateError,
  InvalidQuoteInputError,
} from "@/modules/quotes/service";

export async function createQuoteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const currency = resolved.baseCurrency as CurrencyCode;
  const presetId = String(formData.get("preset_id") ?? "").trim();
  const customerId = String(formData.get("customer_id") ?? "").trim();
  try {
    const { id } = await createQuote(resolved.ctx, resolved.archetype, {
      customerId: customerId || undefined,
      presetId: presetId || undefined,
      currency,
      terms: String(formData.get("terms") ?? "") || undefined,
      lines: [
        {
          description: String(formData.get("description") ?? ""),
          qty: Number(formData.get("qty") ?? 1) || 1,
          unit: String(formData.get("unit") ?? "unit"),
          unitPriceMinor: toMinorUnits(String(formData.get("unit_price") ?? "0"), currency),
          vatRate: Number(formData.get("vat_rate") ?? 0) || 0,
        },
      ],
    });
    revalidatePath(`/o/${orgId}/quotes`);
    redirect(`/o/${orgId}/quotes/${id}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof InvalidQuoteInputError
          ? "invalid"
          : "failed";
    redirect(`/o/${orgId}/quotes/new?error=${code}`);
  }
}

async function quoteTransition(
  orgId: string,
  formData: FormData,
  fn: (ctx: never, arch: never, id: string) => Promise<unknown>,
  ok: string,
): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("quote_id") ?? "");
  const base = `/o/${orgId}/quotes/${id}`;
  try {
    await fn(resolved.ctx as never, resolved.archetype as never, id);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof QuoteStateError ? "state" : "failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=${ok}`);
}

export async function submitQuoteAction(orgId: string, formData: FormData): Promise<void> {
  await quoteTransition(orgId, formData, (c, a, id) => submitQuote(c, a, id), "submitted");
}
export async function sendQuoteAction(orgId: string, formData: FormData): Promise<void> {
  await quoteTransition(orgId, formData, (c, a, id) => markQuoteSent(c, a, id), "sent");
}
export async function acceptQuoteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("quote_id") ?? "");
  try {
    const { jobId } = await acceptQuote(resolved.ctx, resolved.archetype, id, {
      note: String(formData.get("note") ?? "") || undefined,
    });
    revalidatePath(`/o/${orgId}/quotes/${id}`);
    redirect(`/o/${orgId}/jobs/${jobId}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/quotes/${id}?error=${err instanceof QuoteStateError ? "state" : "failed"}`,
    );
  }
}
export async function rejectQuoteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("quote_id") ?? "");
  const base = `/o/${orgId}/quotes/${id}`;
  try {
    await rejectQuote(resolved.ctx, resolved.archetype, id, String(formData.get("reason") ?? ""));
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof QuoteStateError ? "state" : "failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=rejected`);
}
