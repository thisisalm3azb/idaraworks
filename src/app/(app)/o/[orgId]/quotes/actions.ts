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
  convertQuoteToJob,
  rejectQuote,
  QuoteStateError,
  InvalidQuoteInputError,
  recoverStaleConversion,
} from "@/modules/quotes/service";

/** Typed create result (003C): the client form keeps every entered value on
 * failure and receives a SPECIFIC code where the service distinguishes causes
 * — never a raw exception detail, never a destructive redirect. */
export type CreateQuoteResult = { ok: true; id: string } | { ok: false; error: string };

export async function createQuoteAction(
  orgId: string,
  formData: FormData,
): Promise<CreateQuoteResult> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") return { ok: false, error: "unauthorized" };
  const currency = resolved.baseCurrency as CurrencyCode;
  const presetId = String(formData.get("preset_id") ?? "").trim();
  const customerId = String(formData.get("customer_id") ?? "").trim();
  const opportunityId = String(formData.get("opportunity_id") ?? "").trim();
  try {
    const { id } = await createQuote(resolved.ctx, resolved.archetype, {
      customerId: customerId || undefined,
      presetId: presetId || undefined,
      opportunityId: opportunityId || undefined,
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
    return { ok: true, id };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: "forbidden" };
    if (err instanceof InvalidQuoteInputError) {
      // The service's controlled messages distinguish these causes; the codes
      // map to specific i18n strings — the raw message never reaches the user.
      if (err.message === "customer archived") return { ok: false, error: "customer_archived" };
      if (err.message === "customer not found") return { ok: false, error: "customer_invalid" };
      return { ok: false, error: "invalid" };
    }
    return { ok: false, error: "failed" };
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
    redirect(
      `${base}?error=${err instanceof QuoteStateError ? `${ok === "submitted" ? "submit" : ok === "sent" ? "send" : "action"}_state` : "failed"}`,
    );
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
    const accepted = await acceptQuote(resolved.ctx, resolved.archetype, id, {
      note: String(formData.get("note") ?? "") || undefined,
    });
    revalidatePath(`/o/${orgId}/quotes/${id}`);
    // A quotation with a template starts its project at once; one without
    // records the acceptance and returns here for the template (D4).
    if (accepted.jobId) redirect(`/o/${orgId}/jobs/${accepted.jobId}?ok=quote_converted`);
    redirect(`/o/${orgId}/quotes/${id}?ok=accepted`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/quotes/${id}?error=${err instanceof QuoteStateError ? "accept_state" : "failed"}`,
    );
  }
}

/** Start the project from an accepted quotation with the template chosen now (D4). */
export async function convertQuoteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("quote_id") ?? "");
  const presetId = String(formData.get("preset_id") ?? "").trim();
  if (!presetId) redirect(`/o/${orgId}/quotes/${id}?error=no_template`);
  try {
    const { jobId } = await convertQuoteToJob(resolved.ctx, resolved.archetype, id, {
      presetId,
      jobName: String(formData.get("job_name") ?? "").trim() || undefined,
    });
    revalidatePath(`/o/${orgId}/quotes/${id}`);
    redirect(`/o/${orgId}/jobs/${jobId}?ok=quote_converted`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/quotes/${id}?error=${err instanceof QuoteStateError ? "convert_state" : "failed"}`,
    );
  }
}

/** Release a quotation stuck in `converting` (see recoverStaleConversion). */
export async function recoverQuoteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("quote_id") ?? "");
  const base = `/o/${orgId}/quotes/${id}`;
  try {
    const result = await recoverStaleConversion(resolved.ctx, resolved.archetype, id);
    revalidatePath(base);
    redirect(`${base}?ok=${result === "not_stale" ? "still_converting" : "recovered"}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof QuoteStateError ? "convert_state" : "failed"}`);
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
    redirect(`${base}?error=${err instanceof QuoteStateError ? "reject_state" : "failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=rejected`);
}
