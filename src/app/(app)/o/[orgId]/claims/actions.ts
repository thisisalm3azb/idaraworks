"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import {
  createClaim,
  submitClaim,
  cancelClaim,
  settleClaimToExpenseBook,
  myEmployee,
} from "@/modules/hr/service";

/**
 * The new-claim form ships a fixed number of line blocks; empty blocks are
 * ignored. Amounts arrive in MAJOR units and convert to integer minor units
 * here — the one place a human-typed decimal becomes money.
 */
export async function createClaimAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/claims`;
  const me = await myEmployee(resolved.ctx);
  if (!me) redirect(`${base}?error=not_employee`);

  const lines: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 5; i++) {
    const date = String(formData.get(`line_${i}_date`) ?? "").trim();
    const description = String(formData.get(`line_${i}_description`) ?? "").trim();
    const amountRaw = String(formData.get(`line_${i}_amount`) ?? "").trim();
    const kmRaw = String(formData.get(`line_${i}_km`) ?? "").trim();
    const category = String(formData.get(`line_${i}_category`) ?? "").trim();
    if (!date && !description && !amountRaw && !kmRaw) continue; // unused block
    lines.push({
      expenseDate: date,
      categoryKey: category,
      description,
      ...(amountRaw ? { amountMinor: Math.round(Number(amountRaw) * 100) } : {}),
      ...(kmRaw ? { mileageKm: Number(kmRaw) } : {}),
    });
  }

  let id = "";
  try {
    const r = await createClaim(resolved.ctx, resolved.archetype, {
      employeeId: me.id,
      title: String(formData.get("title") ?? ""),
      settlementRoute: String(formData.get("route") ?? "payroll"),
      lines,
    });
    id = r.id;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}/new?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}/${id}?ok=created`);
}

export async function submitClaimAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const claimId = String(formData.get("claim_id") ?? "");
  const base = `/o/${orgId}/claims/${claimId}`;
  let warnings = 0;
  try {
    const r = await submitClaim(resolved.ctx, resolved.archetype, { claimId });
    warnings = r.warnings.length;
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=submitted${warnings > 0 ? `&warn=${warnings}` : ""}`);
}

export async function cancelClaimAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const claimId = String(formData.get("claim_id") ?? "");
  const base = `/o/${orgId}/claims`;
  try {
    await cancelClaim(resolved.ctx, resolved.archetype, { claimId });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}/${claimId}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=cancelled`);
}

export async function settleClaimAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const claimId = String(formData.get("claim_id") ?? "");
  const base = `/o/${orgId}/claims/${claimId}`;
  try {
    await settleClaimToExpenseBook(resolved.ctx, resolved.archetype, { claimId });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=failed`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=settled`);
}
