"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createItem } from "@/modules/masters/service";

export async function createItemAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/items`;
  try {
    const cost = String(formData.get("unit_cost_minor") ?? "").trim();
    const price = String(formData.get("selling_price_minor") ?? "").trim();
    await createItem(resolved.ctx, resolved.archetype, {
      sku: String(formData.get("sku") ?? ""),
      name: String(formData.get("name") ?? ""),
      categoryKey: String(formData.get("category_key") ?? ""),
      unit: String(formData.get("unit") ?? ""),
      unitCostMinor: cost ? Number(cost) : undefined,
      sellingPriceMinor: price ? Number(price) : undefined,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=create_failed`);
  }
  revalidatePath(base);
  redirect(base);
}
