"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  createMaterialRequest,
  submitMaterialRequest,
  convertMrToPo,
  InvalidSupplyInputError,
  SupplyStateError,
} from "@/modules/supply/service";

export type MrCreatePayload = {
  jobId?: string;
  urgency: "low" | "normal" | "high" | "urgent";
  requiredDate?: string;
  notes?: string;
  lines: Array<{
    itemId?: string;
    itemName: string;
    qty: number;
    unit: string;
    estUnitCostMinor?: number;
  }>;
};

export async function createMrAction(
  orgId: string,
  payload: MrCreatePayload,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return { ok: false, error: "unauthorized" };
  try {
    const { id } = await createMaterialRequest(resolved.ctx, resolved.archetype, payload);
    revalidatePath(`/o/${orgId}/material-requests`);
    return { ok: true, id };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: "forbidden" };
    if (err instanceof InvalidSupplyInputError) return { ok: false, error: "invalid" };
    return { ok: false, error: "failed" };
  }
}

export async function submitMrAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const mrId = String(formData.get("mr_id") ?? "");
  const base = `/o/${orgId}/material-requests/${mrId}`;
  try {
    await submitMaterialRequest(resolved.ctx, resolved.archetype, mrId);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof SupplyStateError ? "state" : "failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=submitted`);
}

export async function convertMrAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const mrId = String(formData.get("mr_id") ?? "");
  try {
    const { poId } = await convertMrToPo(resolved.ctx, resolved.archetype, mrId, {
      supplierId: String(formData.get("supplier_id") ?? ""),
      vatMinor: Number(formData.get("vat_minor") ?? 0) || 0,
    });
    revalidatePath(`/o/${orgId}/material-requests/${mrId}`);
    redirect(`/o/${orgId}/purchase-orders/${poId}`);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof SupplyStateError
          ? "state"
          : "failed";
    redirect(`/o/${orgId}/material-requests/${mrId}?error=${code}`);
  }
}
