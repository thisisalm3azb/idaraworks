/**
 * H26 — the document library: folders, tags, saved views, search and the
 * organisation's document settings (retention).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { PROVIDER_NAMES } from "./providers";
import { DocError } from "./types";

// ── settings ──────────────────────────────────────────────────────────────────
export const SETTINGS_KEY = "documents.settings";
export const DocOrgSettings = z
  .object({
    /** Years an issued document is retained from issue (ADR-30; min 5, default 7). */
    retentionYears: z.number().int().min(5).max(30).default(7),
    /** Default reminder offsets (days before due) for new obligations. */
    reminderDays: z.array(z.number().int().min(0).max(365)).max(5).default([30, 7, 1]),
    /** Signature provider adapter (ADR-23); only `native` is provisioned. */
    signatureProvider: z.enum(PROVIDER_NAMES).default("native"),
  })
  .strict();
export type DocOrgSettings = z.infer<typeof DocOrgSettings>;

export async function getDocSettingsIn(tx: TenantTx, ctx: Ctx): Promise<DocOrgSettings> {
  const rows = (await tx.execute(sql`
    select value from public.app_settings where org_id = ${ctx.orgId} and key = ${SETTINGS_KEY}
  `)) as unknown as Array<{ value: unknown }>;
  const parsed = DocOrgSettings.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : DocOrgSettings.parse({});
}

export async function getDocSettings(ctx: Ctx, archetype: RoleArchetype): Promise<DocOrgSettings> {
  assertCan(archetype, "documents.view");
  return withCtx(ctx, (tx) => getDocSettingsIn(tx, ctx));
}

export async function setDocSettings(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<DocOrgSettings> {
  assertCan(archetype, "config.manage");
  const input = DocOrgSettings.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.settings.update",
        entityType: "config",
        summary: `Document settings: retention ${input.retentionYears} years`,
        after: input,
      },
    },
    async (tx) => {
      const current = await getDocSettingsIn(tx, ctx);
      if (input.retentionYears < current.retentionYears) {
        throw new DocError("retention can only be lengthened", "validation");
      }
      await tx.execute(sql`
        insert into public.app_settings (org_id, key, value)
        values (${ctx.orgId}, ${SETTINGS_KEY}, ${JSON.stringify(input)}::jsonb)
        on conflict (org_id, key) do update set value = excluded.value, updated_at = now()
      `);
      return input;
    },
  );
}

// ── folders ───────────────────────────────────────────────────────────────────
export type FolderRow = { id: string; name: string; parentId: string | null; documents: number };

export async function listFolders(ctx: Ctx, archetype: RoleArchetype): Promise<FolderRow[]> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select f.id::text as id, f.name, f.parent_id::text as parent_id,
             (select count(*)::int from public.doc_document d
              where d.folder_id = f.id and d.org_id = f.org_id and d.status <> 'archived') as documents
      from public.doc_folder f
      where f.org_id = ${ctx.orgId} and f.archived_at is null
      order by f.name
    `),
  )) as unknown as Array<{ id: string; name: string; parent_id: string | null; documents: number }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    documents: Number(r.documents),
  }));
}

export async function createFolder(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.create");
  const input = z
    .object({
      name: z.string().trim().min(1).max(120),
      parentId: z.string().uuid().nullable().optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "documents.folder.create",
        entityType: "document_folder",
        entityId: r.id,
        summary: `Created folder "${input.name}"`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.doc_folder (org_id, name, parent_id, created_by)
        values (${ctx.orgId}, ${input.name}, ${input.parentId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function updateFolder(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.edit");
  const input = z
    .object({
      folderId: z.string().uuid(),
      name: z.string().trim().min(1).max(120).optional(),
      parentId: z.string().uuid().nullable().optional(),
      archive: z.boolean().optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: input.archive ? "documents.folder.archive" : "documents.folder.update",
        entityType: "document_folder",
        entityId: input.folderId,
        summary: input.archive ? "Archived folder" : "Updated folder",
      },
    },
    async (tx) => {
      if (input.parentId === input.folderId)
        throw new DocError("a folder cannot contain itself", "validation");
      const rows = (await tx.execute(sql`
        update public.doc_folder
        set name = coalesce(${input.name ?? null}, name),
            parent_id = case when ${input.parentId !== undefined} then ${input.parentId ?? null} else parent_id end,
            archived_at = case when ${input.archive === true} then now() else archived_at end
        where id = ${input.folderId} and org_id = ${ctx.orgId}
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new DocError("folder not found", "not_found");
      return { id: rows[0].id };
    },
  );
}

