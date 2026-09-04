"use server";

/**
 * H30 LB-2 — the server actions behind warehouse setup.
 *
 * Every one re-resolves the caller's context and archetype from the session; the
 * form is never trusted for identity, and the module re-checks the permission
 * itself, so hiding a button is never the only thing standing between a user and
 * a write.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { resolveCtx } from "@/platform/auth/resolve";
import { stockSurfacesEnabled } from "@/platform/flags";
import {
  createLocation,
  createWarehouse,
  setDefaultReceiving,
  WarehouseSetupError,
  LOCATION_KINDS,
  type LocationKind,
} from "@/modules/inventory/service";

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

/** One place decides where a result goes, so every action reports the same way. */
function back(orgId: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  revalidatePath(`/o/${orgId}/stock/warehouses`);
  redirect(`/o/${orgId}/stock/warehouses${q ? `?${q}` : ""}`);
}

async function guard(orgId: string) {
  if (!stockSurfacesEnabled()) redirect(`/o/${orgId}`);
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  return resolved;
}

export async function createWarehouseAction(orgId: string, form: FormData): Promise<void> {
  const resolved = await guard(orgId);
  try {
    await createWarehouse(resolved.ctx, resolved.archetype, {
      code: str(form, "code"),
      nameEn: str(form, "name_en"),
      nameAr: str(form, "name_ar"),
      city: str(form, "city"),
      // An unchecked box posts nothing at all, so absence means "no".
      withReceivingBay: form.get("with_receiving") !== null,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof WarehouseSetupError) back(orgId, { error: err.messageKey });
    throw err;
  }
  back(orgId, { ok: "created" });
}

export async function createLocationAction(orgId: string, form: FormData): Promise<void> {
  const resolved = await guard(orgId);
  const kind = str(form, "kind") as LocationKind;
  try {
    await createLocation(resolved.ctx, resolved.archetype, {
      warehouseId: str(form, "warehouse_id"),
      code: str(form, "code"),
      nameEn: str(form, "name_en"),
      nameAr: str(form, "name_ar"),
      // Validated by the module against the same closed list the table checks.
      kind: LOCATION_KINDS.includes(kind) ? kind : ("storage" as LocationKind),
      canHoldStock: form.get("can_hold_stock") !== null,
    });
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof WarehouseSetupError) back(orgId, { error: err.messageKey });
    throw err;
  }
  back(orgId, { ok: "location_created" });
}

export async function setDefaultReceivingAction(orgId: string, form: FormData): Promise<void> {
  const resolved = await guard(orgId);
  try {
    await setDefaultReceiving(resolved.ctx, resolved.archetype, str(form, "location_id"));
  } catch (err) {
    if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    if (err instanceof WarehouseSetupError) back(orgId, { error: err.messageKey });
    throw err;
  }
  back(orgId, { ok: "default_set" });
}
