"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtxForAction } from "@/platform/auth/resolve";
import { ForbiddenError } from "@/platform/authz";
import {
  createPurchaseOrder,
  submitPurchaseOrder,
  recordGoodsReceipt,
  InvalidSupplyInputError,
  SupplyStateError,
} from "@/modules/supply/service";

export type PoCreatePayload = {
  supplierId: string;
  jobId?: string;
  vatMinor: number;
  notes?: string;
  lines: Array<{ itemName: string; qty: number; unit: string; unitCostMinor: number }>;
};

export async function createPoAction(
  orgId: string,
  payload: PoCreatePayload,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const resolved = await resolveCtxForAction(orgId);
  if (typeof resolved === "string") return { ok: false, error: "unauthorized" };
  try {
    const { id } = await createPurchaseOrder(resolved.ctx, resolved.archetype, payload);
    revalidatePath(`/o/${orgId}/purchase-orders`);
    return { ok: true, id };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, error: "forbidden" };
    if (err instanceof InvalidSupplyInputError) return { ok: false, error: "invalid" };
    return { ok: false, error: "failed" };
  }
}

export async function submitPoAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const poId = String(formData.get("po_id") ?? "");
  const base = `/o/${orgId}/purchase-orders/${poId}`;
  try {
    await submitPurchaseOrder(resolved.ctx, resolved.archetype, poId);
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    redirect(`${base}?error=${err instanceof SupplyStateError ? "state" : "failed"}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=submitted`);
}

export async function recordGrnAction(orgId: string, formData: FormData): Promise<void> {
  const resolved = await resolveCtxForAction(orgId);
  if (resolved === "mfa_required") redirect("/mfa");
  if (typeof resolved === "string") redirect("/");
  const poId = String(formData.get("po_id") ?? "");
  const base = `/o/${orgId}/purchase-orders/${poId}`;
  // One received qty per PO line: fields named recv_<poLineId>.
  const lines: Array<{ poLineId: string; receivedQty: number }> = [];
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("recv_")) {
      const qty = Number(v);
      if (qty > 0) lines.push({ poLineId: k.slice(5), receivedQty: qty });
    }
  }
  try {
    await recordGoodsReceipt(resolved.ctx, resolved.archetype, {
      poId,
      receivedDate: String(formData.get("received_date") ?? ""),
      lines,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    const code =
      err instanceof ForbiddenError
        ? "forbidden"
        : err instanceof SupplyStateError
          ? "state"
          : err instanceof InvalidSupplyInputError
            ? "invalid"
            : "failed";
    redirect(`${base}?error=${code}`);
  }
  revalidatePath(base);
  redirect(`${base}?ok=received`);
}
