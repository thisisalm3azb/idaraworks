/**
 * H27 — reviewed customer merge (ADR-42). A merge is proposed with a preview
 * (field conflicts and the rows that would be re-pointed), resolved field by
 * field by a person, then applied in ONE transaction that re-points every
 * org-scoped reference from the source to the target, marks the source
 * inactive with `merged_into_customer_id`, and stores the full before-images
 * and counts as immutable evidence. Nothing is deleted; reads that follow the
 * pointer land on the surviving customer.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";

const uuid = z.string().uuid();

/** Every org-scoped table with a customer_id column that the merge re-points. */
const REPOINT_TABLES = [
  "customer_contact",
  "customer_update",
  "quote",
  "invoice",
  "payment",
  "job",
  "opportunity",
  "lead",
  "sales_activity",
  "crm_consent",
  "crm_touch",
  "crm_customer_signal",
] as const;

const MERGE_FIELDS = [
  "name",
  "country",
  "contact_name",
  "phone",
  "email",
  "tax_reg_no",
  "notes",
  "owner_user_id",
  "territory_id",
  "segment",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export type MergePreview = {
  source: Record<string, unknown>;
  target: Record<string, unknown>;
  conflicts: Array<{ field: MergeField; source: unknown; target: unknown }>;
  counts: Record<string, number>;
  tagsUnion: string[];
};

export class MergeError extends Error {
  readonly code: "not_found" | "state" | "validation";
  constructor(message: string, code: MergeError["code"]) {
    super(message);
    this.code = code;
  }
}

async function customerImageIn(
  tx: TenantTx,
  ctx: Ctx,
  id: string,
): Promise<Record<string, unknown>> {
  const rows = (await tx.execute(sql`
    select id::text as id, name, country, contact_name, phone, email, tax_reg_no, notes, active, owner_user_id::text as owner_user_id,
           territory_id::text as territory_id, tags, segment, merged_into_customer_id::text as merged_into_customer_id, source_kind,
           created_at::text as created_at
    from public.customer where id = ${id} and org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) throw new MergeError("customer not found", "not_found");
  return rows[0];
}

async function countsIn(tx: TenantTx, ctx: Ctx, sourceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of REPOINT_TABLES) {
    const has = (await tx.execute(sql`
      select 1 from information_schema.columns where table_schema = 'public' and table_name = ${t} and column_name = 'customer_id'
    `)) as unknown as unknown[];
    if (!has.length) continue;
    const r = (await tx.execute(
      sql`select count(*)::int as n from public.${sql.raw(t)} where org_id = ${ctx.orgId} and customer_id = ${sourceId}`,
    )) as unknown as Array<{ n: number }>;
    out[t] = Number(r[0]?.n ?? 0);
  }
  const docs = (await tx.execute(sql`
    select count(*)::int as n from public.doc_document where org_id = ${ctx.orgId} and counterparty_kind = 'customer' and counterparty_id = ${sourceId}
  `)) as unknown as Array<{ n: number }>;
  out.doc_document = Number(docs[0]?.n ?? 0);
  return out;
}

export async function previewMerge(
  ctx: Ctx,
  archetype: RoleArchetype,
  sourceId: string,
  targetId: string,
): Promise<MergePreview> {
  assertCan(archetype, "crm.merge");
  if (sourceId === targetId)
    throw new MergeError("source and target are the same customer", "validation");
  return withCtx(ctx, async (tx) => {
    const source = await customerImageIn(tx, ctx, sourceId);
    const target = await customerImageIn(tx, ctx, targetId);
    if (source.merged_into_customer_id || target.merged_into_customer_id)
      throw new MergeError("a customer already merged cannot merge again", "state");
    const conflicts: MergePreview["conflicts"] = [];
    for (const f of MERGE_FIELDS) {
      const s = source[f];
      const t = target[f];
      if (
        s !== null &&
        s !== undefined &&
        s !== "" &&
        t !== null &&
        t !== undefined &&
        t !== "" &&
        s !== t
      )
        conflicts.push({ field: f, source: s, target: t });
    }
    const counts = await countsIn(tx, ctx, sourceId);
    const tagsUnion = [
      ...new Set([...((target.tags as string[]) ?? []), ...((source.tags as string[]) ?? [])]),
    ];
    return { source, target, conflicts, counts, tagsUnion };
  });
}

export const MergeInput = z.object({
  sourceId: uuid,
  targetId: uuid,
  /** For each conflicting field: keep the target's value or take the source's. Missing = keep target. */
  resolutions: z.partialRecord(z.enum(MERGE_FIELDS), z.enum(["target", "source"])).default({}),
  reason: z.string().trim().min(1).max(1000),
});

export async function mergeCustomers(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ mergeId: string; repointed: Record<string, number> }> {
  assertCan(archetype, "crm.merge");
  const input = MergeInput.parse(raw);
  if (input.sourceId === input.targetId)
    throw new MergeError("source and target are the same customer", "validation");
  return command(
    ctx,
    {
      audit: (r: { mergeId: string }) => ({
        action: "crm.customer.merge",
        entityType: "customer",
        entityId: input.targetId,
        summary: `Merged ${input.sourceId.slice(0, 8)} into ${input.targetId.slice(0, 8)} (${r.mergeId.slice(0, 8)}): ${input.reason}`,
      }),
    },
    async (tx) => {
      // Lock both rows in a stable order to make concurrent merges serialise.
      const [a, b] = [input.sourceId, input.targetId].sort();
      await tx.execute(
        sql`select id from public.customer where org_id = ${ctx.orgId} and id in (${a}::uuid, ${b}::uuid) order by id for update`,
      );
      const source = await customerImageIn(tx, ctx, input.sourceId);
      const target = await customerImageIn(tx, ctx, input.targetId);
      if (source.merged_into_customer_id || target.merged_into_customer_id)
        throw new MergeError("a customer already merged cannot merge again", "state");
      const preview = await previewMerge(ctx, archetype, input.sourceId, input.targetId);
      // Field resolutions: only conflicting fields may take the source's value; empty target fields fill from the source.
      const patch: Partial<Record<MergeField, unknown>> = {};
      for (const f of MERGE_FIELDS) {
        const s = source[f];
        const t = target[f];
        const empty = t === null || t === undefined || t === "";
        if (empty && s !== null && s !== undefined && s !== "") patch[f] = s;
        else if (
          !empty &&
          input.resolutions[f] === "source" &&
          preview.conflicts.some((c) => c.field === f)
        )
          patch[f] = s;
      }
      const tagsUnion = preview.tagsUnion;
      await tx.execute(sql`
        update public.customer set
          name = coalesce(${(patch.name as string | null) ?? null}, name),
          country = coalesce(${(patch.country as string | null) ?? null}, country),
          contact_name = coalesce(${(patch.contact_name as string | null) ?? null}, contact_name),
          phone = coalesce(${(patch.phone as string | null) ?? null}, phone),
          email = coalesce(${(patch.email as string | null) ?? null}, email),
          tax_reg_no = coalesce(${(patch.tax_reg_no as string | null) ?? null}, tax_reg_no),
          notes = coalesce(${(patch.notes as string | null) ?? null}, notes),
          owner_user_id = coalesce(${(patch.owner_user_id as string | null) ?? null}::uuid, owner_user_id),
          territory_id = coalesce(${(patch.territory_id as string | null) ?? null}::uuid, territory_id),
          segment = coalesce(${(patch.segment as string | null) ?? null}, segment),
          tags = array(select x from jsonb_array_elements_text(${JSON.stringify(tagsUnion)}::jsonb) as x),
          updated_at = now()
        where id = ${input.targetId} and org_id = ${ctx.orgId}
      `);
      const repointed: Record<string, number> = {};
      for (const t of REPOINT_TABLES) {
        if (!(t in preview.counts)) continue;
        const r = (await tx.execute(
          sql`update public.${sql.raw(t)} set customer_id = ${input.targetId} where org_id = ${ctx.orgId} and customer_id = ${input.sourceId} returning 1`,
        )) as unknown as unknown[];
        repointed[t] = r.length;
      }
      const d = (await tx.execute(sql`
        update public.doc_document set counterparty_id = ${input.targetId}
        where org_id = ${ctx.orgId} and counterparty_kind = 'customer' and counterparty_id = ${input.sourceId} returning 1
      `)) as unknown as unknown[];
      repointed.doc_document = d.length;
      // Contacts that became duplicates on the target keep their rows; only one primary survives.
      await tx.execute(sql`
        update public.customer_contact c set is_primary = false
        where c.org_id = ${ctx.orgId} and c.customer_id = ${input.targetId} and c.is_primary
          and c.id <> (select id from public.customer_contact where org_id = ${ctx.orgId} and customer_id = ${input.targetId} and is_primary order by created_at asc limit 1)
      `);
      await tx.execute(sql`
        update public.customer set active = false, merged_into_customer_id = ${input.targetId}, updated_at = now()
        where id = ${input.sourceId} and org_id = ${ctx.orgId}
      `);
      const rows = (await tx.execute(sql`
        insert into public.crm_merge (org_id, source_customer_id, target_customer_id, preview, resolutions, source_snapshot, target_snapshot, repointed, reason, applied_by)
        values (${ctx.orgId}, ${input.sourceId}, ${input.targetId}, ${JSON.stringify({ conflicts: preview.conflicts, counts: preview.counts })}::jsonb,
                ${JSON.stringify(input.resolutions)}::jsonb, ${JSON.stringify(source)}::jsonb, ${JSON.stringify(target)}::jsonb,
                ${JSON.stringify(repointed)}::jsonb, ${input.reason}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        insert into public.sales_activity (org_id, customer_id, kind, title, body, actor_user_id, meta)
        values (${ctx.orgId}, ${input.targetId}, 'merged', ${`Merged ${String(source.name)} into this customer`}, ${input.reason}, ${ctx.userId},
                ${JSON.stringify({ mergeId: rows[0]!.id, sourceId: input.sourceId, repointed })}::jsonb)
      `);
      return { mergeId: rows[0]!.id, repointed };
    },
  );
}

/** Follow the merge pointer: the customer a caller should be looking at. */
export async function resolveMergedCustomer(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<string> {
  assertCan(archetype, "customers.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      with recursive chain as (
        select id, merged_into_customer_id, 0 as depth from public.customer where org_id = ${ctx.orgId} and id = ${id}
        union all
        select c.id, c.merged_into_customer_id, chain.depth + 1 from public.customer c join chain on c.id = chain.merged_into_customer_id where c.org_id = ${ctx.orgId} and chain.depth < 10
      )
      select id::text as id from chain where merged_into_customer_id is null limit 1
    `),
  )) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? id;
}

export type MergeRow = {
  id: string;
  sourceCustomerId: string;
  targetCustomerId: string;
  reason: string;
  repointed: Record<string, number>;
  appliedAt: string;
  appliedBy: string | null;
};

export async function listMerges(
  ctx: Ctx,
  archetype: RoleArchetype,
  customerId?: string,
): Promise<MergeRow[]> {
  assertCan(archetype, "customers.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select m.id::text as id, m.source_customer_id::text as source_customer_id, m.target_customer_id::text as target_customer_id, m.reason, m.repointed,
             m.applied_at::text as applied_at, u.full_name as applied_by
      from public.crm_merge m left join public.user_profile u on u.id = m.applied_by
      where m.org_id = ${ctx.orgId} and (${customerId ?? null}::uuid is null or m.target_customer_id = ${customerId ?? null}::uuid or m.source_customer_id = ${customerId ?? null}::uuid)
      order by m.applied_at desc limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    sourceCustomerId: String(r.source_customer_id),
    targetCustomerId: String(r.target_customer_id),
    reason: String(r.reason),
    repointed: (r.repointed as Record<string, number>) ?? {},
    appliedAt: String(r.applied_at),
    appliedBy: (r.applied_by as string | null) ?? null,
  }));
}
