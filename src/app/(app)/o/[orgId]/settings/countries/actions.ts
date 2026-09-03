"use server";

/**
 * H29E — the Country Readiness Centre's writes.
 *
 * Every one of these goes through the country module's service door, which does
 * the permission check, the pack validation and the audit. Nothing here decides
 * anything: this file turns a form into the module's input shape and turns a
 * refusal back into a message the person can act on.
 *
 * Adoption in particular is deliberately a two-step: the preview is not a
 * courtesy, it is the record. `adoptPack` computes it again and stores it on the
 * adoption row, so what was shown and what was applied cannot drift.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { resolveCtx } from "@/platform/auth/resolve";
import { countryPacksEnabled } from "@/platform/flags";
import {
  adoptPack,
  CountryError,
  createEstablishment,
  setRegistration,
  updateEstablishment,
} from "@/modules/country/service";
import type { Ctx } from "@/platform/tenancy";
import type { RoleArchetype } from "@/platform/registries";

async function resolve(orgId: string): Promise<{ ctx: Ctx; archetype: RoleArchetype }> {
  if (!countryPacksEnabled()) redirect(`/o/${orgId}`);
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  return { ctx: resolved.ctx, archetype: resolved.archetype };
}

const str = (fd: FormData, k: string): string | undefined => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/**
 * The address arrives as `address.<field>` inputs so the form can be built from
 * the country's own schema without this file knowing any country's field names.
 */
function addressFrom(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (!key.startsWith("address.")) continue;
    if (typeof value !== "string" || value.trim() === "") continue;
    out[key.slice("address.".length)] = value.trim();
  }
  return out;
}

/** A refusal the person can act on: the module's own field problems, or a code. */
function fail(orgId: string, path: string, err: unknown): never {
  if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
  if (err instanceof CountryError) {
    const fields = err.problems.map((p) => p.field).join(",");
    redirect(
      `/o/${orgId}/settings/countries${path}?error=${err.kind}${fields ? `&fields=${encodeURIComponent(fields)}` : ""}`,
    );
  }
  redirect(`/o/${orgId}/settings/countries${path}?error=failed`);
}

export async function createEstablishmentAction(orgId: string, fd: FormData): Promise<void> {
  const { ctx, archetype } = await resolve(orgId);
  let id: string;
  try {
    const row = await createEstablishment(ctx, archetype, {
      code: str(fd, "code"),
      legalName: str(fd, "legalName"),
      tradingName: str(fd, "tradingName"),
      legalNameLocal: str(fd, "legalNameLocal"),
      country: str(fd, "country"),
      timezone: str(fd, "timezone"),
      baseCurrency: str(fd, "baseCurrency"),
      address: addressFrom(fd),
      isPrimary: fd.get("isPrimary") === "on",
    });
    id = row.id;
  } catch (e) {
    fail(orgId, "/new", e);
  }
  revalidatePath(`/o/${orgId}/settings/countries`);
  redirect(`/o/${orgId}/settings/countries/${id}?notice=created`);
}

export async function updateEstablishmentAction(
  orgId: string,
  id: string,
  fd: FormData,
): Promise<void> {
  const { ctx, archetype } = await resolve(orgId);
  try {
    const address = addressFrom(fd);
    await updateEstablishment(ctx, archetype, {
      id,
      legalName: str(fd, "legalName"),
      tradingName: str(fd, "tradingName") ?? null,
      legalNameLocal: str(fd, "legalNameLocal") ?? null,
      timezone: str(fd, "timezone"),
      baseCurrency: str(fd, "baseCurrency"),
      // Only send an address when the form carried one, so a page that does not
      // render address fields cannot blank the stored address by omission.
      ...(Object.keys(address).length > 0 ? { address } : {}),
      banking: { bankName: str(fd, "bankName"), iban: str(fd, "iban") },
    });
  } catch (e) {
    fail(orgId, `/${id}`, e);
  }
  revalidatePath(`/o/${orgId}/settings/countries/${id}`);
  redirect(`/o/${orgId}/settings/countries/${id}?notice=saved`);
}

export async function setRegistrationAction(
  orgId: string,
  establishmentId: string,
  fd: FormData,
): Promise<void> {
  const { ctx, archetype } = await resolve(orgId);
  try {
    await setRegistration(ctx, archetype, {
      establishmentId,
      identifierKey: str(fd, "identifierKey"),
      value: str(fd, "value"),
      issuedOn: str(fd, "issuedOn"),
      expiresOn: str(fd, "expiresOn"),
    });
  } catch (e) {
    fail(orgId, `/${establishmentId}`, e);
  }
  revalidatePath(`/o/${orgId}/settings/countries/${establishmentId}`);
  redirect(`/o/${orgId}/settings/countries/${establishmentId}?notice=registration`);
}

/**
 * Step one of adoption: show what would change. This writes nothing — it only
 * carries the choice into the simulator page, which recomputes the preview.
 */
export async function previewAdoptionAction(
  orgId: string,
  establishmentId: string,
  fd: FormData,
): Promise<void> {
  await resolve(orgId);
  const packKey = str(fd, "packKey") ?? "";
  const effectiveFrom = str(fd, "effectiveFrom") ?? "";
  redirect(
    `/o/${orgId}/settings/countries/${establishmentId}/simulate` +
      `?packKey=${encodeURIComponent(packKey)}&effectiveFrom=${encodeURIComponent(effectiveFrom)}`,
  );
}

/** Step two: apply, from the same three values the preview was computed on. */
export async function adoptPackAction(
  orgId: string,
  establishmentId: string,
  fd: FormData,
): Promise<void> {
  const { ctx, archetype } = await resolve(orgId);
  const packKey = str(fd, "packKey") ?? "";
  const effectiveFrom = str(fd, "effectiveFrom") ?? "";
  try {
    await adoptPack(ctx, archetype, {
      establishmentId,
      packKey,
      effectiveFrom,
      note: str(fd, "note"),
    });
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    const code = e instanceof CountryError ? e.kind : "failed";
    redirect(
      `/o/${orgId}/settings/countries/${establishmentId}/simulate` +
        `?packKey=${encodeURIComponent(packKey)}&effectiveFrom=${encodeURIComponent(effectiveFrom)}&error=${code}`,
    );
  }
  revalidatePath(`/o/${orgId}/settings/countries/${establishmentId}`);
  redirect(`/o/${orgId}/settings/countries/${establishmentId}?notice=adopted`);
}
