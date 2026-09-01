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
import { postGoodsReceiptToStock } from "@/modules/inventory/service";
import { can } from "@/platform/authz";
import { stockSurfacesEnabled } from "@/platform/flags";
import { logger } from "@/platform/logger";

export type PoCreatePayload = {
  supplierId: string;
  jobId?: string;
  vatMinor: number;
  notes?: string;
  lines: Array<{
    /** Set when the line names a catalogue item — the link stock depends on. */
    itemId?: string;
    itemName: string;
    qty: number;
    unit: string;
    unitCostMinor: number;
  }>;
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
  let receiptId = "";
  try {
    const receipt = await recordGoodsReceipt(resolved.ctx, resolved.archetype, {
      poId,
      receivedDate: String(formData.get("received_date") ?? ""),
      lines,
    });
    receiptId = receipt.id;
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
  /*
   * BOOK IT INTO STOCK.
   *
   * This is the join H22 was missing. H22C built the posting and nothing ever
   * called it, so the real receiving desk — this action, the one people
   * actually use — recorded a goods receipt and the stock ledger never heard
   * about it. Every stock screen would have stayed empty forever while the
   * paperwork said the goods had arrived.
   *
   * Deliberately AFTER the receipt is committed, not inside it. The receipt is
   * the record of a physical fact: a lorry came and goods were unloaded. That
   * must not be lost because a warehouse has no receiving bin configured or
   * because an item is missing a base unit. So a posting failure is reported as
   * its own outcome rather than swallowed or allowed to roll back the receipt —
   * and posting is idempotent under an advisory lock, so the fix is to correct
   * the setup and receive again, which re-posts without duplicating.
   *
   * Gated on the release flag as well as the permission: on a deployment where
   * the stock system is off, receiving behaves exactly as it did before.
   */
  if (receiptId && stockSurfacesEnabled() && can(resolved.archetype, "inventory.receive")) {
    try {
      await postGoodsReceiptToStock(resolved.ctx, resolved.archetype, receiptId);
    } catch (err) {
      if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
      logger.warn(
        { err: (err as Error).message, receiptId, orgId },
        "goods receipt recorded but not booked into stock",
      );
      revalidatePath(base);
      redirect(`${base}?ok=received&warn=not_stocked`);
    }
  }

  revalidatePath(base);
  redirect(`${base}?ok=received`);
}
