/**
 * H29 — the establishment's record of what personal data it processes.
 *
 * The readiness centre reports a missing privacy register, and a product that
 * names a problem with no way to fix it is worse than one that says nothing. So
 * this is the way to fix it: a plain list of data categories, each with its
 * purpose, where it is processed, who processes it, how long it is kept, and
 * whether it leaves the country.
 *
 * It is a DESCRIPTION, not a compliance claim. Nothing here checks an entry
 * against a law, and a reviewed entry means a person read it — not that a
 * regulator accepted it. H29 moves and duplicates no data across regions; this
 * records what the organisation already does.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz/can";
import { command } from "@/platform/audit";
import type { RoleArchetype } from "@/platform/registries";
import { CountryError, getEstablishment } from "./establishments";

export type PrivacyEntryRow = {
  id: string;
  establishmentId: string;
  dataCategory: string;
  purpose: string;
  provider: string | null;
  processingRegion: string | null;
  retention: string | null;
  crossBorder: boolean;
  transferBasis: string | null;
  lawfulBasis: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  note: string | null;
};

export const SetPrivacyEntryInput = z.object({
  establishmentId: z.string().uuid(),
  dataCategory: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(500),
  provider: z.string().trim().max(200).nullable().optional(),
  processingRegion: z.string().trim().max(80).nullable().optional(),
  retention: z.string().trim().max(200).nullable().optional(),
  crossBorder: z.boolean().optional(),
  transferBasis: z.string().trim().max(200).nullable().optional(),
  lawfulBasis: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

function rowOf(r: Record<string, unknown>): PrivacyEntryRow {
  return {
    id: String(r.id),
    establishmentId: String(r.establishment_id),
    dataCategory: String(r.data_category),
    purpose: String(r.purpose),
    provider: (r.provider as string | null) ?? null,
    processingRegion: (r.processing_region as string | null) ?? null,
    retention: (r.retention as string | null) ?? null,
    crossBorder: Boolean(r.cross_border),
    transferBasis: (r.transfer_basis as string | null) ?? null,
    lawfulBasis: (r.lawful_basis as string | null) ?? null,
    reviewedBy: (r.reviewed_by as string | null) ?? null,
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

/**
 * The register for one establishment. Unpaged: it is a list of data CATEGORIES,
 * one row per kind of personal data, and an organisation has a handful.
 */
export async function listPrivacyEntries(
  ctx: Ctx,
  establishmentId: string,
): Promise<PrivacyEntryRow[]> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, establishment_id::text as establishment_id, data_category, purpose,
             provider, processing_region, retention, cross_border, transfer_basis, lawful_basis,
             reviewed_by::text as reviewed_by, reviewed_at::text as reviewed_at, note
      from public.establishment_privacy
      where org_id = ${ctx.orgId} and establishment_id = ${establishmentId}
      order by data_category`)) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  });
}

/**
 * Record or update one data category.
 *
 * Editing an entry CLEARS its review. Someone read the old wording, not the new
 * one, and carrying the review across would turn a real fact into a stale one.
 */
export async function setPrivacyEntry(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<PrivacyEntryRow> {
  assertCan(archetype, "country.manage");
  const input = SetPrivacyEntryInput.parse(raw);
  const establishment = await getEstablishment(ctx, input.establishmentId);
  if (!establishment) throw new CountryError("establishment not found", "not_found");
  // A transfer out of the country without a stated basis is the one thing that
  // must not be recorded silently: the register would then assert a lawful
  // transfer nobody described.
  if (input.crossBorder && !input.transferBasis?.trim())
    throw new CountryError("a cross-border transfer needs a stated basis", "invalid", [
      { field: "transferBasis", messageKey: "country.validation.field_required" },
    ]);

  return command<PrivacyEntryRow>(
    ctx,
    {
      audit: (row) => ({
        action: "country.privacy.set",
        entityType: "establishment",
        entityId: input.establishmentId,
        summary: `Recorded the privacy entry "${row.dataCategory}" for ${establishment.code}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.establishment_privacy
          (org_id, establishment_id, data_category, purpose, provider, processing_region,
           retention, cross_border, transfer_basis, lawful_basis, note)
        values (${ctx.orgId}, ${input.establishmentId}, ${input.dataCategory}, ${input.purpose},
                ${input.provider ?? null}, ${input.processingRegion ?? null},
                ${input.retention ?? null}, ${input.crossBorder ?? false},
                ${input.transferBasis ?? null}, ${input.lawfulBasis ?? null}, ${input.note ?? null})
        on conflict (org_id, establishment_id, data_category) do update set
          purpose = excluded.purpose,
          provider = excluded.provider,
          processing_region = excluded.processing_region,
          retention = excluded.retention,
          cross_border = excluded.cross_border,
          transfer_basis = excluded.transfer_basis,
          lawful_basis = excluded.lawful_basis,
          note = excluded.note,
          reviewed_by = null,
          reviewed_at = null,
          updated_at = now()
        returning id::text as id, establishment_id::text as establishment_id, data_category, purpose,
                  provider, processing_region, retention, cross_border, transfer_basis, lawful_basis,
                  reviewed_by::text as reviewed_by, reviewed_at::text as reviewed_at, note`)) as unknown as Array<
        Record<string, unknown>
      >;
      return rowOf(rows[0]!);
    },
  );
}

/**
 * Mark one entry as read by a person. Recorded with WHO and WHEN, because a
 * review with neither is a claim rather than a fact.
 */
export async function reviewPrivacyEntry(
  ctx: Ctx,
  archetype: RoleArchetype,
  entryId: string,
): Promise<PrivacyEntryRow> {
  assertCan(archetype, "country.manage");
  return command<PrivacyEntryRow>(
    ctx,
    {
      audit: (row) => ({
        action: "country.privacy.review",
        entityType: "establishment",
        entityId: row.establishmentId,
        summary: `Reviewed the privacy entry "${row.dataCategory}"`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.establishment_privacy
           set reviewed_by = ${ctx.userId}, reviewed_at = now(), updated_at = now()
         where org_id = ${ctx.orgId} and id = ${entryId}
        returning id::text as id, establishment_id::text as establishment_id, data_category, purpose,
                  provider, processing_region, retention, cross_border, transfer_basis, lawful_basis,
                  reviewed_by::text as reviewed_by, reviewed_at::text as reviewed_at, note`)) as unknown as Array<
        Record<string, unknown>
      >;
      if (!rows[0]) throw new CountryError("privacy entry not found", "not_found");
      return rowOf(rows[0]);
    },
  );
}
