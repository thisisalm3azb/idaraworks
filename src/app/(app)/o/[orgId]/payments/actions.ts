"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { toMinorUnits } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import { recordPayment, voidPayment, PaymentStateError } from "@/modules/payments/service";

export async function recordPaymentAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const currency = resolved.baseCurrency as CurrencyCode;
  const invoiceId = String(formData.get("invoice_id") ?? "").trim();
  try {
    await recordPayment(resolved.ctx, resolved.archetype, {
      invoiceId: invoiceId || undefined,
      method: String(formData.get("method") ?? "bank_transfer") as never,
      paymentDate: String(formData.get("payment_date") ?? ""),
      amountMinor: toMinorUnits(String(formData.get("amount") ?? "0"), currency),
      currency,
      externalReference: String(formData.get("external_reference") ?? "") || undefined,
      idempotencyKey: String(formData.get("idempotency_key") ?? "") || undefined,
    });
    revalidatePath(`/o/${orgId}/payments`);
    redirect(`/o/${orgId}/payments?ok=recorded`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/payments/new?error=${err instanceof ForbiddenError ? "forbidden" : "failed"}`,
    );
  }
}

export async function voidPaymentAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("payment_id") ?? "");
  try {
    await voidPayment(resolved.ctx, resolved.archetype, id, String(formData.get("reason") ?? ""));
    revalidatePath(`/o/${orgId}/payments`);
    redirect(`/o/${orgId}/payments?ok=voided`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`/o/${orgId}/payments?error=${err instanceof PaymentStateError ? "state" : "failed"}`);
  }
}
