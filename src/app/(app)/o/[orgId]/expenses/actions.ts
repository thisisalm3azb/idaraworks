"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import { toMinorUnits } from "@/platform/format/money";
import type { CurrencyCode } from "@/platform/registries";
import {
  createExpense,
  voidExpense,
  InvalidExpenseInputError,
  ExpenseStateError,
} from "@/modules/expenses/service";

export async function createExpenseAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const currency = resolved.baseCurrency as CurrencyCode;
  const jobId = String(formData.get("job_id") ?? "").trim();
  try {
    await createExpense(resolved.ctx, resolved.archetype, {
      jobId: jobId === "" ? null : jobId,
      categoryKey: String(formData.get("category_key") ?? ""),
      description: String(formData.get("description") ?? ""),
      expenseDate: String(formData.get("expense_date") ?? ""),
      amountMinor: toMinorUnits(String(formData.get("amount") ?? "0"), currency),
      vatAmountMinor: toMinorUnits(String(formData.get("vat_amount") ?? "0") || "0", currency),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof InvalidExpenseInputError
          ? "invalid"
          : "failed";
    redirect(`/o/${orgId}/expenses/new?error=${code}`);
  }
  revalidatePath(`/o/${orgId}/expenses`);
  redirect(`/o/${orgId}/expenses?ok=created`);
}

export async function voidExpenseAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const expenseId = String(formData.get("expense_id") ?? "");
  const base = `/o/${orgId}/expenses/${expenseId}`;
  try {
    await voidExpense(resolved.ctx, resolved.archetype, {
      expenseId,
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof ExpenseStateError
          ? "state"
          : "failed";
    redirect(`${base}?error=${code}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=voided`);
}