// ── saved views ───────────────────────────────────────────────────────────────
export const ViewConfig = z
  .object({
    status: z.array(z.string()).max(10).optional(),
    category: z.array(z.string()).max(10).optional(),
    folderId: z.string().uuid().nullable().optional(),
    tag: z.string().max(40).optional(),
    counterpartyKind: z.string().max(20).optional(),
    search: z.string().max(200).optional(),
    sort: z.enum(["updated", "created", "title", "expires"]).optional(),
    layout: z.enum(["list", "board", "timeline", "graph"]).optional(),
  })
  .strict();
export type ViewConfig = z.infer<typeof ViewConfig>;
export type SavedViewRow = {
  id: string;
  name: string;
  config: ViewConfig;
  isShared: boolean;
  mine: boolean;
};

export async function listDocViews(ctx: Ctx, archetype: RoleArchetype): Promise<SavedViewRow[]> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, name, config, is_shared, created_by::text as created_by
      from public.doc_saved_view
      where org_id = ${ctx.orgId} and removed_at is null
      order by name
    `),
  )) as unknown as Array<{
    id: string;
    name: string;
    config: unknown;
    is_shared: boolean;
    created_by: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    config: ViewConfig.safeParse(r.config).data ?? {},
    isShared: r.is_shared,
    mine: r.created_by === ctx.userId,
  }));
}

export async function saveDocView(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.view");
  const input = z
    .object({
      name: z.string().trim().min(1).max(120),
      config: ViewConfig,
      isShared: z.boolean().default(false),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "documents.view.save",
        entityType: "document_view",
        entityId: r.id,
        summary: `Saved view "${input.name}"`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.doc_saved_view (org_id, name, config, is_shared, created_by)
        values (${ctx.orgId}, ${input.name}, ${JSON.stringify(input.config)}::jsonb, ${input.isShared}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function updateDocView(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.view");
  const input = z
    .object({
      viewId: z.string().uuid(),
      name: z.string().trim().min(1).max(120).optional(),
      config: ViewConfig.optional(),
      isShared: z.boolean().optional(),
      remove: z.boolean().optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: input.remove ? "documents.view.remove" : "documents.view.update",
        entityType: "document_view",
        entityId: input.viewId,
        summary: input.remove ? "Removed saved view" : "Updated saved view",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.doc_saved_view
        set name = coalesce(${input.name ?? null}, name),
            config = coalesce(${input.config ? JSON.stringify(input.config) : null}::jsonb, config),
            is_shared = coalesce(${input.isShared ?? null}, is_shared),
            removed_at = case when ${input.remove === true} then now() else removed_at end
        where id = ${input.viewId} and org_id = ${ctx.orgId} and created_by = ${ctx.userId}
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new DocError("view not found", "not_found");
      return { id: rows[0].id };
    },
  );
}

// ── tags ──────────────────────────────────────────────────────────────────────
export async function listTags(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<Array<{ tag: string; count: number }>> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select t as tag, count(*)::int as count
      from public.doc_document d, unnest(d.tags) as t
      where d.org_id = ${ctx.orgId} and d.status <> 'archived'
      group by t order by count desc, t
      limit 200
    `),
  )) as unknown as Array<{ tag: string; count: number }>;
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}
