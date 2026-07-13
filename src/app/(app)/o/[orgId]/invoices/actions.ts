"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { toMinorUnits } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import {
  createInvoice,
  issueInvoice,
  voidInvoice,
  createCreditNote,
  submitEInvoice,
  InvoiceStateError,
  InvalidInvoiceInputError,
} from "@/modules/invoices/service";

export async function createInvoiceAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const currency = resolved.baseCurrency as CurrencyCode;
  const customerId = String(formData.get("customer_id") ?? "").trim();
  const jobId = String(formData.get("job_id") ?? "").trim();
  try {
    const { id } = await createInvoice(resolved.ctx, resolved.archetype, {
      customerId: customerId || undefined,
      jobId: jobId || undefined,
      isExport: formData.get("is_export") === "on",
      currency,
      dueDate: String(formData.get("due_date") ?? "") || undefined,
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
    revalidatePath(`/o/${orgId}/invoices`);
    redirect(`/o/${orgId}/invoices/${id}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof InvalidInvoiceInputError
          ? "invalid"
          : "failed";
    redirect(`/o/${orgId}/invoices/new?error=${code}`);
  }
}

export async function issueInvoiceAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("invoice_id") ?? "");
  const base = `/o/${orgId}/invoices/${id}`;
  try {
    await issueInvoice(resolved.ctx, resolved.archetype, id);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof InvoiceStateError ? "state" : "failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=issued`);
}

export async function voidInvoiceAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("invoice_id") ?? "");
  const base = `/o/${orgId}/invoices/${id}`;
  try {
    await voidInvoice(resolved.ctx, resolved.archetype, id, String(formData.get("reason") ?? ""));
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof InvoiceStateError ? "state" : "failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=voided`);
}

export async function creditNoteAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("invoice_id") ?? "");
  try {
    const cn = await createCreditNote(
      resolved.ctx,
      resolved.archetype,
      id,
      String(formData.get("reason") ?? ""),
    );
    revalidatePath(`/o/${orgId}/invoices`);
    redirect(`/o/${orgId}/invoices/${cn.id}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(
      `/o/${orgId}/invoices/${id}?error=${err instanceof InvoiceStateError ? "state" : "failed"}`,
    );
  }
}

export async function submitEInvoiceAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const id = String(formData.get("invoice_id") ?? "");
  const base = `/o/${orgId}/invoices/${id}`;
  try {
    const res = await submitEInvoice(resolved.ctx, resolved.archetype, id);
    revalidatePath(base);
    redirect(`${base}?ok=einvoice_${res.status}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof InvoiceStateError ? "state" : "failed"}`);
  }
}
