"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { createItem } from "@/modules/masters/service";
import { failMasterDataAction } from "@/platform/http/actionError";

export async function createItemAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const base = `/o/${orgId}/items`;
  // Captured up front so a failure can echo them back — the form is never wiped.
  const values = {
    sku: String(formData.get("sku") ?? ""),
    name: String(formData.get("name") ?? ""),
    category_key: String(formData.get("category_key") ?? ""),
    unit: String(formData.get("unit") ?? ""),
    unit_cost_minor: String(formData.get("unit_cost_minor") ?? "").trim(),
    selling_price_minor: String(formData.get("selling_price_minor") ?? "").trim(),
  };
  try {
    await createItem(resolved.ctx, resolved.archetype, {
      sku: values.sku,
      name: values.name,
      categoryKey: values.category_key,
      unit: values.unit,
      unitCostMinor: values.unit_cost_minor ? Number(values.unit_cost_minor) : undefined,
      sellingPriceMinor: values.selling_price_minor
        ? Number(values.selling_price_minor)
        : undefined,
    });
  } catch (err) {
    return failMasterDataAction(err, { ctx: resolved.ctx, base, entity: "item", values });
  }
  revalidatePath(base);
  redirect(base);
}
